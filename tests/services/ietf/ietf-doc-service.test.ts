/**
 * @fileoverview Tests for `IetfDocService`: the RFC Editor `rfcN.json` read
 * (404 as `undefined`, relation ids as "RFC N", `page_count` parsing, email
 * scrubbing of title and authors), the Datatracker `doc.json` reads (RFC
 * tracking, `findDraft` with its `-NN` revision strip after a 404, a draft
 * missing `rev`, `state`, or `time` as unreadable), `getDraftRelations`
 * filtering edges by slug and name, the series reads (`getRfcSeries` for every
 * RFC in one `target__name__in` query, `getSeriesMembers` sorted by number),
 * each read naming its own operation when refused at the request limit,
 * malformed and mis-shaped JSON as `upstream_unreadable` (a `relateddocument`
 * page with more pages after it included), zero-padded ids read in linear
 * time, and
 * `relatedDocumentsUrl` serializing allow-listed keys only. Upstream I/O is a
 * `createFetchMock` fake; every author and address in a fixture is invented,
 * and the two `contains` pages are verbatim Datatracker captures.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATATRACKER_MAX_BYTES,
  DATATRACKER_ORIGIN,
  DATATRACKER_QUERY_KEYS,
  datatrackerPageUrl,
  getIetfDocService,
  IetfDocService,
  initIetfDocService,
  RFC_EDITOR_ORIGIN,
  RFC_JSON_MAX_BYTES,
  relatedDocumentsUrl,
  rfcJsonUrl,
  rfcPageUrl,
} from '@/services/ietf/ietf-doc-service.js';
import type { CallBudget } from '@/services/upstream/call-budget.js';
import {
  BCP14_CONTAINS_PAGE,
  DOC_PERSON_MARKERS,
  draftDocJson,
  edge,
  MEMBERSHIP_PAGE,
  pagedRelated,
  related,
  rfcDocJson,
  rfcJson,
} from '../../fixtures/ietf.js';
import {
  asMcpError,
  createHarness,
  hang,
  htmlResponse,
  jsonResponse,
  makeBudget,
  settle as settleWith,
  statusResponse,
  streamResponse,
  textResponse,
} from '../../shared/upstream-harness.js';

type Answer = (request: Request) => Response | Promise<Response>;

const DRAFT = 'draft-example-wg-topic';
const docUrl = (name: string) => `${DATATRACKER_ORIGIN}/doc/${name}/doc.json`;
const OUTGOING_URL = `${DATATRACKER_ORIGIN}/api/v1/doc/relateddocument/?format=json&limit=100&source__name=${DRAFT}&relationship__in=replaces%2Cbecame_rfc`;
const INCOMING_URL = `${DATATRACKER_ORIGIN}/api/v1/doc/relateddocument/?format=json&limit=100&target__name=${DRAFT}&relationship=replaces`;

const notFoundText = () => statusResponse(404, {}, '404 - Not found', 'text/plain');
const notFoundHtml = () => statusResponse(404, {}, '<html>Not found</html>', 'text/html');

describe('IetfDocService: process-wide instance', () => {
  it('throws until initialized, then returns the instance init built', () => {
    expect(() => getIetfDocService()).toThrow(/IetfDocService not initialized/);
    const h = createHarness();
    const service = initIetfDocService({ client: h.client });
    expect(service).toBeInstanceOf(IetfDocService);
    expect(getIetfDocService()).toBe(service);
  });
});

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

/** A service over a scripted upstream; an unscripted URL throws, so an unexpected fetch is loud. */
function setup() {
  const routes = new Map<string, Answer>();
  const h = createHarness([
    {
      match: /./,
      respond: (request) => {
        const answer = routes.get(request.url);
        if (!answer) throw new Error(`No upstream answer scripted for ${request.url}`);
        return answer(request);
      },
    },
  ]);
  const service = new IetfDocService({ client: h.client });
  return {
    ...h,
    service,
    fetches: () => h.http.calls.length,
    serve(answers: Record<string, Answer>) {
      for (const [url, answer] of Object.entries(answers)) routes.set(url, answer);
    },
  };
}

/** The resolved value, failing the test when the call rejected. */
async function value<T>(call: () => Promise<T>): Promise<T> {
  const outcome = await settle(call);
  if (outcome.error !== undefined) throw outcome.error;
  return outcome.value as T;
}

/** Wall-clock milliseconds `call` takes to settle; `performance.now()` is faked along with the timers. */
async function realMs(call: () => Promise<unknown>): Promise<number> {
  const start = vi.getRealSystemTime();
  await value(call);
  return vi.getRealSystemTime() - start;
}

/**
 * The fastest of three runs of `run(n)` at each of 5k, 20k, and 80k characters,
 * for a growth check: a linear parse grows about 16× from 5k to 80k, a
 * quadratic one about 256×.
 */
async function timings(run: (n: number) => Promise<unknown>) {
  const fastest = async (n: number) => {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt++) best = Math.min(best, await realMs(() => run(n)));
    return best;
  };
  return { t5k: await fastest(5_000), t20k: await fastest(20_000), t80k: await fastest(80_000) };
}

