/**
 * @fileoverview Tests for `UpstreamClient`: accept-lists (304/404 as results),
 * the content-type check, byte ceilings, the per-attempt timer, the retry
 * ladder, per-host pacing, and the one per-call budget across ladders and
 * pacer waits. Upstream I/O is a `createFetchMock` fake; timing runs on fake
 * timers with jitter pinned.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PACING,
  type RequestOptions,
  UpstreamClient,
  type UpstreamResponse,
  upstreamUnreadable,
} from '@/services/upstream/upstream-client.js';
import {
  asMcpError,
  createHarness,
  hang,
  htmlResponse,
  jsonResponse,
  makeBudget,
  notModified,
  settle as settleWith,
  statusResponse,
  streamResponse,
  textResponse,
  thrown,
  untypedResponse,
  xmlResponse,
} from '../../shared/upstream-harness.js';

const IANA_URL = 'https://www.iana.org/assignments/example/example.xml';
const RFC_URL = 'https://www.rfc-editor.org/rfc/rfc9999.json';
const DT_URL = 'https://datatracker.ietf.org/doc/rfc9999/doc.json';

function options(
  overrides: Partial<RequestOptions<string>> = {},
  budget = makeBudget(),
): RequestOptions<string> {
  return {
    budget,
    profile: 'small',
    operation: 'test',
    accept: [200],
    expect: 'xml',
    maxBytes: 10_000,
    parse: (response) => response.body,
    ...overrides,
  };
}

/** Like {@link options}, but the parse step returns the accepted response itself. */
function raw(
  overrides: Partial<RequestOptions<UpstreamResponse>> = {},
  budget = makeBudget(),
): RequestOptions<UpstreamResponse> {
  return {
    budget,
    profile: 'small',
    operation: 'test',
    accept: [200],
    expect: 'xml',
    maxBytes: 10_000,
    parse: (response) => response,
    ...overrides,
  };
}

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

describe('single attempt: accept-lists', () => {
  it('returns a 200 with its body, byte count and headers', async () => {
    const h = createHarness([
      {
        match: IANA_URL,
        respond: xmlResponse('<registry/>', { 'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT' }),
      },
    ]);
    const response = await h.client.request(IANA_URL, raw());
    expect(response.status).toBe(200);
    expect(response.body).toBe('<registry/>');
    expect(response.bytes).toBe(11);
    expect(response.headers.get('last-modified')).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
  });

  it('returns an accepted 304 with an empty body', async () => {
    const h = createHarness([{ match: IANA_URL, respond: notModified() }]);
    const response = await h.client.request(IANA_URL, raw({ accept: [200, 304] }));
    expect(response).toMatchObject({ status: 304, body: '', bytes: 0 });
  });

  it('returns an accepted 404 with an empty body and does not check its content type', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: statusResponse(404, {}, '<html>Page not found</html>') },
    ]);
    const response = await h.client.request(IANA_URL, raw({ accept: [200, 404] }));
    expect(response).toMatchObject({ status: 404, body: '', bytes: 0 });
    expect(h.http.calls).toHaveLength(1);
  });

  it('treats a 304 as unreadable when the accept-list leaves it out', async () => {
    const h = createHarness([{ match: IANA_URL, respond: notModified() }]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data).toMatchObject({
      reason: 'upstream_unreadable',
      status: 304,
      host: 'www.iana.org',
    });
  });

  it('treats a 404 as unreadable on a fixed URL, retried like any unreadable answer', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: statusResponse(404, {}, 'Page not found') },
    ]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    expect(asMcpError(error).data).toMatchObject({ reason: 'upstream_unreadable', status: 404 });
    expect(h.http.calls).toHaveLength(3);
  });

  it('sends the User-Agent, merges extra headers and follows redirects', async () => {
    const h = createHarness([{ match: IANA_URL, respond: xmlResponse('<a/>') }]);
    await h.client.request(
      IANA_URL,
      options({ headers: { 'If-Modified-Since': 'Mon, 01 Jan 2026 00:00:00 GMT' } }),
    );
    const request = h.http.calls[0]?.request;
    expect(request?.headers.get('user-agent')).toContain('iana-registries-mcp-server-tests');
    expect(request?.headers.get('if-modified-since')).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
    expect(request?.redirect).toBe('follow');
    expect(request?.method).toBe('GET');
  });
});

