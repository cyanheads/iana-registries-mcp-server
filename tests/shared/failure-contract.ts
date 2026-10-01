/**
 * @fileoverview The upstream-failure rows every registry-backed tool shares,
 * registered as one `describe` block per tool: the `pacer_shed` row, upstream
 * 5xx and 429, unreadable answers (`reason` + `recovery` reach the result),
 * the call deadline, caller cancellation, the stale-copy disclosure in both
 * surfaces, and the 2-minute hold. Each tool file calls
 * {@link describeFailureContract} with its fetch target and a valid body.
 * @module tests/shared/failure-contract
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRESH_MS,
  HOLD_MS,
  LANGUAGE_REGISTRY_URL,
  PEN_URL,
  STALE_MAX_MS,
} from '@/services/registry/registry-store.js';
import { callTool, setupTools } from './tool-harness.js';
import { hang, makeBudget, statusResponse } from './upstream-harness.js';

/** A 200 the service must refuse, and how many fetches the retry ladder spends on it. */
export interface UnreadableAnswer {
  attempts: number;
  label: string;
  response: () => Response;
}

/** What one tool must show for the shared failure rows. */
export interface FailureContractCase {
  definition: AnyToolDefinition;
  /** A call that succeeds against {@link ok} and fetches only {@link url}. */
  input: Record<string, unknown>;
  /** The valid body for {@link url}. */
  ok: () => Response;
  /** The `data.reason` an unreadable answer carries. */
  reason: 'index_unreadable' | 'upstream_unreadable';
  /** The contract's recovery text for {@link reason}. */
  recovery: string;
  /** Answers that arrive but cannot be read. */
  unreadable: readonly UnreadableAnswer[];
  /** The single file the call fetches. */
  url: string;
}

const DAY_MS = 24 * 3_600_000;

