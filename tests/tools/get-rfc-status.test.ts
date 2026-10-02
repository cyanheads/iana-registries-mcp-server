/**
 * @fileoverview Tests for `iana_get_rfc_status`: every id form the
 * classification row lists (RFC Editor `/rfc/`, `/rfc/inline-errata/`, and
 * `/info/` URLs, tools.ietf.org and ietf.org URLs, `rfcN` and draft file names,
 * each extension, Datatracker `/doc/`, `/doc/html/`, and `/doc/id/` paths
 * including a `/NN/` revision, ietf.org `/id/` and `/archive/id/`, series
 * pages on the RFC Editor and Datatracker) and the near misses that stay
 * unsupported, string and array `ids` (a string starting with `[` is not split
 * on commas; a URL's query and fragment dropped before the 200-character cap),
 * ids resolving to one document fetched once, BCP / STD / FYI ids as series
 * with their member RFCs, each RFC's series (`is_also`) from one membership
 * read per call (a page with more after it leaves `is_also` out), a
 * draft revision above the latest, an unpublished RFC as `found: false`,
 * partial failure into `failed[]` (a failed `relateddocument` read included,
 * each entry carrying its reason and `retryable` when the failure states
 * them, a refused redirect `retryable: false`), the rethrow only when every
 * id failed, the stream-and-group and series notices, a cancelled call
 * reporting no per-id failures, the `pacer_shed` rows for both hosts, the
 * `request_limit` rows (ids admitted in request order by planned cost within 20
 * Datatracker requests per call, retries counted, the ids left out in
 * `failed[]` unrequested with a notice), the warnings a failed Datatracker
 * read logs and a cancelled call does not, and `format()` parity and
 * sanitizing.
 * Upstream I/O is a `createFetchMock` fake whose Datatracker `contains` table
 * holds real series edges; every author and address is invented.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRfcStatus } from '@/mcp-server/tools/definitions/get-rfc-status.tool.js';
import {
  initIetfDocService,
  RFC_JSON_MAX_BYTES,
  relatedDocumentsUrl,
  rfcJsonUrl,
} from '@/services/ietf/ietf-doc-service.js';
import { DATATRACKER_CALL_REQUESTS } from '@/services/upstream/upstream-client.js';
import {
  CONTAINS_EDGES,
  DOC_PERSON_MARKERS,
  draftDocJson,
  edge,
  pagedRelated,
  related,
  rfcDocJson,
  rfcJson,
} from '../fixtures/ietf.js';
import { missingFromText } from '../shared/format-parity.js';
import { type Answer, callTool, settle, setupTools } from '../shared/tool-harness.js';
import {
  hang,
  htmlResponse,
  jsonResponse,
  makeBudget,
  PERMISSIVE_PACING,
  redirectResponse,
  statusResponse,
  streamResponse,
} from '../shared/upstream-harness.js';

type Out = Awaited<ReturnType<typeof callTool>>;

interface Doc {
  draft?: Record<string, unknown>;
  found: boolean;
  guidance?: string;
  id: string;
  kind: string;
  rfc?: Record<string, unknown>;
  series?: Record<string, unknown>;
  title?: string;
}

const DRAFT = 'draft-example-wg-topic';
const docUrl = (name: string) => `https://datatracker.ietf.org/doc/${name}/doc.json`;
const outgoingUrl = (name: string) =>
  relatedDocumentsUrl({ source__name: name, relationship__in: 'replaces,became_rfc' });
const incomingUrl = (name: string) =>
  relatedDocumentsUrl({ target__name: name, relationship: 'replaces' });
const notFound = () => statusResponse(404, {}, '404 - Not found', 'text/plain');

const RELATED = 'https://datatracker.ietf.org/api/v1/doc/relateddocument/';
/** The one membership read a call makes for its RFCs, written out literally so a dropped query key fails. */
const membershipUrl = (...rfcs: readonly number[]) =>
  `${RELATED}?format=json&limit=100&target__name__in=${rfcs.map((n) => `rfc${n}`).join('%2C')}&relationship=contains`;
/** The read of one series' members, written out literally. */
const seriesUrl = (name: string) =>
  `${RELATED}?format=json&limit=100&source__name=${name}&relationship=contains`;
/** True for a `relateddocument` read of `contains` edges: a membership or a series read. */
function isContainsRead(href: string): boolean {
  const url = new URL(href);
  return (
    url.pathname === '/api/v1/doc/relateddocument/' &&
    url.searchParams.get('relationship') === 'contains'
  );
}

/**
 * Datatracker's `contains` table over {@link CONTAINS_EDGES}, filtered by the
 * query keys it is sent; like the real API, it ignores a key it does not know
 * and answers the unfiltered table.
 */
function containsTable(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const source = query.get('source__name');
  const targets = query.get('target__name__in')?.split(',');
  const edges = CONTAINS_EDGES.filter(
    ([series, rfc]) =>
      (source === null || series === source) && (targets === undefined || targets.includes(rfc)),
  ).map(([series, rfc]) => edge('contains', series, rfc));
  return jsonResponse(related(...edges));
}

const SHED_HINT =
  'Wait the retryAfter seconds given in this error, then call iana_get_rfc_status again.';
const UNREADABLE_HINT =
  'The RFC Editor or Datatracker response could not be read; retry iana_get_rfc_status in a minute.';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The tool harness with the IETF service over it, and Datatracker's `contains` table served for every series read. */
function boot(options: Parameters<typeof setupTools>[0] = {}) {
  const s = setupTools(options);
  initIetfDocService({ client: s.client });
  s.serveWhere((url) => isContainsRead(url.href), containsTable);
  return s;
}

type Setup = ReturnType<typeof boot>;

/** Serves RFC `n`: its RFC Editor record and its Datatracker tracking (each replaceable). */
function serveRfc(s: Setup, n: number, answers: { rfc?: Answer; tracking?: Answer } = {}) {
  s.serve({
    [rfcJsonUrl(n)]: answers.rfc ?? (() => jsonResponse(rfcJson(n))),
    [docUrl(`rfc${n}`)]: answers.tracking ?? (() => jsonResponse(rfcDocJson(n))),
  });
}

/** Serves draft `name`: its doc.json and the two relateddocument pages (each replaceable). */
function serveDraft(
  s: Setup,
  name: string,
  answers: { doc?: Answer; incoming?: Answer; outgoing?: Answer } = {},
) {
  s.serve({
    [docUrl(name)]: answers.doc ?? (() => jsonResponse(draftDocJson(name))),
    [outgoingUrl(name)]: answers.outgoing ?? (() => jsonResponse(related())),
    [incomingUrl(name)]: answers.incoming ?? (() => jsonResponse(related())),
  });
}

const call = (input: Record<string, unknown>) => callTool(getRfcStatus, input);
const docs = (out: Out) => out.structured.documents as Doc[];
const failed = (out: Out) =>
  out.structured.failed as { error: string; id: string; reason?: string; retryable?: boolean }[];
const docIds = (out: Out) => docs(out).map((doc) => doc.id);

const RFC_8001: Doc = {
  id: 'RFC 8001',
  kind: 'rfc',
  found: true,
  title: 'Example Protocol Specification',
  rfc: {
    status: 'INTERNET STANDARD',
    published_status: 'PROPOSED STANDARD',
    stream: 'IETF',
    group: { acronym: 'exwg', name: 'Example Working Group', type: 'WG' },
    published: 'June 2022',
    page_count: 42,
    authors: ['Example Author, Ed.', 'Another Example'],
    obsoletes: ['RFC 7230', 'RFC 791'],
    obsoleted_by: [],
    updates: ['RFC 5234'],
    updated_by: ['RFC 8002'],
    is_also: [],
    doi: '10.17487/RFC8001',
    errata_url: 'https://www.rfc-editor.org/errata/rfc8001',
    draft_name: 'draft-example-wg-topic-12',
    url: 'https://www.rfc-editor.org/rfc/rfc8001.html',
    datatracker_url: 'https://datatracker.ietf.org/doc/rfc8001/',
  },
};

const DRAFT_DOC: Doc = {
  id: DRAFT,
  kind: 'draft',
  found: true,
  title: 'Example Draft Topic',
  draft: {
    rev: '03',
    state: 'Active',
    iesg_state: 'I-D Exists',
    stream: 'IETF',
    group: { acronym: 'exwg', name: 'Example Working Group', type: 'WG' },
    intended_std_level: 'Proposed Standard',
    last_updated: '2026-08-01 10:20:30',
    expires: '2027-02-01 10:20:30',
    replaced_by: [],
    replaces: [],
    datatracker_url: 'https://datatracker.ietf.org/doc/draft-example-wg-topic/',
  },
};