/** Linear growth from 5k to 80k characters, and a bound no quadratic parse meets at 80k. */
function expectLinear({ t5k, t20k, t80k }: Awaited<ReturnType<typeof timings>>): void {
  const measured = `5k ${t5k} ms, 20k ${t20k} ms, 80k ${t80k} ms`;
  expect(t80k / Math.max(t5k, 1), measured).toBeLessThan(64);
  expect(t80k, measured).toBeLessThan(500);
}

/** `budget` with no Datatracker requests left, so the next Datatracker read is refused unsent. */
function exhausted(budget: CallBudget): CallBudget {
  return { ...budget, requests: { datatracker: 0 } };
}

/** The rejection of `call`, failing the test when it resolved. */
async function rejection(call: () => Promise<unknown>): Promise<ReturnType<typeof asMcpError>> {
  const outcome = await settle(call);
  if (outcome.error === undefined) throw new Error('Expected the call to reject.');
  return asMcpError(outcome.error);
}

describe('rfcJsonUrl, rfcPageUrl, datatrackerPageUrl', () => {
  it('build the documented URLs, with no zero padding', () => {
    expect(RFC_EDITOR_ORIGIN).toBe('https://www.rfc-editor.org');
    expect(DATATRACKER_ORIGIN).toBe('https://datatracker.ietf.org');
    expect(rfcJsonUrl(1)).toBe('https://www.rfc-editor.org/rfc/rfc1.json');
    expect(rfcPageUrl(8001)).toBe('https://www.rfc-editor.org/rfc/rfc8001.html');
    expect(datatrackerPageUrl('rfc8001')).toBe('https://datatracker.ietf.org/doc/rfc8001/');
    expect(datatrackerPageUrl(DRAFT)).toBe(`https://datatracker.ietf.org/doc/${DRAFT}/`);
  });

  it('percent-encodes a document name', () => {
    expect(datatrackerPageUrl('a b/c')).toBe('https://datatracker.ietf.org/doc/a%20b%2Fc/');
  });

  it('exports the body ceilings', () => {
    expect(RFC_JSON_MAX_BYTES).toBe(256 * 1024);
    expect(DATATRACKER_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe('relatedDocumentsUrl', () => {
  const BASE = 'https://datatracker.ietf.org/api/v1/doc/relateddocument/?';

  it('adds format=json and limit=100 to the filters', () => {
    expect(relatedDocumentsUrl({ source__name: DRAFT })).toBe(
      `${BASE}format=json&limit=100&source__name=${DRAFT}`,
    );
    expect(relatedDocumentsUrl({})).toBe(`${BASE}format=json&limit=100`);
  });

  it('serializes only allow-listed keys, in the allow-list order', () => {
    const url = relatedDocumentsUrl({
      relationship: 'replaces',
      unknown_filter: 'x',
      target__name__in: 'rfc1,rfc2',
      target__name: 'draft-a',
      source__name: 'draft-b',
      id__gt: '5',
      relationship__in: 'replaces,became_rfc',
    } as never);
    expect(url).toBe(
      `${BASE}format=json&limit=100&source__name=draft-b&target__name=draft-a&target__name__in=rfc1%2Crfc2&relationship=replaces&relationship__in=replaces%2Cbecame_rfc`,
    );
    expect(url).not.toContain('unknown_filter');
    expect(url).not.toContain('id__gt');
  });

  it('lets a filter override the default limit and format', () => {
    expect(relatedDocumentsUrl({ limit: '5', format: 'json' })).toBe(`${BASE}format=json&limit=5`);
  });

  it('percent-encodes values', () => {
    expect(relatedDocumentsUrl({ source__name: 'a b&c=d' })).toContain('source__name=a+b%26c%3Dd');
  });

  it('lists exactly the query keys verified to narrow the result', () => {
    expect([...DATATRACKER_QUERY_KEYS]).toEqual([
      'format',
      'limit',
      'source__name',
      'target__name',
      'target__name__in',
      'relationship',
      'relationship__in',
    ]);
  });
});

describe('IetfDocService.getRfc', () => {
  const URL_8001 = rfcJsonUrl(8001);

  it('maps the RFC Editor record: relation ids as "RFC N", page_count as a number', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse(rfcJson(8001)) });
    const record = await value(() => s.service.getRfc(8001, s.budget()));
    expect(record).toEqual({
      number: 8001,
      title: 'Example Protocol Specification',
      authors: ['Example Author, Ed.', 'Another Example'],
      pageCount: 42,
      status: 'INTERNET STANDARD',
      publishedStatus: 'PROPOSED STANDARD',
      published: 'June 2022',
      obsoletes: ['RFC 7230', 'RFC 791'],
      obsoletedBy: [],
      updates: ['RFC 5234'],
      updatedBy: ['RFC 8002'],
      doi: '10.17487/RFC8001',
      errataUrl: 'https://www.rfc-editor.org/errata/rfc8001',
      draftName: 'draft-example-wg-topic-12',
    });
    expect(s.urls()).toEqual([URL_8001]);
    expect(s.http.calls[0]?.request.method).toBe('GET');
  });

  it.each([
    ['rfc0791', 'RFC 791'],
    ['RFC7230', 'RFC 7230'],
    ['rfc 7230', 'rfc 7230'],
    ['BCP0047', 'BCP0047'],
    ['STD0097', 'STD0097'],
    ['draft-example-x', 'draft-example-x'],
  ])('reads the relation id %j as %j', async (id, expected) => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse(rfcJson(8001, { obsoletes: [id] })) });
    expect((await value(() => s.service.getRfc(8001, s.budget())))?.obsoletes).toEqual([expected]);
  });

  it('reads a relation id with a long zero run in linear time', { timeout: 60_000 }, async () => {
    const s = setup();
    const times = await timings((n) => {
      const id = `rfc${'0'.repeat(n)}x`;
      s.serve({ [URL_8001]: () => jsonResponse(rfcJson(8001, { obsoletes: [id] })) });
      return s.service.getRfc(8001, s.budget());
    });
    expectLinear(times);
  });

  it.each([
    ['a digit string', '42', 42],
    ['a number', 42, 42],
    ['a padded digit string', ' 12 ', 12],
    ['zero', '0', undefined],
    ['an empty string', '', undefined],
    ['null', null, undefined],
    ['text', 'n/a', undefined],
    ['a negative', '-3', undefined],
    ['a fraction', '4.5', undefined],
  ])('reads page_count as %s: %j → %j', async (_label, raw, expected) => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse(rfcJson(8001, { page_count: raw })) });
    const record = await value(() => s.service.getRfc(8001, s.budget()));
    if (expected === undefined) expect(record).not.toHaveProperty('pageCount');
    else expect(record?.pageCount).toBe(expected);
  });

  it('omits page_count when the key is absent', async () => {
    const s = setup();
    const { page_count: _omitted, ...body } = rfcJson(8001);
    s.serve({ [URL_8001]: () => jsonResponse(body) });
    expect(await value(() => s.service.getRfc(8001, s.budget()))).not.toHaveProperty('pageCount');
  });

  it('omits an empty or null title, errata URL, and draft', async () => {
    const s = setup();
    s.serve({
      [URL_8001]: () => jsonResponse(rfcJson(8001, { title: '', errata_url: null, draft: null })),
    });
    const record = await value(() => s.service.getRfc(8001, s.budget()));
    expect(record).not.toHaveProperty('title');
    expect(record).not.toHaveProperty('errataUrl');
    expect(record).not.toHaveProperty('draftName');
  });

  it('defaults absent or null relation lists and authors to empty arrays', async () => {
    const s = setup();
    s.serve({
      [URL_8001]: () =>
        jsonResponse(
          rfcJson(8001, {
            authors: null,
            obsoletes: null,
            obsoleted_by: undefined,
            updates: null,
            updated_by: undefined,
          }),
        ),
    });
    expect(await value(() => s.service.getRfc(8001, s.budget()))).toMatchObject({
      authors: [],
      obsoletes: [],
      obsoletedBy: [],
      updates: [],
      updatedBy: [],
    });
  });

  it('never carries see_also, which the RFC Editor sends empty on every RFC', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse(rfcJson(8001, { see_also: ['STD0097'] })) });
    expect(await value(() => s.service.getRfc(8001, s.budget()))).not.toHaveProperty('seeAlso');
  });

  it('scrubs email addresses from the title and the authors', async () => {
    const s = setup();
    s.serve({
      [URL_8001]: () =>
        jsonResponse(
          rfcJson(8001, {
            title: 'Example Title (contact author@example.org)',
            authors: [
              'Example Author <author@example.org>',
              'mailto:author@example.org',
              'Another Example',
            ],
          }),
        ),
    });
    const record = await value(() => s.service.getRfc(8001, s.budget()));
    expect(record?.title).toBe('Example Title (contact [email removed])');
    expect(record?.authors).toEqual([
      'Example Author <[email removed]>',
      '[email removed]',
      'Another Example',
    ]);
    expect(JSON.stringify(record)).not.toContain('example.org');
  });

  it('answers undefined on a 404, after one fetch', async () => {
    const s = setup();
    s.serve({ [URL_8001]: notFoundText });
    expect(await value(() => s.service.getRfc(8001, s.budget()))).toBeUndefined();
    expect(s.fetches()).toBe(1);
  });

  it('retries a 5xx to three attempts and then rejects as ServiceUnavailable', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => statusResponse(503) });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(s.fetches()).toBe(3);
  });

  it('rejects an unexpected status as upstream_unreadable naming the status', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => statusResponse(403) });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', status: 403 });
  });

  it('rejects an HTML page served as 200 after one fetch, stating no retryable', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => htmlResponse('<html>maintenance</html>') });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.data).not.toHaveProperty('retryable');
    expect(s.fetches()).toBe(1);
  });

  it('rejects malformed JSON as upstream_unreadable, retried inside the ladder', async () => {
    const s = setup();
    s.serve({
      [URL_8001]: () =>
        new Response('{"doc_id":', { headers: { 'content-type': 'application/json' } }),
    });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.message).toContain('malformed JSON');
    expect(s.fetches()).toBe(3);
  });

  it.each([
    ['a missing status', { status: undefined }, 'status'],
    ['a non-string doi', { doi: 7 }, 'doi'],
    ['authors that are objects', { authors: [{ name: 'Example Author' }] }, 'authors.0'],
    ['a non-array relation list', { obsoletes: 'RFC7230' }, 'obsoletes'],
  ])('rejects %s as upstream_unreadable naming the field', async (_label, override, field) => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse(rfcJson(8001, override)) });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.message).toContain('unexpected shape');
    expect(error.message).toContain(field);
    expect(s.fetches()).toBe(3);
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"text"'],
  ])('rejects %s as a mis-shaped root', async (_label, body) => {
    const s = setup();
    s.serve({
      [URL_8001]: () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('rejects a body over the 256 KiB ceiling after one fetch, not retryable', async () => {
    const s = setup();
    s.serve({
      [URL_8001]: () =>
        streamResponse([new Uint8Array(RFC_JSON_MAX_BYTES + 1).fill(32)], 'application/json'),
    });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.data).toMatchObject({
      reason: 'upstream_unreadable',
      maxBytes: RFC_JSON_MAX_BYTES,
      retryable: false,
    });
    expect(s.fetches()).toBe(1);
  });

  it('rejects as a Timeout inside the call budget when the upstream never answers', async () => {
    const s = setup();
    s.serve({ [URL_8001]: hang });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
  });

  it('rejects with the abort reason, after one fetch, when the caller aborts mid-read', async () => {
    const s = setup();
    s.serve({ [URL_8001]: hang });
    const controller = new AbortController();
    const pending = s.service.getRfc(8001, makeBudget(45_000, controller.signal)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('client went away'));
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ message: 'client went away' });
    expect(s.fetches()).toBe(1);
  });
});

