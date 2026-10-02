/**
 * @fileoverview Shared harness for tool tests: a `RegistryStore` over a scripted
 * `createFetchMock` upstream with a manual clock, installed as the process-wide
 * store the handlers read through `getRegistryStore()`, and `callTool`, which
 * drives a definition through `runToolContract` on fake timers. No test reaches
 * the network. Call `setupTools()` from `beforeEach` and `vi.useFakeTimers()`
 * before it. A tool backed by another service builds it over the returned
 * `client` (for example `initMediaTemplateReader({ client: s.client })`) after
 * `setupTools()`.
 * @module tests/shared/tool-harness
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { vi } from 'vitest';
import {
  initRegistryStore,
  type RegistryStoreOptions,
} from '@/services/registry/registry-store.js';
import type { UpstreamClientOptions } from '@/services/upstream/upstream-client.js';
import {
  createHarness,
  PERMISSIVE_PACING,
  settle as settleWith,
  statusResponse,
} from './upstream-harness.js';

/** The store clock's start. */
export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** A scripted answer: a factory, so every request gets a fresh `Response`. */
export type Answer = (request: Request) => Response | Promise<Response>;

/** Options for {@link setupTools}. */
export interface ToolSetupOptions {
  freshMs?: RegistryStoreOptions['freshMs'];
  pacing?: UpstreamClientOptions['pacing'];
  staleMaxMs?: RegistryStoreOptions['staleMaxMs'];
}

/**
 * Builds the upstream fake, the store over it (installed process-wide), and a
 * manual clock. `serve` scripts answers by exact URL, and `serveWhere` answers
 * the URLs a predicate accepts when no exact answer is scripted; an unscripted
 * URL throws, so an unexpected fetch is loud.
 */
export function setupTools(options: ToolSetupOptions = {}) {
  let clock = T0;
  const routes = new Map<string, Answer>();
  const matchers: { answer: Answer; test: (url: URL) => boolean }[] = [];
  const h = createHarness([{ match: /./, respond: (request) => answerFor(request) }], {
    pacing: options.pacing ?? PERMISSIVE_PACING,
  });
  const answerFor = (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url);
    const answer = routes.get(request.url) ?? matchers.find((matcher) => matcher.test(url))?.answer;
    if (!answer) throw new Error(`No upstream answer scripted for ${request.url}`);
    return answer(request);
  };
  const store = initRegistryStore({
    client: h.client,
    now: () => clock,
    ...(options.freshMs === undefined ? {} : { freshMs: options.freshMs }),
    ...(options.staleMaxMs === undefined ? {} : { staleMaxMs: options.staleMaxMs }),
  });
  return {
    ...h,
    store,
    /** Script answers by exact URL, e.g. `{ [url]: () => xmlResponse(xml) }`; later calls replace earlier ones. */
    serve(answers: Record<string, Answer>) {
      for (const [url, answer] of Object.entries(answers)) routes.set(url, answer);
    },
    /** Answers every URL `test` accepts that has no exact answer; a later call takes precedence. */
    serveWhere(test: (url: URL) => boolean, answer: Answer) {
      matchers.unshift({ test, answer });
    },
    /** Answers every scripted URL with `answer` from now on. */
    answerAll(answer: Answer) {
      for (const url of routes.keys()) routes.set(url, answer);
    },
    advance(ms: number) {
      clock += ms;
    },
    /** Number of upstream requests so far. */
    fetches: () => h.http.calls.length,
    /** Request URLs fetched, in order. */
    fetched: () => h.http.calls.map((call) => call.request.url),
  };
}

/** `fn` run under fake time until it settles; needs `vi.useFakeTimers()`. */
export const settle = <T>(call: () => Promise<T>, ms?: number) =>
  settleWith(call, (step) => vi.advanceTimersByTimeAsync(step), ms);

/** A 5xx answer, for scripting a failing upstream. */
export const serverError = () => statusResponse(503);

/** What `runToolContract` resolves to. */
export type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** A tool result with its surfaces typed for assertions. */
export interface ToolOutcome {
  readonly isError: boolean;
  readonly result: CallToolResult;
  /** `structuredContent`, success or error envelope. */
  readonly structured: Record<string, unknown>;
  /** The `content[]` text, joined. */
  readonly text: string;
}

/** Runs a definition through the contract runner on fake time and unpacks the result. */
export async function callTool(
  definition: AnyToolDefinition,
  input: Record<string, unknown>,
  context?: Parameters<typeof runToolContract>[2],
): Promise<ToolOutcome> {
  const settled = await settle(() => runToolContract(definition, input, context));
  if (settled.error !== undefined) throw settled.error;
  const result = settled.value as CallToolResult;
  const text = (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
  return {
    result,
    text,
    isError: result.isError === true,
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
}
