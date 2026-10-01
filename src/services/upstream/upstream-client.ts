/**
 * @fileoverview Plain-fetch boundary for the three keyless upstreams (IANA, RFC
 * Editor, IETF Datatracker): per-host pacers, status accept-lists, content-type
 * checks, byte-ceiling body reads, a per-attempt timer, and the retry ladder
 * bounded by the caller's {@link CallBudget}. 304 and 404 are results here, not
 * errors, which is why it calls `fetch` directly instead of `fetchWithTimeout`.
 * @module services/upstream/upstream-client
 */

import { internalError, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  type Pacer,
  type PacerOptions,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { budgetExceeded, type CallBudget } from './call-budget.js';

/** The upstream hosts this server talks to; each gets its own pacer. */
export type UpstreamHost = 'iana' | 'rfc-editor' | 'datatracker';

/** The content family a 200 must carry. */
export type ExpectedContent = 'xml' | 'text' | 'json' | 'html';

/** Retry ladder shape: bulk registry files vs small JSON/template reads. */
export type RetryProfile = 'bulk' | 'small';

/** A `fetch`-compatible function (tests pass `createFetchMock`). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** An accepted response. `body` is the decoded text of a 200, and `''` otherwise. */
export interface UpstreamResponse {
  readonly body: string;
  /** Decoded body size in bytes (0 for a non-200). */
  readonly bytes: number;
  readonly headers: Headers;
  readonly status: number;
}

/** Options for one single-attempt {@link UpstreamClient.get}. */
export interface GetOptions {
  /** Statuses returned as results. Anything else throws. */
  accept: readonly number[];
  /** Content family a 200 must carry. */
  expect: ExpectedContent;
  /** Extra request headers (e.g. `If-Modified-Since`). */
  headers?: Readonly<Record<string, string>>;
  /** Decoded-body ceiling; passing it cancels the stream and throws unreadable. */
  maxBytes: number;
  /** Cancellation for this attempt (the retry attempt's signal). */
  signal: AbortSignal;
  /** Per-attempt timer, cleared once the body is read. */
  timeoutMs: number;
  /** `data.reason` on an unreadable throw. Default `upstream_unreadable`. */
  unreadableReason?: string;
}

/** Options for {@link UpstreamClient.request}: one paced, retried, budgeted read. */
export interface RequestOptions<T> extends Omit<GetOptions, 'signal' | 'timeoutMs'> {
  /** The call's remaining budget and cancellation. */
  budget: CallBudget;
  /** Operation name for retry logs. */
  operation: string;
  /**
   * Turns an accepted response into the result. Runs inside the retry boundary,
   * so a throw here (malformed body) is retried like a failed fetch.
   */
  parse: (response: UpstreamResponse) => T;
  profile: RetryProfile;
}

/** Constructor options. Every seam a test needs is here, never in env vars. */
export interface UpstreamClientOptions {
  fetch?: FetchLike;
  /** Per-host pacer overrides (tests pass permissive limits). */
  pacing?: Partial<Record<UpstreamHost, PacerOptions>>;
  userAgent: string;
}

const HOSTS: Readonly<Record<string, UpstreamHost>> = {
  'www.iana.org': 'iana',
  'www.rfc-editor.org': 'rfc-editor',
  'datatracker.ietf.org': 'datatracker',
};

/** Self-imposed pacing; none of the upstreams publishes a rate limit. */
export const DEFAULT_PACING: Readonly<Record<UpstreamHost, PacerOptions>> = {
  iana: {
    name: 'iana',
    maxConcurrent: 2,
    minStartGapMs: 500,
    limits: [{ requests: 30, perMs: 60_000 }],
    cooldown: { baseMs: 2_000, maxMs: 60_000 },
  },
  'rfc-editor': {
    name: 'rfc-editor',
    maxConcurrent: 3,
    minStartGapMs: 100,
    limits: [{ requests: 60, perMs: 60_000 }],
  },
  datatracker: {
    name: 'datatracker',
    maxConcurrent: 2,
    minStartGapMs: 250,
    limits: [{ requests: 60, perMs: 60_000 }],
  },
};

const PROFILES: Readonly<
  Record<
    RetryProfile,
    { attemptMs: number; baseDelayMs: number; deadlineMs: number; maxRetries: number }
  >
> = {
  bulk: { maxRetries: 2, baseDelayMs: 500, deadlineMs: 40_000, attemptMs: 30_000 },
  small: { maxRetries: 2, baseDelayMs: 500, deadlineMs: 20_000, attemptMs: 10_000 },
};

/** Longest a call may sit in a host's queue before it is shed (`pacer_shed`). */
const PACER_MAX_WAIT_MS = 15_000;

const CONTENT_TYPES: Readonly<Record<ExpectedContent, readonly string[]>> = {
  xml: ['application/xml', 'text/xml'],
  text: ['text/plain'],
  json: ['application/json'],
  html: ['text/html'],
};

/**
 * The `ServiceUnavailable` every unreadable upstream answer produces: an
 * unexpected status on a server-owned URL, a wrong content type, a body over its
 * ceiling, or a body that fails to parse.
 */
export function upstreamUnreadable(
  message: string,
  data: Record<string, unknown> = {},
  { reason = 'upstream_unreadable', cause }: { cause?: unknown; reason?: string } = {},
) {
  return serviceUnavailable(
    message,
    { ...data, reason },
    cause === undefined ? undefined : { cause },
  );
}

/** Paced, budgeted HTTP reads against the IANA, RFC Editor, and Datatracker hosts. */
export class UpstreamClient implements Disposable {
  readonly #fetch: FetchLike;
  readonly #pacers: Readonly<Record<UpstreamHost, Pacer>>;
  readonly #userAgent: string;

  constructor(options: UpstreamClientOptions) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#userAgent = options.userAgent;
    const pacing = { ...DEFAULT_PACING, ...options.pacing };
    this.#pacers = {
      iana: createPacer(pacing.iana),
      'rfc-editor': createPacer(pacing['rfc-editor']),
      datatracker: createPacer(pacing.datatracker),
    };
  }

  /**
   * One paced, retried read inside the caller's budget:
   * `withRetry(attempt => pacer.run(() => get + parse))`. Pacer queue time, every
   * attempt, and every backoff draw on `budget`; expiry is a `Timeout` with
   * `reason: 'retry_deadline_exceeded'`, a full host queue is `pacer_shed`. Every
   * failure, an unconfigured host included, is a rejection.
   */
  async request<T>(url: string, options: RequestOptions<T>): Promise<T> {
    const { budget, parse, profile: profileName, operation, ...get } = options;
    const host = hostOf(url);
    const pacer = this.#pacers[host];
    const profile = PROFILES[profileName];
    const remaining = budget.remainingMs();
    if (remaining <= 0) throw budgetExceeded(budget, operation);

    return await withRetry(
      (attempt) =>
        pacer.run(
          async (signal) =>
            parse(
              await this.get(url, {
                ...get,
                signal,
                timeoutMs: Math.min(profile.attemptMs, attempt.remainingMs),
              }),
            ),
          {
            signal: attempt.signal,
            maxWaitMs: Math.min(PACER_MAX_WAIT_MS, attempt.remainingMs),
          },
        ),
      {
        operation,
        context: budget.context,
        signal: budget.signal,
        maxRetries: profile.maxRetries,
        baseDelayMs:
          host === 'datatracker' && profileName === 'small' ? 1_000 : profile.baseDelayMs,
        deadlineMs: Math.min(profile.deadlineMs, remaining),
      },
    );
  }

  /**
   * One attempt: fetch, status and content-type checks, byte-capped body read.
   * A status in `accept` is returned; 408/429/5xx throw the classified HTTP error
   * (transient, `Retry-After` honored); any other status throws unreadable. When
   * the per-attempt timer fires the throw is a transient `Timeout`; any other
   * abort propagates unchanged.
   */
  async get(url: string, options: GetOptions): Promise<UpstreamResponse> {
    const host = new URL(url).hostname;
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), options.timeoutMs);
    const signal = AbortSignal.any([options.signal, timer.signal]);
    const reason = options.unreadableReason ?? 'upstream_unreadable';

    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          headers: { 'User-Agent': this.#userAgent, ...options.headers },
          redirect: 'follow',
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw serviceUnavailable(
          `Request to ${host} failed: ${error instanceof Error ? error.message : String(error)}`,
          { host },
          { cause: error },
        );
      }

      const { status } = response;
      if (options.accept.includes(status)) {
        if (status !== 200) {
          await discard(response);
          return { status, headers: response.headers, body: '', bytes: 0 };
        }
        const mediaType =
          (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!CONTENT_TYPES[options.expect].includes(mediaType)) {
          await discard(response);
          throw upstreamUnreadable(
            `${host} answered with ${mediaType || 'no content type'} where ${options.expect} was expected.`,
            { host, url, contentType: mediaType },
            { reason },
          );
        }
        const { text, bytes } = await readBody(response, options.maxBytes, () =>
          upstreamUnreadable(
            `${host} sent more than ${options.maxBytes} bytes for ${url}.`,
            { host, url, maxBytes: options.maxBytes },
            { reason },
          ),
        );
        return { status, headers: response.headers, body: text, bytes };
      }

      if (status === 408 || status === 429 || status >= 500) {
        const error = await httpErrorFromResponse(response, { service: host, captureBody: false });
        await discard(response);
        throw error;
      }
      await discard(response);
      throw upstreamUnreadable(
        `${host} answered HTTP ${status} for ${url}.`,
        { host, url, status },
        { reason },
      );
    } catch (error) {
      if (timer.signal.aborted && !options.signal.aborted) {
        throw timeout(
          `${host} did not answer within ${options.timeoutMs} ms.`,
          { host, timeoutMs: options.timeoutMs },
          {
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(handle);
    }
  }

  /** Rejects every queued caller and stops the pacers' timers. */
  dispose(): void {
    for (const pacer of Object.values(this.#pacers)) pacer.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

function hostOf(url: string): UpstreamHost {
  const host = HOSTS[new URL(url).hostname];
  if (!host) throw internalError(`No pacer is configured for ${new URL(url).hostname}.`);
  return host;
}

/** Releases an unread body so the connection returns to the pool. */
async function discard(response: Response): Promise<void> {
  if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined);
}

async function readBody(
  response: Response,
  maxBytes: number,
  overflow: () => Error,
): Promise<{ bytes: number; text: string }> {
  if (!response.body) return { text: '', bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw overflow();
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), bytes };
}

let _client: UpstreamClient | undefined;

/** Constructs the process-wide client. Called from `createApp({ setup })`. */
export function initUpstreamClient(options: UpstreamClientOptions): UpstreamClient {
  _client = new UpstreamClient(options);
  return _client;
}

/** The process-wide client. */
export function getUpstreamClient(): UpstreamClient {
  if (!_client)
    throw new Error('UpstreamClient not initialized — call initUpstreamClient() in setup()');
  return _client;
}