describe('IetfDocService.getRfcTracking', () => {
  const URL_8001 = docUrl('rfc8001');

  it('reads stream and group, nothing else', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse(rfcDocJson(8001)) });
    const tracking = await value(() => s.service.getRfcTracking(8001, s.budget()));
    expect(tracking).toEqual({
      stream: 'IETF',
      group: { acronym: 'exwg', name: 'Example Working Group', type: 'WG' },
    });
    expect(s.urls()).toEqual([URL_8001]);
  });

  it('never parses authors, shepherd, or the responsible AD', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse(rfcDocJson(8001)) });
    const tracking = await value(() => s.service.getRfcTracking(8001, s.budget()));
    const text = JSON.stringify(tracking);
    for (const marker of DOC_PERSON_MARKERS) expect(text).not.toContain(marker);
    expect(Object.keys(tracking ?? {}).sort()).toEqual(['group', 'stream']);
  });

  it('scrubs an address from the group name', async () => {
    const s = setup();
    s.serve({
      [URL_8001]: () =>
        jsonResponse(
          rfcDocJson(8001, {
            group: { name: 'Example Group <chair@example.org>', type: 'WG', acronym: 'exwg' },
          }),
        ),
    });
    const tracking = await value(() => s.service.getRfcTracking(8001, s.budget()));
    expect(tracking?.group?.name).toBe('Example Group <[email removed]>');
  });

  it('answers an empty object when Datatracker has neither stream nor group', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse(rfcDocJson(8001, { stream: '', group: null })) });
    expect(await value(() => s.service.getRfcTracking(8001, s.budget()))).toEqual({});
  });

  it('answers undefined on a 404', async () => {
    const s = setup();
    s.serve({ [URL_8001]: notFoundHtml });
    expect(await value(() => s.service.getRfcTracking(8001, s.budget()))).toBeUndefined();
    expect(s.fetches()).toBe(1);
  });

  it('rejects mis-shaped JSON (no name) as upstream_unreadable', async () => {
    const s = setup();
    s.serve({ [URL_8001]: () => jsonResponse({ rev: '' }) });
    const error = await rejection(() => s.service.getRfcTracking(8001, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.message).toContain('name');
  });

  it('rejects malformed JSON as upstream_unreadable', async () => {
    const s = setup();
    s.serve({
      [URL_8001]: () => new Response('<<', { headers: { 'content-type': 'application/json' } }),
    });
    const error = await rejection(() => s.service.getRfcTracking(8001, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.message).toContain('malformed JSON');
  });
});