describe('content-type check', () => {
  it.each([
    ['xml', 'application/xml'],
    ['xml', 'text/xml'],
    ['xml', 'Application/XML; charset=UTF-8'],
    ['text', 'text/plain; charset=utf-8'],
    ['json', 'application/json'],
    ['html', 'text/html; charset=utf-8'],
  ] as const)('accepts %s served as %s', async (expect_, contentType) => {
    const h = createHarness([
      {
        match: IANA_URL,
        respond: new Response('ok', { headers: { 'content-type': contentType } }),
      },
    ]);
    const body = await h.client.request(IANA_URL, options({ expect: expect_ }));
    expect(body).toBe('ok');
  });

  it.each([
    ['xml', htmlResponse('<html><title>Page not found</title></html>'), 'text/html'],
    ['text', htmlResponse('<html/>'), 'text/html'],
    ['json', htmlResponse('<html/>'), 'text/html'],
    ['html', textResponse('plain'), 'text/plain'],
    ['xml', jsonResponse({ a: 1 }), 'application/json'],
    ['json', textResponse('404 - Not found'), 'text/plain'],
  ] as const)(
    'rejects %s expected but %s…: an HTML or wrong-family page is unreadable',
    async (expected, response, served) => {
      const h = createHarness([{ match: IANA_URL, respond: response }]);
      const { error } = await settle(() =>
        h.client.request(IANA_URL, options({ expect: expected })),
      );
      const failure = asMcpError(error);
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(failure.data).toMatchObject({
        reason: 'upstream_unreadable',
        host: 'www.iana.org',
        url: IANA_URL,
        contentType: served,
      });
      expect(failure.message).toContain(`where ${expected} was expected`);
    },
  );

  it('names a missing content type', async () => {
    const h = createHarness([{ match: IANA_URL, respond: () => untypedResponse('<a/>') }]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    const failure = asMcpError(error);
    expect(failure.data).toMatchObject({ contentType: '' });
    expect(failure.message).toContain('no content type');
  });

  it('carries a caller-supplied reason instead of upstream_unreadable', async () => {
    const h = createHarness([{ match: IANA_URL, respond: htmlResponse('<html/>') }]);
    const { error } = await settle(() =>
      h.client.request(IANA_URL, options({ unreadableReason: 'index_unreadable' })),
    );
    expect(asMcpError(error).data).toMatchObject({ reason: 'index_unreadable' });
  });

  it('applies the caller reason to status and byte-ceiling failures too', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: () => statusResponse(403, {}, 'no') },
      { match: RFC_URL, respond: () => xmlResponse('x'.repeat(50)) },
    ]);
    const status = await settle(() =>
      h.client.request(IANA_URL, options({ unreadableReason: 'index_unreadable' })),
    );
    expect(asMcpError(status.error).data).toMatchObject({
      reason: 'index_unreadable',
      status: 403,
    });
    const size = await settle(() =>
      h.client.request(RFC_URL, options({ unreadableReason: 'index_unreadable', maxBytes: 10 })),
    );
    expect(asMcpError(size.error).data).toMatchObject({ reason: 'index_unreadable', maxBytes: 10 });
  });
});

describe('unread bodies are released', () => {
  const getOptions = {
    accept: [200, 404] as const,
    expect: 'xml' as const,
    maxBytes: 100,
    timeoutMs: 10_000,
  };

  it.each([
    ['a wrong content type', 200, 'text/html'],
    ['an accepted 404', 404, 'text/html'],
    ['an unaccepted status', 403, 'text/html'],
    ['a retryable status', 503, 'text/html'],
  ])('cancels the stream for %s instead of leaving it open', async (_name, status, contentType) => {
    let cancelled = 0;
    const h = createHarness([
      {
        match: IANA_URL,
        respond: () => {
          const response = streamResponse(
            [new Uint8Array(10).fill(0x61), new Uint8Array(10).fill(0x61)],
            contentType,
            () => cancelled++,
          );
          return new Response(response.body, { status, headers: response.headers });
        },
      },
    ]);
    await h.client
      .get(IANA_URL, { ...getOptions, signal: new AbortController().signal })
      .catch(() => undefined);
    expect(cancelled).toBe(1);
  });
});

