/**
 * @fileoverview Tests for the per-call budget: the shared wall-clock, the
 * `retry_deadline_exceeded` timeout, and `raceBudget`'s three exits.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  budgetExceeded,
  CALL_BUDGET_MS,
  createCallBudget,
  raceBudget,
} from '@/services/upstream/call-budget.js';
import { asMcpError, makeBudget, thrown } from '../../shared/upstream-harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createCallBudget', () => {
  it('counts down on the wall clock and never goes negative', () => {
    const budget = makeBudget(1_000);
    expect(budget.totalMs).toBe(1_000);
    expect(budget.remainingMs()).toBe(1_000);
    vi.advanceTimersByTime(400);
    expect(budget.remainingMs()).toBe(600);
    vi.advanceTimersByTime(5_000);
    expect(budget.remainingMs()).toBe(0);
  });

  it('is one 45 s budget by default', () => {
    expect(CALL_BUDGET_MS).toBe(45_000);
  });

  it('keeps the signal it was given', () => {
    const controller = new AbortController();
    const budget = makeBudget(1_000, controller.signal);
    expect(budget.signal).toBe(controller.signal);
    expect(
      createCallBudget({ context: budget.context, signal: budget.signal, totalMs: 5 }).signal,
    ).toBe(controller.signal);
  });
});

describe('budgetExceeded', () => {
  it('is a Timeout carrying retry_deadline_exceeded and the budget length', () => {
    const error = budgetExceeded(makeBudget(2_500), 'Loading the thing');
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 2_500 });
    expect(error.message).toContain('Loading the thing');
    expect(error.message).toContain('2500 ms');
  });
});

describe('raceBudget', () => {
  it('resolves with the promise when it settles inside the budget', async () => {
    const budget = makeBudget(1_000);
    const pending = raceBudget(
      new Promise<string>((resolve) => setTimeout(() => resolve('done'), 200)),
      budget,
      'op',
    );
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the promise rejection through and clears its timer', async () => {
    const budget = makeBudget(1_000);
    const failure = new Error('boom');
    await expect(raceBudget(Promise.reject(failure), budget, 'op')).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with retry_deadline_exceeded when the budget runs out first', async () => {
    const budget = makeBudget(500);
    const pending = thrown(() => raceBudget(new Promise(() => undefined), budget, 'Waiting'));
    await vi.advanceTimersByTimeAsync(500);
    const error = asMcpError(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 500 });
  });

  it('rejects at once when the budget is already spent', async () => {
    const budget = makeBudget(100);
    vi.advanceTimersByTime(100);
    const error = asMcpError(await thrown(() => raceBudget(Promise.resolve(1), budget, 'op')));
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
  });

  it('rejects with the signal reason when the signal aborts, leaving the promise running', async () => {
    const controller = new AbortController();
    const budget = makeBudget(10_000, controller.signal);
    const reason = new Error('caller went away');
    const pending = thrown(() => raceBudget(new Promise(() => undefined), budget, 'op'));
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the reason immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    const budget = makeBudget(10_000, controller.signal);
    expect(await thrown(() => raceBudget(Promise.resolve('late'), budget, 'op'))).toBe(reason);
  });
});