describe('IetfDocService.findDraft', () => {
  it('maps the Datatracker record without the personal fields', async () => {
    const s = setup();
    s.serve({ [docUrl(DRAFT)]: () => jsonResponse(draftDocJson(DRAFT)) });
    const found = await value(() => s.service.findDraft(DRAFT, s.budget()));
    expect(found).toEqual({
      draft: {
        name: DRAFT,
        rev: '03',
        state: 'Active',
        lastUpdated: '2026-08-01 10:20:30',
        title: 'Example Draft Topic',
        group: { acronym: 'exwg', name: 'Example Working Group', type: 'WG' },
        iesgState: 'I-D Exists',
        stream: 'IETF',
        intendedStdLevel: 'Proposed Standard',
        expires: '2027-02-01 10:20:30',
      },
    });
    for (const marker of DOC_PERSON_MARKERS) expect(JSON.stringify(found)).not.toContain(marker);
    expect(s.urls()).toEqual([docUrl(DRAFT)]);
  });

  it('omits optional fields that are null or empty', async () => {
    const s = setup();
    s.serve({
      [docUrl(DRAFT)]: () =>
        jsonResponse(
          draftDocJson(DRAFT, {
            title: '',
            group: null,
            iesg_state: null,
            stream: null,
            intended_std_level: '',
            expires: null,
          }),
        ),
    });
    const found = await value(() => s.service.findDraft(DRAFT, s.budget()));
    expect(found?.draft).toEqual({
      name: DRAFT,
      rev: '03',
      state: 'Active',
      lastUpdated: '2026-08-01 10:20:30',
    });
  });

  it('keeps the RFC Editor queue state when present', async () => {
    const s = setup();
    s.serve({
      [docUrl(DRAFT)]: () => jsonResponse(draftDocJson(DRAFT, { rfceditor_state: 'EDIT' })),
    });
    expect((await value(() => s.service.findDraft(DRAFT, s.budget())))?.draft.rfceditorState).toBe(
      'EDIT',
    );
  });

  it('scrubs an address from the title', async () => {
    const s = setup();
    s.serve({
      [docUrl(DRAFT)]: () =>
        jsonResponse(draftDocJson(DRAFT, { title: 'Example Draft (author@example.org)' })),
    });
    expect((await value(() => s.service.findDraft(DRAFT, s.budget())))?.draft.title).toBe(
      'Example Draft ([email removed])',
    );
  });

  it('does not set requestedRevision when the name resolves as given', async () => {
    const s = setup();
    s.serve({ [docUrl(`${DRAFT}-03`)]: () => jsonResponse(draftDocJson(DRAFT)) });
    const found = await value(() => s.service.findDraft(`${DRAFT}-03`, s.budget()));
    expect(found).not.toHaveProperty('requestedRevision');
    expect(s.fetches()).toBe(1);
  });

  it('strips a -NN revision after a 404 and reports it as requestedRevision', async () => {
    const s = setup();
    s.serve({
      [docUrl(`${DRAFT}-07`)]: notFoundHtml,
      [docUrl(DRAFT)]: () => jsonResponse(draftDocJson(DRAFT)),
    });
    const found = await value(() => s.service.findDraft(`${DRAFT}-07`, s.budget()));
    expect(found?.requestedRevision).toBe('07');
    expect(found?.draft.name).toBe(DRAFT);
    expect(s.urls()).toEqual([docUrl(`${DRAFT}-07`), docUrl(DRAFT)]);
  });

  it('answers undefined when the name and the stripped name both 404', async () => {
    const s = setup();
    s.serve({ [docUrl(`${DRAFT}-07`)]: notFoundHtml, [docUrl(DRAFT)]: notFoundHtml });
    expect(await value(() => s.service.findDraft(`${DRAFT}-07`, s.budget()))).toBeUndefined();
    expect(s.fetches()).toBe(2);
  });

  it('answers undefined after one fetch when a name with no revision 404s', async () => {
    const s = setup();
    s.serve({ [docUrl(DRAFT)]: notFoundHtml });
    expect(await value(() => s.service.findDraft(DRAFT, s.budget()))).toBeUndefined();
    expect(s.fetches()).toBe(1);
  });

  it.each([
    ['one digit', `${DRAFT}-1`],
    ['three digits', `${DRAFT}-123`],
    ['a letter suffix', `${DRAFT}-v2`],
    ['digits with no hyphen', `${DRAFT}07`],
  ])('does not strip %s as a revision', async (_label, name) => {
    const s = setup();
    s.serve({ [docUrl(name)]: notFoundHtml });
    expect(await value(() => s.service.findDraft(name, s.budget()))).toBeUndefined();
    expect(s.fetches()).toBe(1);
  });

  it.each([
    ['rev', 'absent', undefined],
    ['rev', 'empty', ''],
    ['state', 'null', null],
    ['state', 'empty', ''],
    ['time', 'absent', undefined],
    ['time', 'null', null],
  ])('rejects a draft with %s %s as upstream_unreadable', async (field, _label, raw) => {
    const s = setup();
    s.serve({ [docUrl(DRAFT)]: () => jsonResponse(draftDocJson(DRAFT, { [field]: raw })) });
    const error = await rejection(() => s.service.findDraft(DRAFT, s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.message).toContain(DRAFT);
    expect(error.message).toContain('lacks its revision, state, or time');
  });

  it('rejects a base record missing a field after the revision strip', async () => {
    const s = setup();
    s.serve({
      [docUrl(`${DRAFT}-07`)]: notFoundHtml,
      [docUrl(DRAFT)]: () => jsonResponse(draftDocJson(DRAFT, { rev: null })),
    });
    const error = await rejection(() => s.service.findDraft(`${DRAFT}-07`, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('does not try the stripped name when the first read fails with a 5xx', async () => {
    const s = setup();
    s.serve({ [docUrl(`${DRAFT}-07`)]: () => statusResponse(503) });
    const error = await rejection(() => s.service.findDraft(`${DRAFT}-07`, s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(s.urls().every((url) => url === docUrl(`${DRAFT}-07`))).toBe(true);
    expect(s.fetches()).toBe(3);
  });

  it('rejects mis-shaped JSON as upstream_unreadable', async () => {
    const s = setup();
    s.serve({ [docUrl(DRAFT)]: () => jsonResponse({ rev: '03', state: 'Active', time: 'x' }) });
    const error = await rejection(() => s.service.findDraft(DRAFT, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
  });
});

describe('IetfDocService.getDraftRelations', () => {
  it('reads outgoing and incoming edges from the two allow-listed queries', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () => jsonResponse(related()),
      [INCOMING_URL]: () => jsonResponse(related()),
    });
    await value(() => s.service.getDraftRelations(DRAFT, s.budget()));
    expect([...s.urls()].sort()).toEqual([INCOMING_URL, OUTGOING_URL].sort());
  });

  it('answers empty lists, with no becameRfc key, when there are no edges', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () => jsonResponse(related()),
      [INCOMING_URL]: () => jsonResponse(related()),
    });
    expect(await value(() => s.service.getDraftRelations(DRAFT, s.budget()))).toEqual({
      replaces: [],
      replacedBy: [],
    });
  });

  it('reads replaces, replaced-by, and the RFC the draft became, names from the URI path', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () =>
        jsonResponse(
          related(
            edge('replaces', DRAFT, 'draft-example-wg-ancient'),
            edge('replaces', DRAFT, 'draft-example-wg-older'),
            edge('became_rfc', DRAFT, 'rfc8001'),
          ),
        ),
      [INCOMING_URL]: () =>
        jsonResponse(related(edge('replaces', 'draft-example-wg-newer', DRAFT))),
    });
    expect(await value(() => s.service.getDraftRelations(DRAFT, s.budget()))).toEqual({
      replaces: ['draft-example-wg-ancient', 'draft-example-wg-older'],
      replacedBy: ['draft-example-wg-newer'],
      becameRfc: 'RFC 8001',
    });
  });

  it('filters outgoing edges again by relationship slug and by source name', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () =>
        jsonResponse(
          related(
            edge('replaces', DRAFT, 'draft-example-wg-ancient'),
            edge('replaces', 'draft-other-wg-topic', 'draft-unrelated'),
            edge('conflrev', DRAFT, 'draft-example-wg-conflict'),
            edge('became_rfc', 'draft-other-wg-topic', 'rfc9'),
          ),
        ),
      [INCOMING_URL]: () => jsonResponse(related()),
    });
    expect(await value(() => s.service.getDraftRelations(DRAFT, s.budget()))).toEqual({
      replaces: ['draft-example-wg-ancient'],
      replacedBy: [],
    });
  });

  it('filters incoming edges again by relationship slug and by target name', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () => jsonResponse(related()),
      [INCOMING_URL]: () =>
        jsonResponse(
          related(
            edge('replaces', 'draft-example-wg-newer', DRAFT),
            edge('replaces', 'draft-example-wg-other', 'draft-unrelated'),
            edge('updates', 'draft-example-wg-updater', DRAFT),
            edge('became_rfc', 'draft-example-wg-bec', DRAFT),
          ),
        ),
    });
    expect((await value(() => s.service.getDraftRelations(DRAFT, s.budget()))).replacedBy).toEqual([
      'draft-example-wg-newer',
    ]);
  });

  it('takes the first became_rfc edge, normalizes a padded RFC target, and keeps other targets verbatim', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () =>
        jsonResponse(
          related(edge('became_rfc', DRAFT, 'rfc0791'), edge('became_rfc', DRAFT, 'rfc9')),
        ),
      [INCOMING_URL]: () => jsonResponse(related()),
    });
    expect((await value(() => s.service.getDraftRelations(DRAFT, s.budget()))).becameRfc).toBe(
      'RFC 791',
    );
    s.serve({
      [OUTGOING_URL]: () => jsonResponse(related(edge('became_rfc', DRAFT, 'draft-example-x'))),
    });
    expect((await value(() => s.service.getDraftRelations(DRAFT, s.budget()))).becameRfc).toBe(
      'draft-example-x',
    );
  });

  it('reads a relationship URI with no trailing slash', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () =>
        jsonResponse(
          related({
            ...edge('replaces', DRAFT, 'draft-example-wg-ancient'),
            relationship: '/api/v1/name/docrelationshipname/replaces',
          }),
        ),
      [INCOMING_URL]: () => jsonResponse(related()),
    });
    expect((await value(() => s.service.getDraftRelations(DRAFT, s.budget()))).replaces).toEqual([
      'draft-example-wg-ancient',
    ]);
  });

  it('rejects when one of the two reads fails: empty lists would read as no relations', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () => jsonResponse(related()),
      [INCOMING_URL]: () => statusResponse(503),
    });
    const error = await rejection(() => s.service.getDraftRelations(DRAFT, s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('accepts only a 200: a 404 is upstream_unreadable naming the status', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () => statusResponse(404),
      [INCOMING_URL]: () => jsonResponse(related()),
    });
    const error = await rejection(() => s.service.getDraftRelations(DRAFT, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', status: 404 });
  });

  it('rejects a page that says more edges follow: a partial page would drop relations', async () => {
    const s = setup();
    s.serve({
      [OUTGOING_URL]: () =>
        jsonResponse(pagedRelated(edge('replaces', DRAFT, 'draft-example-wg-ancient'))),
      [INCOMING_URL]: () => jsonResponse(related()),
    });
    const error = await rejection(() => s.service.getDraftRelations(DRAFT, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', url: OUTGOING_URL });
  });

  it.each([
    [
      'malformed JSON',
      () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    ],
    ['no objects array', () => jsonResponse({ meta: {} })],
    [
      'an edge with no target',
      () => jsonResponse({ objects: [{ relationship: '/x/replaces/', source: '/y/a/' }] }),
    ],
    [
      'a non-string source',
      () => jsonResponse({ objects: [{ relationship: 'r', source: 5, target: 't' }] }),
    ],
  ])('rejects %s as upstream_unreadable', async (_label, answer) => {
    const s = setup();
    s.serve({ [OUTGOING_URL]: answer, [INCOMING_URL]: () => jsonResponse(related()) });
    const error = await rejection(() => s.service.getDraftRelations(DRAFT, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('names getDraftRelations as the operation of a read refused at the request limit', async () => {
    const s = setup();
    const error = await rejection(() => s.service.getDraftRelations(DRAFT, exhausted(s.budget())));
    expect(error.message).toBe(
      'IetfDocService.getDraftRelations was not sent: this call has started every request to datatracker.ietf.org it may.',
    );
    expect(error.data).toMatchObject({ reason: 'request_limit' });
    expect(s.fetches()).toBe(0);
  });
});

describe('IetfDocService.getRfcSeries', () => {
  const MEMBERSHIP_URL = `${DATATRACKER_ORIGIN}/api/v1/doc/relateddocument/?format=json&limit=100&target__name__in=rfc2119%2Crfc9293%2Crfc4949&relationship=contains`;
  const NON_MEMBERS_URL = `${DATATRACKER_ORIGIN}/api/v1/doc/relateddocument/?format=json&limit=100&target__name__in=rfc7231%2Crfc793&relationship=contains`;
  const RFC_8001_URL = `${DATATRACKER_ORIGIN}/api/v1/doc/relateddocument/?format=json&limit=100&target__name__in=rfc8001&relationship=contains`;

  it("reads every RFC's series from one allow-listed query, as series ids", async () => {
    const s = setup();
    s.serve({ [MEMBERSHIP_URL]: () => jsonResponse(MEMBERSHIP_PAGE) });
    const series = await value(() => s.service.getRfcSeries([2119, 9293, 4949], s.budget()));
    expect(series).toEqual(
      new Map([
        [2119, ['BCP 14']],
        [9293, ['STD 7']],
        [4949, ['FYI 36']],
      ]),
    );
    expect(s.urls()).toEqual([MEMBERSHIP_URL]);
  });

  it('leaves out an RFC that belongs to no series', async () => {
    const s = setup();
    s.serve({ [NON_MEMBERS_URL]: () => jsonResponse(related()) });
    const series = await value(() => s.service.getRfcSeries([7231, 793], s.budget()));
    expect(series.size).toBe(0);
    expect(s.urls()).toEqual([NON_MEMBERS_URL]);
  });

  it('drops edges of another relationship or another target, and sorts an RFC in two series', async () => {
    const s = setup();
    s.serve({
      [RFC_8001_URL]: () =>
        jsonResponse(
          related(
            edge('contains', 'std97', 'rfc8001'),
            edge('refnorm', 'draft-example-wg-topic', 'rfc8001'),
            edge('contains', 'bcp14', 'rfc2119'),
            edge('contains', 'bcp47', 'rfc8001'),
          ),
        ),
    });
    const series = await value(() => s.service.getRfcSeries([8001], s.budget()));
    expect(series).toEqual(new Map([[8001, ['BCP 47', 'STD 97']]]));
  });

  it('reads a zero-padded series name as its series id, and any other name verbatim', async () => {
    const s = setup();
    s.serve({
      [RFC_8001_URL]: () =>
        jsonResponse(
          related(
            edge('contains', 'bcp0014', 'rfc8001'),
            edge('contains', 'STD097', 'rfc8001'),
            edge('contains', 'ien137', 'rfc8001'),
          ),
        ),
    });
    const series = await value(() => s.service.getRfcSeries([8001], s.budget()));
    expect(series).toEqual(new Map([[8001, ['BCP 14', 'ien137', 'STD 97']]]));
  });

  it('reads a series name with a long zero run in linear time', { timeout: 60_000 }, async () => {
    const s = setup();
    const times = await timings((n) => {
      const name = `bcp${'0'.repeat(n)}x`;
      s.serve({ [RFC_8001_URL]: () => jsonResponse(related(edge('contains', name, 'rfc8001'))) });
      return s.service.getRfcSeries([8001], s.budget());
    });
    expectLinear(times);
  });

  it('rejects a failed read rather than answering that no RFC is in a series', async () => {
    const s = setup();
    s.serve({ [RFC_8001_URL]: () => statusResponse(503) });
    const error = await rejection(() => s.service.getRfcSeries([8001], s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(s.fetches()).toBe(3);
  });

  it('rejects a page with no objects array as upstream_unreadable', async () => {
    const s = setup();
    s.serve({ [RFC_8001_URL]: () => jsonResponse({ meta: {} }) });
    const error = await rejection(() => s.service.getRfcSeries([8001], s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('rejects a page that says more edges follow, rather than reading its RFCs as in no series', async () => {
    const s = setup();
    s.serve({
      [RFC_8001_URL]: () => jsonResponse(pagedRelated(edge('contains', 'bcp9', 'rfc2026'))),
    });
    const error = await rejection(() => s.service.getRfcSeries([8001], s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', url: RFC_8001_URL });
    expect(error.message).toContain(
      `datatracker.ietf.org sent a page of ${RFC_8001_URL} with more pages after it; one page alone would drop edges.`,
    );
  });

  it.each([
    ['no meta', { objects: [] }],
    ['a meta with no next', { meta: { limit: 100, total_count: 0 }, objects: [] }],
  ])('rejects a page with %s as upstream_unreadable', async (_label, body) => {
    const s = setup();
    s.serve({ [RFC_8001_URL]: () => jsonResponse(body) });
    const error = await rejection(() => s.service.getRfcSeries([8001], s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('names getRfcSeries as the operation of a read refused at the request limit', async () => {
    const s = setup();
    const error = await rejection(() => s.service.getRfcSeries([8001], exhausted(s.budget())));
    expect(error.message).toMatch(/^IetfDocService\.getRfcSeries was not sent/);
    expect(s.fetches()).toBe(0);
  });
});

describe('IetfDocService.getSeriesMembers', () => {
  const seriesUrl = (name: string) =>
    `${DATATRACKER_ORIGIN}/api/v1/doc/relateddocument/?format=json&limit=100&source__name=${name}&relationship=contains`;

  it('reads the member RFCs from one allow-listed query, as RFC ids', async () => {
    const s = setup();
    s.serve({ [seriesUrl('bcp14')]: () => jsonResponse(BCP14_CONTAINS_PAGE) });
    expect(await value(() => s.service.getSeriesMembers('bcp14', s.budget()))).toEqual([
      'RFC 2119',
      'RFC 8174',
    ]);
    expect(s.urls()).toEqual([seriesUrl('bcp14')]);
  });

  it('lists members in ascending number order, whatever order Datatracker sends', async () => {
    const s = setup();
    s.serve({
      [seriesUrl('std5')]: () =>
        jsonResponse(
          related(
            edge('contains', 'std5', 'rfc1112'),
            edge('contains', 'std5', 'rfc950'),
            edge('contains', 'std5', 'rfc791'),
            edge('contains', 'std5', 'rfc922'),
            edge('contains', 'std5', 'rfc792'),
            edge('contains', 'std5', 'rfc919'),
          ),
        ),
    });
    expect(await value(() => s.service.getSeriesMembers('std5', s.budget()))).toEqual([
      'RFC 791',
      'RFC 792',
      'RFC 919',
      'RFC 922',
      'RFC 950',
      'RFC 1112',
    ]);
  });

  it('answers an empty list for a series with no members', async () => {
    const s = setup();
    s.serve({ [seriesUrl('bcp9999')]: () => jsonResponse(related()) });
    expect(await value(() => s.service.getSeriesMembers('bcp9999', s.budget()))).toEqual([]);
  });

  it('drops edges of another relationship or another source', async () => {
    const s = setup();
    s.serve({
      [seriesUrl('bcp14')]: () =>
        jsonResponse(
          related(
            edge('contains', 'bcp14', 'rfc8174'),
            edge('contains', 'bcp47', 'rfc5646'),
            edge('updates', 'bcp14', 'rfc9999'),
          ),
        ),
    });
    expect(await value(() => s.service.getSeriesMembers('bcp14', s.budget()))).toEqual([
      'RFC 8174',
    ]);
  });

  it('reads a zero-padded member as its RFC id', async () => {
    const s = setup();
    s.serve({
      [seriesUrl('bcp14')]: () =>
        jsonResponse(
          related(edge('contains', 'bcp14', 'rfc08174'), edge('contains', 'bcp14', 'RFC2119')),
        ),
    });
    expect(await value(() => s.service.getSeriesMembers('bcp14', s.budget()))).toEqual([
      'RFC 2119',
      'RFC 8174',
    ]);
  });

  it('rejects a failed read rather than answering an empty series', async () => {
    const s = setup();
    s.serve({ [seriesUrl('bcp14')]: () => statusResponse(503) });
    const error = await rejection(() => s.service.getSeriesMembers('bcp14', s.budget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('rejects a page that says more edges follow, rather than answering a short member list', async () => {
    const s = setup();
    s.serve({
      [seriesUrl('bcp14')]: () => jsonResponse(pagedRelated(edge('contains', 'bcp14', 'rfc2119'))),
    });
    const error = await rejection(() => s.service.getSeriesMembers('bcp14', s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', url: seriesUrl('bcp14') });
  });

  it('names getSeriesMembers as the operation of a read refused at the request limit', async () => {
    const s = setup();
    const error = await rejection(() => s.service.getSeriesMembers('bcp14', exhausted(s.budget())));
    expect(error.message).toMatch(/^IetfDocService\.getSeriesMembers was not sent/);
    expect(s.fetches()).toBe(0);
  });
});

describe('IetfDocService: text type of fixtures', () => {
  it('rejects a text/plain 200 where JSON is expected', async () => {
    const s = setup();
    s.serve({ [rfcJsonUrl(8001)]: () => textResponse('{}') });
    const error = await rejection(() => s.service.getRfc(8001, s.budget()));
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
  });
});