describe('byte ceiling', () => {
  it('accepts a body exactly at the ceiling', async () => {
    const h = createHarness([{ match: IANA_URL, respond: xmlResponse('x'.repeat(100)) }]);
    const response = await h.client.request(IANA_URL, raw({ maxBytes: 100 }));
    expect(response.bytes).toBe(100);
  });

  it('rejects a body one byte over the ceiling, with the ceiling and URL in the error', async () => {
    const h = createHarness([{ match: IANA_URL, respond: xmlResponse('x'.repeat(101)) }]);
    const { error } = await settle(() => h.client.request(IANA_URL, options({ maxBytes: 100 })));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data).toMatchObject({
      reason: 'upstream_unreadable',
      maxBytes: 100,
      url: IANA_URL,
    });
  });

  it('cancels the stream as soon as the ceiling is crossed instead of draining it', async () => {
    let cancelled = 0;
    const chunk = new Uint8Array(40).fill(0x61);
    const h = createHarness([
      {
        match: IANA_URL,
        respond: () =>
          streamResponse([chunk, chunk, chunk, chunk, chunk], 'application/xml', () => cancelled++),
      },
    ]);
    const error = asMcpError(
      await thrown(() =>
        h.client.get(IANA_URL, {
          accept: [200],
          expect: 'xml',
          maxBytes: 100,
          signal: new AbortController().signal,
          timeoutMs: 10_000,
        }),
      ),
    );
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', maxBytes: 100 });
    expect(cancelled).toBe(1);
  });

  it('counts decoded bytes, not characters', async () => {
    const h = createHarness([{ match: IANA_URL, respond: xmlResponse('é'.repeat(10)) }]);
    const ok = await h.client.request(IANA_URL, raw({ maxBytes: 20 }));
    expect(ok.bytes).toBe(20);
    const tooBig = await settle(() => h.client.request(IANA_URL, options({ maxBytes: 19 })));
    expect(asMcpError(tooBig.error).data).toMatchObject({ maxBytes: 19 });
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('<a>é€</a>');
    const split = bytes.indexOf(0xc3) + 1;
    const h = createHarness([
      {
        match: IANA_URL,
        respond: () => streamResponse([bytes.slice(0, split), bytes.slice(split)]),
      },
    ]);
    expect(await h.client.request(IANA_URL, options())).toBe('<a>é€</a>');
  });

  it('reads an empty 200 as an empty body', async () => {
    const h = createHarness([
      {
        match: IANA_URL,
        respond: new Response(null, { headers: { 'content-type': 'application/xml' } }),
      },
    ]);
    expect(await h.client.request(IANA_URL, options())).toBe('');
  });
});

