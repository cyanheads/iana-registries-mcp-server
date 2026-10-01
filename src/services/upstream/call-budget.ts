/**
 * @fileoverview One wall-clock budget per tool call, threaded through every retry
 * ladder, pacer wait, and shared-load wait the call makes, so a multi-step call
 * never sums separate deadlines past the client's timeout. A budget can also
 * carry a per-host request allowance that bounds how many requests the call
 * starts, so one call cannot take most of a host's shared pacing.
 * @module services/upstream/call-budget
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { timeout } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import type { UpstreamHost } from './upstream-client.js';

/** The per-call budget a tool handler starts at entry (client timeout is 60 s). */
export const CALL_BUDGET_MS = 45_000;

/** What remains of one call's wall-clock budget. */
export interface CallBudget {
  /** Correlated log context for retry and cache logs. */
  readonly context: RequestContext;
  /** Milliseconds left, never negative. */
  remainingMs(): number;
  /**
   * Requests the call may still start, per host, retries included; counted down
   * by `UpstreamClient.request`. A host with no entry is unbounded.
   */
  readonly requests?: Partial<Record<UpstreamHost, number>>;
  /** Cancellation: the request's `ctx.signal`, or the server scope for a shared load. */
  readonly signal: AbortSignal;
  /** The budget's full length, for error messages. */
  readonly totalMs: number;
}

/** Inputs for {@link createCallBudget}. */
export interface CallBudgetOptions {
  context: RequestContext;
  /** Per-host request allowance; the budget counts down its own copy. */
  requests?: Partial<Record<UpstreamHost, number>>;
  signal: AbortSignal;
  totalMs: number;
}

/** Creates a budget that starts counting now. */
export function createCallBudget({
  context,
  requests,
  signal,
  totalMs,
}: CallBudgetOptions): CallBudget {
  const deadline = Date.now() + totalMs;
  return {
    context,
    signal,
    totalMs,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    ...(requests ? { requests: { ...requests } } : {}),
  };
}

/**
 * Starts the 45 s budget for one tool call, with an optional per-host request
 * allowance. Call it first thing in the handler.
 */
export function startCallBudget(
  ctx: Context,
  requests?: Partial<Record<UpstreamHost, number>>,
): CallBudget {
  return createCallBudget({
    context: ctx,
    signal: ctx.signal,
    totalMs: CALL_BUDGET_MS,
    ...(requests ? { requests } : {}),
  });
}

/** The `Timeout` a call gets when its budget runs out outside a retry ladder. */
export function budgetExceeded(budget: CallBudget, operation: string) {
  return timeout(`${operation} did not finish within the call's ${budget.totalMs} ms budget.`, {
    reason: 'retry_deadline_exceeded',
    deadlineMs: budget.totalMs,
  });
}

/**
 * Awaits `promise`, giving up when the budget runs out (`Timeout`,
 * `retry_deadline_exceeded`) or the budget's signal aborts (rejects with the
 * signal's reason). The promise itself is not cancelled; a shared load keeps
 * running for its other waiters.
 */
export function raceBudget<T>(
  promise: Promise<T>,
  budget: CallBudget,
  operation: string,
): Promise<T> {
  if (budget.signal.aborted) return Promise.reject(budget.signal.reason);
  const remaining = budget.remainingMs();
  if (remaining <= 0) return Promise.reject(budgetExceeded(budget, operation));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(budget.signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(budgetExceeded(budget, operation));
    }, remaining);
    const cleanup = () => {
      clearTimeout(timer);
      budget.signal.removeEventListener('abort', onAbort);
    };
    budget.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
