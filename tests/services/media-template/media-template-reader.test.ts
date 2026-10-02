/**
 * @fileoverview Tests for `MediaTemplateReader`: statements from a 200, IANA's
 * "No registration template available." page read as `available: false`, the
 * best-effort contract (every failure but caller cancellation resolves
 * `{ fetched: false }`), the request shape, and the cache (successful reads
 * only, 24 h TTL without revalidation, LRU, no in-flight sharing). Upstream I/O
 * is a `createFetchMock` fake; timing runs on fake timers with jitter pinned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMediaTemplateReader,
  initMediaTemplateReader,
  MediaTemplateReader,
  TEMPLATE_CACHE_MAX_ENTRIES,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_TTL_MS,
} from '@/services/media-template/media-template-reader.js';
import {
  TEMPLATE_HOSTILE,
  TEMPLATE_LABELLED,
  TEMPLATE_NO_LABELS,
  TEMPLATE_PERSON_MARKERS,
  TEMPLATE_PLACEHOLDER,
  TEMPLATE_QUOTING_PLACEHOLDER,
} from '../../fixtures/media-registry.js';
import {
  createHarness,
  hang,
  htmlResponse,
  makeBudget,
  settle as settleWith,
  statusResponse,
  textResponse,
  thrown,
} from '../../shared/upstream-harness.js';

const BASE = 'https://www.iana.org/assignments/media-types/';
const JSON_URL = `${BASE}application/json`;
const PNG_URL = `${BASE}image/png`;
const OCCUPANT_URL = 'https://www.iana.org/assignments/occupant';

type Answer = (request: Request) => Response | Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = <T>(call: () => Promise<T>, ms?: number) =>
  settleWith(call, (step) => vi.advanceTimersByTimeAsync(step), ms);

/** A template served the way IANA serves it: `text/plain` with the bogus `content-encoding: utf-8`. */
const template = (body: string) => textResponse(body, { 'content-encoding': 'utf-8' });

/** A reader over a scripted upstream with a manual clock. `answer` is replaceable between reads. */
function setup(
  options: {
    maxEntries?: number;
    pacing?: NonNullable<Parameters<typeof createHarness>[1]>['pacing'];
    ttlMs?: number;
  } = {},
) {
  let clock = Date.UTC(2026, 9, 1, 12, 0, 0);
  const state: { answer: Answer } = { answer: () => template(TEMPLATE_LABELLED) };
  const h = createHarness(
    [{ match: /./, respond: (request) => state.answer(request) }],
    options.pacing ? { pacing: options.pacing } : undefined,
  );
  const reader = new MediaTemplateReader({
    client: h.client,
    now: () => clock,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  return {
    ...h,
    reader,
    state,
    advance: (ms: number) => {
      clock += ms;
    },
    read: (url: string, budget = h.budget()) => settle(() => reader.read(url, budget)),
  };
}

describe('MediaTemplateReader: a successful read', () => {
  it('returns the three statements with fetched: true, available: true', async () => {
    const s = setup();
    expect((await s.read(JSON_URL)).value).toEqual({
      fetched: true,
      available: true,
      fileExtensions: '.json',
      intendedUsage: 'COMMON',
      deprecatedAliases: 'n/a',
    });
    expect(s.urls()).toEqual([JSON_URL]);
  });

  it('is fetched and available with no statements when the template has none of the labels', async () => {
    const s = setup();
    s.state.answer = () => template(TEMPLATE_NO_LABELS);
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: true, available: true });
  });

  it('never returns the invented contact data of a template', async () => {
    const s = setup();
    const result = JSON.stringify((await s.read(JSON_URL)).value);
    for (const marker of TEMPLATE_PERSON_MARKERS) expect(result).not.toContain(marker);
  });

  it('keeps hostile statement text verbatim (escaping is format()s job)', async () => {
    const s = setup();
    s.state.answer = () => template(TEMPLATE_HOSTILE);
    expect((await s.read(JSON_URL)).value).toMatchObject({
      fileExtensions:
        '.evil\n# Forged heading\n- forged item\n[x](https://evil.example/)\n<b>bold</b>\u{202E}\u0007',
    });
  });

  it('sends one GET with the descriptive User-Agent and no conditional header', async () => {
    const s = setup();
    await s.read(JSON_URL);
    expect(s.http.calls).toHaveLength(1);
    const { request } = s.http.calls[0] ?? {};
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe(JSON_URL);
    expect(request?.headers.get('user-agent')).toContain('iana-registries-mcp-server');
    expect(request?.headers.has('if-modified-since')).toBe(false);
  });

  it('accepts a body of exactly the 256 KiB ceiling', async () => {
    expect(TEMPLATE_MAX_BYTES).toBe(256 * 1024);
    const s = setup();
    const head = 'File extension(s): .big\n\n';
    s.state.answer = () => template(head + 'x'.repeat(TEMPLATE_MAX_BYTES - head.length));
    expect((await s.read(JSON_URL)).value).toEqual({
      fetched: true,
      available: true,
      fileExtensions: '.big',
    });
  });
});