describe('network failures and HTTP errors', () => {
  it('wraps a fetch rejection as a transient ServiceUnavailable naming the host, after 3 attempts', async () => {
    const h = createHarness([
      {
        match: IANA_URL,
        respond: () => {
          throw new TypeError('connection reset');
        },
      },
    ]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.message).toContain('Request to www.iana.org failed: connection reset');
    expect(failure.data).toMatchObject({ host: 'www.iana.org', retryAttempts: 3 });
    expect(h.http.calls).toHaveLength(3);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'retries HTTP %i and surfaces it after 3 attempts',
    async (status) => {
      const h = createHarness([
        { match: IANA_URL, respond: () => statusResponse(status, {}, 'busy') },
      ]);
      const { error } = await settle(() => h.client.request(IANA_URL, options()));
      const failure = asMcpError(error);
      expect(failure.data).toMatchObject({ status, retryAttempts: 3 });
      expect(failure.data?.reason).not.toBe('upstream_unreadable');
      expect(h.http.calls).toHaveLength(3);
    },
  );

  it('recovers when a later attempt succeeds', async () => {
    const answers = [statusResponse(503), statusResponse(502), xmlResponse('<ok/>')];
    const h = createHarness([
      { match: IANA_URL, respond: () => answers.shift() ?? xmlResponse('<extra/>') },
    ]);
    const { value } = await settle(() => h.client.request(IANA_URL, options()));
    expect(value).toBe('<ok/>');
    expect(h.http.calls).toHaveLength(3);
  });

  it('honors a Retry-After inside the ladder instead of the exponential delay', async () => {
    const answers = [statusResponse(429, { 'retry-after': '3' }), xmlResponse('<ok/>')];
    const h = createHarness([
      { match: IANA_URL, respond: () => answers.shift() ?? xmlResponse('<extra/>') },
    ]);
    let value: string | undefined;
    h.client.request(IANA_URL, options()).then((v) => {
      value = v;
    });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(h.http.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(value).toBe('<ok/>');
    expect(h.http.calls).toHaveLength(2);
  });

  it('fails fast with the 429 and its Retry-After when the wait cannot fit the ladder', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: () => statusResponse(429, { 'retry-after': '120' }) },
    ]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(failure.data).toMatchObject({ status: 429, retryAfter: '120' });
    expect(h.http.calls).toHaveLength(1);
  });

  it('does not capture the upstream error body', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: () => statusResponse(500, {}, 'SECRET-UPSTREAM-DETAIL') },
    ]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    expect(JSON.stringify(asMcpError(error).data)).not.toContain('SECRET-UPSTREAM-DETAIL');
  });
});

describe('parse inside the retry boundary', () => {
  it('retries a parse that throws a transient error, then returns the next parse', async () => {
    const bodies = ['<broken', '<ok/>'];
    const h = createHarness([
      { match: IANA_URL, respond: () => xmlResponse(bodies.shift() ?? '<ok/>') },
    ]);
    const { value } = await settle(() =>
      h.client.request(
        IANA_URL,
        options({
          parse: (response) => {
            if (response.body === '<broken')
              throw upstreamUnreadable('malformed', { url: IANA_URL });
            return response.body;
          },
        }),
      ),
    );
    expect(value).toBe('<ok/>');
    expect(h.http.calls).toHaveLength(2);
  });

  it('does not retry a parse that opts out with retryable: false', async () => {
    const h = createHarness([{ match: IANA_URL, respond: () => xmlResponse('<a/>') }]);
    const { error } = await settle(() =>
      h.client.request(
        IANA_URL,
        options({
          parse: () => {
            throw upstreamUnreadable('under the floor', { retryable: false });
          },
        }),
      ),
    );
    expect(asMcpError(error).data).toMatchObject({
      reason: 'upstream_unreadable',
      retryable: false,
    });
    expect(h.http.calls).toHaveLength(1);
  });
});

