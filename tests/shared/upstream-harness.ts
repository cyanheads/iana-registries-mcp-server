/**
 * @fileoverview Shared test harness for the service layer: response builders for
 * the content families the upstreams serve, a call budget on a caller-owned
 * signal, and an `UpstreamClient` wired to a `createFetchMock` fake with
 * permissive pacing. No test reaches the network.
 * @module tests/shared/upstream-harness
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, type FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { type CallBudget, createCallBudget } from '@/services/upstream/call-budget.js';
import { UpstreamClient, type UpstreamClientOptions } from '@/services/upstream/upstream-client.js';

/** Pacing that never delays or sheds: every host gets an unlimited pacer. */
export const PERMISSIVE_PACING = {
  iana: { name: 'iana' },
  'rfc-editor': { name: 'rfc-editor' },
  datatracker: { name: 'datatracker' },
} satisfies NonNullable<UpstreamClientOptions['pacing']>;

/** Response headers for one family; extra headers override. */
function respond(
  body: ConstructorParameters<typeof Response>[0],
  contentType: string | undefined,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: { ...(contentType ? { 'content-type': contentType } : {}), ...headers },
  });
}

/** A 200 `application/xml` response. */
export const xmlResponse = (body: string, headers?: Record<string, string>) =>
  respond(body, 'application/xml', headers);

/** A 200 `text/plain` response. */
export const textResponse = (body: string, headers?: Record<string, string>) =>
  respond(body, 'text/plain', headers);

/** A 200 `text/html` response. */
export const htmlResponse = (body: string, headers?: Record<string, string>) =>
  respond(body, 'text/html; charset=utf-8', headers);

/** A 200 `application/json` response. */
export const jsonResponse = (value: unknown, headers?: Record<string, string>) =>
  respond(JSON.stringify(value), 'application/json', headers);

/** A bodiless 304. */
export const notModified = (headers?: Record<string, string>) =>
  new Response(null, { status: 304, ...(headers ? { headers } : {}) });

/** An error response with a short body. */
export const statusResponse = (
  status: number,
  headers: Record<string, string> = {},
  body = '',
  contentType = 'text/html',
) => respond(body, contentType, headers, status);

/** A 200 with no content-type header (a stream body, since a string body gets `text/plain`). */
export const untypedResponse = (body: string) =>
  streamResponse([new TextEncoder().encode(body)], null);

/** A 200 whose body streams the given chunks (no content-length). */
export function streamResponse(
  chunks: readonly Uint8Array[],
  contentType: string | null = 'application/xml',
  onCancel?: () => void,
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return respond(stream, contentType ?? undefined);
}

/** A responder that never answers, but rejects with the signal's reason when aborted. */
export function hang(request: Request): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });
}

/** Runs `fn` and returns the thrown value, failing the test when nothing is thrown. */
export async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/** Narrows a thrown value to `McpError`. */
export function asMcpError(error: unknown): McpError {
  if (!(error instanceof McpError)) {
    throw new Error(`Expected an McpError, got ${String(error)}`);
  }
  return error;
}

/** Context and budget for service calls; `signal` defaults to a fresh, never-aborted one. */
export function makeBudget(totalMs = 45_000, signal: AbortSignal = new AbortController().signal) {
  return createCallBudget({
    totalMs,
    signal,
    context: requestContextService.createRequestContext({ operation: 'test' }),
  });
}

/** The pieces most service tests need. */
export interface Harness {
  readonly budget: () => CallBudget;
  readonly client: UpstreamClient;
  readonly http: ReturnType<typeof createFetchMock>;
  /** Request URLs in call order. */
  urls(): string[];
}

/** An `UpstreamClient` over a fetch fake. Pass `pacing: undefined` explicitly for the defaults. */
export function createHarness(
  routes: readonly FetchMockRoute[] = [],
  options: { pacing?: UpstreamClientOptions['pacing'] } = { pacing: PERMISSIVE_PACING },
): Harness {
  const http = createFetchMock(routes);
  const client = new UpstreamClient({
    fetch: http.fetch,
    userAgent: 'iana-registries-mcp-server-tests/0.0 (+https://example.org)',
    ...(options.pacing ? { pacing: options.pacing } : {}),
  });
  return {
    client,
    http,
    budget: () => makeBudget(),
    urls: () => http.calls.map((call) => call.request.url),
  };
}

/**
 * Starts `call` and lets fake time run (250 ms steps, so backoff and attempt
 * timers fire) until it settles; returns the value or the error. Needs
 * `vi.useFakeTimers()`.
 */
export async function settle<T>(
  call: () => Promise<T>,
  advance: (ms: number) => Promise<unknown>,
  maxMs = 120_000,
): Promise<{ error?: unknown; value?: T }> {
  let outcome: { error?: unknown; value?: T } | undefined;
  call().then(
    (value) => {
      outcome = { value };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  const step = 250;
  for (let elapsed = 0; !outcome && elapsed < maxMs; elapsed += step) await advance(step);
  if (!outcome) throw new Error('The call did not settle in the allotted fake time.');
  return outcome;
}