describe("MediaTemplateReader: IANA's no-template page", () => {
  const PLAIN_URL = `${BASE}text/plain`;
  const QUOTING_URL = `${BASE}application/vnd.example.quoting`;
  const MISSING_URL = `${BASE}application/vnd.example.missing`;

  it('tells the placeholder, a real template, a template quoting the sentence, and a 404 apart, and caches every 200', async () => {
    const s = setup();
    const bodies: Record<string, () => Response> = {
      [PLAIN_URL]: () => template(TEMPLATE_PLACEHOLDER),
      [JSON_URL]: () => template(TEMPLATE_LABELLED),
      [QUOTING_URL]: () => template(TEMPLATE_QUOTING_PLACEHOLDER),
      [MISSING_URL]: () => statusResponse(404, {}, 'Page not found'),
    };
    s.state.answer = (request) => {
      const answer = bodies[request.url];
      if (!answer) throw new Error(`unscripted ${request.url}`);
      return answer();
    };
    const expected = {
      [PLAIN_URL]: { fetched: true, available: false },
      [JSON_URL]: {
        fetched: true,
        available: true,
        fileExtensions: '.json',
        intendedUsage: 'COMMON',
        deprecatedAliases: 'n/a',
      },
      [QUOTING_URL]: { fetched: true, available: true, fileExtensions: '.quo' },
      [MISSING_URL]: { fetched: false },
    };
    for (const [url, value] of Object.entries(expected)) {
      expect((await s.read(url)).value).toStrictEqual(value);
    }
    expect(s.urls()).toEqual([PLAIN_URL, JSON_URL, QUOTING_URL, MISSING_URL]);

    for (const [url, value] of Object.entries(expected)) {
      expect((await s.read(url)).value).toStrictEqual(value);
    }
    expect(s.urls()).toEqual([PLAIN_URL, JSON_URL, QUOTING_URL, MISSING_URL, MISSING_URL]);
  });

  it.each([
    ['as served: 35 bytes, no newline', TEMPLATE_PLACEHOLDER],
    ['with a trailing newline', `${TEMPLATE_PLACEHOLDER}\n`],
    ['with surrounding whitespace and CRLF', ` \r\n\t${TEMPLATE_PLACEHOLDER}  \r\n`],
  ])('reads the placeholder %s as available: false', async (_label, body) => {
    const s = setup();
    s.state.answer = () => template(body);
    expect((await s.read(PLAIN_URL)).value).toStrictEqual({ fetched: true, available: false });
  });

  it.each([
    ['without its period', 'No registration template available'],
    ['in lowercase', 'no registration template available.'],
    ['twice', `${TEMPLATE_PLACEHOLDER}\n${TEMPLATE_PLACEHOLDER}`],
    ['followed by a label', `${TEMPLATE_PLACEHOLDER}\nFile extension(s): .x`],
  ])('reads the sentence %s as a real template', async (_label, body) => {
    const s = setup();
    s.state.answer = () => template(body);
    expect((await s.read(PLAIN_URL)).value).toMatchObject({ fetched: true, available: true });
  });

  it('keeps the statements of a template that follows the sentence with a label', async () => {
    const s = setup();
    s.state.answer = () => template(`${TEMPLATE_PLACEHOLDER}\nFile extension(s): .x`);
    expect((await s.read(PLAIN_URL)).value).toStrictEqual({
      fetched: true,
      available: true,
      fileExtensions: '.x',
    });
  });

  it('expires a cached placeholder with the TTL like any read', async () => {
    const s = setup();
    s.state.answer = () => template(TEMPLATE_PLACEHOLDER);
    await s.read(PLAIN_URL);
    s.advance(TEMPLATE_TTL_MS);
    s.state.answer = () => template(TEMPLATE_LABELLED);
    expect((await s.read(PLAIN_URL)).value).toMatchObject({
      fetched: true,
      available: true,
      fileExtensions: '.json',
    });
    expect(s.http.calls).toHaveLength(2);
  });

  it('hands out a fresh placeholder object per read, so a caller mutating it cannot change the cache', async () => {
    const s = setup();
    s.state.answer = () => template(TEMPLATE_PLACEHOLDER);
    const first = (await s.read(PLAIN_URL)).value;
    Object.assign(first ?? {}, { available: true, fileExtensions: 'tampered' });
    expect((await s.read(PLAIN_URL)).value).toStrictEqual({ fetched: true, available: false });
  });
});