describe('per-attempt timer', () => {
  it('get() throws a transient Timeout naming the host when the timer fires', async () => {
    const h = createHarness([{ match: IANA_URL, respond: hang }]);
    const pending = thrown(() =>
      h.client.get(IANA_URL, {
        accept: [200],
        expect: 'xml',
        maxBytes: 100,
        signal: new AbortController().signal,
        timeoutMs: 200,
      }),
    );
    await vi.advanceTimersByTimeAsync(200);
    const failure = asMcpError(await pending);
    expect(failure.code).toBe(JsonRpcErrorCode.Timeout);
    expect(failure.data).toMatchObject({ host: 'www.iana.org', timeoutMs: 200 });
  });

  it('get() clears the timer once the body is read', async () => {
    const h = createHarness([{ match: IANA_URL, respond: xmlResponse('<a/>') }]);
    await h.client.get(IANA_URL, {
      accept: [200],
      expect: 'xml',
      maxBytes: 100,
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('get() propagates a caller abort unchanged instead of calling it a timeout', async () => {
    const h = createHarness([{ match: IANA_URL, respond: hang }]);
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = thrown(() =>
      h.client.get(IANA_URL, {
        accept: [200],
        expect: 'xml',
        maxBytes: 100,
        signal: controller.signal,
        timeoutMs: 10_000,
      }),
    );
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a small-profile attempt times out at 10 s and retries; a bulk attempt at 30 s', async () => {
    const small = createHarness([{ match: IANA_URL, respond: hang }]);
    small.client.request(IANA_URL, options({ profile: 'small' })).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(small.http.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(small.http.calls).toHaveLength(2);

    const bulk = createHarness([{ match: RFC_URL, respond: hang }]);
    bulk.client.request(RFC_URL, options({ profile: 'bulk' })).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(29_900);
    expect(bulk.http.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bulk.http.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it('a timed-out ladder ends in the ladder deadline, a Timeout with retry_deadline_exceeded', async () => {
    const h = createHarness([{ match: IANA_URL, respond: hang }]);
    const { error } = await settle(() => h.client.request(IANA_URL, options({ profile: 'small' })));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.Timeout);
    expect(failure.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 20_000 });
  });
});

describe('the one per-call budget', () => {
  it('rejects at once when the budget is already spent, without fetching', async () => {
    const h = createHarness([{ match: IANA_URL, respond: xmlResponse('<a/>') }]);
    const budget = makeBudget(100);
    vi.advanceTimersByTime(100);
    const error = asMcpError(await thrown(() => h.client.request(IANA_URL, options({}, budget))));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 100 });
    expect(h.http.calls).toHaveLength(0);
  });

  it('caps a ladder at what the budget has left, not at the profile deadline', async () => {
    const h = createHarness([{ match: IANA_URL, respond: hang }]);
    const budget = makeBudget(3_000);
    const started = Date.now();
    const { error } = await settle(() =>
      h.client.request(IANA_URL, options({ profile: 'bulk' }, budget)),
    );
    expect(asMcpError(error).data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      deadlineMs: 3_000,
    });
    expect(Date.now() - started).toBeLessThanOrEqual(3_250);
  });

  it('shares one budget across consecutive ladders: the second sees only what the first left', async () => {
    const h = createHarness([
      {
        match: IANA_URL,
        respond: async () => {
          await new Promise((resolve) => setTimeout(resolve, 700));
          return xmlResponse('<a/>');
        },
      },
      { match: RFC_URL, respond: hang },
    ]);
    const budget = makeBudget(1_000);
    const first = await settle(() =>
      h.client.request(IANA_URL, options({ profile: 'bulk' }, budget)),
    );
    expect(first.value).toBe('<a/>');
    const startedSecond = Date.now();
    const second = await settle(() =>
      h.client.request(RFC_URL, options({ profile: 'bulk' }, budget)),
    );
    const failure = asMcpError(second.error);
    expect(failure.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
    expect(Date.now() - startedSecond).toBeLessThanOrEqual(500);
  });

  it('charges pacer queue time to the budget: a start gap past the budget is shed, never retried', async () => {
    const h = createHarness([{ match: IANA_URL, respond: () => xmlResponse('<a/>') }], {
      pacing: { iana: { name: 'iana', maxConcurrent: 1, minStartGapMs: 5_000 } },
    });
    const budget = makeBudget(300);
    const first = await h.client.request(IANA_URL, options({}, budget));
    expect(first).toBe('<a/>');
    const error = asMcpError(await thrown(() => h.client.request(IANA_URL, options({}, budget))));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'pacer_shed' });
    expect(h.http.calls).toHaveLength(1);
  });

  it('a caller abort rejects with the signal reason and ends the ladder without another attempt', async () => {
    const h = createHarness([{ match: IANA_URL, respond: hang }]);
    const controller = new AbortController();
    const reason = new Error('client closed the request');
    const pending = thrown(() =>
      h.client.request(IANA_URL, options({}, makeBudget(45_000, controller.signal))),
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.http.calls).toHaveLength(1);
  });
});

describe('per-host pacing', () => {
  it('spaces IANA starts by the 500 ms gap', async () => {
    const starts: number[] = [];
    const h = createHarness(
      [
        {
          match: /iana\.org/,
          respond: () => {
            starts.push(Date.now());
            return xmlResponse('<a/>');
          },
        },
      ],
      { pacing: undefined },
    );
    const calls = [1, 2, 3].map(() => h.client.request(IANA_URL, options()));
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(calls);
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(DEFAULT_PACING.iana.minStartGapMs ?? 0);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(DEFAULT_PACING.iana.minStartGapMs ?? 0);
  });

  it('keeps one pacer per host: a busy IANA queue does not delay RFC Editor or Datatracker starts', async () => {
    const starts: Record<string, number[]> = {};
    const record = (key: string) => () => {
      starts[key] = [...(starts[key] ?? []), Date.now()];
      return key === 'rfc'
        ? jsonResponse({ ok: 1 })
        : key === 'dt'
          ? jsonResponse({ ok: 2 })
          : xmlResponse('<a/>');
    };
    const h = createHarness(
      [
        { match: /iana\.org/, respond: record('iana') },
        { match: /rfc-editor\.org/, respond: record('rfc') },
        { match: /datatracker/, respond: record('dt') },
      ],
      { pacing: undefined },
    );
    const t0 = Date.now();
    const calls = [
      h.client.request(IANA_URL, options()),
      h.client.request(IANA_URL, options()),
      h.client.request(RFC_URL, options({ expect: 'json' })),
      h.client.request(DT_URL, options({ expect: 'json' })),
    ];
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.all(calls);
    const [firstIana = 0, secondIana = 0] = starts.iana ?? [];
    expect(secondIana - firstIana).toBeGreaterThanOrEqual(500);
    expect(starts.rfc?.[0]).toBe(t0);
    expect(starts.dt?.[0]).toBe(t0);
  });

  it('applies the documented default pacing to each host', () => {
    expect(DEFAULT_PACING.iana).toMatchObject({
      maxConcurrent: 2,
      minStartGapMs: 500,
      limits: [{ requests: 30, perMs: 60_000 }],
    });
    expect(DEFAULT_PACING['rfc-editor']).toMatchObject({
      maxConcurrent: 3,
      minStartGapMs: 100,
      limits: [{ requests: 60, perMs: 60_000 }],
    });
    expect(DEFAULT_PACING.datatracker).toMatchObject({
      maxConcurrent: 2,
      minStartGapMs: 250,
      limits: [{ requests: 60, perMs: 60_000 }],
    });
  });

  it('rejects a host with no pacer rather than fetching it', async () => {
    const h = createHarness([{ match: /./, respond: xmlResponse('<a/>') }]);
    const call = async () => h.client.request('https://example.org/x.xml', options());
    const error = await thrown(call);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('example.org');
    expect(h.http.calls).toHaveLength(0);
  });

  it('reports an unconfigured host as a rejected promise, never a synchronous throw', async () => {
    const h = createHarness([{ match: /./, respond: xmlResponse('<a/>') }]);
    let pending: Promise<string> | undefined;
    expect(() => {
      pending = h.client.request('https://example.org/x', options());
    }).not.toThrow();
    await expect(pending).rejects.toThrow('example.org');
    expect(h.http.calls).toHaveLength(0);
  });

  it('dispose() rejects callers still queued behind the pacer', async () => {
    const h = createHarness([{ match: IANA_URL, respond: () => xmlResponse('<a/>') }], {
      pacing: { iana: { name: 'iana', maxConcurrent: 1, minStartGapMs: 10_000 } },
    });
    await h.client.request(IANA_URL, options());
    const queued = thrown(() => h.client.request(IANA_URL, options()));
    await vi.advanceTimersByTimeAsync(50);
    h.client.dispose();
    const error = asMcpError(await queued);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(h.http.calls).toHaveLength(1);
  });

  it('constructs with no fetch option and no pacing override', () => {
    const client = new UpstreamClient({ userAgent: 'x' });
    client.dispose();
  });
});

describe('upstreamUnreadable', () => {
  it('is a ServiceUnavailable with the reason merged into the data', () => {
    const error = upstreamUnreadable('bad', { url: 'u' });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ url: 'u', reason: 'upstream_unreadable' });
  });

  it('takes a reason override and a cause', () => {
    const cause = new Error('inner');
    const error = upstreamUnreadable('bad', {}, { reason: 'index_unreadable', cause });
    expect(error.data).toMatchObject({ reason: 'index_unreadable' });
    expect(error.cause).toBe(cause);
  });
});
