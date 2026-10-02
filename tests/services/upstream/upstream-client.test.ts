/**
 * @fileoverview Tests for `UpstreamClient`: accept-lists (304/404 as results),
 * redirects the client follows itself (https upgrade on the upstream hosts,
 * off-host refusal, hop limit, each hop paced and budgeted), the content-type
 * check, byte ceilings, the per-attempt timer, the retry ladder, per-host
 * pacing, and the one per-call budget across ladders and pacer waits, with its
 * per-host request allowance. Upstream I/O is a `createFetchMock` fake; timing
 * runs on fake timers with jitter pinned.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallBudget, createCallBudget } from '@/services/upstream/call-budget.js';
import {
  DATATRACKER_CALL_REQUESTS,
  DEFAULT_PACING,
  type RequestOptions,
  UpstreamClient,
  type UpstreamHost,
  type UpstreamResponse,
  upstreamUnreadable,
} from '@/services/upstream/upstream-client.js';
import {
  asMcpError,
  BODY_OVER_CEILING_HINT,
  createHarness,
  hang,
  htmlResponse,
  jsonResponse,
  makeBudget,
  notModified,
  PERMISSIVE_PACING,
  REDIRECT_LIMIT_HINT,
  REDIRECT_OFF_HOST_HINT,
  redirectResponse,
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

  it('sends the User-Agent, merges extra headers and follows no redirect inside fetch', async () => {
    const h = createHarness([{ match: IANA_URL, respond: xmlResponse('<a/>') }]);
    await h.client.request(
      IANA_URL,
      options({ headers: { 'If-Modified-Since': 'Mon, 01 Jan 2026 00:00:00 GMT' } }),
    );
    const request = h.http.calls[0]?.request;
    expect(request?.headers.get('user-agent')).toContain('iana-registries-mcp-server-tests');
    expect(request?.headers.get('if-modified-since')).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
    expect(request?.redirect).toBe('manual');
    expect(request?.method).toBe('GET');
  });
});

describe('redirects', () => {
  const MOVED = 'https://www.iana.org/assignments/example/moved.xml';
  /** The address-literal-tags registry file, which IANA redirects to the SMTP registry over plain http. */
  const LITERAL_TAGS =
    'https://www.iana.org/assignments/address-literal-tags/address-literal-tags.xml';
  const SMTP = 'https://www.iana.org/assignments/smtp/smtp.xml';
  /** How a refused redirect names a target carrying a username or password, which it never echoes. */
  const CREDENTIALS = 'a URL with a username or password';

  it.each([301, 302, 303, 307, 308])(
    'follows a %i itself, sending each hop with redirect: manual',
    async (status) => {
      const h = createHarness([
        { match: IANA_URL, respond: () => redirectResponse(MOVED, status) },
        { match: MOVED, respond: () => xmlResponse('<moved/>') },
      ]);
      await expect(h.client.request(IANA_URL, options())).resolves.toBe('<moved/>');
      expect(h.urls()).toEqual([IANA_URL, MOVED]);
      expect(h.http.calls.map((call) => call.request.redirect)).toEqual(['manual', 'manual']);
    },
  );

  it.each([
    ['an absolute path', '/assignments/smtp/smtp.xml', SMTP],
    ['a sibling file', 'moved.xml', MOVED],
    ['a parent path', '../smtp/smtp.xml', 'https://www.iana.org/assignments/smtp/smtp.xml'],
    ['a scheme-relative URL', '//www.iana.org/assignments/smtp/smtp.xml', SMTP],
    ['a query string', '?format=xml', `${IANA_URL}?format=xml`],
  ])('resolves %s against the request URL', async (_label, location, target) => {
    const h = createHarness([
      { match: IANA_URL, respond: () => redirectResponse(location, 302) },
      { match: target, respond: () => xmlResponse('<moved/>') },
    ]);
    await expect(h.client.request(IANA_URL, options())).resolves.toBe('<moved/>');
    expect(h.urls()).toEqual([IANA_URL, target]);
  });

  it('upgrades a plain-http redirect on www.iana.org to https before sending anything', async () => {
    const h = createHarness([
      {
        match: LITERAL_TAGS,
        respond: () => redirectResponse('http://www.iana.org/assignments/smtp/smtp.xml'),
      },
      { match: SMTP, respond: () => xmlResponse('<smtp/>') },
      { match: /^http:/, respond: () => xmlResponse('<plain-http/>') },
    ]);
    await expect(h.client.request(LITERAL_TAGS, options())).resolves.toBe('<smtp/>');
    expect(h.urls()).toEqual([LITERAL_TAGS, SMTP]);
    expect(h.urls().filter((url) => url.startsWith('http:'))).toEqual([]);
  });

  it.each([
    ['within www.rfc-editor.org', RFC_URL, 'https://www.rfc-editor.org/rfc/rfc9999.json?moved'],
    ['within datatracker.ietf.org', DT_URL, 'https://datatracker.ietf.org/doc/rfc9999/'],
    ['to another upstream host', DT_URL, 'https://www.rfc-editor.org/rfc/rfc9999.json'],
    [
      'over plain http on www.rfc-editor.org',
      RFC_URL,
      'http://www.rfc-editor.org/rfc/rfc9999.json?moved',
    ],
    [
      'over plain http on datatracker.ietf.org',
      DT_URL,
      'http://datatracker.ietf.org/doc/rfc9999/doc.json?moved',
    ],
    ['over plain http to another upstream host', RFC_URL, 'http://www.iana.org/assignments/x.xml'],
  ])('follows a redirect %s, over https', async (_label, from, to) => {
    const target = to.replace(/^http:/, 'https:');
    const h = createHarness([
      { match: from, respond: () => redirectResponse(to) },
      { match: target, respond: () => xmlResponse('<a/>') },
    ]);
    await expect(h.client.request(from, options())).resolves.toBe('<a/>');
    expect(h.urls()).toEqual([from, target]);
  });

  it.each([
    ['another host', IANA_URL, 'https://evil.example/registry.xml', 'https://evil.example'],
    [
      'plain http on another host',
      IANA_URL,
      'http://evil.example/registry.xml',
      'http://evil.example',
    ],
    [
      'a look-alike host',
      RFC_URL,
      'https://www.rfc-editor.org.evil.example/rfc9999.json',
      'https://www.rfc-editor.org.evil.example',
    ],
    [
      'a sub-domain of an upstream host',
      DT_URL,
      'https://x.datatracker.ietf.org/doc.json',
      'https://x.datatracker.ietf.org',
    ],
    [
      'a host named like an object key',
      DT_URL,
      'https://constructor/doc.json',
      'https://constructor',
    ],
    [
      'another host behind credentials naming an upstream host',
      IANA_URL,
      'https://www.iana.org:secret@evil.example/x.xml',
      'https://evil.example',
    ],
    ['an ftp URL on an upstream host', IANA_URL, 'ftp://www.iana.org/x.xml', 'ftp://www.iana.org'],
    ['a javascript: URL', IANA_URL, 'javascript:alert(1)', 'a javascript: URL'],
    ['an unparseable URL', IANA_URL, 'https://[www.iana.org/x.xml', 'an unparseable URL'],
  ])(
    'refuses a redirect to %s after one request: not retryable, with a hint that does not say to retry',
    async (_label, from, to, shown) => {
      const h = createHarness([{ match: from, respond: () => redirectResponse(to) }]);
      const { error } = await settle(() => h.client.request(from, options()));
      const failure = asMcpError(error);
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(failure.data).toMatchObject({
        reason: 'upstream_unreadable',
        retryable: false,
        url: from,
        redirectedTo: shown,
        recovery: { hint: REDIRECT_OFF_HOST_HINT },
      });
      expect(failure.message).toBe(
        `${new URL(from).hostname} redirected ${from} to ${shown}, outside the https upstream hosts this server reads.`,
      );
      expect(REDIRECT_OFF_HOST_HINT).not.toMatch(/retry/i);
      expect(h.urls()).toEqual([from]);
    },
  );

  it.each([
    ['a username', 'https://user@www.iana.org/assignments/smtp/smtp.xml', CREDENTIALS],
    [
      'a username and password',
      'https://user:secret@www.iana.org/assignments/smtp/smtp.xml',
      CREDENTIALS,
    ],
    ['a password alone', 'https://:secret@www.iana.org/assignments/smtp/smtp.xml', CREDENTIALS],
    [
      'credentials over plain http',
      'http://user:secret@www.iana.org/assignments/smtp/smtp.xml',
      CREDENTIALS,
    ],
    [
      'a non-default https port',
      'https://www.iana.org:8443/assignments/smtp/smtp.xml',
      'https://www.iana.org:8443',
    ],
    [
      'a non-default port over plain http',
      'http://www.iana.org:8080/assignments/smtp/smtp.xml',
      'http://www.iana.org:8080',
    ],
    [
      'port 80 over https',
      'https://www.iana.org:80/assignments/smtp/smtp.xml',
      'https://www.iana.org:80',
    ],
  ])(
    'refuses a redirect to an upstream-host URL with %s after one request, never echoing credentials',
    async (_label, location, shown) => {
      const h = createHarness([
        { match: IANA_URL, respond: () => redirectResponse(location) },
        { match: /./, respond: () => xmlResponse('<followed/>') },
      ]);
      const { error } = await settle(() => h.client.request(IANA_URL, options()));
      const failure = asMcpError(error);
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(failure.data).toMatchObject({
        reason: 'upstream_unreadable',
        retryable: false,
        url: IANA_URL,
        redirectedTo: shown,
        recovery: { hint: REDIRECT_OFF_HOST_HINT },
      });
      expect(failure.message).toBe(
        `www.iana.org redirected ${IANA_URL} to ${shown}, outside the https upstream hosts this server reads.`,
      );
      expect(`${failure.message} ${JSON.stringify(failure.data)}`).not.toMatch(/secret|user@/);
      expect(h.urls()).toEqual([IANA_URL]);
    },
  );

  it.each([
    ['port 80 over plain http', 'http://www.iana.org:80/assignments/smtp/smtp.xml'],
    ['port 443 over https', 'https://www.iana.org:443/assignments/smtp/smtp.xml'],
    ['port 443 over plain http', 'http://www.iana.org:443/assignments/smtp/smtp.xml'],
  ])('follows a redirect naming %s as the default https URL', async (_label, location) => {
    const h = createHarness([
      { match: IANA_URL, respond: () => redirectResponse(location) },
      { match: SMTP, respond: () => xmlResponse('<smtp/>') },
    ]);
    await expect(h.client.request(IANA_URL, options())).resolves.toBe('<smtp/>');
    expect(h.urls()).toEqual([IANA_URL, SMTP]);
  });

  it('hands parse the URL that answered: the request URL, or the last hop of a redirect chain', async () => {
    const h = createHarness([
      {
        match: LITERAL_TAGS,
        respond: () => redirectResponse('http://www.iana.org/assignments/smtp/smtp.xml'),
      },
      { match: SMTP, respond: () => xmlResponse('<smtp/>') },
      { match: IANA_URL, respond: () => redirectResponse(MOVED) },
      { match: MOVED, respond: () => notModified() },
      { match: RFC_URL, respond: () => jsonResponse({}) },
    ]);
    expect(await h.client.request(LITERAL_TAGS, raw())).toMatchObject({ status: 200, url: SMTP });
    expect(await h.client.request(IANA_URL, raw({ accept: [200, 304] }))).toMatchObject({
      status: 304,
      url: MOVED,
    });
    expect(await h.client.request(RFC_URL, raw({ expect: 'json' }))).toMatchObject({
      status: 200,
      url: RFC_URL,
    });
  });

  it('carries the caller reason on a refused redirect', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: () => redirectResponse('https://evil.example/') },
    ]);
    const { error } = await settle(() =>
      h.client.request(IANA_URL, options({ unreadableReason: 'index_unreadable' })),
    );
    expect(asMcpError(error).data).toMatchObject({ reason: 'index_unreadable', retryable: false });
  });

  it('refuses a redirect off the upstream hosts before reading its target, so a 404 there is never a miss', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: () => redirectResponse('https://evil.example/missing') },
      { match: 'https://evil.example/missing', respond: () => statusResponse(404) },
    ]);
    const { error } = await settle(() => h.client.request(IANA_URL, raw({ accept: [200, 404] })));
    expect(asMcpError(error).data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(h.urls()).toEqual([IANA_URL]);
  });

  /** `IANA_URL` redirecting through `count` hops, `…/hop-1.xml` to `…/hop-<count>.xml`, which answers XML. */
  function chain(count: number) {
    const hop = (index: number) =>
      index === 0 ? IANA_URL : `https://www.iana.org/assignments/example/hop-${index}.xml`;
    return {
      hops: Array.from({ length: count + 1 }, (_, index) => hop(index)),
      routes: Array.from({ length: count + 1 }, (_, index) => ({
        match: hop(index),
        respond: () =>
          index === count ? xmlResponse('<end/>') : redirectResponse(hop(index + 1), 307),
      })),
    };
  }

  it('follows a chain of five redirects', async () => {
    const { hops, routes } = chain(5);
    const h = createHarness(routes);
    await expect(h.client.request(IANA_URL, options())).resolves.toBe('<end/>');
    expect(h.urls()).toEqual(hops);
  });

  it('refuses a sixth redirect after six requests in one attempt: not retryable', async () => {
    const { hops, routes } = chain(6);
    const h = createHarness(routes);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data).toMatchObject({
      reason: 'upstream_unreadable',
      retryable: false,
      url: IANA_URL,
      maxRedirects: 5,
      recovery: { hint: REDIRECT_LIMIT_HINT },
    });
    expect(failure.message).toBe(
      `${IANA_URL} redirected more than 5 times; this server follows at most 5.`,
    );
    expect(REDIRECT_LIMIT_HINT).not.toMatch(/retry/i);
    expect(h.urls()).toEqual(hops.slice(0, 6));
  });

  it('sends the User-Agent and the caller headers on every hop', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: () => redirectResponse(MOVED) },
      { match: MOVED, respond: () => notModified() },
    ]);
    const response = await h.client.request(
      IANA_URL,
      raw({
        accept: [200, 304],
        headers: { 'If-Modified-Since': 'Mon, 01 Jan 2026 00:00:00 GMT' },
      }),
    );
    expect(response.status).toBe(304);
    for (const { request } of h.http.calls) {
      expect(request.headers.get('user-agent')).toContain('iana-registries-mcp-server-tests');
      expect(request.headers.get('if-modified-since')).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
    }
  });

  it('restarts from the first URL when a later hop fails transiently', async () => {
    let movedCalls = 0;
    const h = createHarness([
      { match: IANA_URL, respond: () => redirectResponse(MOVED) },
      {
        match: MOVED,
        respond: () => (++movedCalls === 1 ? statusResponse(503) : xmlResponse('<moved/>')),
      },
    ]);
    const { value } = await settle(() => h.client.request(IANA_URL, options()));
    expect(value).toBe('<moved/>');
    expect(h.urls()).toEqual([IANA_URL, MOVED, IANA_URL, MOVED]);
  });

  it('reads a 3xx without a Location as an unexpected status, retried like any unreadable answer', async () => {
    const h = createHarness([{ match: IANA_URL, respond: () => statusResponse(301) }]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    expect(asMcpError(error).data).toMatchObject({ reason: 'upstream_unreadable', status: 301 });
    expect(asMcpError(error).data).not.toHaveProperty('retryable');
    expect(h.http.calls).toHaveLength(3);
  });

  it('releases the body of a redirect it follows', async () => {
    let cancelled = 0;
    const h = createHarness([
      {
        match: IANA_URL,
        respond: () => {
          const body = streamResponse(
            [new Uint8Array(10).fill(0x61)],
            'text/html',
            () => cancelled++,
          );
          return new Response(body.body, { status: 301, headers: { location: MOVED } });
        },
      },
      { match: MOVED, respond: () => xmlResponse('<moved/>') },
    ]);
    await h.client.request(IANA_URL, options());
    expect(cancelled).toBe(1);
  });

  it('paces every hop on its host: the hop waits the IANA start gap', async () => {
    const starts: number[] = [];
    const h = createHarness(
      [
        {
          match: /iana\.org/,
          respond: (request: Request) => {
            starts.push(Date.now());
            return request.url === IANA_URL ? redirectResponse(MOVED) : xmlResponse('<a/>');
          },
        },
      ],
      { pacing: undefined },
    );
    const pending = h.client.request(IANA_URL, options());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe('<a/>');
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(DEFAULT_PACING.iana.minStartGapMs ?? 0);
  });

  it("paces a hop to another host on that host's pacer, never on the first URL's", async () => {
    const DT_MOVED = 'https://datatracker.ietf.org/doc/rfc9999/moved.json';
    const datatrackerGap = DEFAULT_PACING.datatracker.minStartGapMs ?? 0;
    // The RFC Editor gap is the shorter one, so a hop paced on the first URL's host starts too soon.
    expect(DEFAULT_PACING['rfc-editor'].minStartGapMs ?? 0).toBeLessThan(datatrackerGap);
    const starts: Record<'hop' | 'prime' | 'rfc', number[]> = { hop: [], prime: [], rfc: [] };
    const h = createHarness(
      [
        {
          match: DT_URL,
          respond: () => {
            starts.prime.push(Date.now());
            return jsonResponse({});
          },
        },
        {
          match: RFC_URL,
          respond: () => {
            starts.rfc.push(Date.now());
            return redirectResponse(DT_MOVED);
          },
        },
        {
          match: DT_MOVED,
          respond: () => {
            starts.hop.push(Date.now());
            return jsonResponse({});
          },
        },
      ],
      { pacing: undefined },
    );
    const calls = [
      h.client.request(DT_URL, options({ expect: 'json' })),
      h.client.request(RFC_URL, options({ expect: 'json' })),
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(calls);
    expect(starts.rfc).toEqual(starts.prime);
    expect(starts.hop).toHaveLength(1);
    expect(starts.hop[0]! - starts.prime[0]!).toBeGreaterThanOrEqual(datatrackerGap);
  });

  it.each([
    ['in flight', PERMISSIVE_PACING, [IANA_URL, MOVED]],
    ['queued behind the IANA start gap', undefined, [IANA_URL]],
  ] as const)(
    'a caller abort while the second hop is %s rejects as cancelled and sends nothing more',
    async (_label, pacing, sent) => {
      const h = createHarness(
        [
          { match: IANA_URL, respond: () => redirectResponse(MOVED) },
          { match: MOVED, respond: hang },
        ],
        { pacing },
      );
      const controller = new AbortController();
      const pending = thrown(() =>
        h.client.request(IANA_URL, options({}, makeBudget(45_000, controller.signal))),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(h.urls()).toEqual(sent);
      controller.abort();
      const error = await pending;
      expect(error).toBe(controller.signal.reason);
      expect((error as Error).name).toBe('AbortError');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.urls()).toEqual(sent);
    },
  );

  it("takes one request per hop from the budget's allowance for the hop's host", async () => {
    const DT_MOVED = 'https://datatracker.ietf.org/doc/rfc9999/moved.json';
    const allowing = (requests: Partial<Record<UpstreamHost, number>>) =>
      createCallBudget({
        totalMs: 45_000,
        signal: new AbortController().signal,
        context: requestContextService.createRequestContext({ operation: 'test' }),
        requests,
      });
    const h = createHarness([
      { match: DT_URL, respond: () => redirectResponse(DT_MOVED) },
      { match: DT_MOVED, respond: () => jsonResponse({}) },
      { match: RFC_URL, respond: () => redirectResponse(DT_URL) },
    ]);

    const capped = await settle(() =>
      h.client.request(DT_URL, options({ expect: 'json' }, allowing({ datatracker: 1 }))),
    );
    expect(asMcpError(capped.error).data).toMatchObject({ reason: 'request_limit' });
    expect(h.urls()).toEqual([DT_URL]);

    const budget = allowing({ datatracker: 2 });
    await h.client.request(RFC_URL, options({ expect: 'json' }, budget));
    expect(budget.requests).toEqual({ datatracker: 0 });
  });

  it('runs every hop inside the call budget: a hop that never answers ends in the ladder deadline', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: () => redirectResponse(MOVED) },
      { match: MOVED, respond: hang },
    ]);
    const started = Date.now();
    const { error } = await settle(() =>
      h.client.request(IANA_URL, options({ profile: 'bulk' }, makeBudget(1_000))),
    );
    expect(asMcpError(error).data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      deadlineMs: 1_000,
    });
    expect(h.urls()).toEqual([IANA_URL, MOVED]);
    expect(Date.now() - started).toBeLessThanOrEqual(1_250);
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

  it('fails a wrong content type on the first answer, leaving retryable off: the page can clear before a later call', async () => {
    const h = createHarness([
      { match: IANA_URL, respond: () => htmlResponse('<html>maintenance</html>') },
    ]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.message).toBe('www.iana.org answered with text/html where xml was expected.');
    expect(failure.data).toMatchObject({ reason: 'upstream_unreadable', contentType: 'text/html' });
    expect(failure.data).not.toHaveProperty('retryable');
    expect(failure.data).not.toHaveProperty('recovery');
    expect(failure.data).not.toHaveProperty('retryAttempts');
    expect(h.http.calls).toHaveLength(1);

    await settle(() => h.client.request(IANA_URL, options()));
    expect(h.http.calls).toHaveLength(2);
  });

  it('fails a wrong content type at the end of a redirect after one pass through the chain', async () => {
    const moved = 'https://www.iana.org/assignments/example/moved.xml';
    const h = createHarness([
      { match: IANA_URL, respond: () => redirectResponse(moved) },
      { match: moved, respond: () => htmlResponse('<html/>') },
    ]);
    const { error } = await settle(() => h.client.request(IANA_URL, options()));
    expect(asMcpError(error).data).toMatchObject({ url: moved, contentType: 'text/html' });
    expect(h.urls()).toEqual([IANA_URL, moved]);
  });

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

  it('fails a body over the ceiling on the first answer: not retryable, with a hint that does not say to retry', async () => {
    const h = createHarness([{ match: IANA_URL, respond: () => xmlResponse('x'.repeat(101)) }]);
    const { error } = await settle(() => h.client.request(IANA_URL, options({ maxBytes: 100 })));
    const failure = asMcpError(error);
    expect(failure.message).toBe(`www.iana.org sent more than 100 bytes for ${IANA_URL}.`);
    expect(failure.data).toMatchObject({
      reason: 'upstream_unreadable',
      retryable: false,
      recovery: { hint: BODY_OVER_CEILING_HINT },
    });
    expect(failure.data).not.toHaveProperty('retryAttempts');
    expect(BODY_OVER_CEILING_HINT).not.toMatch(/retry/i);
    expect(h.http.calls).toHaveLength(1);
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

describe("the budget's per-host request allowance", () => {
  /** A 45 s budget that may start `requests` requests per host. */
  const allowing = (requests: Partial<Record<UpstreamHost, number>>) =>
    createCallBudget({
      totalMs: 45_000,
      signal: new AbortController().signal,
      context: requestContextService.createRequestContext({ operation: 'test' }),
      requests,
    });
  const json = (budget: CallBudget) => options({ expect: 'json' }, budget);

  it('takes one request per attempt, retries included, and refuses once none is left', async () => {
    const h = createHarness([{ match: DT_URL, respond: () => statusResponse(503) }]);
    const budget = allowing({ datatracker: 4 });

    const first = await settle(() => h.client.request(DT_URL, json(budget)));
    expect(asMcpError(first.error).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(h.http.calls).toHaveLength(3);

    const second = await settle(() => h.client.request(DT_URL, json(budget)));
    const refused = asMcpError(second.error);
    expect(refused.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(refused.data).toMatchObject({
      reason: 'request_limit',
      host: 'datatracker.ietf.org',
      retryable: false,
    });
    expect(h.http.calls).toHaveLength(4);

    const third = await settle(() => h.client.request(DT_URL, json(budget)));
    expect(asMcpError(third.error).data).toMatchObject({ reason: 'request_limit' });
    expect(h.http.calls).toHaveLength(4);
  });

  it('bounds only the hosts it names', async () => {
    const h = createHarness([
      { match: DT_URL, respond: () => jsonResponse({}) },
      { match: RFC_URL, respond: () => jsonResponse({}) },
    ]);
    const budget = allowing({ datatracker: 1 });
    await h.client.request(DT_URL, json(budget));
    for (let index = 0; index < 5; index++) await h.client.request(RFC_URL, json(budget));
    expect(
      asMcpError(await thrown(() => h.client.request(DT_URL, json(budget)))).data,
    ).toMatchObject({ reason: 'request_limit' });
    expect(h.http.calls).toHaveLength(6);
  });

  it('counts down its own copy, leaving the object it was given untouched', async () => {
    const h = createHarness([{ match: DT_URL, respond: () => jsonResponse({}) }]);
    const allowance = { datatracker: 2 };
    const budget = allowing(allowance);
    await h.client.request(DT_URL, json(budget));
    expect(allowance).toEqual({ datatracker: 2 });
    expect(budget.requests).toEqual({ datatracker: 1 });
  });

  it('is unbounded when the budget names no allowance', async () => {
    const h = createHarness([{ match: DT_URL, respond: () => jsonResponse({}) }]);
    const budget = makeBudget();
    for (let index = 0; index < 30; index++) await h.client.request(DT_URL, json(budget));
    expect(h.http.calls).toHaveLength(30);
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

  it('allows one call a third of the Datatracker pacer: 20 requests', () => {
    expect(DATATRACKER_CALL_REQUESTS).toBe(20);
    expect(DATATRACKER_CALL_REQUESTS * 3).toBe(DEFAULT_PACING.datatracker.limits?.[0]?.requests);
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
