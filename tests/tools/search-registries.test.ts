/**
 * @fileoverview Tests for `iana_search_registries`: whole-token search over
 * titles, categories, and ids, exact-id ranking, limits and truncation, input
 * validation, the index floor and `index_unreadable`, the stale-index
 * disclosure, the list-enrichment contract, and `format()` parity and
 * sanitizing. The index page is a synthetic fixture served through a
 * `createFetchMock` fake behind the injected `UpstreamClient`.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchRegistries } from '@/mcp-server/tools/definitions/search-registries.tool.js';
import {
  FRESH_MS,
  HOLD_MS,
  PROTOCOL_INDEX_URL,
  STALE_MAX_MS,
} from '@/services/registry/registry-store.js';
import { indexHtmlWith, SMALL_INDEX_HTML } from '../fixtures/protocol-index.js';
import { SEARCH_ENTRIES, searchIndexHtml } from '../fixtures/search-index.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { callTool, setupTools, T0 } from '../shared/tool-harness.js';
import { htmlResponse, statusResponse, xmlResponse } from '../shared/upstream-harness.js';

const INDEX_HTML = searchIndexHtml();
const INDEX_HINT =
  'The IANA registry index could not be read; call iana_get_registry_records directly with a known registry id such as tls-parameters.';

interface RegistryRow {
  category: string;
  defining_documents: { id: string; title?: string; url?: string }[];
  page_url: string;
  registration_procedure?: string;
  registry_id: string;
  subregistry_id?: string;
  title: string;
  xml_url: string;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function boot(html = INDEX_HTML) {
  const s = setupTools();
  s.serve({ [PROTOCOL_INDEX_URL]: () => htmlResponse(html) });
  return s;
}

const escapeInline = (text: string) => text.replace(/[\\[\]<>]/g, '\\$&');
const call = (input: Record<string, unknown>) => callTool(searchRegistries, input);
const rows = (out: { structured: Record<string, unknown> }) =>
  out.structured.registries as RegistryRow[];
const ids = (out: { structured: Record<string, unknown> }) =>
  rows(out).map((row) =>
    row.subregistry_id ? `${row.registry_id}#${row.subregistry_id}` : row.registry_id,
  );

describe('iana_search_registries: matching', () => {
  it('returns the ids, procedure, category, and URLs of a sub-registry entry', async () => {
    boot();
    const out = await call({ query: 'cipher suites' });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      registries: [
        {
          registry_id: 'example-tls',
          subregistry_id: 'example-tls-4',
          title: 'Example Cipher Suites',
          category: 'Example Protocols',
          registration_procedure: 'Specification Required',
          defining_documents: [],
          page_url: 'https://www.iana.org/assignments/example-tls#example-tls-4',
          xml_url: 'https://www.iana.org/assignments/example-tls/example-tls.xml',
        },
      ],
      source: {
        registry_id: 'protocols',
        url: PROTOCOL_INDEX_URL,
        fetched_at: new Date(T0).toISOString(),
        stale: false,
      },
      totalCount: 1,
      shown: 1,
      cap: 20,
      truncated: false,
    });
    expect(out.structured.source).not.toHaveProperty('registry_updated');
  });

  it('never carries a designated expert, in either surface', async () => {
    boot();
    const out = await call({ query: 'cipher suites' });
    expect(JSON.stringify(out.structured)).not.toContain('Example Reviewer');
    expect(out.text).not.toContain('Example Reviewer');
  });

  it('returns defining documents with their titles and iana.org links', async () => {
    boot();
    const [row] = rows(await call({ query: 'transport parameters' }));
    expect(row).toMatchObject({
      registry_id: 'example-tls',
      registration_procedure: 'IETF Review',
      defining_documents: [
        { id: 'RFC9999', title: 'Example Transport Spec', url: 'https://www.iana.org/go/rfc9999' },
        { id: 'RFC8888' },
      ],
    });
    expect(row).not.toHaveProperty('subregistry_id');
  });

  it('omits the procedure of an entry that lists none', async () => {
    boot();
    expect(rows(await call({ query: 'resource record' }))[0]).not.toHaveProperty(
      'registration_procedure',
    );
  });

  it('matches whole tokens only, across title words', async () => {
    boot();
    expect(ids(await call({ query: 'cipher' }))).toEqual([
      'example-tls#example-tls-4',
      'example-tls#example-tls-5',
    ]);
    expect(ids(await call({ query: 'cipher extensions' }))).toEqual(['example-tls#example-tls-5']);
    expect(ids(await call({ query: 'ciph' }))).toEqual([]);
    expect(ids(await call({ query: 'CIPHER   SUITES' }))).toEqual(['example-tls#example-tls-4']);
  });

  it('searches the protocol category and the ids as well as the title', async () => {
    boot();
    const byCategory = await call({ query: 'example protocols', limit: 50 });
    expect(byCategory.structured).toMatchObject({ totalCount: SEARCH_ENTRIES.length });
    expect(ids(await call({ query: 'rank first' }))).toEqual(['rank-first']);
  });

  it('ranks an exact registry id before earlier title matches', async () => {
    boot();
    expect(ids(await call({ query: 'alpha' }))).toEqual(['alpha', 'rank-first']);
    expect(ids(await call({ query: 'ALPHA' }))).toEqual(['alpha', 'rank-first']);
  });

  it('ranks an exact sub-registry id first, and lists every entry of an exact registry id', async () => {
    boot();
    expect(ids(await call({ query: 'example-tls-5' }))).toEqual(['example-tls#example-tls-5']);
    expect(ids(await call({ query: 'example-tls' }))).toEqual([
      'example-tls',
      'example-tls#example-tls-4',
      'example-tls#example-tls-5',
    ]);
  });

  it('returns a mixed-case id in the index casing for a case-insensitive query', async () => {
    boot();
    expect(rows(await call({ query: 'example-mixed' }))[0]?.registry_id).toBe('Example-Mixed');
  });

  it('loads the index once for repeated searches', async () => {
    const s = boot();
    await call({ query: 'cipher' });
    await call({ query: 'alpha' });
    expect(s.fetched()).toEqual([PROTOCOL_INDEX_URL]);
  });
});

describe('iana_search_registries: limit and miss', () => {
  it('cuts at limit, discloses it, and counts the full match set', async () => {
    boot();
    const out = await call({ query: 'example protocols', limit: 3 });
    expect(rows(out)).toHaveLength(3);
    expect(out.structured).toMatchObject({
      totalCount: SEARCH_ENTRIES.length,
      shown: 3,
      cap: 3,
      truncated: true,
      notice: `Showing 3 of ${SEARCH_ENTRIES.length} matching registries; add words to query to narrow, or raise limit (max 50).`,
    });
    expect(out.text).toContain('Showing 3 of 8 matching registries');
  });

  it('applies the default cap of 20, a digit-string limit, and the maximum of 50', async () => {
    boot();
    expect((await call({ query: 'cipher' })).structured).toMatchObject({ cap: 20 });
    expect((await call({ query: 'cipher', limit: '5' })).structured).toMatchObject({ cap: 5 });
    expect((await call({ query: 'cipher', limit: 50 })).structured).toMatchObject({ cap: 50 });
  });

  it('reads a blank limit as unset', async () => {
    boot();
    expect((await call({ query: 'cipher', limit: '  ' })).structured).toMatchObject({ cap: 20 });
  });

  it('explains a miss and points at the curated tools', async () => {
    boot();
    const out = await call({ query: 'zzzzqq' });
    expect(out.structured).toMatchObject({
      registries: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice:
        'No registry title matched "zzzzqq". Use the protocol\'s name or acronym (e.g. "DHCP options"); the curated tools cover ports, media types, HTTP status codes and fields, URI schemes, enterprise numbers, and language tags.',
    });
  });

  it.each(['  ', '!!', '--'])(
    'rejects the query %j with no searchable token as invalid arguments, before any fetch',
    async (query) => {
      const s = boot();
      const out = await call({ query });
      expect(out.isError).toBe(true);
      expect(out.structured.error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(out.text).toContain('Must contain at least one letter or digit');
      expect(s.fetches()).toBe(0);
    },
  );

  it('echoes a multi-line query on one line in the miss notice', async () => {
    boot();
    const out = await call({ query: 'zz\n\n# Pwned\tqq' });
    expect(out.structured.notice).toContain('No registry title matched "zz # Pwned qq".');
  });
});

describe('iana_search_registries: input validation', () => {
  it.each([
    ['a missing query', {}],
    ['an empty query', { query: '' }],
    ['a one-character query', { query: 'a' }],
    ['a query over 100 characters', { query: 'a'.repeat(101) }],
    ['limit 0', { query: 'cipher', limit: 0 }],
    ['limit above 50', { query: 'cipher', limit: 51 }],
    ['a fractional limit', { query: 'cipher', limit: 1.5 }],
    ['a non-numeric limit', { query: 'cipher', limit: 'many' }],
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

  it('accepts a 100-character query', async () => {
    boot();
    expect((await call({ query: 'a'.repeat(100) })).isError).toBe(false);
  });
});

describe('iana_search_registries: list-enrichment contract', () => {
  it('zero-result page: counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ query: 'zzzz' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      registries: [],
      totalCount: 0,
      shown: 0,
      cap: 20,
      truncated: false,
    });
    expect(out.text).toContain('0 total');
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('under-cap page: shown equals the match count and nothing is truncated', async () => {
    boot();
    const out = await call({ query: 'cipher', limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2, cap: 10, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_search_registries: format()', () => {
  it('carries every structuredContent field of a page', async () => {
    boot();
    const out = await call({ query: 'example', limit: 50 });
    for (const row of rows(out)) {
      expect(out.text).toContain(`### ${escapeInline(row.title)}`);
      expect(out.text).toContain(`**Registry:** \`${row.registry_id}\``);
      if (row.subregistry_id)
        expect(out.text).toContain(`**Subregistry:** \`${row.subregistry_id}\``);
      expect(out.text).toContain(`**Category:** ${row.category}`);
      expect(out.text).toContain(`<${row.page_url}>`);
      expect(out.text).toContain(`<${row.xml_url}>`);
    }
    expect(out.text).toContain('**Source:** `protocols` · fetched');
    expect(out.text).not.toContain('registry updated');
  });

  it('prints the procedure and the defining documents of an entry', async () => {
    boot();
    const out = await call({ query: 'transport parameters' });
    expect(out.text).toContain('### Example Transport Parameters');
    expect(out.text).toContain('**Registration procedure:** IETF Review');
    expect(out.text).toContain(
      '- RFC9999 — Example Transport Spec <https://www.iana.org/go/rfc9999>',
    );
    expect(out.text).toContain('- RFC8888\n');
  });

  it('keeps hostile index text verbatim in structuredContent and inert in format()', async () => {
    boot();
    const out = await call({ query: 'hostile' });
    const [row] = rows(out);

    expect(row?.title).toBe(
      'Hostile [link](https://evil.example/) <script>alert(1)</script> <img src=x>',
    );
    expect(row?.defining_documents).toEqual([
      {
        id: 'RFC1',
        title: 'Doc [x](https://evil.example/) <b>bold</b>',
        url: 'https://www.iana.org/go/a b)>[c](d)',
      },
    ]);
    expect(row?.registration_procedure).toBe('Reach maintainers at [email removed]');

    const lines = out.text.split('\n');
    expect(lines).toContain(
      String.raw`### Hostile \[link\](https://evil.example/) \<script\>alert(1)\</script\> \<img src=x\>`,
    );
    expect(lines).toContain(
      String.raw`- RFC1 — Doc \[x\](https://evil.example/) \<b\>bold\</b\> <https://www.iana.org/go/a%20b%29%3E%5Bc%5D%28d%29>`,
    );
    expect(out.text).not.toContain('<script>');
    expect(out.text).not.toContain('maintainers@example.org');
  });
});

describe('iana_search_registries: index_unreadable', () => {
  it('a page under the floor fails index_unreadable, not retryable, after one fetch', async () => {
    const s = boot(SMALL_INDEX_HTML);
    const out = await call({ query: 'example' });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'index_unreadable',
        retryable: false,
        registryIds: 4,
        entries: 5,
        recovery: { hint: INDEX_HINT },
      },
    });
    expect(out.text).toContain(`Recovery: ${INDEX_HINT}`);
    expect(out.text).toContain('reason index_unreadable · not retryable');
    expect(s.fetches()).toBe(1);
  });

  it.each([
    ['one id short of the floor', indexHtmlWith(499, 2_000)],
    ['one entry short of the floor', indexHtmlWith(500, 1_999)],
  ])('refuses a page %s', async (_label, html) => {
    boot(html);
    const out = await call({ query: 'example' });
    expect(out.structured.error).toMatchObject({ data: { reason: 'index_unreadable' } });
  });

  it('accepts a page exactly at the floor', async () => {
    boot(indexHtmlWith(500, 2_000));
    expect((await call({ query: 'registry' })).isError).toBe(false);
  });

  it('does not cache a floor failure: after the hold a good page is fetched and served', async () => {
    const s = boot(SMALL_INDEX_HTML);
    await call({ query: 'cipher' });
    s.advance(HOLD_MS + 1_000);
    s.serve({ [PROTOCOL_INDEX_URL]: () => htmlResponse(INDEX_HTML) });
    const out = await call({ query: 'cipher' });
    expect(out.isError).toBe(false);
    expect(rows(out)).toHaveLength(2);
    expect(s.fetches()).toBe(2);
  });

  it('rethrows the remembered floor error inside the hold without fetching', async () => {
    const s = boot(SMALL_INDEX_HTML);
    const first = await call({ query: 'cipher' });
    s.advance(HOLD_MS - 1_000);
    s.serve({ [PROTOCOL_INDEX_URL]: () => htmlResponse(INDEX_HTML) });
    const second = await call({ query: 'cipher' });
    expect(second.structured.error).toEqual(first.structured.error);
    expect(s.fetches()).toBe(1);
  });

  it('serves a good copy up to 7 days old as stale when a refresh parses under the floor', async () => {
    const s = boot();
    const fresh = await call({ query: 'cipher' });
    s.advance(FRESH_MS + 1);
    s.serve({ [PROTOCOL_INDEX_URL]: () => htmlResponse(SMALL_INDEX_HTML) });
    const stale = await call({ query: 'cipher' });
    expect(stale.isError).toBe(false);
    expect(ids(stale)).toEqual(ids(fresh));
    expect(stale.structured.source).toMatchObject({ stale: true });
    expect(stale.text).toContain('**Served from a stale copy** fetched');
    expect(s.fetches()).toBe(2);
  });

  it('fails index_unreadable when the only good copy is older than 7 days', async () => {
    const s = boot();
    await call({ query: 'cipher' });
    s.advance(STALE_MAX_MS + FRESH_MS);
    s.serve({ [PROTOCOL_INDEX_URL]: () => htmlResponse(SMALL_INDEX_HTML) });
    const out = await call({ query: 'cipher' });
    expect(out.structured.error).toMatchObject({ data: { reason: 'index_unreadable' } });
  });

  it('an exhausted 503 stays framework-classified, without the index_unreadable reason', async () => {
    const s = setupTools();
    s.serve({ [PROTOCOL_INDEX_URL]: () => statusResponse(503) });
    const out = await call({ query: 'cipher' });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503 },
    });
    expect((out.structured.error as { data: Record<string, unknown> }).data.reason).toBeUndefined();
  });

  it('a body over the 8 MiB ceiling is index_unreadable', async () => {
    const s = boot('x'.repeat(8 * 1024 * 1024 + 1));
    const out = await call({ query: 'cipher' });
    expect(out.structured.error).toMatchObject({
      data: { reason: 'index_unreadable', maxBytes: 8 * 1024 * 1024 },
    });
    expect(s.fetches()).toBe(3);
  });
});

describeFailureContract({
  definition: searchRegistries,
  input: { query: 'cipher suites' },
  url: PROTOCOL_INDEX_URL,
  ok: () => htmlResponse(INDEX_HTML),
  reason: 'index_unreadable',
  recovery: INDEX_HINT,
  unreadable: [
    {
      label: 'an XML body where HTML is expected',
      attempts: 3,
      response: () => xmlResponse('<a/>'),
    },
    {
      label: 'a page under the floor',
      attempts: 1,
      response: () => htmlResponse(SMALL_INDEX_HTML),
    },
    { label: 'an empty page', attempts: 1, response: () => htmlResponse('') },
  ],
});