describe('MediaTemplateReader: best effort', () => {
  it('a 404 resolves fetched: false after one request', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(404, {}, 'Page not found');
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: false });
    expect(s.http.calls).toHaveLength(1);
  });

  it('a 200 with the wrong content type resolves fetched: false after one request', async () => {
    const s = setup();
    s.state.answer = () => htmlResponse('<html>Moved</html>');
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: false });
    expect(s.http.calls).toHaveLength(1);
  });

  it('a body over 256 KiB resolves fetched: false after one request', async () => {
    const s = setup();
    s.state.answer = () => template(`File extension(s): .a\n${'x'.repeat(TEMPLATE_MAX_BYTES)}`);
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: false });
    expect(s.http.calls).toHaveLength(1);
  });

  it.each([
    ['a 503', () => statusResponse(503), 3],
    ['a 429', () => statusResponse(429, { 'retry-after': '1' }), 3],
    ['a 408', () => statusResponse(408), 3],
    ['an unexpected status (403)', () => statusResponse(403), 3],
  ])('%s resolves fetched: false', async (_label, response, attempts) => {
    const s = setup();
    s.state.answer = response;
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: false });
    expect(s.http.calls).toHaveLength(attempts);
  });

  it('a network failure resolves fetched: false', async () => {
    const s = setup();
    s.state.answer = () => {
      throw new TypeError('connection reset');
    };
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: false });
  });

  it('an upstream that never answers resolves fetched: false inside the call budget', async () => {
    const s = setup();
    s.state.answer = hang;
    const budget = s.budget();
    const outcome = await s.read(JSON_URL, budget);
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({ fetched: false });
    expect(budget.remainingMs()).toBeGreaterThan(0);
  });

  it('a spent budget resolves fetched: false without a request', async () => {
    const s = setup();
    const budget = makeBudget(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(budget.remainingMs()).toBe(0);
    expect((await s.read(JSON_URL, budget)).value).toEqual({ fetched: false });
    expect(s.http.calls).toHaveLength(0);
  });

  it('a full host queue (pacer shed) resolves fetched: false', async () => {
    const s = setup({ pacing: { iana: { name: 'iana', maxConcurrent: 1, maxQueueDepth: 0 } } });
    s.state.answer = (request) =>
      request.url === OCCUPANT_URL ? hang(request) : template(TEMPLATE_LABELLED);
    const occupantSignal = new AbortController();
    s.client
      .request(OCCUPANT_URL, {
        budget: makeBudget(45_000, occupantSignal.signal),
        profile: 'small',
        operation: 'occupy',
        accept: [200],
        expect: 'text',
        maxBytes: 100,
        parse: (response) => response.body,
      })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    expect((await s.read(JSON_URL)).value).toEqual({ fetched: false });
    expect(s.urls()).toEqual([OCCUPANT_URL]);

    occupantSignal.abort(new Error('slot freed'));
    await vi.advanceTimersByTimeAsync(10);
    expect((await s.read(JSON_URL)).value).toMatchObject({
      fetched: true,
      fileExtensions: '.json',
    });
  });

  it('the next read after a failure fetches again and recovers', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(404);
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: false });
    s.state.answer = () => template(TEMPLATE_LABELLED);
    expect((await s.read(JSON_URL)).value).toMatchObject({ fetched: true });
    expect(s.http.calls).toHaveLength(2);
  });
});