describe('iana_get_rfc_status: an RFC', () => {
  it('returns the RFC Editor status and relations with the Datatracker stream, group, and series', async () => {
    const s = boot();
    serveRfc(s, 8001);
    const out = await call({ ids: ['RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({ documents: [RFC_8001], failed: [] });
    expect(s.fetched().sort()).toEqual(
      [rfcJsonUrl(8001), docUrl('rfc8001'), membershipUrl(8001)].sort(),
    );
  });

  it('never carries see_also, which the RFC Editor sends empty on every RFC', async () => {
    const s = boot();
    serveRfc(s, 8001, { rfc: () => jsonResponse(rfcJson(8001, { see_also: ['STD0097'] })) });
    const out = await call({ ids: ['RFC 8001'] });
    expect(docs(out)[0]?.rfc).not.toHaveProperty('see_also');
    expect(out.text).not.toContain('See also');
  });

  it('never carries the personal fields of the Datatracker record', async () => {
    const s = boot();
    serveRfc(s, 8001);
    const out = await call({ ids: ['RFC 8001'] });
    for (const marker of DOC_PERSON_MARKERS) {
      expect(JSON.stringify(out.structured)).not.toContain(marker);
      expect(out.text).not.toContain(marker);
    }
  });

  it('scrubs addresses from the title and authors, in both surfaces', async () => {
    const s = boot();
    serveRfc(s, 8001, {
      rfc: () =>
        jsonResponse(
          rfcJson(8001, {
            title: 'Example Title (author@example.org)',
            authors: ['Example Author <author@example.org>'],
          }),
        ),
    });
    const out = await call({ ids: ['RFC 8001'] });
    expect(docs(out)[0]?.title).toBe('Example Title ([email removed])');
    expect(docs(out)[0]?.rfc?.authors).toEqual(['Example Author <[email removed]>']);
    expect(JSON.stringify(out.structured)).not.toContain('example.org');
    expect(out.text).not.toContain('example.org');
  });

  it('omits what the RFC Editor leaves out: page_count, errata, draft, title', async () => {
    const s = boot();
    serveRfc(s, 8001, {
      rfc: () =>
        jsonResponse(rfcJson(8001, { page_count: '', errata_url: null, draft: null, title: null })),
    });
    const [doc] = docs(await call({ ids: ['RFC 8001'] }));
    expect(doc).not.toHaveProperty('title');
    expect(doc?.rfc).not.toHaveProperty('page_count');
    expect(doc?.rfc).not.toHaveProperty('errata_url');
    expect(doc?.rfc).not.toHaveProperty('draft_name');
  });

  it('answers an unpublished RFC as found: false with guidance, no rfc block, and no notice', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    const out = await call({ ids: ['RFC 99999'] });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      documents: [
        {
          id: 'RFC 99999',
          kind: 'rfc',
          found: false,
          guidance:
            'RFC 99999 is not published (never issued, or not yet assigned). Check the number; drafts go by their draft- name.',
        },
      ],
      failed: [],
    });
  });

  it('leaves out stream and group, with a notice naming the RFC, when Datatracker has no record', async () => {
    const s = boot();
    serveRfc(s, 8002, { tracking: notFound });
    const out = await call({ ids: ['RFC 8002'] });
    expect(out.isError).toBe(false);
    const [doc] = docs(out);
    expect(doc?.found).toBe(true);
    expect(doc?.rfc).not.toHaveProperty('stream');
    expect(doc?.rfc).not.toHaveProperty('group');
    expect(doc?.rfc?.status).toBe('INTERNET STANDARD');
    expect(out.structured.notice).toBe(
      'Stream and working group were unavailable for RFC 8002; status and relations come from the RFC Editor.',
    );
    expect(out.text).toContain(String(out.structured.notice));
  });

  it.each([
    ['a 503', () => statusResponse(503)],
    ['an HTML page served as 200', () => htmlResponse('<html/>')],
    [
      'malformed JSON',
      () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    ],
    ['mis-shaped JSON', () => jsonResponse({ rev: '' })],
  ])(
    'treats Datatracker answering %s as unavailable, not as a failed id',
    async (_label, tracking) => {
      const s = boot();
      serveRfc(s, 8002, { tracking });
      const out = await call({ ids: ['RFC 8002'] });
      expect(out.isError).toBe(false);
      expect(failed(out)).toEqual([]);
      expect(docs(out)[0]?.found).toBe(true);
      expect(out.structured.notice).toContain('RFC 8002');
    },
  );

  it('lists every RFC without Datatracker fields in the notice, in request order', async () => {
    const s = boot();
    serveRfc(s, 8003, { tracking: notFound });
    serveRfc(s, 8001);
    serveRfc(s, 8002, { tracking: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 8003', 'RFC 8001', 'RFC 8002'] });
    expect(out.structured.notice).toBe(
      'Stream and working group were unavailable for RFC 8003, RFC 8002; status and relations come from the RFC Editor.',
    );
  });

  it('gives no notice when Datatracker answers but carries neither stream nor group', async () => {
    const s = boot();
    serveRfc(s, 8001, {
      tracking: () => jsonResponse(rfcDocJson(8001, { stream: null, group: null })),
    });
    const out = await call({ ids: ['RFC 8001'] });
    expect(docs(out)[0]?.rfc).not.toHaveProperty('stream');
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('gives no notice for an RFC the RFC Editor does not know, whatever Datatracker said', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 99999'] });
    expect(docs(out)[0]?.found).toBe(false);
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_get_rfc_status: the series an RFC belongs to (is_also)', () => {
  const SERIES_NOTICE = (ids: string) =>
    `Series membership was unavailable for ${ids}, so is_also is left out; status and relations still answered.`;

  it('lists the series of an RFC that belongs to one: RFC 2119 is also BCP 14', async () => {
    const s = boot();
    serveRfc(s, 2119);
    const out = await call({ ids: ['RFC 2119'] });
    expect(docs(out)[0]?.rfc?.is_also).toEqual(['BCP 14']);
    expect(out.text).toContain('**Is also:** BCP 14');
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('answers an empty is_also for RFCs in no series: RFC 7231, and RFC 793 since RFC 9293 replaced it in STD 7', async () => {
    const s = boot();
    serveRfc(s, 7231);
    serveRfc(s, 793);
    const out = await call({ ids: ['RFC 7231', 'RFC 793'] });
    expect(docs(out).map((doc) => doc.rfc?.is_also)).toEqual([[], []]);
    expect(out.text.match(/\*\*Is also:\*\* none/g)).toHaveLength(2);
  });

  it('serves every RFC in a call from one membership read, in request order', async () => {
    const s = boot();
    for (const n of [2119, 7231, 9293, 4949]) serveRfc(s, n);
    serveDraft(s, DRAFT);
    const out = await call({ ids: ['RFC 2119', DRAFT, 'RFC 7231', 'RFC 9293', 'RFC 4949'] });
    expect(docs(out).map((doc) => [doc.id, doc.rfc?.is_also])).toEqual([
      ['RFC 2119', ['BCP 14']],
      [DRAFT, undefined],
      ['RFC 7231', []],
      ['RFC 9293', ['STD 7']],
      ['RFC 4949', ['FYI 36']],
    ]);
    expect(s.fetched().filter(isContainsRead)).toEqual([membershipUrl(2119, 7231, 9293, 4949)]);
  });

  it('makes no membership read for a call without an RFC', async () => {
    const s = boot();
    serveDraft(s, DRAFT);
    const out = await call({ ids: [DRAFT, 'ISO 639'] });
    expect(out.isError).toBe(false);
    expect(s.fetches()).toBe(3);
    expect(s.fetched().filter(isContainsRead)).toEqual([]);
  });

  it('leaves out is_also, with a notice naming the RFCs, when the membership read fails; the rest still answers', async () => {
    const s = boot();
    serveRfc(s, 2119);
    serveRfc(s, 7231);
    s.serve({ [membershipUrl(2119, 7231)]: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 2119', 'RFC 7231'] });
    expect(out.isError).toBe(false);
    expect(failed(out)).toEqual([]);
    for (const doc of docs(out)) {
      expect(doc.found).toBe(true);
      expect(doc.rfc).not.toHaveProperty('is_also');
      expect(doc.rfc).toMatchObject({ status: 'INTERNET STANDARD', stream: 'IETF' });
      expect(doc.rfc?.group).toMatchObject({ acronym: 'exwg' });
    }
    expect(out.structured.notice).toBe(SERIES_NOTICE('RFC 2119, RFC 7231'));
    expect(out.text).toContain(SERIES_NOTICE('RFC 2119, RFC 7231'));
    expect(out.text).not.toContain('**Is also:**');
    expect(s.fetched().filter(isContainsRead)).toHaveLength(3);
  });

  it('leaves out is_also, failing no RFC, when retries against a failing Datatracker use up the limit', async () => {
    const s = boot();
    const RFCS = Array.from({ length: 10 }, (_, index) => 8001 + index);
    for (const n of RFCS) serveRfc(s, n, { tracking: () => statusResponse(503) });
    s.serve({ [membershipUrl(...RFCS)]: () => statusResponse(503) });
    const out = await call({ ids: RFCS.map((n) => `RFC ${n}`) });
    expect(out.isError).toBe(false);
    expect(failed(out)).toEqual([]);
    expect(
      s.fetched().filter((url) => url.startsWith('https://datatracker.ietf.org/')),
    ).toHaveLength(20);
    expect(docs(out).every((doc) => doc.found && doc.rfc?.is_also === undefined)).toBe(true);
    expect(out.structured.notice).toContain(SERIES_NOTICE(RFCS.map((n) => `RFC ${n}`).join(', ')));
  });

  it('leaves out is_also, with the notice, when the membership page says more edges follow', async () => {
    const s = boot();
    serveRfc(s, 2119);
    s.serve({
      [membershipUrl(2119)]: () => jsonResponse(pagedRelated(edge('contains', 'bcp9', 'rfc2026'))),
    });
    const out = await call({ ids: ['RFC 2119'] });
    expect(out.isError).toBe(false);
    expect(failed(out)).toEqual([]);
    expect(docs(out)[0]).toMatchObject({ id: 'RFC 2119', found: true });
    expect(docs(out)[0]?.rfc).not.toHaveProperty('is_also');
    expect(out.structured.notice).toBe(SERIES_NOTICE('RFC 2119'));
    expect(out.text).toContain(SERIES_NOTICE('RFC 2119'));
    expect(out.text).not.toContain('**Is also:**');
  });

  it('names only found RFCs in the series notice', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    s.serve({ [membershipUrl(99999, 8001)]: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 99999', 'RFC 8001'] });
    expect(docs(out)[0]).toMatchObject({ id: 'RFC 99999', found: false });
    expect(out.structured.notice).toBe(SERIES_NOTICE('RFC 8001'));
  });

  it('places the series fragment after the stream-and-group fragment', async () => {
    const s = boot();
    serveRfc(s, 8001, { tracking: notFound });
    s.serve({ [membershipUrl(8001)]: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 8001'] });
    expect(out.structured.notice).toBe(
      `Stream and working group were unavailable for RFC 8001; status and relations come from the RFC Editor. ${SERIES_NOTICE('RFC 8001')}`,
    );
  });

  it('rejects as RequestCancelled, never a degraded success, when the caller aborts during the membership read', async () => {
    const s = boot();
    serveRfc(s, 8001);
    s.serve({ [membershipUrl(8001)]: hang });
    const controller = new AbortController();
    const pending = callTool(
      getRfcStatus,
      { ids: ['RFC 8001'] },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(s.fetched()).toContain(rfcJsonUrl(8001));
    controller.abort(new Error('client went away'));
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(out.structured).not.toHaveProperty('documents');
  });
});

describe('iana_get_rfc_status: a BCP, STD, or FYI series', () => {
  const BCP_14 = {
    id: 'BCP 14',
    kind: 'series',
    found: true,
    series: {
      members: ['RFC 2119', 'RFC 8174'],
      datatracker_url: 'https://datatracker.ietf.org/doc/bcp14/',
    },
  };

  it.each(['BCP 14', 'bcp14', 'BCP-14', 'BCP0014', 'bcp 14', '  BCP 14  '])(
    'resolves %j as BCP 14 and its member RFCs from one request',
    async (id) => {
      const s = boot();
      const out = await call({ ids: [id] });
      expect(out.isError).toBe(false);
      expect(out.structured).toEqual({ documents: [BCP_14], failed: [] });
      expect(s.fetched()).toEqual([seriesUrl('bcp14')]);
    },
  );

  it('resolves every spelling of one series once', async () => {
    const s = boot();
    const out = await call({ ids: ['BCP 14', 'bcp14', 'BCP-14', 'BCP0014'] });
    expect(out.structured).toEqual({ documents: [BCP_14], failed: [] });
    expect(s.fetches()).toBe(1);
  });

  it.each<[string, string, string]>([
    ['https://datatracker.ietf.org/doc/bcp14/', 'BCP 14', 'bcp14'],
    ['https://datatracker.ietf.org/doc/bcp14', 'BCP 14', 'bcp14'],
    ['http://datatracker.ietf.org/doc/std7/', 'STD 7', 'std7'],
    ['datatracker.ietf.org/doc/FYI36/', 'FYI 36', 'fyi36'],
    ['https://datatracker.ietf.org/doc/bcp14/?include_text=1', 'BCP 14', 'bcp14'],
    ['https://www.rfc-editor.org/info/bcp14', 'BCP 14', 'bcp14'],
    ['https://rfc-editor.org/info/std7', 'STD 7', 'std7'],
    ['rfc-editor.org/info/std7', 'STD 7', 'std7'],
    ['www.rfc-editor.org/info/fyi36/', 'FYI 36', 'fyi36'],
    ['https://www.rfc-editor.org/info/bcp14#section-1', 'BCP 14', 'bcp14'],
    ['https://www.rfc-editor.org/info/bcp14.html', 'BCP 14', 'bcp14'],
    ['https://www.rfc-editor.org/info/bcp0014', 'BCP 14', 'bcp14'],
    ['HTTPS://WWW.RFC-EDITOR.ORG/INFO/BCP14', 'BCP 14', 'bcp14'],
  ])('reads the series URL %j as %j', async (input, id, name) => {
    const s = boot();
    const out = await call({ ids: [input] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toMatchObject([{ id, kind: 'series', found: true }]);
    expect(s.fetched()).toEqual([seriesUrl(name)]);
  });

  it('reads the series.datatracker_url a call returned as that series', async () => {
    boot();
    const first = docs(await call({ ids: ['BCP 14'] }))[0];
    const url = first?.series?.datatracker_url as string;
    expect(url).toBe('https://datatracker.ietf.org/doc/bcp14/');
    const again = await call({ ids: [url] });
    expect(again.structured).toEqual({ documents: [BCP_14], failed: [] });
  });

  it('collapses series URLs beside the series number into one entry', async () => {
    const s = boot();
    const out = await call({
      ids: ['BCP 14', 'https://datatracker.ietf.org/doc/bcp14/', 'rfc-editor.org/info/bcp14'],
    });
    expect(out.structured).toEqual({ documents: [BCP_14], failed: [] });
    expect(s.fetches()).toBe(1);
  });

  it.each<[string, string, string, string[]]>([
    ['STD 7', 'STD 7', 'std7', ['RFC 9293']],
    ['FYI 36', 'FYI 36', 'fyi36', ['RFC 4949']],
    ['std 5', 'STD 5', 'std5', ['RFC 791', 'RFC 792', 'RFC 919', 'RFC 922', 'RFC 950', 'RFC 1112']],
    [
      'BCP 9',
      'BCP 9',
      'bcp9',
      [
        'RFC 2026',
        'RFC 5657',
        'RFC 6410',
        'RFC 7100',
        'RFC 7127',
        'RFC 7475',
        'RFC 8789',
        'RFC 9282',
      ],
    ],
  ])('resolves %j as %j with its members in ascending order', async (input, id, name, members) => {
    const s = boot();
    const out = await call({ ids: [input] });
    expect(docs(out)).toEqual([
      {
        id,
        kind: 'series',
        found: true,
        series: { members, datatracker_url: `https://datatracker.ietf.org/doc/${name}/` },
      },
    ]);
    expect(s.fetched()).toEqual([seriesUrl(name)]);
  });

  it.each([
    ['BCP 9999', 'bcp9999'],
    ['BCP 1', 'bcp1'],
    ['FYI 1', 'fyi1'],
  ])(
    'answers %j, a series with no member RFCs, as found: false with guidance',
    async (id, name) => {
      const s = boot();
      const out = await call({ ids: [id] });
      expect(out.isError).toBe(false);
      expect(out.structured).toEqual({
        documents: [
          {
            id,
            kind: 'series',
            found: false,
            guidance: `${id} has no member RFCs: the number is unassigned, or the series no longer contains any RFC. Check the number.`,
          },
        ],
        failed: [],
      });
      expect(s.fetched()).toEqual([seriesUrl(name)]);
    },
  );

  it('answers a series beside an RFC that belongs to it', async () => {
    const s = boot();
    serveRfc(s, 2119);
    const out = await call({ ids: ['BCP 14', 'RFC 2119'] });
    expect(docs(out).map((doc) => [doc.id, doc.kind])).toEqual([
      ['BCP 14', 'series'],
      ['RFC 2119', 'rfc'],
    ]);
    expect(docs(out)[1]?.rfc?.is_also).toEqual(['BCP 14']);
    expect(s.fetched().filter(isContainsRead).sort()).toEqual(
      [seriesUrl('bcp14'), membershipUrl(2119)].sort(),
    );
  });

  it('sends a series whose read failed to failed[] and still answers the rest', async () => {
    const s = boot();
    serveRfc(s, 8001);
    s.serve({ [seriesUrl('bcp14')]: () => statusResponse(503) });
    const out = await call({ ids: ['BCP 14', 'RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(failed(out)).toEqual([{ id: 'BCP 14', error: expect.any(String) }]);
  });

  it('sends a series whose members page says more edges follow to failed[], never a short member list', async () => {
    const s = boot();
    serveRfc(s, 8001);
    s.serve({
      [seriesUrl('bcp14')]: () => jsonResponse(pagedRelated(edge('contains', 'bcp14', 'rfc2119'))),
    });
    const out = await call({ ids: ['BCP 14', 'RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(failed(out)).toEqual([
      { id: 'BCP 14', error: expect.stringContaining('more pages'), reason: 'upstream_unreadable' },
    ]);
    expect(out.text).toContain('- BCP 14: ');
    expect(out.text).toContain('(upstream_unreadable)');
  });

  it('fails the call when the only id is a series whose read failed', async () => {
    const s = boot();
    s.serve({ [seriesUrl('bcp14')]: () => statusResponse(503) });
    const out = await call({ ids: ['BCP 14'] });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503, retryAttempts: 3 },
    });
  });

  it('prints a series with its members and Datatracker page, and an empty one with its guidance', async () => {
    boot();
    const out = await call({ ids: ['BCP 14', 'BCP 9999'] });
    expect(out.text).toContain(
      '### BCP 14\n**Kind:** series · **Found:** true\n**Members:** RFC 2119, RFC 8174\n**Datatracker:** <https://datatracker.ietf.org/doc/bcp14/>',
    );
    expect(out.text).toContain(
      '### BCP 9999\n**Kind:** series · **Found:** false\nBCP 9999 has no member RFCs',
    );
  });
});

describe('iana_get_rfc_status: an Internet-Draft', () => {
  it('returns state, IESG state, intended status, expiry, and the replacement relations', async () => {
    const s = boot();
    serveDraft(s, DRAFT, {
      outgoing: () =>
        jsonResponse(
          related(
            edge('replaces', DRAFT, 'draft-example-wg-ancient'),
            edge('became_rfc', DRAFT, 'rfc8001'),
          ),
        ),
      incoming: () => jsonResponse(related(edge('replaces', 'draft-example-wg-newer', DRAFT))),
    });
    const out = await call({ ids: [DRAFT] });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      documents: [
        {
          ...DRAFT_DOC,
          draft: {
            ...DRAFT_DOC.draft,
            replaces: ['draft-example-wg-ancient'],
            replaced_by: ['draft-example-wg-newer'],
            became_rfc: 'RFC 8001',
          },
        },
      ],
      failed: [],
    });
    expect(s.fetches()).toBe(3);
  });

  it('returns the draft with empty relation lists when there are no edges', async () => {
    const s = boot();
    serveDraft(s, DRAFT);
    const out = await call({ ids: [DRAFT] });
    expect(out.structured).toEqual({ documents: [DRAFT_DOC], failed: [] });
    expect(JSON.stringify(out.structured)).not.toContain('became_rfc');
  });

  it('omits the optional state fields Datatracker leaves null', async () => {
    const s = boot();
    serveDraft(s, DRAFT, {
      doc: () =>
        jsonResponse(
          draftDocJson(DRAFT, {
            iesg_state: null,
            stream: null,
            group: null,
            intended_std_level: null,
            expires: null,
            title: null,
          }),
        ),
    });
    const [doc] = docs(await call({ ids: [DRAFT] }));
    expect(doc).not.toHaveProperty('title');
    expect(doc?.draft).toEqual({
      rev: '03',
      state: 'Active',
      last_updated: '2026-08-01 10:20:30',
      replaced_by: [],
      replaces: [],
      datatracker_url: 'https://datatracker.ietf.org/doc/draft-example-wg-topic/',
    });
  });

  it('strips a -NN revision after a 404, echoing it as requested_revision under the draft name', async () => {
    const s = boot();
    s.serve({ [docUrl(`${DRAFT}-07`)]: notFound });
    serveDraft(s, DRAFT);
    const out = await call({ ids: [`${DRAFT}-07`] });
    const [doc] = docs(out);
    expect(doc?.id).toBe(DRAFT);
    expect(doc?.draft).toMatchObject({ requested_revision: '07', rev: '03' });
    expect(s.fetched()).toEqual([
      docUrl(`${DRAFT}-07`),
      docUrl(DRAFT),
      expect.stringContaining('relateddocument'),
      expect.stringContaining('relateddocument'),
    ]);
    expect(out.text).toContain('**State:** Active · **Revision:** 03 (requested -07)');
  });

  describe('a revision suffix', () => {
    const HTTPBIS = 'draft-ietf-httpbis-semantics';
    const serveHttpbis = (s: Setup, revision: string) => {
      s.serve({ [docUrl(`${HTTPBIS}-${revision}`)]: notFound });
      serveDraft(s, HTTPBIS, {
        doc: () => jsonResponse(draftDocJson(HTTPBIS, { rev: '19', state: 'RFC' })),
      });
    };

    it('above the latest revision keeps the draft found and adds guidance naming the latest', async () => {
      const s = boot();
      serveHttpbis(s, '99');
      const out = await call({ ids: [`${HTTPBIS}-99`] });
      const guidance = `${HTTPBIS} has no revision -99; the latest is -19.`;
      expect(docs(out)).toEqual([
        {
          id: HTTPBIS,
          kind: 'draft',
          found: true,
          guidance,
          title: 'Example Draft Topic',
          draft: expect.objectContaining({ rev: '19', requested_revision: '99', state: 'RFC' }),
        },
      ]);
      expect(out.text).toContain(
        `### ${HTTPBIS} · Example Draft Topic\n**Kind:** draft · **Found:** true\n${guidance}`,
      );
      expect(out.text).toContain('**Revision:** 19 (requested -99)');
    });

    it.each(['07', '19'])('-%s, at or below the latest revision, adds no guidance', async (rev) => {
      const s = boot();
      serveHttpbis(s, rev);
      const [doc] = docs(await call({ ids: [`${HTTPBIS}-${rev}`] }));
      expect(doc).toMatchObject({ found: true, draft: { rev: '19', requested_revision: rev } });
      expect(doc).not.toHaveProperty('guidance');
    });
  });

  it('answers a draft missing under both names as found: false under the requested name', async () => {
    const s = boot();
    s.serve({
      [docUrl('draft-example-wg-missing-05')]: notFound,
      [docUrl('draft-example-wg-missing')]: notFound,
    });
    const out = await call({ ids: ['draft-example-wg-missing-05'] });
    expect(out.structured).toEqual({
      documents: [
        {
          id: 'draft-example-wg-missing-05',
          kind: 'draft',
          found: false,
          guidance:
            'No Internet-Draft named draft-example-wg-missing-05. Draft names look like draft-<source>-<group>-<topic>; a revision suffix such as -07 is optional.',
        },
      ],
      failed: [],
    });
    expect(s.fetches()).toBe(2);
  });

  it('answers a draft that RFC publication replaced: state RFC and the RFC it became', async () => {
    const s = boot();
    serveDraft(s, DRAFT, {
      doc: () => jsonResponse(draftDocJson(DRAFT, { state: 'RFC', rfceditor_state: 'PUB' })),
      outgoing: () => jsonResponse(related(edge('became_rfc', DRAFT, 'rfc0791'))),
    });
    const [doc] = docs(await call({ ids: [DRAFT] }));
    expect(doc?.draft).toMatchObject({
      state: 'RFC',
      rfceditor_state: 'PUB',
      became_rfc: 'RFC 791',
    });
  });

  it('drops edges that name another source or target', async () => {
    const s = boot();
    serveDraft(s, DRAFT, {
      outgoing: () =>
        jsonResponse(related(edge('replaces', 'draft-other-wg-topic', 'draft-unrelated'))),
      incoming: () =>
        jsonResponse(related(edge('replaces', 'draft-example-wg-newer', 'draft-unrelated'))),
    });
    const [doc] = docs(await call({ ids: [DRAFT] }));
    expect(doc?.draft).toMatchObject({ replaces: [], replaced_by: [] });
  });

  it('scrubs an address from the draft title', async () => {
    const s = boot();
    serveDraft(s, DRAFT, {
      doc: () => jsonResponse(draftDocJson(DRAFT, { title: 'Example Draft (author@example.org)' })),
    });
    expect(docs(await call({ ids: [DRAFT] }))[0]?.title).toBe('Example Draft ([email removed])');
  });
});

describe('iana_get_rfc_status: id forms', () => {
  const RFC_FORMS = [
    'RFC 8001',
    'rfc 8001',
    'rfc8001',
    'RFC-8001',
    'RFC8001',
    '8001',
    '  8001  ',
    '08001',
    'RFC 0008001',
    'https://www.rfc-editor.org/rfc/rfc8001',
    'https://www.rfc-editor.org/rfc/rfc8001.html',
    'https://www.rfc-editor.org/rfc/rfc8001.txt',
    'https://www.rfc-editor.org/rfc/rfc8001.json',
    'https://www.rfc-editor.org/rfc/rfc8001.pdf',
    'https://www.rfc-editor.org/rfc/rfc8001.xml',
    'http://www.rfc-editor.org/rfc/rfc8001.html',
    'www.rfc-editor.org/rfc/rfc8001.html',
    'rfc-editor.org/rfc/rfc8001',
    'https://www.rfc-editor.org/info/rfc8001',
    'http://www.rfc-editor.org/info/rfc8001',
    'rfc-editor.org/info/rfc8001',
    'https://www.rfc-editor.org/rfc/rfc8001.html#section-2',
    'https://www.rfc-editor.org/rfc/rfc8001.html?ref=1',
    'HTTPS://WWW.RFC-EDITOR.ORG/RFC/RFC8001.HTML',
    'https://datatracker.ietf.org/doc/rfc8001',
    'https://datatracker.ietf.org/doc/rfc8001/',
    'https://datatracker.ietf.org/doc/html/rfc8001',
    'https://datatracker.ietf.org/doc/html/rfc8001/',
    'datatracker.ietf.org/doc/rfc8001/',
    'https://datatracker.ietf.org/doc/rfc8001/#section-1',
  ];

  it.each(RFC_FORMS)('reads %j as RFC 8001', async (id) => {
    const s = boot();
    serveRfc(s, 8001);
    const out = await call({ ids: [id] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toMatchObject([{ id: 'RFC 8001', kind: 'rfc', found: true }]);
    expect(s.fetches()).toBe(3);
  });

  it.each([
    'https://www.datatracker.ietf.org/doc/rfc8001',
    'http://datatracker.ietf.org/doc/rfc8001',
    'https://www.rfc-editor.org/info/rfc8001.html',
    'https://www.rfc-editor.org/rfc/rfc8001.html/',
    'https://datatracker.ietf.org/doc/html/rfc8001.html',
    'HTTPS://DATATRACKER.IETF.ORG/DOC/RFC8001',
  ])('keeps reading %j as RFC 8001', async (id) => {
    const s = boot();
    serveRfc(s, 8001);
    expect(docs(await call({ ids: [id] }))).toMatchObject([
      { id: 'RFC 8001', kind: 'rfc', found: true },
    ]);
  });

  it.each<[string, number]>([
    ['https://tools.ietf.org/html/rfc7231', 7231],
    ['http://tools.ietf.org/html/rfc7231', 7231],
    ['tools.ietf.org/html/rfc7231', 7231],
    ['https://tools.ietf.org/html/rfc7231#section-6.5.1', 7231],
    ['HTTPS://TOOLS.IETF.ORG/HTML/RFC7231', 7231],
    ['https://tools.ietf.org/html/rfc7231/', 7231],
    ['https://tools.ietf.org/html/rfc7231?include_text=1', 7231],
    ['https://tools.ietf.org/html/rfc7231.html', 7231],
    ['https://tools.ietf.org/rfc/rfc7231.txt', 7231],
    ['https://tools.ietf.org/rfc/rfc7231', 7231],
    ['https://www.ietf.org/rfc/rfc2616.txt', 2616],
    ['http://www.ietf.org/rfc/rfc2616.txt', 2616],
    ['https://ietf.org/rfc/rfc2616.txt', 2616],
    ['https://www.ietf.org/rfc/rfc2616.html', 2616],
    ['www.ietf.org/rfc/rfc2616', 2616],
    ['https://www.rfc-editor.org/rfc/inline-errata/rfc9110.html', 9110],
    ['rfc-editor.org/rfc/inline-errata/rfc9110', 9110],
    ['rfc2616.txt', 2616],
    ['RFC2616.TXT', 2616],
    ['rfc2616.html', 2616],
    ['rfc2616.xml', 2616],
    ['rfc2616.pdf', 2616],
    ['rfc9110.json', 9110],
    ['rfc0791.txt', 791],
  ])('reads %j as RFC %i', async (id, number) => {
    const s = boot();
    serveRfc(s, number);
    const out = await call({ ids: [id] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toMatchObject([{ id: `RFC ${number}`, kind: 'rfc', found: true }]);
    expect(s.fetched()).toContain(rfcJsonUrl(number));
  });

  it('collapses an RFC URL and file name beside the RFC number into one entry', async () => {
    const s = boot();
    serveRfc(s, 7231);
    const out = await call({
      ids: ['RFC 7231', 'https://tools.ietf.org/html/rfc7231', 'rfc7231.txt'],
    });
    expect(docIds(out)).toEqual(['RFC 7231']);
    expect(s.fetches()).toBe(3);
  });

  const DRAFT_FORMS: [string, string, string | undefined][] = [
    [DRAFT, DRAFT, undefined],
    ['DRAFT-Example-WG-Topic', DRAFT, undefined],
    [`https://datatracker.ietf.org/doc/${DRAFT}/`, DRAFT, undefined],
    [`https://datatracker.ietf.org/doc/${DRAFT}`, DRAFT, undefined],
    [`datatracker.ietf.org/doc/${DRAFT}/`, DRAFT, undefined],
    [`https://datatracker.ietf.org/doc/html/${DRAFT}`, DRAFT, undefined],
    [`https://datatracker.ietf.org/doc/html/${DRAFT}/`, DRAFT, undefined],
    [`https://datatracker.ietf.org/doc/${DRAFT}/#section-1`, DRAFT, undefined],
    [`https://datatracker.ietf.org/doc/${DRAFT}/?include_text=1`, DRAFT, undefined],
    [`${DRAFT}-03`, DRAFT, '03'],
    [`https://datatracker.ietf.org/doc/${DRAFT}/03/`, DRAFT, '03'],
    [`https://datatracker.ietf.org/doc/${DRAFT}/03`, DRAFT, '03'],
    [`https://datatracker.ietf.org/doc/html/${DRAFT}/03`, DRAFT, '03'],
    [`https://datatracker.ietf.org/doc/html/${DRAFT}-03`, DRAFT, '03'],
  ];

  it.each(DRAFT_FORMS)(
    'reads %j as the draft %j (requested revision %j)',
    async (id, name, revision) => {
      const s = boot();
      if (revision) s.serve({ [docUrl(`${name}-${revision}`)]: notFound });
      serveDraft(s, name);
      const out = await call({ ids: [id] });
      expect(out.isError).toBe(false);
      expect(docs(out)).toMatchObject([{ id: name, kind: 'draft', found: true }]);
      if (revision) expect(docs(out)[0]?.draft).toMatchObject({ requested_revision: revision });
      else expect(docs(out)[0]?.draft).not.toHaveProperty('requested_revision');
    },
  );

  it.each<[string, string | undefined]>([
    [`https://tools.ietf.org/html/${DRAFT}-03`, '03'],
    [`http://tools.ietf.org/html/${DRAFT}`, undefined],
    [`https://tools.ietf.org/id/${DRAFT}-03.txt`, '03'],
    [`https://www.ietf.org/archive/id/${DRAFT}-03.html`, '03'],
    [`https://www.ietf.org/archive/id/${DRAFT}-03.txt`, '03'],
    [`https://www.ietf.org/archive/id/${DRAFT}-03.html#section-2`, '03'],
    [`ietf.org/archive/id/${DRAFT}-03.xml`, '03'],
    [`https://www.ietf.org/id/${DRAFT}-03.txt`, '03'],
    [`https://www.ietf.org/id/${DRAFT}-03.html#section-1`, '03'],
    [`http://ietf.org/id/${DRAFT}.txt`, undefined],
    [`www.ietf.org/id/${DRAFT}-03`, '03'],
    [`HTTPS://WWW.IETF.ORG/ID/${DRAFT.toUpperCase()}-03.TXT`, '03'],
    [`https://datatracker.ietf.org/doc/html/${DRAFT}-03.txt`, '03'],
    [`https://datatracker.ietf.org/doc/html/${DRAFT}-03.html`, '03'],
    [`https://datatracker.ietf.org/doc/id/${DRAFT}-03.txt`, '03'],
    [`https://datatracker.ietf.org/doc/id/${DRAFT}-03`, '03'],
    [`HTTPS://TOOLS.IETF.ORG/ID/${DRAFT.toUpperCase()}-03.TXT`, '03'],
    [`${DRAFT}-03.txt`, '03'],
    [`${DRAFT}-03.pdf`, '03'],
    [`${DRAFT}-03.json`, '03'],
    [`${DRAFT.toUpperCase()}-03.TXT`, '03'],
    [`${DRAFT}.txt`, undefined],
  ])('reads %j as the draft (requested revision %j)', async (id, revision) => {
    const s = boot();
    if (revision) s.serve({ [docUrl(`${DRAFT}-${revision}`)]: notFound });
    serveDraft(s, DRAFT);
    const out = await call({ ids: [id] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toMatchObject([{ id: DRAFT, kind: 'draft', found: true }]);
    if (revision) expect(docs(out)[0]?.draft).toMatchObject({ requested_revision: revision });
    else expect(docs(out)[0]?.draft).not.toHaveProperty('requested_revision');
  });

  it.each<[string, string | undefined]>([
    ['https://www.ietf.org/archive/id/draft-ietf-httpbis-semantics-19.html', '19'],
    ['https://www.ietf.org/id/draft-ietf-httpbis-semantics-19.txt', '19'],
    ['draft-ietf-httpbis-semantics-19.txt', '19'],
    ['draft-ietf-httpbis-semantics-19.pdf', '19'],
    ['https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-semantics-19.txt', '19'],
    ['draft-ietf-httpbis-semantics.txt', undefined],
  ])('reads %j as draft-ietf-httpbis-semantics (requested revision %j)', async (id, revision) => {
    const s = boot();
    const name = 'draft-ietf-httpbis-semantics';
    s.serve({ [docUrl(`${name}-19`)]: notFound });
    serveDraft(s, name, { doc: () => jsonResponse(draftDocJson(name, { rev: '19' })) });
    const [doc] = docs(await call({ ids: [id] }));
    expect(doc).toMatchObject({ id: name, kind: 'draft', found: true, draft: { rev: '19' } });
    expect(doc?.draft?.requested_revision).toBe(revision);
    expect(doc).not.toHaveProperty('guidance');
  });

  it('collapses a draft URL and file name beside the draft name into one entry', async () => {
    const s = boot();
    serveDraft(s, DRAFT);
    const out = await call({
      ids: [DRAFT, `https://tools.ietf.org/html/${DRAFT}`, `${DRAFT}.txt`],
    });
    expect(docIds(out)).toEqual([DRAFT]);
    expect(s.fetches()).toBe(3);
  });

  it('reads a bare number given as a JSON number', async () => {
    const s = boot();
    serveRfc(s, 8001);
    expect(docIds(await call({ ids: [8001] }))).toEqual(['RFC 8001']);
  });

  it.each([
    '2616.txt',
    'rfc8001.doc',
    `${DRAFT}-03.doc`,
    'https://www.rfc-editor.org/errata/rfc8001',
    'https://www.rfc-editor.org/rfc/pdfrfc/rfc8001.txt.pdf',
    'https://tools.ietf.org/html/rfc8001.html/extra',
    'https://example.org/html/rfc8001',
    'ftp://tools.ietf.org/html/rfc8001',
    'BCP',
    'BCP 0',
    'BCP 14a',
    'XYZ 14',
    'ISO 639',
  ])('keeps reading %j as unsupported, with no fetch', async (id) => {
    const s = boot();
    const out = await call({ ids: [id] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toMatchObject([{ id, kind: 'unsupported', found: false }]);
    expect(s.fetches()).toBe(0);
  });

  it.each([
    `https://www.ietf.org.example.com/id/${DRAFT}-03.txt`,
    `https://evil.ietf.org/id/${DRAFT}-03.txt`,
    `https://user@www.ietf.org/id/${DRAFT}-03.txt`,
    `https://www.ietf.org@evil.example/id/${DRAFT}-03.txt`,
    `https://evil.example/www.ietf.org/id/${DRAFT}-03.txt`,
    `https://www.ietf.org/ids/${DRAFT}-03.txt`,
    'https://www.ietf.org/id/rfc8001.txt',
    'https://www.ietf.org/id/bcp14',
    'https://datatracker.ietf.org.example.com/doc/bcp14/',
    'https://user@datatracker.ietf.org/doc/bcp14/',
    'https://www.datatracker.ietf.org/doc/bcp14/',
    'https://datatracker.ietf.org/doc/html/bcp14',
    'https://datatracker.ietf.org/doc/bcp-14/',
    'https://datatracker.ietf.org/doc/bcp0/',
    'https://www.rfc-editor.org.example.com/info/bcp14',
    'https://example.org/info/bcp14',
    'https://www.rfc-editor.org/info/bcp',
    'https://www.rfc-editor.org/info/bcp14a',
    'https://www.rfc-editor.org/info/xyz14',
    'https://www.rfc-editor.org/rfc/bcp/bcp14.txt',
    'https://tools.ietf.org/html/bcp14',
    'bcp14.txt',
    'rfc2616.txt#page-3',
  ])('reads the near-miss %j as unsupported, with no fetch', async (id) => {
    const s = boot();
    const out = await call({ ids: [id] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toMatchObject([{ id, kind: 'unsupported', found: false }]);
    expect(s.fetches()).toBe(0);
  });

  it.each([
    ['hello world'],
    ['RFC 0'],
    ['0'],
    ['123456'],
    ['RFC 100000'],
    ['rfc'],
    ['draft-'],
    ['draft_example'],
    ['RFC 12a'],
    ['2616.txt'],
    ['https://example.org/rfc/rfc8001.html'],
    ['https://www.rfc-editor.org/rfc/rfc8001.html/extra'],
    ['https://www.rfc-editor.org/rfc/std97.html'],
  ])('reads %j as unsupported, with guidance naming the accepted forms', async (id) => {
    const s = boot();
    const out = await call({ ids: [id] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toEqual([
      {
        id,
        kind: 'unsupported',
        found: false,
        guidance: `${id} is not an RFC, Internet-Draft, or BCP/STD/FYI id. Pass an RFC number ("RFC 9110"), a draft name ("draft-ietf-httpbis-semantics-19"), a series number ("BCP 14"), an RFC or draft file name ("rfc9110.txt"), or the URL of an RFC or draft on datatracker.ietf.org, tools.ietf.org, or ietf.org, of an RFC on rfc-editor.org, or of a series at rfc-editor.org/info/ or datatracker.ietf.org/doc/.`,
      },
    ]);
    expect(s.fetches()).toBe(0);
  });

  it('accepts a five-digit RFC number', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    expect(docIds(await call({ ids: ['RFC 99999'] }))).toEqual(['RFC 99999']);
  });
});

describe('iana_get_rfc_status: ids input', () => {
  it.each([
    ['commas', 'RFC 8001, RFC 8002'],
    ['semicolons', 'RFC 8001;RFC 8002'],
    ['newlines', 'RFC 8001\nRFC 8002'],
    ['mixed delimiters with blanks', 'RFC 8001,, ;\n RFC 8002 ,'],
    ['an array with blanks and padding', ['  RFC 8001 ', '', '   ', 'RFC 8002']],
  ])('reads %s as two ids', async (_label, ids) => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002);
    const out = await call({ ids });
    expect(docIds(out)).toEqual(['RFC 8001', 'RFC 8002']);
  });

  it('reads a single id string', async () => {
    const s = boot();
    serveRfc(s, 8001);
    expect(docIds(await call({ ids: 'RFC 8001' }))).toEqual(['RFC 8001']);
  });

  it('does not split a string that starts with [ on commas: the JSON array reads whole', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002);
    const out = await call({ ids: '["RFC 8001", "RFC 8002"]' });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 8001', 'RFC 8002']);
    expect(docs(out).every((doc) => doc.kind === 'rfc')).toBe(true);
  });

  it('accepts ten ids and rejects eleven', async () => {
    const s = boot();
    for (let n = 1; n <= 11; n++) serveRfc(s, n, { rfc: notFound, tracking: notFound });
    const ten = await call({ ids: Array.from({ length: 10 }, (_, i) => `RFC ${i + 1}`) });
    expect(ten.isError).toBe(false);
    expect(docs(ten)).toHaveLength(10);

    const eleven = await call({ ids: Array.from({ length: 11 }, (_, i) => `RFC ${i + 1}`) });
    expect(eleven.isError).toBe(true);
    expect(eleven.structured.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
  });

  it('fails a list far over the maximum with one bounded issue', async () => {
    boot();
    const out = await call({ ids: Array.from({ length: 80 }, (_, i) => `RFC ${i + 1}`) });
    expect(out.structured.error).toMatchObject({ data: { reason: 'invalid_arguments' } });
    const issues = (out.structured.error as { data: { issues: unknown[] } }).data.issues;
    expect(issues).toHaveLength(1);
  });

  it('counts the ten-id cap after blanks are dropped', async () => {
    const s = boot();
    for (let n = 1; n <= 10; n++) serveRfc(s, n, { rfc: notFound, tracking: notFound });
    const ids = Array.from({ length: 10 }, (_, i) => `RFC ${i + 1}`).join(',,,');
    const out = await call({ ids });
    expect(out.isError).toBe(false);
    expect(docs(out)).toHaveLength(10);
  });

  it.each([
    ['no ids', {}],
    ['an empty array', { ids: [] }],
    ['an empty string', { ids: '' }],
    ['only delimiters', { ids: ',;\n' }],
    ['an array of blanks', { ids: ['', '  '] }],
    ['an id over 200 characters', { ids: ['x'.repeat(201)] }],
    [
      'a URL over 200 characters before its fragment',
      { ids: [`https://tools.ietf.org/html/${'a'.repeat(200)}#x`] },
    ],
    [
      'a file name whose fragment takes it over 200 characters',
      { ids: [`rfc2616.txt#${'x'.repeat(200)}`] },
    ],
  ])('rejects %s as invalid arguments, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(s.fetches()).toBe(0);
  });

  it('reads a URL whose fragment runs past 200 characters as its RFC, beside the other ids', async () => {
    const s = boot();
    serveRfc(s, 2119);
    serveRfc(s, 7231);
    const out = await call({
      ids: ['RFC 2119', `https://tools.ietf.org/html/rfc7231#${'x'.repeat(300)}`],
    });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 2119', 'RFC 7231']);
    expect(failed(out)).toEqual([]);
  });

  it('reads a series URL whose query runs past 200 characters, in a comma-separated string', async () => {
    boot();
    const out = await call({
      ids: `BCP 14, https://datatracker.ietf.org/doc/std7/?${'a=1&'.repeat(80)}`,
    });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['BCP 14', 'STD 7']);
  });

  it('echoes an unsupported URL without its query', async () => {
    const s = boot();
    const out = await call({
      ids: [`https://example.org/rfc/rfc8001.html?ref=${'x'.repeat(250)}`],
    });
    expect(docs(out)).toMatchObject([
      { id: 'https://example.org/rfc/rfc8001.html', kind: 'unsupported', found: false },
    ]);
    expect(out.text).toContain('### https://example.org/rfc/rfc8001.html\n');
    expect(s.fetches()).toBe(0);
  });
});

describe('iana_get_rfc_status: one document, one fetch', () => {
  it('resolves every spelling of one RFC once', async () => {
    const s = boot();
    serveRfc(s, 8001);
    const out = await call({
      ids: [
        'RFC 8001',
        '8001',
        'rfc8001',
        'https://www.rfc-editor.org/rfc/rfc8001.html',
        'RFC-8001',
      ],
    });
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(s.fetches()).toBe(3);
  });

  it('resolves every spelling of one draft once', async () => {
    const s = boot();
    serveDraft(s, DRAFT);
    const out = await call({
      ids: [DRAFT, 'DRAFT-EXAMPLE-WG-TOPIC', `https://datatracker.ietf.org/doc/${DRAFT}/`],
    });
    expect(docIds(out)).toEqual([DRAFT]);
    expect(s.fetches()).toBe(3);
  });

  it('keeps request order by first occurrence', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002);
    serveDraft(s, DRAFT);
    const out = await call({ ids: [DRAFT, 'RFC 8002', 'ISO 639', 'RFC 8001', '8002', 'ISO 639'] });
    expect(docIds(out)).toEqual([DRAFT, 'RFC 8002', 'ISO 639', 'RFC 8001']);
  });

  it('keeps the first spelling when ids differ only in case', async () => {
    boot();
    const out = await call({ ids: ['ISO 639', 'iso 639'] });
    expect(docIds(out)).toEqual(['ISO 639']);
    expect(docs(out)).toHaveLength(1);
  });

  it('keeps a single failure single when the id repeats', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 8001', 'RFC 8002', '8002'] });
    expect(failed(out).map((failure) => failure.id)).toEqual(['RFC 8002']);
    expect(docIds(out)).toEqual(['RFC 8001']);
  });
});

describe('iana_get_rfc_status: partial failure', () => {
  it('sends an id whose RFC Editor read failed to failed[] and still answers the rest', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 8002', 'RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(failed(out)).toEqual([{ id: 'RFC 8002', error: expect.any(String) }]);
    expect(failed(out)[0]?.error).not.toBe('');
    expect(out.text).toContain('### Failed');
    expect(out.text).toContain(`- RFC 8002: ${failed(out)[0]?.error}`);
  });

  it('marks a refused redirect retryable: false and leaves a transient failure unmarked, in both surfaces', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002, { rfc: () => redirectResponse('https://evil.example/rfc8002.json') });
    serveRfc(s, 8003, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 8001', 'RFC 8002', 'RFC 8003'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(failed(out)).toEqual([
      {
        id: 'RFC 8002',
        error: `www.rfc-editor.org redirected ${rfcJsonUrl(8002)} to https://evil.example, outside the https upstream hosts this server reads.`,
        reason: 'upstream_unreadable',
        retryable: false,
      },
      { id: 'RFC 8003', error: expect.stringContaining('503') },
    ]);
    expect(s.fetched().filter((url) => url.includes('evil.example'))).toEqual([]);
    expect(out.text).toContain(
      `- RFC 8002: ${failed(out)[0]?.error} (upstream_unreadable, retryable: false)`,
    );
    expect(out.text.split('\n')).toContain(`- RFC 8003: ${failed(out)[1]?.error}`);
    expect(out.text.split('\n').filter((line) => line.includes('retryable'))).toHaveLength(1);
    expect(missingFromText(out.structured, out.text)).toEqual([]);
  });

  it('fails a body over its ceiling after one request, retryable: false, and a wrong content type after one request with retryable left out, in both surfaces', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002, {
      rfc: () =>
        streamResponse([new Uint8Array(RFC_JSON_MAX_BYTES + 1).fill(32)], 'application/json'),
    });
    serveRfc(s, 8003, { rfc: () => htmlResponse('<html>maintenance</html>') });
    const out = await call({ ids: ['RFC 8001', 'RFC 8002', 'RFC 8003'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(failed(out)).toEqual([
      {
        id: 'RFC 8002',
        error: `www.rfc-editor.org sent more than ${RFC_JSON_MAX_BYTES} bytes for ${rfcJsonUrl(8002)}.`,
        reason: 'upstream_unreadable',
        retryable: false,
      },
      {
        id: 'RFC 8003',
        error: 'www.rfc-editor.org answered with text/html where json was expected.',
        reason: 'upstream_unreadable',
      },
    ]);
    expect(s.fetched().filter((url) => url === rfcJsonUrl(8002))).toHaveLength(1);
    expect(s.fetched().filter((url) => url === rfcJsonUrl(8003))).toHaveLength(1);
    expect(out.text.split('\n')).toContain(
      `- RFC 8002: ${failed(out)[0]?.error} (upstream_unreadable, retryable: false)`,
    );
    expect(out.text.split('\n')).toContain(
      `- RFC 8003: ${failed(out)[1]?.error} (upstream_unreadable)`,
    );
    expect(missingFromText(out.structured, out.text)).toEqual([]);
  });

  it('sends an unreadable RFC Editor answer to failed[] with the reason in the message', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002, {
      rfc: () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    });
    const out = await call({ ids: ['RFC 8001', 'RFC 8002'] });
    expect(failed(out)).toHaveLength(1);
    expect(failed(out)[0]?.error).toContain('malformed JSON');
  });

  it('sends an upstream timeout to failed[]', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002, { rfc: hang });
    const out = await call({ ids: ['RFC 8001', 'RFC 8002'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(failed(out).map((failure) => failure.id)).toEqual(['RFC 8002']);
  });

  it('sends a draft with a failed relateddocument read to failed[], never to empty relation lists', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveDraft(s, DRAFT, { incoming: () => statusResponse(503) });
    const out = await call({ ids: [DRAFT, 'RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(failed(out).map((failure) => failure.id)).toEqual([DRAFT]);
    expect(JSON.stringify(out.structured.documents)).not.toContain('replaced_by');
  });

  it('sends a draft whose outgoing relateddocument page is malformed to failed[]', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveDraft(s, DRAFT, { outgoing: () => jsonResponse({ meta: {} }) });
    const out = await call({ ids: [DRAFT, 'RFC 8001'] });
    expect(failed(out).map((failure) => failure.id)).toEqual([DRAFT]);
    expect(failed(out)[0]?.error).toContain('unexpected shape');
  });

  it('sends a draft whose incoming relateddocument page says more edges follow to failed[]', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveDraft(s, DRAFT, {
      incoming: () => jsonResponse(pagedRelated(edge('replaces', 'draft-example-wg-newer', DRAFT))),
    });
    const out = await call({ ids: [DRAFT, 'RFC 8001'] });
    expect(docIds(out)).toEqual(['RFC 8001']);
    expect(failed(out)).toEqual([
      { id: DRAFT, error: expect.stringContaining('more pages'), reason: 'upstream_unreadable' },
    ]);
  });

  it('sends a draft missing rev, state, or time to failed[], with its reason', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveDraft(s, DRAFT, { doc: () => jsonResponse(draftDocJson(DRAFT, { rev: null })) });
    const out = await call({ ids: [DRAFT, 'RFC 8001'] });
    expect(failed(out)).toEqual([
      {
        id: DRAFT,
        error: expect.stringContaining('lacks its revision'),
        reason: 'upstream_unreadable',
      },
    ]);
    expect(out.text).toContain(`- ${DRAFT}: ${failed(out)[0]?.error} (upstream_unreadable)`);
  });

  it('files a failed draft under the id as requested, revision included', async () => {
    const s = boot();
    serveRfc(s, 8001);
    s.serve({ [docUrl(`${DRAFT}-07`)]: () => statusResponse(503) });
    const out = await call({ ids: [`${DRAFT}-07`, 'RFC 8001'] });
    expect(failed(out).map((failure) => failure.id)).toEqual([`${DRAFT}-07`]);
  });

  it('answers found: false and unsupported ids beside a failed one', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    serveRfc(s, 8002, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 99999', 'ISO 639', 'RFC 8002'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 99999', 'ISO 639']);
    expect(failed(out).map((failure) => failure.id)).toEqual(['RFC 8002']);
  });

  it('answers a call mixing a miss, an unsupported id, and an empty series without failures', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    const out = await call({ ids: ['ISO 639', 'RFC 99999', 'BCP 9999'] });
    expect(out.structured).toMatchObject({ failed: [] });
    expect(docs(out).map((doc) => [doc.id, doc.kind, doc.found])).toEqual([
      ['ISO 639', 'unsupported', false],
      ['RFC 99999', 'rfc', false],
      ['BCP 9999', 'series', false],
    ]);
  });
});

describe('iana_get_rfc_status: every id failed upstream', () => {
  it('rethrows an unreadable answer with the contract reason and recovery in both surfaces', async () => {
    const s = boot();
    serveRfc(s, 8001, { rfc: () => htmlResponse('<html/>') });
    serveRfc(s, 8002, { rfc: () => htmlResponse('<html/>') });
    const out = await call({ ids: ['RFC 8001', 'RFC 8002'] });
    expect(out.isError).toBe(true);
    expect(out.structured).not.toHaveProperty('documents');
    expect(out.structured).not.toHaveProperty('failed');
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable', recovery: { hint: UNREADABLE_HINT } },
    });
    expect(out.text).toContain(`Recovery: ${UNREADABLE_HINT}`);
    expect(out.text).toContain('reason upstream_unreadable');
  });

  it('rethrows the first failure in request order', async () => {
    const s = boot();
    serveRfc(s, 8001, { rfc: () => statusResponse(429, { 'retry-after': '1' }) });
    serveRfc(s, 8002, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 8001', 'RFC 8002'] });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { status: 429, retryAfter: '1' },
    });
  });

  it('rethrows a 503 as ServiceUnavailable for a single id', async () => {
    const s = boot();
    serveRfc(s, 8001, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 8001'] });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503, retryAttempts: 3 },
    });
  });

  it('rethrows a timeout', async () => {
    const s = boot();
    serveRfc(s, 8001, { rfc: hang });
    const out = await call({ ids: ['RFC 8001'] });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });
  });

  it('rethrows when the only id is a draft whose relateddocument read failed', async () => {
    const s = boot();
    serveDraft(s, DRAFT, { outgoing: () => statusResponse(503) });
    const out = await call({ ids: [DRAFT] });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });

  it('does not rethrow when an unsupported id is beside the failures', async () => {
    const s = boot();
    serveRfc(s, 8001, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['ISO 639', 'RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['ISO 639']);
    expect(failed(out).map((failure) => failure.id)).toEqual(['RFC 8001']);
  });

  it('does not rethrow when a not-found id is beside the failures', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    serveRfc(s, 8001, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 99999', 'RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(docs(out)[0]).toMatchObject({ id: 'RFC 99999', found: false });
    expect(failed(out)).toHaveLength(1);
  });
});

describe('iana_get_rfc_status: cancellation', () => {
  it('rejects as RequestCancelled with no per-id failures when the caller aborts mid-call', async () => {
    const s = boot();
    serveRfc(s, 8001, { rfc: hang, tracking: hang });
    serveRfc(s, 8002, { rfc: hang, tracking: hang });
    const controller = new AbortController();
    const pending = callTool(
      getRfcStatus,
      { ids: ['RFC 8001', 'RFC 8002'] },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('client went away'));
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'client went away',
    });
    expect(out.structured).not.toHaveProperty('failed');
    expect(out.structured).not.toHaveProperty('documents');
    expect(out.text).not.toContain('### Failed');
  });

  it('does not report the aborted ids as failures even when other ids already answered', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveRfc(s, 8002, { rfc: hang, tracking: hang });
    const controller = new AbortController();
    const pending = callTool(
      getRfcStatus,
      { ids: ['RFC 8001', 'RFC 8002'] },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('client went away'));
    const out = await pending;
    expect(out.structured.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(out.structured).not.toHaveProperty('failed');
  });

  it('rejects as RequestCancelled when the signal is already aborted', async () => {
    const s = boot();
    serveRfc(s, 8001);
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    const out = await callTool(
      getRfcStatus,
      { ids: ['ISO 639'] },
      { context: { signal: controller.signal } },
    );
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });
});

describe('iana_get_rfc_status: warning logs', () => {
  /** Runs the handler on a mock context, which `callTool` hides, so the test can read its log. */
  async function runHandler(ids: string[], signal?: AbortSignal) {
    const ctx = createMockContext({ errors: getRfcStatus.errors, ...(signal ? { signal } : {}) });
    const outcome = await settle(async () => getRfcStatus.handler({ ids }, ctx));
    const warnings = (ctx.log as MockContextLogger).calls
      .filter((entry) => entry.level === 'warning')
      .map((entry) => entry.msg);
    return { outcome, warnings };
  }

  it('warns once when the series membership read fails', async () => {
    const s = boot();
    serveRfc(s, 8001);
    s.serve({ [membershipUrl(8001)]: () => statusResponse(503) });
    const { outcome, warnings } = await runHandler(['RFC 8001']);
    expect(outcome.error).toBeUndefined();
    expect(warnings).toEqual(['Datatracker series membership lookup failed']);
  });

  it('warns when Datatracker fails for an RFC the RFC Editor answered', async () => {
    const s = boot();
    serveRfc(s, 8001, { tracking: () => statusResponse(503) });
    const { outcome, warnings } = await runHandler(['RFC 8001']);
    expect(outcome.error).toBeUndefined();
    expect(warnings).toEqual(['Datatracker lookup failed for an RFC']);
  });

  it.each<[string, { membership: Answer; tracking?: Answer }]>([
    ['the membership and tracking reads hang', { membership: hang, tracking: hang }],
    ["the membership read waits out a retry's backoff", { membership: () => statusResponse(503) }],
  ])('logs no warning when the caller cancels while %s', async (_label, answers) => {
    const s = boot();
    serveRfc(s, 8001, answers.tracking ? { tracking: answers.tracking } : {});
    s.serve({ [membershipUrl(8001)]: answers.membership });
    const controller = new AbortController();
    const pending = runHandler(['RFC 8001'], controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.fetched()).toContain(rfcJsonUrl(8001));
    expect(s.fetched()).toContain(membershipUrl(8001));
    controller.abort(new Error('client went away'));
    const { outcome, warnings } = await pending;
    expect(outcome.error).toMatchObject({ message: 'client went away' });
    expect(warnings).toEqual([]);
  });
});

describe('iana_get_rfc_status: pacer_shed', () => {
  const rfcEditorShed = () =>
    boot({
      pacing: {
        ...PERMISSIVE_PACING,
        'rfc-editor': { name: 'rfc-editor', maxConcurrent: 1, maxQueueDepth: 0 },
      },
    });
  const datatrackerShed = () =>
    boot({
      pacing: {
        ...PERMISSIVE_PACING,
        datatracker: { name: 'datatracker', maxConcurrent: 1, maxQueueDepth: 0 },
      },
    });

  /** Occupies the host's only slot with a request that never answers; abort it to free the slot. */
  function occupy(s: Setup, url: string) {
    const controller = new AbortController();
    s.serve({ [url]: hang });
    s.client
      .request(url, {
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

  const shedError = {
    code: JsonRpcErrorCode.RateLimited,
    data: {
      reason: 'pacer_shed',
      shedKind: 'queue_full',
      retryAfter: expect.any(Number),
      recovery: { hint: SHED_HINT },
    },
  };

  it('a full RFC Editor queue sheds the call as RateLimited with retryAfter and the recovery', async () => {
    const s = rfcEditorShed();
    serveRfc(s, 8001);
    const occupant = occupy(s, 'https://www.rfc-editor.org/rfc/rfc1.json');
    await vi.advanceTimersByTimeAsync(10);

    const out = await call({ ids: ['RFC 8001'] });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject(shedError);
    expect(out.text).toContain(`Recovery: ${SHED_HINT}`);
    expect(out.text).toContain('reason pacer_shed');
    expect(s.fetched()).not.toContain(rfcJsonUrl(8001));
    occupant.abort(new Error('test done'));
  });

  it('a full Datatracker queue sheds a draft call the same way', async () => {
    const s = datatrackerShed();
    serveDraft(s, DRAFT);
    const occupant = occupy(s, docUrl('draft-example-occupant'));
    await vi.advanceTimersByTimeAsync(10);

    const out = await call({ ids: [DRAFT] });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject(shedError);
    expect(out.text).toContain(`Recovery: ${SHED_HINT}`);
    expect(s.fetched()).toEqual([docUrl('draft-example-occupant')]);
    occupant.abort(new Error('test done'));
  });

  it('a shed Datatracker queue only costs an RFC its stream, group, and series', async () => {
    const s = datatrackerShed();
    serveRfc(s, 8001);
    const occupant = occupy(s, docUrl('draft-example-occupant'));
    await vi.advanceTimersByTimeAsync(10);

    const out = await call({ ids: ['RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(failed(out)).toEqual([]);
    expect(docs(out)[0]?.found).toBe(true);
    expect(docs(out)[0]?.rfc).not.toHaveProperty('stream');
    expect(docs(out)[0]?.rfc).not.toHaveProperty('is_also');
    expect(out.structured.notice).toContain(
      'Stream and working group were unavailable for RFC 8001',
    );
    expect(out.structured.notice).toContain('Series membership was unavailable for RFC 8001');
    occupant.abort(new Error('test done'));
  });

  it('a shed RFC Editor queue fails only the RFC ids, leaving a draft answered', async () => {
    const s = rfcEditorShed();
    serveRfc(s, 8001);
    serveDraft(s, DRAFT);
    const occupant = occupy(s, 'https://www.rfc-editor.org/rfc/rfc1.json');
    await vi.advanceTimersByTimeAsync(10);

    const out = await call({ ids: ['RFC 8001', DRAFT] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual([DRAFT]);
    expect(failed(out).map((failure) => failure.id)).toEqual(['RFC 8001']);
    occupant.abort(new Error('test done'));
  });

  it('serves the next call once the slot is free: a shed starts no hold', async () => {
    const s = rfcEditorShed();
    serveRfc(s, 8001);
    const occupant = occupy(s, 'https://www.rfc-editor.org/rfc/rfc1.json');
    await vi.advanceTimersByTimeAsync(10);
    expect((await call({ ids: ['RFC 8001'] })).isError).toBe(true);

    occupant.abort(new Error('slot freed'));
    await vi.advanceTimersByTimeAsync(10);
    const out = await call({ ids: ['RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(docs(out)[0]?.found).toBe(true);
  });
});

describe('iana_get_rfc_status: request_limit', () => {
  const DRAFTS = [...'abcdefghij'].map((letter) => `draft-example-wg-${letter}`);
  /** The same drafts asked for at revision 07, which Datatracker answers 404 before the plain name is read. */
  const SUFFIXED = DRAFTS.map((name) => `${name}-07`);
  const RFCS = Array.from({ length: 10 }, (_, index) => 8001 + index);
  const LIMIT_HINT =
    'Call iana_get_rfc_status again with just the ids that failed with request_limit.';
  const LIMIT_MESSAGE =
    "Not resolved within this call's limit of 20 Datatracker requests. Call iana_get_rfc_status again with this id.";
  const datatrackerFetches = (s: Setup) =>
    s.fetched().filter((url) => url.startsWith('https://datatracker.ietf.org/')).length;
  const limitFailures = (ids: readonly string[]) =>
    ids.map((id) => ({ id, error: LIMIT_MESSAGE, reason: 'request_limit', retryable: true }));
  /** Serves draft `name` asked for as `name-07`: a 404 for the suffixed name, then the plain draft. */
  const serveSuffixed = (s: Setup, name: string) => {
    s.serve({ [docUrl(`${name}-07`)]: notFound });
    serveDraft(s, name);
  };

  it('declares request_limit as retryable RateLimited, its when text naming the 20-request limit', () => {
    expect(DATATRACKER_CALL_REQUESTS).toBe(20);
    const entry = getRfcStatus.errors?.find((candidate) => candidate.reason === 'request_limit');
    expect(entry).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      recovery: LIMIT_HINT,
    });
    expect(entry?.when).toContain('20 Datatracker requests');
  });

  it('takes six plain drafts on 18 requests and returns the four that do not fit in failed, unrequested', async () => {
    const s = boot();
    for (const name of DRAFTS) serveDraft(s, name);
    const out = await call({ ids: DRAFTS });
    expect(out.isError).toBe(false);
    expect(datatrackerFetches(s)).toBe(18);
    expect(docIds(out)).toEqual(DRAFTS.slice(0, 6));
    const cut = DRAFTS.slice(6);
    expect(failed(out)).toEqual(limitFailures(cut));
    expect(s.fetched().filter((url) => cut.some((name) => url.includes(name)))).toEqual([]);
    expect(out.structured.notice).toBe(
      `${cut.join(', ')} were not resolved within this call's limit of 20 Datatracker requests; call iana_get_rfc_status again with them.`,
    );
    expect(out.text).toContain(String(out.structured.notice));
    expect(out.text).toContain(`- ${cut[0]}: ${LIMIT_MESSAGE} (request_limit, retryable: true)`);
  });

  it('takes five drafts given with a revision suffix, four requests each', async () => {
    const s = boot();
    for (const name of DRAFTS) serveSuffixed(s, name);
    const out = await call({ ids: SUFFIXED });
    expect(out.isError).toBe(false);
    expect(datatrackerFetches(s)).toBe(20);
    expect(docIds(out)).toEqual(DRAFTS.slice(0, 5));
    expect(docs(out).map((doc) => doc.draft?.requested_revision)).toEqual(Array(5).fill('07'));
    expect(failed(out)).toEqual(limitFailures(SUFFIXED.slice(5)));
  });

  it('takes a mixed list in request order, passing over an id that does not fit for a later one that does', async () => {
    const s = boot();
    const plain = DRAFTS.slice(0, 4);
    for (const n of [8001, 8002, 8003]) serveRfc(s, n);
    for (const name of plain) serveDraft(s, name);
    serveSuffixed(s, 'draft-example-wg-g');
    serveSuffixed(s, 'draft-example-wg-h');
    /**
     * Planned: RFC 8001 2 (its read and the call's membership read), four plain
     * drafts 14, draft g with a suffix 18, draft h with a suffix 22 (over),
     * RFC 8002 19, BCP 14 20, RFC 8003 21 (over).
     */
    const out = await call({
      ids: [
        'RFC 8001',
        ...plain,
        'draft-example-wg-g-07',
        'draft-example-wg-h-07',
        'RFC 8002',
        'BCP 14',
        'RFC 8003',
      ],
    });
    expect(out.isError).toBe(false);
    expect(datatrackerFetches(s)).toBe(20);
    expect(docIds(out)).toEqual(['RFC 8001', ...plain, 'draft-example-wg-g', 'RFC 8002', 'BCP 14']);
    expect(failed(out)).toEqual(limitFailures(['draft-example-wg-h-07', 'RFC 8003']));
    expect(s.fetched()).not.toContain(rfcJsonUrl(8003));
    expect(s.fetched()).toContain(membershipUrl(8001, 8002));
  });

  it('plans ten RFCs at 11 requests: one each, and one membership read for the call', async () => {
    const s = boot();
    for (const n of RFCS) serveRfc(s, n);
    const out = await call({ ids: RFCS.map((n) => `RFC ${n}`) });
    expect(datatrackerFetches(s)).toBe(11);
    expect(failed(out)).toEqual([]);
    expect(s.fetched().filter(isContainsRead)).toEqual([membershipUrl(...RFCS)]);
  });

  it('takes six plain drafts and one RFC on 20 planned requests, passing over a second RFC', async () => {
    const s = boot();
    const plain = DRAFTS.slice(0, 6);
    for (const name of plain) serveDraft(s, name);
    serveRfc(s, 8001);
    serveRfc(s, 8002);
    const out = await call({ ids: [...plain, 'RFC 8001', 'RFC 8002'] });
    expect(out.isError).toBe(false);
    expect(datatrackerFetches(s)).toBe(20);
    expect(docIds(out)).toEqual([...plain, 'RFC 8001']);
    expect(failed(out)).toEqual(limitFailures(['RFC 8002']));
    expect(s.fetched()).toContain(membershipUrl(8001));
    expect(s.fetched()).not.toContain(rfcJsonUrl(8002));
  });

  it('takes two RFCs and five plain drafts when the RFCs come first, passing over the sixth draft', async () => {
    const s = boot();
    const plain = DRAFTS.slice(0, 6);
    for (const name of plain) serveDraft(s, name);
    serveRfc(s, 8001);
    serveRfc(s, 8002);
    const out = await call({ ids: ['RFC 8001', 'RFC 8002', ...plain] });
    expect(datatrackerFetches(s)).toBe(18);
    expect(docIds(out)).toEqual(['RFC 8001', 'RFC 8002', ...plain.slice(0, 5)]);
    expect(failed(out)).toEqual(limitFailures([plain[5] as string]));
  });

  it('plans a series id at one request', async () => {
    const s = boot();
    const plain = DRAFTS.slice(0, 6);
    for (const name of plain) serveDraft(s, name);
    const out = await call({ ids: ['BCP 14', ...plain, 'STD 7', 'FYI 36'] });
    expect(out.isError).toBe(false);
    expect(datatrackerFetches(s)).toBe(20);
    expect(docIds(out)).toEqual(['BCP 14', ...plain, 'STD 7']);
    expect(failed(out)).toEqual(limitFailures(['FYI 36']));
    expect(s.fetched()).not.toContain(seriesUrl('fyi36'));
  });

  it('makes progress on every call: the ids one call left out resolve on the next', async () => {
    const s = boot();
    for (const name of DRAFTS) serveSuffixed(s, name);
    const first = await call({ ids: SUFFIXED });
    const cut = failed(first).map((failure) => failure.id);
    expect(cut).toEqual(SUFFIXED.slice(5));
    const second = await call({ ids: cut });
    expect(second.isError).toBe(false);
    expect(failed(second)).toEqual([]);
    expect(docIds(second)).toEqual(DRAFTS.slice(5));
  });

  it('names one cut id in the singular, ahead of the stream-and-group fragment', async () => {
    const s = boot();
    const drafts = DRAFTS.slice(0, 7);
    for (const name of drafts) serveDraft(s, name);
    serveRfc(s, 8001, { tracking: notFound });
    const out = await call({ ids: [...drafts, 'RFC 8001'] });
    expect(datatrackerFetches(s)).toBe(20);
    expect(failed(out)).toEqual(limitFailures(['draft-example-wg-g']));
    expect(out.structured.notice).toBe(
      "draft-example-wg-g was not resolved within this call's limit of 20 Datatracker requests; call iana_get_rfc_status again with it. Stream and working group were unavailable for RFC 8001; status and relations come from the RFC Editor.",
    );
  });

  it('counts every retry: a failing Datatracker gets 20 requests, not three per RFC', async () => {
    const s = boot();
    for (const n of RFCS) serveRfc(s, n, { tracking: () => statusResponse(503) });
    const out = await call({ ids: RFCS.map((n) => `RFC ${n}`) });
    expect(out.isError).toBe(false);
    expect(datatrackerFetches(s)).toBe(20);
    expect(docs(out).every((doc) => doc.found && doc.rfc?.stream === undefined)).toBe(true);
    expect(failed(out)).toEqual([]);
    expect(out.structured.notice).toContain(
      'Stream and working group were unavailable for RFC 8001',
    );
  });

  it('answers ten RFCs inside the limit with no request_limit failure', async () => {
    const s = boot();
    for (const n of RFCS) serveRfc(s, n);
    const out = await call({ ids: RFCS.map((n) => `RFC ${n}`) });
    expect(failed(out)).toEqual([]);
    expect(docs(out).every((doc) => doc.rfc?.stream === 'IETF')).toBe(true);
    expect(docs(out).every((doc) => Array.isArray(doc.rfc?.is_also))).toBe(true);
  });

  it('fails the call with the upstream error, not request_limit, when every admitted draft fails upstream', async () => {
    const s = boot();
    for (const name of DRAFTS) serveDraft(s, name, { doc: () => statusResponse(503) });
    const out = await call({ ids: DRAFTS });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503, retryAttempts: 3 },
    });
    expect(datatrackerFetches(s)).toBe(18);
  });

  it('fails the call with request_limit when retries against a failing Datatracker cut every admitted id', async () => {
    const s = boot();
    const failing = () => statusResponse(503);
    for (const name of DRAFTS) serveDraft(s, name, { outgoing: failing, incoming: failing });
    const out = await call({ ids: DRAFTS });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      message: LIMIT_MESSAGE,
      data: { reason: 'request_limit', recovery: { hint: LIMIT_HINT } },
    });
    expect(out.text).toContain(`Recovery: ${LIMIT_HINT}`);
    expect(datatrackerFetches(s)).toBe(20);
  });

  it('gives each call its own 20 requests', async () => {
    const s = boot();
    for (const name of DRAFTS) serveDraft(s, name);
    const first = await call({ ids: DRAFTS });
    const cut = failed(first).map((failure) => failure.id);
    const second = await call({ ids: cut });
    expect(second.isError).toBe(false);
    expect(failed(second)).toEqual([]);
    expect(docIds(second).sort()).toEqual(cut);
  });
});

describe('iana_get_rfc_status: enrichment contract', () => {
  it('zero-result page (no document found): the page parses with no notice', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    const out = await call({ ids: ['RFC 99999'] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toMatchObject([{ found: false }]);
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('zero-result page (only an unsupported id): the page parses with no notice', async () => {
    boot();
    const out = await call({ ids: ['ISO 639'] });
    expect(out.isError).toBe(false);
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('zero-result page (only a series with no members): the page parses with no notice', async () => {
    boot();
    const out = await call({ ids: ['BCP 9999'] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toMatchObject([{ kind: 'series', found: false }]);
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('under-cap page: fewer ids than the ten-id cap, no notice', async () => {
    const s = boot();
    serveRfc(s, 8001);
    serveDraft(s, DRAFT);
    const out = await call({ ids: ['RFC 8001', DRAFT] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toHaveLength(2);
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('a page with a notice carries it in both surfaces', async () => {
    const s = boot();
    serveRfc(s, 8002, { tracking: notFound });
    const out = await call({ ids: ['RFC 8002'] });
    expect(out.structured.notice).toEqual(expect.any(String));
    expect(out.text).toContain(String(out.structured.notice));
  });
});

describe('iana_get_rfc_status: format()', () => {
  it('prints every field of an RFC', async () => {
    const s = boot();
    serveRfc(s, 8001);
    const out = await call({ ids: ['RFC 8001'] });
    expect(out.text).toContain('**Documents:** 1 · **Failed:** 0');
    expect(out.text).toContain('### RFC 8001 · Example Protocol Specification');
    expect(out.text).toContain('**Kind:** rfc · **Found:** true');
    expect(out.text).toContain(
      '**Status:** INTERNET STANDARD · **As published:** PROPOSED STANDARD · **Stream:** IETF · **Group:** exwg (Example Working Group, WG)',
    );
    expect(out.text).toContain(
      '**Published:** June 2022 · **Pages:** 42 · **DOI:** 10.17487/RFC8001',
    );
    expect(out.text).toContain('**Authors:** Example Author, Ed.; Another Example');
    expect(out.text).toContain('**Obsoletes:** RFC 7230, RFC 791 · **Obsoleted by:** none');
    expect(out.text).toContain(
      '**Updates:** RFC 5234 · **Updated by:** RFC 8002\n**Is also:** none\n**Draft:** draft-example-wg-topic-12',
    );
    expect(out.text).not.toContain('See also');
    expect(out.text).toContain('**Errata:** <https://www.rfc-editor.org/errata/rfc8001>');
    expect(out.text).toContain(
      '**RFC Editor:** <https://www.rfc-editor.org/rfc/rfc8001.html> · **Datatracker:** <https://datatracker.ietf.org/doc/rfc8001/>',
    );
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd'])(
    'prints an errata value %s as inert text, never as a link',
    async (errata) => {
      const s = boot();
      serveRfc(s, 8001, { rfc: () => jsonResponse(rfcJson(8001, { errata_url: errata })) });
      const out = await call({ ids: ['RFC 8001'] });
      expect(JSON.stringify(out.structured)).toContain(JSON.stringify(errata));
      const line = out.text.split('\n').find((text) => text.startsWith('**Errata:**'));
      expect(line).toBe(`**Errata:** ${errata.replace(/[<>]/g, '\\$&')}`);
    },
  );

  it('prints every field of a draft', async () => {
    const s = boot();
    serveDraft(s, DRAFT, {
      outgoing: () =>
        jsonResponse(
          related(
            edge('replaces', DRAFT, 'draft-example-wg-ancient'),
            edge('became_rfc', DRAFT, 'rfc8001'),
          ),
        ),
      incoming: () => jsonResponse(related(edge('replaces', 'draft-example-wg-newer', DRAFT))),
    });
    const out = await call({ ids: [DRAFT] });
    expect(out.text).toContain(`### ${DRAFT} · Example Draft Topic`);
    expect(out.text).toContain('**Kind:** draft · **Found:** true');
    expect(out.text).toContain('**State:** Active · **Revision:** 03');
    expect(out.text).toContain(
      '**IESG state:** I-D Exists · **Stream:** IETF · **Group:** exwg (Example Working Group, WG) · **Intended status:** Proposed Standard',
    );
    expect(out.text).toContain(
      '**Last updated:** 2026-08-01 10:20:30 · **Expires:** 2027-02-01 10:20:30',
    );
    expect(out.text).toContain('**Became:** RFC 8001');
    expect(out.text).toContain(
      '**Replaces:** draft-example-wg-ancient · **Replaced by:** draft-example-wg-newer',
    );
    expect(out.text).toContain(
      '**Datatracker:** <https://datatracker.ietf.org/doc/draft-example-wg-topic/>',
    );
  });

  it('prints guidance for a miss and a failed section for failures', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    serveRfc(s, 8002, { rfc: () => statusResponse(503) });
    const out = await call({ ids: ['RFC 99999', 'ISO 639', 'RFC 8002'] });
    expect(out.text).toContain('**Documents:** 2 · **Failed:** 1');
    expect(out.text).toContain('### RFC 99999\n**Kind:** rfc · **Found:** false');
    expect(out.text).toContain(String(docs(out)[0]?.guidance));
    expect(out.text).toContain('### ISO 639\n**Kind:** unsupported · **Found:** false');
    expect(out.text).toContain(String(docs(out)[1]?.guidance));
    expect(out.text).toContain('### Failed\n- RFC 8002: ');
  });

  it('prints a draft miss with its guidance, angle brackets escaped', async () => {
    const s = boot();
    s.serve({ [docUrl('draft-example-wg-missing')]: notFound });
    const out = await call({ ids: ['draft-example-wg-missing'] });
    expect(out.text).toContain('### draft-example-wg-missing\n**Kind:** draft · **Found:** false');
    expect(out.text).toContain(
      String.raw`No Internet-Draft named draft-example-wg-missing. Draft names look like draft-\<source\>-\<group\>-\<topic\>; a revision suffix such as -07 is optional.`,
    );
  });

  /** Each row: a label, the upstream it arranges (returning the ids to call), and a value structuredContent must carry. */
  it.each<[string, (s: Setup) => string[], string]>([
    [
      'an RFC with its stream and group',
      (s) => {
        serveRfc(s, 8001);
        return ['RFC 8001'];
      },
      'Example Working Group',
    ],
    [
      'an RFC without Datatracker fields (notice)',
      (s) => {
        serveRfc(s, 8002, { tracking: notFound });
        return ['RFC 8002'];
      },
      'Stream and working group were unavailable',
    ],
    [
      'an RFC with empty relation lists',
      (s) => {
        serveRfc(s, 8003, {
          rfc: () =>
            jsonResponse(
              rfcJson(8003, {
                obsoletes: [],
                updates: [],
                updated_by: [],
                authors: [],
                errata_url: null,
                draft: null,
              }),
            ),
        });
        return ['RFC 8003'];
      },
      'RFC 8003',
    ],
    [
      'an RFC in a series',
      (s) => {
        serveRfc(s, 2119);
        return ['RFC 2119'];
      },
      'BCP 14',
    ],
    [
      'an RFC whose series read failed (notice)',
      (s) => {
        serveRfc(s, 8001);
        s.serve({ [membershipUrl(8001)]: () => statusResponse(503) });
        return ['RFC 8001'];
      },
      'Series membership was unavailable',
    ],
    ['a series with members, and one without', () => ['STD 5', 'BCP 9999'], 'RFC 1112'],
    [
      'a draft above its latest revision (guidance)',
      (s) => {
        s.serve({ [docUrl(`${DRAFT}-99`)]: notFound });
        serveDraft(s, DRAFT);
        return [`${DRAFT}-99`];
      },
      'has no revision -99',
    ],
    [
      'a draft with relations',
      (s) => {
        serveDraft(s, DRAFT, {
          outgoing: () =>
            jsonResponse(
              related(edge('became_rfc', DRAFT, 'rfc8001'), edge('replaces', DRAFT, 'draft-a-b-c')),
            ),
          incoming: () => jsonResponse(related(edge('replaces', 'draft-d-e-f', DRAFT))),
        });
        return [DRAFT];
      },
      'draft-d-e-f',
    ],
    [
      'a draft found by dropping its revision',
      (s) => {
        s.serve({ [docUrl(`${DRAFT}-07`)]: notFound });
        serveDraft(s, DRAFT);
        return [`${DRAFT}-07`];
      },
      '"requested_revision":"07"',
    ],
    [
      'a mix of hits, misses, an unsupported id, a series, and a failure',
      (s) => {
        serveRfc(s, 8001);
        serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
        serveRfc(s, 8002, { rfc: () => statusResponse(503) });
        return ['RFC 8001', 'RFC 99999', 'ISO 639', 'BCP 14', 'RFC 8002'];
      },
      'RFC 8174',
    ],
  ])(
    'carries every string and number of structuredContent: %s',
    async (_label, arrange, carries) => {
      const s = boot();
      const ids = arrange(s);
      const out = await call({ ids });
      expect(out.isError).toBe(false);
      expect(JSON.stringify(out.structured)).toContain(carries);
      expect(missingFromText(out.structured, out.text)).toEqual([]);
    },
  );

  it('keeps hostile upstream text verbatim in structuredContent and inert in format()', async () => {
    const s = boot();
    const hostile = 'Evil [x](https://evil.example/) <b>x</b> \\ # Pwned\u202E\u0007\r\n# Injected';
    serveRfc(s, 8001, {
      rfc: () =>
        jsonResponse(
          rfcJson(8001, {
            title: hostile,
            authors: [hostile],
            status: hostile,
          }),
        ),
      tracking: () =>
        jsonResponse(rfcDocJson(8001, { group: { name: hostile, type: 'WG', acronym: 'exwg' } })),
    });
    const hostileSeries = 'evil[x](https:%2F%2Fevil.example)<b>';
    s.serve({
      [membershipUrl(8001)]: () =>
        jsonResponse(related(edge('contains', hostileSeries, 'rfc8001'))),
    });
    const out = await call({ ids: ['RFC 8001'] });
    const [doc] = docs(out);
    expect(doc?.title).toBe(hostile);
    expect(doc?.rfc?.authors).toEqual([hostile]);
    expect(doc?.rfc?.status).toBe(hostile);
    expect(doc?.rfc?.group).toMatchObject({ name: hostile });
    expect(doc?.rfc?.is_also).toEqual([hostileSeries]);
    expect(out.text).toContain(String.raw`**Is also:** evil\[x\](https:%2F%2Fevil.example)\<b\>`);

    const lines = out.text.split('\n');
    expect(lines.filter((line) => /^#{1,6} /.test(line))).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('# '))).toBe(false);
    expect(out.text).not.toMatch(/[\r\u2028\u2029\u202E\u0007]/);
    expect(lines.find((line) => line.startsWith('### '))).toBe(
      String.raw`### RFC 8001 · Evil \[x\](https://evil.example/) \<b\>x\</b\> \\ # Pwned # Injected`,
    );
  });

  it('keeps CR/LF in a draft state, group, and failure message out of the inline slots', async () => {
    const s = boot();
    serveDraft(s, DRAFT, {
      doc: () =>
        jsonResponse(
          draftDocJson(DRAFT, {
            state: 'Active\r\n# Heading',
            iesg_state: 'I-D\nExists',
            title: 'Draft\r# Title',
          }),
        ),
    });
    const out = await call({ ids: [DRAFT] });
    expect(docs(out)[0]?.draft?.state).toBe('Active\r\n# Heading');
    const lines = out.text.split('\n');
    expect(lines.filter((line) => /^#{1,6} /.test(line))).toEqual([`### ${DRAFT} · Draft # Title`]);
    expect(out.text).not.toMatch(/[\r]/);
    expect(out.text).toContain('**State:** Active # Heading · **Revision:** 03');
  });

  it('keeps a newline in an unsupported id out of the heading', async () => {
    boot();
    const out = await call({ ids: ['evil\n# Pwned'] });
    expect(docs(out)[0]?.id).toBe('evil\n# Pwned');
    const lines = out.text.split('\n');
    expect(lines.filter((line) => /^#{1,6} /.test(line))).toEqual(['### evil # Pwned']);
    expect(lines).toContain(
      'evil # Pwned is not an RFC, Internet-Draft, or BCP/STD/FYI id. Pass an RFC number ("RFC 9110"), a draft name ("draft-ietf-httpbis-semantics-19"), a series number ("BCP 14"), an RFC or draft file name ("rfc9110.txt"), or the URL of an RFC or draft on datatracker.ietf.org, tools.ietf.org, or ietf.org, of an RFC on rfc-editor.org, or of a series at rfc-editor.org/info/ or datatracker.ietf.org/doc/.',
    );
  });
});