/** Registers the shared failure rows for one tool. */
export function describeFailureContract(c: FailureContractCase): void {
  const name = c.definition.name;

  describe(`${name}: upstream failure contract`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** Another iana file, so the occupant never shadows the tool's own URL. */
    const occupantUrl = c.url === PEN_URL ? LANGUAGE_REGISTRY_URL : PEN_URL;

    /** Occupies the only iana slot with a request that never answers; abort it to free the slot. */
    function occupySlot(s: ReturnType<typeof setupTools>) {
      const controller = new AbortController();
      s.serve({ [occupantUrl]: hang });
      s.client
        .request(occupantUrl, {
          budget: makeBudget(45_000, controller.signal),
          profile: 'small',
          operation: 'occupy',
          accept: [200],
          expect: 'text',
          maxBytes: 100,
          parse: (response) => response.body,
        })
        .catch(() => undefined);
      return controller;
    }

    it('succeeds against the valid body (baseline)', async () => {
      const s = setupTools();
      s.serve({ [c.url]: c.ok });
      const out = await callTool(c.definition, c.input);
      expect(out.isError).toBe(false);
      expect(s.fetched()).toEqual([c.url]);
    });

    it('pacer_shed: a full host queue sheds the call as RateLimited with retryAfter and the recovery', async () => {
      const s = setupTools({
        pacing: { iana: { name: 'iana', maxConcurrent: 1, maxQueueDepth: 0 } },
      });
      s.serve({ [c.url]: c.ok });
      const occupant = occupySlot(s);
      await vi.advanceTimersByTimeAsync(10);

      const out = await callTool(c.definition, c.input);
      expect(out.isError).toBe(true);
      expect(out.structured.error).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'pacer_shed',
          shedKind: 'queue_full',
          retryAfter: expect.any(Number),
          recovery: {
            hint: `Wait the retryAfter seconds given in this error, then call ${name} again.`,
          },
        },
      });
      expect(out.text).toContain(
        `Recovery: Wait the retryAfter seconds given in this error, then call ${name} again.`,
      );
      expect(out.text).toContain('reason pacer_shed');
      expect(s.fetched()).toEqual([occupantUrl]);
      occupant.abort(new Error('test done'));
    });

    it('pacer_shed: a shed starts no hold, so the next call fetches as soon as the slot is free', async () => {
      const s = setupTools({
        pacing: { iana: { name: 'iana', maxConcurrent: 1, maxQueueDepth: 0 } },
      });
      s.serve({ [c.url]: c.ok });
      const occupant = occupySlot(s);
      await vi.advanceTimersByTimeAsync(10);
      expect((await callTool(c.definition, c.input)).isError).toBe(true);

      occupant.abort(new Error('slot freed'));
      await vi.advanceTimersByTimeAsync(10);
      const out = await callTool(c.definition, c.input);
      expect(out.isError).toBe(false);
      expect(s.fetched().filter((url) => url === c.url)).toHaveLength(1);
    });

    it('pacer_shed: a shed during a refresh serves the cached copy as stale instead of failing', async () => {
      const s = setupTools({
        pacing: { iana: { name: 'iana', maxConcurrent: 1, maxQueueDepth: 0 } },
      });
      s.serve({ [c.url]: c.ok });
      expect((await callTool(c.definition, c.input)).isError).toBe(false);
      s.advance(FRESH_MS + 1);
      const occupant = occupySlot(s);
      await vi.advanceTimersByTimeAsync(10);

      const out = await callTool(c.definition, c.input);
      expect(out.isError).toBe(false);
      expect(out.structured.source).toMatchObject({ stale: true });
      occupant.abort(new Error('test done'));
    });

    it('a 503 is retried to three attempts and surfaces as ServiceUnavailable', async () => {
      const s = setupTools();
      s.serve({ [c.url]: () => statusResponse(503) });
      const out = await callTool(c.definition, c.input);
      expect(out.isError).toBe(true);
      expect(out.structured.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 503, retryAttempts: 3 },
      });
      expect(s.fetches()).toBe(3);
    });

    it('a 429 is retried to three attempts and surfaces as RateLimited with the upstream retryAfter', async () => {
      const s = setupTools();
      s.serve({ [c.url]: () => statusResponse(429, { 'retry-after': '1' }) });
      const out = await callTool(c.definition, c.input);
      expect(out.isError).toBe(true);
      expect(out.structured.error).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { status: 429, retryAfter: '1', retryAttempts: 3 },
      });
      expect(s.fetches()).toBe(3);
    });

    it.each(c.unreadable)(
      `$label surfaces ${c.reason} with the contract recovery in both surfaces`,
      async ({ response, attempts }) => {
        const s = setupTools();
        s.serve({ [c.url]: response });
        const out = await callTool(c.definition, c.input);
        expect(out.isError).toBe(true);
        expect(out.structured.error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: c.reason, recovery: { hint: c.recovery } },
        });
        expect(out.text).toContain(`Recovery: ${c.recovery}`);
        expect(out.text).toContain(`reason ${c.reason}`);
        expect(s.fetches()).toBe(attempts);
      },
    );

    it('an unexpected status on the fixed URL (403) surfaces the same unreadable reason', async () => {
      const s = setupTools();
      s.serve({ [c.url]: () => statusResponse(403) });
      const out = await callTool(c.definition, c.input);
      expect(out.structured.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 403, reason: c.reason },
      });
    });

    it('an upstream that never answers ends in a Timeout inside the call budget', async () => {
      const s = setupTools();
      s.serve({ [c.url]: hang });
      const out = await callTool(c.definition, c.input);
      expect(out.isError).toBe(true);
      expect(out.structured.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded' },
      });
    });

    it('a caller cancellation rejects as RequestCancelled after one fetch', async () => {
      const s = setupTools();
      s.serve({ [c.url]: hang });
      const controller = new AbortController();
      const pending = callTool(c.definition, c.input, { context: { signal: controller.signal } });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort(new Error('client went away'));
      const out = await pending;
      expect(out.structured.error).toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        message: 'client went away',
      });
      expect(s.fetches()).toBe(1);
    });

    describe('stale copy and hold', () => {
      it('serves the cached copy marked stale when the refresh fails, in structuredContent and format()', async () => {
        const s = setupTools();
        s.serve({ [c.url]: c.ok });
        const fresh = await callTool(c.definition, c.input);
        expect(fresh.structured.source).toMatchObject({ stale: false });
        expect(fresh.text).not.toContain('Served from a stale copy');

        s.advance(FRESH_MS + 1);
        s.answerAll(() => statusResponse(503));
        const stale = await callTool(c.definition, c.input);
        expect(stale.isError).toBe(false);
        const source = stale.structured.source as { fetched_at: string; stale: boolean };
        expect(source.stale).toBe(true);
        expect(source.fetched_at).toBe(
          (fresh.structured.source as { fetched_at: string }).fetched_at,
        );
        expect(stale.text).toContain(
          `**Served from a stale copy** fetched ${source.fetched_at}; the latest refresh failed.`,
        );
        expect(s.fetches()).toBe(1 + 3);
      });

      it('starts a 2-minute hold on the failed refresh: no fetch inside it, a fresh try after it', async () => {
        const s = setupTools();
        s.serve({ [c.url]: c.ok });
        await callTool(c.definition, c.input);
        s.advance(FRESH_MS + 1);
        s.answerAll(() => statusResponse(503));
        await callTool(c.definition, c.input);
        const afterFailure = s.fetches();

        s.advance(HOLD_MS - 1_000);
        const held = await callTool(c.definition, c.input);
        expect(held.structured.source).toMatchObject({ stale: true });
        expect(s.fetches()).toBe(afterFailure);

        s.advance(2_000);
        s.answerAll(c.ok);
        const recovered = await callTool(c.definition, c.input);
        expect(recovered.structured.source).toMatchObject({ stale: false });
        expect(s.fetches()).toBe(afterFailure + 1);
      });

      it('rethrows the remembered error inside the hold when no copy was ever cached', async () => {
        const s = setupTools();
        s.serve({ [c.url]: () => statusResponse(503) });
        const first = await callTool(c.definition, c.input);
        const afterFailure = s.fetches();
        s.advance(HOLD_MS - 1_000);
        const second = await callTool(c.definition, c.input);
        expect(second.structured.error).toEqual(first.structured.error);
        expect(s.fetches()).toBe(afterFailure);
      });

      it('does not serve a copy older than 7 days: the refresh error surfaces instead', async () => {
        const s = setupTools();
        s.serve({ [c.url]: c.ok });
        await callTool(c.definition, c.input);
        s.advance(STALE_MAX_MS + DAY_MS);
        s.answerAll(() => statusResponse(503));
        const out = await callTool(c.definition, c.input);
        expect(out.isError).toBe(true);
        expect(out.structured.error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      });
    });
  });
}