describe('MediaTemplateReader: caller cancellation is the only rejection', () => {
  it('rejects with the abort reason when the caller cancels mid-read', async () => {
    const s = setup();
    s.state.answer = hang;
    const controller = new AbortController();
    const pending = thrown(() => s.reader.read(JSON_URL, makeBudget(45_000, controller.signal)));
    await vi.advanceTimersByTimeAsync(100);
    const reason = new Error('client went away');
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(s.http.calls).toHaveLength(1);
  });

  it('rejects when the signal was already aborted, without a request', async () => {
    const s = setup();
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    const error = await settle(() =>
      s.reader.read(JSON_URL, makeBudget(45_000, controller.signal)),
    );
    expect(error.error).toBe(reason);
    expect(s.http.calls).toHaveLength(0);
  });

  it('does not cache anything for a cancelled read', async () => {
    const s = setup();
    s.state.answer = hang;
    const controller = new AbortController();
    const pending = thrown(() => s.reader.read(JSON_URL, makeBudget(45_000, controller.signal)));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('stop'));
    await pending;

    s.state.answer = () => template(TEMPLATE_LABELLED);
    expect((await s.read(JSON_URL)).value).toMatchObject({ fetched: true });
    expect(s.http.calls).toHaveLength(2);
  });
});

describe('MediaTemplateReader: cache', () => {
  it('serves a repeat read from cache with no request', async () => {
    const s = setup();
    const first = (await s.read(JSON_URL)).value;
    const second = (await s.read(JSON_URL)).value;
    expect(second).toEqual(first);
    expect(s.http.calls).toHaveLength(1);
  });

  it('caches per URL', async () => {
    const s = setup();
    await s.read(JSON_URL);
    await s.read(PNG_URL);
    await s.read(JSON_URL);
    await s.read(PNG_URL);
    expect(s.urls()).toEqual([JSON_URL, PNG_URL]);
  });

  it('caches a fetched: true read that carries no statements', async () => {
    const s = setup();
    s.state.answer = () => template(TEMPLATE_NO_LABELS);
    await s.read(JSON_URL);
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: true, available: true });
    expect(s.http.calls).toHaveLength(1);
  });

  it.each([
    ['a 404', () => statusResponse(404)],
    ['a 503', () => statusResponse(503)],
    ['an HTML 200', () => htmlResponse('<html/>')],
  ])('does not cache %s: the next read fetches again', async (_label, response) => {
    const s = setup();
    s.state.answer = response;
    await s.read(JSON_URL);
    const afterFailure = s.http.calls.length;
    await s.read(JSON_URL);
    expect(s.http.calls.length).toBeGreaterThan(afterFailure);
  });

  it('refetches after the 24 h TTL, never before, and without revalidation headers', async () => {
    expect(TEMPLATE_TTL_MS).toBe(24 * 3_600_000);
    const s = setup();
    await s.read(JSON_URL);
    s.advance(TEMPLATE_TTL_MS - 1);
    await s.read(JSON_URL);
    expect(s.http.calls).toHaveLength(1);

    s.advance(1);
    await s.read(JSON_URL);
    expect(s.http.calls).toHaveLength(2);
    expect(s.http.calls[1]?.request.headers.has('if-modified-since')).toBe(false);
  });

  it('honors a custom ttlMs', async () => {
    const s = setup({ ttlMs: 1_000 });
    await s.read(JSON_URL);
    s.advance(999);
    await s.read(JSON_URL);
    s.advance(1);
    await s.read(JSON_URL);
    expect(s.http.calls).toHaveLength(2);
  });

  it('serves nothing stale: an expired entry whose refetch fails reads fetched: false', async () => {
    const s = setup();
    await s.read(JSON_URL);
    s.advance(TEMPLATE_TTL_MS);
    s.state.answer = () => statusResponse(404);
    expect((await s.read(JSON_URL)).value).toEqual({ fetched: false });
    s.state.answer = () => template(TEMPLATE_LABELLED);
    expect((await s.read(JSON_URL)).value).toMatchObject({ fetched: true });
    expect(s.http.calls).toHaveLength(3);
  });

  it('evicts the least recently used entry beyond maxEntries, and a hit refreshes recency', async () => {
    const s = setup({ maxEntries: 2 });
    const [a, b, c] = [`${BASE}x/a`, `${BASE}x/b`, `${BASE}x/c`];
    await s.read(a);
    await s.read(b);
    await s.read(a);
    await s.read(c);
    expect(s.http.calls).toHaveLength(3);

    await s.read(a);
    await s.read(c);
    expect(s.http.calls).toHaveLength(3);

    await s.read(b);
    expect(s.urls().at(-1)).toBe(b);
    expect(s.http.calls).toHaveLength(4);
  });

  it('holds 256 entries by default and evicts the oldest on the 257th', async () => {
    expect(TEMPLATE_CACHE_MAX_ENTRIES).toBe(256);
    const s = setup();
    const url = (index: number) => `${BASE}x/t${index}`;
    for (let index = 0; index <= 256; index++) await s.read(url(index));
    expect(s.http.calls).toHaveLength(257);

    await s.read(url(256));
    await s.read(url(1));
    expect(s.http.calls).toHaveLength(257);
    await s.read(url(0));
    expect(s.http.calls).toHaveLength(258);
  });

  it('does not share one in-flight read between concurrent callers', async () => {
    const s = setup();
    const outcomes = await settle(() =>
      Promise.all([s.reader.read(JSON_URL, s.budget()), s.reader.read(JSON_URL, s.budget())]),
    );
    expect(outcomes.value).toEqual([
      expect.objectContaining({ fetched: true }),
      expect.objectContaining({ fetched: true }),
    ]);
    expect(s.http.calls).toHaveLength(2);
  });

  it('hands out a fresh object per read, so a caller mutating its result cannot change the cache', async () => {
    const s = setup();
    const first = (await s.read(JSON_URL)).value;
    if (!first) throw new Error('read did not resolve');
    Object.assign(first, { fetched: false, fileExtensions: 'tampered' });
    expect((await s.read(JSON_URL)).value).toMatchObject({
      fetched: true,
      fileExtensions: '.json',
    });
  });

  it('a read from one reader does not warm another reader', async () => {
    const s = setup();
    const other = new MediaTemplateReader({ client: s.client });
    await s.read(JSON_URL);
    await settle(() => other.read(JSON_URL, s.budget()));
    expect(s.http.calls).toHaveLength(2);
  });
});

describe('MediaTemplateReader: the process-wide reader', () => {
  it('initMediaTemplateReader builds the reader getMediaTemplateReader returns', () => {
    const s = setup();
    const reader = initMediaTemplateReader({ client: s.client });
    expect(reader).toBeInstanceOf(MediaTemplateReader);
    expect(getMediaTemplateReader()).toBe(reader);
  });

  it('reading before init fails with a message naming the setup call', async () => {
    vi.resetModules();
    const fresh = await import('@/services/media-template/media-template-reader.js');
    expect(() => fresh.getMediaTemplateReader()).toThrow(/initMediaTemplateReader\(\)/);
  });

  it('keeps the defaults in the options type optional: client alone is enough', async () => {
    const s = setup();
    const reader = new MediaTemplateReader({ client: s.client });
    s.state.answer = () => template(TEMPLATE_LABELLED);
    expect((await settle(() => reader.read(JSON_URL, s.budget()))).value).toMatchObject({
      fetched: true,
    });
  });
});
