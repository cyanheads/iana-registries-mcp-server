/**
 * @fileoverview Plain-fetch boundary for the three keyless upstreams (IANA, RFC
 * Editor, IETF Datatracker): per-host pacers, status accept-lists, redirects
 * followed by the client itself and only over https on those hosts,
 * content-type checks, byte-ceiling body reads, a per-attempt timer, and the
 * retry ladder bounded by the caller's {@link CallBudget} and its per-host
 * request allowance. 304 and 404 are results here, not errors, which is why it
 * calls `fetch` directly instead of `fetchWithTimeout`.
 * @module services/upstream/upstream-client
 */

import {
  internalError,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
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
  /** The URL that answered: the request URL, or the last hop of the redirects followed to it. */
  readonly url: string;
}

/** A redirect {@link UpstreamClient.get} returns unread, for {@link UpstreamClient.request} to follow. */
export interface UpstreamRedirect {
  /** The `Location` header, as sent. */
  readonly location: string;
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

/** Hostname → pacer. A `Map`, so a redirect's hostname never reaches an object prototype. */
const HOSTS: ReadonlyMap<string, UpstreamHost> = new Map([
  ['www.iana.org', 'iana'],
  ['www.rfc-editor.org', 'rfc-editor'],
  ['datatracker.ietf.org', 'datatracker'],
]);

/** Datatracker requests this server starts per minute, across every client. */
const DATATRACKER_PER_MINUTE = 60;

/**
 * The most Datatracker requests one tool call may start, retries included: a
 * third of the host's per-minute pacing, so one call cannot take most of it.
 */
export const DATATRACKER_CALL_REQUESTS = DATATRACKER_PER_MINUTE / 3;

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
    limits: [{ requests: DATATRACKER_PER_MINUTE, perMs: 60_000 }],
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

/** Statuses that redirect when they carry a `Location`. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Redirects one read follows; the next one fails the read. */
const MAX_REDIRECTS = 5;

const OFF_HOST_HINT =
  'This upstream file redirects off the https hosts this server reads, so calling again fails the same way; open its page on the upstream site instead.';
const REDIRECT_LIMIT_HINT = `This upstream file redirects more than ${MAX_REDIRECTS} times, so calling again fails the same way; open its page on the upstream site instead.`;
const OVER_CEILING_HINT =
  'This upstream file is larger than this server reads, so calling again fails the same way; open its page on the upstream site instead.';

/**
 * Unreadable answers that come back the same on every attempt within a call but
 * can clear before a later one: a wrong content type, typically an error or
 * maintenance page served as 200. {@link UpstreamClient.request} fails on the
 * first and leaves `retryable` off the wire, so the caller is still told to
 * retry later.
 */
const sameWithinCall = new WeakSet<Error>();

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
   * `withRetry(attempt => each hop: pacer.run(() => get, + parse at the last))`.
   * A redirect is followed hop by hop, each hop a request of its own: it takes
   * one request from the budget's allowance for its host, waits its turn on that
   * host's pacer, and gets its own per-attempt timer under the ladder deadline.
   * Pacer queue time, every hop, and every backoff draw on `budget`; expiry is a
   * `Timeout` with `reason: 'retry_deadline_exceeded'`, a full host queue is
   * `pacer_shed`. With no request left for a host the read fails `RateLimited`
   * with `reason: 'request_limit'`, unretried. A redirect off the upstream hosts
   * or past {@link MAX_REDIRECTS}, a wrong content type, and a body over its
   * ceiling fail unreadable on the first answer, since every attempt in the call
   * would get the same one. Every failure, an unconfigured host included, is a
   * rejection.
   */
  async request<T>(url: string, options: RequestOptions<T>): Promise<T> {
    const { budget, parse, profile: profileName, operation, ...get } = options;
    const host = hostOf(url);
    const profile = PROFILES[profileName];
    const remaining = budget.remainingMs();
    if (remaining <= 0) throw budgetExceeded(budget, operation);
    const reason = get.unreadableReason ?? 'upstream_unreadable';

    return await withRetry(
      async (attempt) => {
        let hop = url;
        for (let redirects = 0; ; redirects++) {
          const hopHost = hostOf(hop);
          takeRequest(budget, hopHost, hop, operation);
          const answer = await this.#pacers[hopHost].run(
            async (signal) => {
              const response = await this.get(hop, {
                ...get,
                signal,
                timeoutMs: Math.min(profile.attemptMs, attempt.remainingMs),
              });
              return 'location' in response ? response : { value: parse(response) };
            },
            {
              signal: attempt.signal,
              maxWaitMs: Math.min(PACER_MAX_WAIT_MS, attempt.remainingMs),
            },
          );
          if ('value' in answer) return answer.value;
          if (redirects === MAX_REDIRECTS) {
            throw repeatingFailure(
              `${url} redirected more than ${MAX_REDIRECTS} times; this server follows at most ${MAX_REDIRECTS}.`,
              { host: new URL(url).hostname, url, maxRedirects: MAX_REDIRECTS },
              reason,
              REDIRECT_LIMIT_HINT,
            );
          }
          hop = nextHop(hop, answer.location, reason);
        }
      },
      {
        operation,
        context: budget.context,
        signal: budget.signal,
        maxRetries: profile.maxRetries,
        baseDelayMs:
          host === 'datatracker' && profileName === 'small' ? 1_000 : profile.baseDelayMs,
        deadlineMs: Math.min(profile.deadlineMs, remaining),
        isTransient: (error) =>
          !(error instanceof Error && sameWithinCall.has(error)) && defaultIsTransient(error),
      },
    );
  }

  /**
   * One request: fetch, status and content-type checks, byte-capped body read.
   * `fetch` follows no redirect: a 301, 302, 303, 307, or 308 carrying a
   * `Location` is returned unread as an {@link UpstreamRedirect}, for
   * {@link request} to follow.
   * A status in `accept` is returned; 408/429/5xx throw the classified HTTP error
   * (transient, `Retry-After` honored); any other status throws unreadable. A
   * wrong content type throws unreadable that {@link request} does not retry; a
   * body over `maxBytes` throws unreadable with `retryable: false` and a hint
   * that calling again fails the same way. When the per-attempt timer fires the
   * throw is a transient `Timeout`; any other abort propagates unchanged.
   */
  async get(url: string, options: GetOptions): Promise<UpstreamResponse | UpstreamRedirect> {
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
          redirect: 'manual',
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
      const location = redirectLocation(response);
      if (location !== undefined) {
        await discard(response);
        return { location };
      }
      if (options.accept.includes(status)) {
        if (status !== 200) {
          await discard(response);
          return { status, headers: response.headers, body: '', bytes: 0, url };
        }
        const mediaType =
          (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!CONTENT_TYPES[options.expect].includes(mediaType)) {
          await discard(response);
          const wrongType = upstreamUnreadable(
            `${host} answered with ${mediaType || 'no content type'} where ${options.expect} was expected.`,
            { host, url, contentType: mediaType },
            { reason },
          );
          sameWithinCall.add(wrongType);
          throw wrongType;
        }
        const { text, bytes } = await readBody(response, options.maxBytes, () =>
          repeatingFailure(
            `${host} sent more than ${options.maxBytes} bytes for ${url}.`,
            { host, url, maxBytes: options.maxBytes },
            reason,
            OVER_CEILING_HINT,
          ),
        );
        return { status, headers: response.headers, body: text, bytes, url };
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
  const host = HOSTS.get(new URL(url).hostname);
  if (!host) throw internalError(`No pacer is configured for ${new URL(url).hostname}.`);
  return host;
}

/** The `Location` of a redirect status, or `undefined` for any other answer. */
function redirectLocation(response: Pick<Response, 'headers' | 'status'>): string | undefined {
  return REDIRECT_STATUSES.has(response.status)
    ? (response.headers.get('location') ?? undefined)
    : undefined;
}

/**
 * The URL a redirect from `from` continues to: `location` resolved against
 * `from`, on one of {@link HOSTS}, with no username or password, `http:`
 * upgraded to `https:` so no plain-http request is ever sent, and on the https
 * default port once upgraded. Any other target is refused before a request.
 */
function nextHop(from: string, location: string, reason: string): string {
  const target = URL.parse(location, from);
  if (target && HOSTS.has(target.hostname) && !target.username && !target.password) {
    const hop = new URL(target);
    if (hop.protocol === 'http:') hop.protocol = 'https:';
    if (hop.protocol === 'https:' && hop.port === '') return hop.href;
  }
  const shown = refusedTarget(target);
  const host = new URL(from).hostname;
  throw repeatingFailure(
    `${host} redirected ${from} to ${shown}, outside the https upstream hosts this server reads.`,
    { host, url: from, redirectedTo: shown },
    reason,
    OFF_HOST_HINT,
  );
}

/**
 * A refused target as its error names it: its origin, which never carries a
 * username or password. A target on one of {@link HOSTS} refused for its
 * credentials would show an upstream origin, so it is named by the reason.
 */
function refusedTarget(target: URL | null): string {
  if (!target) return 'an unparseable URL';
  if (target.origin === 'null') return `a ${target.protocol} URL`;
  if (HOSTS.has(target.hostname) && (target.username || target.password)) {
    return 'a URL with a username or password';
  }
  return target.origin;
}

/**
 * An answer every later call gets too (a redirect this client will not follow,
 * a body over its ceiling): unreadable and `retryable: false`, with a hint
 * saying so.
 */
function repeatingFailure(
  message: string,
  data: Record<string, unknown>,
  reason: string,
  hint: string,
) {
  return upstreamUnreadable(message, { ...data, retryable: false, recovery: { hint } }, { reason });
}

/**
 * Takes one request for `host` from the budget's allowance, or throws
 * `request_limit` when none is left. `retryable: false` keeps `withRetry` from
 * re-attempting: within this call, no later attempt would be allowed either.
 */
function takeRequest(budget: CallBudget, host: UpstreamHost, url: string, operation: string) {
  const { requests } = budget;
  const left = requests?.[host];
  if (requests === undefined || left === undefined) return;
  if (left <= 0) {
    const hostname = new URL(url).hostname;
    throw rateLimited(
      `${operation} was not sent: this call has started every request to ${hostname} it may.`,
      { reason: 'request_limit', host: hostname, retryable: false },
    );
  }
  requests[host] = left - 1;
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
