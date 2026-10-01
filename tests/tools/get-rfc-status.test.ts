/**
 * @fileoverview Tests for `iana_get_rfc_status`: every id form the
 * classification row lists (RFC Editor `/rfc/` and `/info/` URLs with `.html`,
 * `.txt`, `.json`, `.pdf`, `.xml`, Datatracker `/doc/` and `/doc/html/` paths
 * including a `/NN/` revision), string and array `ids` (a string starting with
 * `[` is not split on commas), ids resolving to one document fetched once, BCP /
 * STD / FYI labels as unsupported documents, an unpublished RFC as
 * `found: false`, partial failure into `failed[]` (a failed `relateddocument`
 * read included, each entry carrying its reason when classified), the rethrow
 * only when every id failed, the stream-and-group notice, a cancelled call
 * reporting no per-id failures, the `pacer_shed` rows for both hosts, the
 * `request_limit` rows (20 Datatracker requests per call, retries counted, the
 * ids past them in `failed[]` with a notice), and `format()` parity and
 * sanitizing.
 * Upstream I/O is a `createFetchMock` fake; every author and address is invented.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRfcStatus } from '@/mcp-server/tools/definitions/get-rfc-status.tool.js';
import {
  initIetfDocService,
  relatedDocumentsUrl,
  rfcJsonUrl,
} from '@/services/ietf/ietf-doc-service.js';
import { DATATRACKER_CALL_REQUESTS } from '@/services/upstream/upstream-client.js';
import {
  DOC_PERSON_MARKERS,
  draftDocJson,
  edge,
  related,
  rfcDocJson,
  rfcJson,
} from '../fixtures/ietf.js';
import { missingFromText } from '../shared/format-parity.js';
import { type Answer, callTool, setupTools } from '../shared/tool-harness.js';
import {
  hang,
  htmlResponse,
  jsonResponse,
  makeBudget,
  PERMISSIVE_PACING,
  statusResponse,
} from '../shared/upstream-harness.js';

type Out = Awaited<ReturnType<typeof callTool>>;

interface Doc {
  draft?: Record<string, unknown>;
  found: boolean;
  guidance?: string;
  id: string;
  kind: string;
  rfc?: Record<string, unknown>;
  title?: string;
}

const DRAFT = 'draft-example-wg-topic';
const docUrl = (name: string) => `https://datatracker.ietf.org/doc/${name}/doc.json`;
const outgoingUrl = (name: string) =>
  relatedDocumentsUrl({ source__name: name, relationship__in: 'replaces,became_rfc' });
const incomingUrl = (name: string) =>
  relatedDocumentsUrl({ target__name: name, relationship: 'replaces' });
const notFound = () => statusResponse(404, {}, '404 - Not found', 'text/plain');

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

function boot(options: Parameters<typeof setupTools>[0] = {}) {
  const s = setupTools(options);
  initIetfDocService({ client: s.client });
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
  out.structured.failed as { error: string; id: string; reason?: string }[];
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
    see_also: ['STD0097', 'BCP0047'],
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
  it('returns the RFC Editor status and relations with the Datatracker stream and group', async () => {
    const s = boot();
    serveRfc(s, 8001);
    const out = await call({ ids: ['RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({ documents: [RFC_8001], failed: [] });
    expect(s.fetched().sort()).toEqual([rfcJsonUrl(8001), docUrl('rfc8001')].sort());
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
    expect(s.fetches()).toBe(2);
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

  it('reads a bare number given as a JSON number', async () => {
    const s = boot();
    serveRfc(s, 8001);
    expect(docIds(await call({ ids: [8001] }))).toEqual(['RFC 8001']);
  });

  it.each([['BCP 47'], ['bcp47'], ['BCP-47'], ['STD 97'], ['std-97'], ['FYI 1'], ['fyi1']])(
    'reads the series label %j as an unsupported document, with no fetch',
    async (id) => {
      const s = boot();
      const out = await call({ ids: [id] });
      expect(out.isError).toBe(false);
      expect(out.structured).toEqual({
        documents: [
          {
            id,
            kind: 'unsupported',
            found: false,
            guidance:
              'BCP, STD, and FYI numbers are series labels, not documents; pass the member RFC numbers instead.',
          },
        ],
        failed: [],
      });
      expect(s.fetches()).toBe(0);
    },
  );

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
    ['https://example.org/rfc/rfc8001.html'],
    ['https://www.rfc-editor.org/rfc/rfc8001.html/extra'],
    ['https://www.rfc-editor.org/rfc/std97.html'],
  ])('reads %j as neither an RFC number nor a draft name', async (id) => {
    const s = boot();
    const out = await call({ ids: [id] });
    expect(out.isError).toBe(false);
    expect(docs(out)).toEqual([
      {
        id,
        kind: 'unsupported',
        found: false,
        guidance: `${id} is neither an RFC number nor a draft name.`,
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
    expect(s.fetches()).toBe(2);
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
    const out = await call({ ids: [DRAFT, 'RFC 8002', 'BCP 47', 'RFC 8001', '8002', 'BCP 47'] });
    expect(docIds(out)).toEqual([DRAFT, 'RFC 8002', 'BCP 47', 'RFC 8001']);
  });

  it('keeps the first spelling when ids differ only in case', async () => {
    boot();
    const out = await call({ ids: ['BCP 47', 'bcp 47'] });
    expect(docIds(out)).toEqual(['BCP 47']);
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
    const out = await call({ ids: ['RFC 99999', 'BCP 47', 'RFC 8002'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['RFC 99999', 'BCP 47']);
    expect(failed(out).map((failure) => failure.id)).toEqual(['RFC 8002']);
  });

  it('answers a call mixing a miss and a series label without failures', async () => {
    const s = boot();
    serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
    const out = await call({ ids: ['BCP 47', 'RFC 99999'] });
    expect(out.structured).toMatchObject({ failed: [] });
    expect(docs(out).map((doc) => [doc.id, doc.kind, doc.found])).toEqual([
      ['BCP 47', 'unsupported', false],
      ['RFC 99999', 'rfc', false],
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
    const out = await call({ ids: ['BCP 47', 'RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(docIds(out)).toEqual(['BCP 47']);
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
      { ids: ['BCP 47'] },
      { context: { signal: controller.signal } },
    );
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
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

  it('a shed Datatracker queue only costs an RFC its stream and group', async () => {
    const s = datatrackerShed();
    serveRfc(s, 8001);
    const occupant = occupy(s, docUrl('draft-example-occupant'));
    await vi.advanceTimersByTimeAsync(10);

    const out = await call({ ids: ['RFC 8001'] });
    expect(out.isError).toBe(false);
    expect(failed(out)).toEqual([]);
    expect(docs(out)[0]?.found).toBe(true);
    expect(docs(out)[0]?.rfc).not.toHaveProperty('stream');
    expect(out.structured.notice).toContain('RFC 8001');
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
  const RFCS = Array.from({ length: 10 }, (_, index) => 8001 + index);
  const LIMIT_HINT =
    'Call iana_get_rfc_status again with just the ids that failed with request_limit.';
  const LIMIT_MESSAGE =
    'Not resolved: this call reached its limit of 20 Datatracker requests first. Call iana_get_rfc_status again with this id.';
  const datatrackerFetches = (s: Setup) =>
    s.fetched().filter((url) => url.startsWith('https://datatracker.ietf.org/')).length;

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

  it('starts at most 20 Datatracker requests and returns the ids past them in failed', async () => {
    const s = boot();
    for (const name of DRAFTS) serveDraft(s, name);
    const out = await call({ ids: DRAFTS });
    expect(out.isError).toBe(false);
    expect(datatrackerFetches(s)).toBe(20);
    expect(docs(out)).toHaveLength(5);
    expect(failed(out)).toHaveLength(5);
    expect([...docIds(out), ...failed(out).map((failure) => failure.id)].sort()).toEqual(DRAFTS);
    for (const failure of failed(out)) {
      expect(failure).toEqual({ id: failure.id, error: LIMIT_MESSAGE, reason: 'request_limit' });
    }
    const cut = failed(out).map((failure) => failure.id);
    expect(out.structured.notice).toBe(
      `${cut.join(', ')} were not resolved within this call's limit of 20 Datatracker requests; call iana_get_rfc_status again with them.`,
    );
    expect(out.text).toContain(String(out.structured.notice));
    expect(out.text).toContain(`- ${cut[0]}: ${LIMIT_MESSAGE} (request_limit)`);
  });

  it('names one cut id in the singular, ahead of the stream-and-group fragment', async () => {
    const s = boot();
    const drafts = DRAFTS.slice(0, 7);
    for (const name of drafts) serveDraft(s, name);
    serveRfc(s, 8001, { tracking: notFound });
    const out = await call({ ids: [...drafts, 'RFC 8001'] });
    expect(datatrackerFetches(s)).toBe(20);
    expect(failed(out)).toEqual([
      { id: expect.any(String), error: LIMIT_MESSAGE, reason: 'request_limit' },
    ]);
    expect(out.structured.notice).toBe(
      `${failed(out)[0]?.id} was not resolved within this call's limit of 20 Datatracker requests; call iana_get_rfc_status again with it. Stream and working group were unavailable for RFC 8001; status and relations come from the RFC Editor.`,
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
    expect(datatrackerFetches(s)).toBe(10);
    expect(failed(out)).toEqual([]);
    expect(docs(out).every((doc) => doc.rfc?.stream === 'IETF')).toBe(true);
  });

  it('fails the call with request_limit when the limit cut every id', async () => {
    const s = boot();
    for (const name of DRAFTS) serveDraft(s, name, { doc: () => statusResponse(503) });
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
    const out = await call({ ids: ['BCP 47'] });
    expect(out.isError).toBe(false);
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
    expect(out.text).toContain('**Updates:** RFC 5234 · **Updated by:** RFC 8002');
    expect(out.text).toContain('**See also:** STD0097, BCP0047');
    expect(out.text).toContain('**Draft:** draft-example-wg-topic-12');
    expect(out.text).toContain('**Errata:** <https://www.rfc-editor.org/errata/rfc8001>');
    expect(out.text).toContain(
      '**RFC Editor:** <https://www.rfc-editor.org/rfc/rfc8001.html> · **Datatracker:** <https://datatracker.ietf.org/doc/rfc8001/>',
    );
  });

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
    const out = await call({ ids: ['RFC 99999', 'BCP 47', 'RFC 8002'] });
    expect(out.text).toContain('**Documents:** 2 · **Failed:** 1');
    expect(out.text).toContain('### RFC 99999\n**Kind:** rfc · **Found:** false');
    expect(out.text).toContain(String(docs(out)[0]?.guidance));
    expect(out.text).toContain('### BCP 47\n**Kind:** unsupported · **Found:** false');
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

  it.each<[string, (s: Setup) => string[]]>([
    [
      'an RFC with its stream and group',
      (s) => {
        serveRfc(s, 8001);
        return ['RFC 8001'];
      },
    ],
    [
      'an RFC without Datatracker fields (notice)',
      (s) => {
        serveRfc(s, 8002, { tracking: notFound });
        return ['RFC 8002'];
      },
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
                see_also: [],
                authors: [],
                errata_url: null,
                draft: null,
              }),
            ),
        });
        return ['RFC 8003'];
      },
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
    ],
    [
      'a draft found by dropping its revision',
      (s) => {
        s.serve({ [docUrl(`${DRAFT}-07`)]: notFound });
        serveDraft(s, DRAFT);
        return [`${DRAFT}-07`];
      },
    ],
    [
      'a mix of hits, misses, an unsupported id, and a failure',
      (s) => {
        serveRfc(s, 8001);
        serveRfc(s, 99999, { rfc: notFound, tracking: notFound });
        serveRfc(s, 8002, { rfc: () => statusResponse(503) });
        return ['RFC 8001', 'RFC 99999', 'BCP 47', 'RFC 8002'];
      },
    ],
  ])('carries every string and number of structuredContent: %s', async (_label, arrange) => {
    const s = boot();
    const ids = arrange(s);
    const out = await call({ ids });
    expect(out.isError).toBe(false);
    expect(missingFromText(out.structured, out.text)).toEqual([]);
  });

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
            see_also: [hostile],
          }),
        ),
      tracking: () =>
        jsonResponse(rfcDocJson(8001, { group: { name: hostile, type: 'WG', acronym: 'exwg' } })),
    });
    const out = await call({ ids: ['RFC 8001'] });
    const [doc] = docs(out);
    expect(doc?.title).toBe(hostile);
    expect(doc?.rfc?.authors).toEqual([hostile]);
    expect(doc?.rfc?.status).toBe(hostile);
    expect(doc?.rfc?.group).toMatchObject({ name: hostile });

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
    expect(lines).toContain('evil # Pwned is neither an RFC number nor a draft name.');
  });
});
