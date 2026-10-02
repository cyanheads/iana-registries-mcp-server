/**
 * @fileoverview Tests for `iana_search_registries`: whole-token search over
 * titles, categories, and ids with singular and plural folded, the order
 * (exact id, title distance, missing words, index position), a pair listed
 * under two categories returned once, limits and truncation, input
 * validation, the index floor and `index_unreadable`, the stale-index
 * disclosure, the list-enrichment contract, and `format()` parity and
 * sanitizing. Index pages are synthetic fixtures or an excerpt of the live
 * index, served through a `createFetchMock` fake behind the injected
 * `UpstreamClient`.
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
import { liveIndexHtml } from '../fixtures/live-index-excerpt.js';
import {
  categoryRow,
  entryRow,
  indexHtmlWith,
  indexPage,
  SMALL_INDEX_HTML,
} from '../fixtures/protocol-index.js';
import { SEARCH_ENTRIES, searchIndexHtml } from '../fixtures/search-index.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { callTool, setupTools, T0 } from '../shared/tool-harness.js';
import {
  BODY_OVER_CEILING_HINT,
  htmlResponse,
  statusResponse,
  xmlResponse,
} from '../shared/upstream-harness.js';

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
      cap: 15,
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
  it('cuts at limit, discloses it, counts the full match set, and names the next offset', async () => {
    boot();
    const out = await call({ query: 'example protocols', limit: 3 });
    expect(rows(out)).toHaveLength(3);
    expect(out.structured).toMatchObject({
      totalCount: SEARCH_ENTRIES.length,
      shown: 3,
      cap: 3,
      truncated: true,
      next_offset: 3,
      notice: `Showing 3 of ${SEARCH_ENTRIES.length} matching registries; pass offset 3 for the next page, raise limit (max 50), or add words to query to narrow.`,
    });
    expect(out.text).toContain('Showing 3 of 8 matching registries');
    expect(out.text).toContain('**next_offset:** 3');
  });

  it('applies the default cap of 15, a digit-string limit, and the maximum of 50', async () => {
    boot();
    expect((await call({ query: 'cipher' })).structured).toMatchObject({ cap: 15 });
    expect((await call({ query: 'cipher', limit: '5' })).structured).toMatchObject({ cap: 5 });
    expect((await call({ query: 'cipher', limit: 50 })).structured).toMatchObject({ cap: 50 });
  });

  it('reads a blank limit as unset', async () => {
    boot();
    expect((await call({ query: 'cipher', limit: '  ' })).structured).toMatchObject({ cap: 15 });
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

describe('iana_search_registries: offset paging', () => {
  it('pages through the matches in one stable order, the last page without next_offset', async () => {
    boot();
    const all = ids(await call({ query: 'example protocols', limit: 50 }));
    const first = await call({ query: 'example protocols', limit: 3 });
    const second = await call({ query: 'example protocols', limit: 3, offset: 3 });
    const last = await call({ query: 'example protocols', limit: 3, offset: 6 });
    expect([...ids(first), ...ids(second), ...ids(last)]).toEqual(all);
    expect(second.structured).toMatchObject({
      totalCount: 8,
      shown: 3,
      truncated: true,
      next_offset: 6,
      notice:
        'Showing 4–6 of 8 matching registries; pass offset 6 for the next page, raise limit (max 50), or add words to query to narrow.',
    });
    expect(last.structured).toMatchObject({ totalCount: 8, shown: 2, truncated: false });
    expect(last.structured).not.toHaveProperty('next_offset');
    expect(last.structured).not.toHaveProperty('notice');
  });

  it('at the maximum limit names the next offset and drops "raise limit"', async () => {
    boot(indexHtmlWith(500, 2_000));
    const out = await call({ query: 'category', limit: 50 });
    expect(rows(out)).toHaveLength(50);
    expect(out.structured).toMatchObject({
      totalCount: 2_000,
      shown: 50,
      cap: 50,
      truncated: true,
      next_offset: 50,
      notice:
        'Showing 50 of 2000 matching registries; pass offset 50 for the next page, or add words to query to narrow.',
    });
    expect(out.structured.notice).not.toContain('raise limit');
    const next = await call({ query: 'category', limit: 50, offset: 50 });
    expect(rows(next)[0]?.title).toBe('R 50');
    expect(next.structured).toMatchObject({ next_offset: 100 });
  });

  it('returns an empty page with the total for an offset past the end, not an error', async () => {
    boot();
    const out = await call({ query: 'example protocols', offset: 8 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      registries: [],
      totalCount: 8,
      shown: 0,
      truncated: false,
      notice:
        'Offset 8 is past the 8 matching registries; pass an offset below 8, or omit offset to start over.',
    });
    expect(out.structured).not.toHaveProperty('next_offset');
  });

  it('keeps the miss notice for a query with no match at any offset', async () => {
    boot();
    const out = await call({ query: 'zzzzqq', offset: 40 });
    expect(out.structured.notice).toMatch(/^No registry title matched "zzzzqq"\./);
  });

  it('reads a blank or digit-string offset', async () => {
    boot();
    expect(ids(await call({ query: 'example protocols', limit: 3, offset: '  ' }))).toEqual(
      ids(await call({ query: 'example protocols', limit: 3 })),
    );
    expect((await call({ query: 'example protocols', offset: '7' })).structured).toMatchObject({
      shown: 1,
    });
  });
});

describe('iana_search_registries: singular and plural', () => {
  it('matches a singular query against plural titles and categories, and the reverse', async () => {
    boot();
    expect(ids(await call({ query: 'cipher suite' }))).toEqual(['example-tls#example-tls-4']);
    expect(ids(await call({ query: 'resource record type' }))).toEqual(['example-dns']);
    expect(ids(await call({ query: 'alpha note' }))).toEqual(['rank-first']);
    expect(ids(await call({ query: 'mixed case examples' }))).toEqual(['Example-Mixed']);
    expect((await call({ query: 'example protocol', limit: 50 })).structured).toMatchObject({
      totalCount: SEARCH_ENTRIES.length,
    });
  });

  it('keeps every match of the written form: plural queries still find plural titles', async () => {
    boot();
    expect(ids(await call({ query: 'cipher suites' }))).toEqual(['example-tls#example-tls-4']);
    expect(ids(await call({ query: 'cipher extensions' }))).toEqual(['example-tls#example-tls-5']);
  });
});

describe('iana_search_registries: order', () => {
  const RANKED_HTML = searchIndexHtml([
    { href: '/assignments/gizmo#command-codes', title: 'Gizmo Command Codes' },
    { href: '/assignments/widget-misc#legacy', title: 'Legacy Widget Numbers for Gadgets' },
    { href: '/assignments/widget-params#codes', title: 'Widget Option Codes' },
    { href: '/assignments/widget-params#options', title: 'Options for Widgets' },
    { href: '/assignments/gizmo-params#gizmo-params-3', title: 'Command Codes' },
    { href: '/assignments/widget-numbers#widget-numbers-1', title: 'Assigned Widget Numbers' },
  ]);

  it('ranks the registry whose id the query names first, singular or plural', async () => {
    boot(RANKED_HTML);
    const expected = ['widget-numbers#widget-numbers-1', 'widget-misc#legacy'];
    expect(ids(await call({ query: 'widget numbers' }))).toEqual(expected);
    expect(ids(await call({ query: 'Widget Number' }))).toEqual(expected);
    expect(ids(await call({ query: 'widget-numbers' }))).toEqual(expected);
  });

  it('ranks the closest title next, in both surfaces', async () => {
    boot(RANKED_HTML);
    const out = await call({ query: 'widget options' });
    expect(ids(out)).toEqual(['widget-params#options', 'widget-params#codes']);
    expect(out.text.indexOf('### Options for Widgets')).toBeLessThan(
      out.text.indexOf('### Widget Option Codes'),
    );
  });

  it('ranks a title equal to the query above a sub-registry whose id spells it', async () => {
    boot(RANKED_HTML);
    expect(ids(await call({ query: 'command codes' }))).toEqual([
      'gizmo-params#gizmo-params-3',
      'gizmo#command-codes',
    ]);
    expect(ids(await call({ query: 'command-codes' }))).toEqual([
      'gizmo#command-codes',
      'gizmo-params#gizmo-params-3',
    ]);
  });

  it('describes the order and the joined categories in its output schema', () => {
    const shape = searchRegistries.output.shape.registries;
    expect(shape.description).toBe(
      'Matching index entries: exact id hits first, then the closest titles.',
    );
    expect(shape.element.shape.category.description).toBe(
      'Protocol category in the index; an entry listed under several joins them with "; ".',
    );
  });

  it('gives "protocol numbers", which ranks its registry first, as its example', () => {
    expect(searchRegistries.description).toContain('"protocol numbers"');
    expect(searchRegistries.description).not.toContain('ip protocol numbers');
  });
});

describe('iana_search_registries: a pair listed under two categories', () => {
  const TWICE_HTML = indexPage(
    ...Array.from({ length: 2_000 }, (_, index) =>
      entryRow({ href: `/assignments/filler-${index % 520}#f${index}`, title: `Filler ${index}` }),
    ),
    categoryRow('Interface Parameters'),
    entryRow({ href: '/assignments/smi-example#smi-example-5', title: 'Example Types (exType)' }),
    categoryRow('Management Information'),
    entryRow({ href: '/assignments/smi-example#smi-example-5', title: 'Example Types (exType)' }),
  );

  it('returns it once, its categories joined with "; ", in both surfaces', async () => {
    boot(TWICE_HTML);
    const out = await call({ query: 'example types' });
    expect(rows(out)).toEqual([
      expect.objectContaining({
        registry_id: 'smi-example',
        subregistry_id: 'smi-example-5',
        category: 'Interface Parameters; Management Information',
      }),
    ]);
    expect(out.structured).toMatchObject({ totalCount: 1, shown: 1 });
    expect(out.text).toContain('**Category:** Interface Parameters; Management Information');
  });

  it('finds it through the words of either category, or both', async () => {
    boot(TWICE_HTML);
    for (const query of [
      'interface parameters',
      'management information',
      'interface management',
    ]) {
      expect(ids(await call({ query }))).toEqual(['smi-example#smi-example-5']);
    }
  });
});

describe('iana_search_registries: the live index', () => {
  const LIVE_HTML = liveIndexHtml();

  it.each([
    ['protocol numbers', 'protocol-numbers#protocol-numbers-1'],
    ['dhcpv6 options', 'dhcpv6-parameters#dhcpv6-parameters-2'],
    ['dhcp options', 'bootp-dhcp-parameters#options'],
    ['ethertype', 'ieee-802-numbers#ieee-802-numbers-1'],
    ['media types', 'media-types'],
    ['tls cipher suites', 'tls-parameters#tls-parameters-4'],
    ['dns rr types', 'dns-parameters#dns-parameters-4'],
    ['cbor tags', 'cbor-tags#tags'],
    ['http methods', 'http-methods#methods'],
    ['command codes', 'aaa-parameters#aaa-parameters-47'],
  ])('"%s" ranks %s first', async (query, first) => {
    boot(LIVE_HTML);
    expect(ids(await call({ query }))[0]).toBe(first);
  });

  it('"tls extensions" ranks the TLS ExtensionType registry within the first two', async () => {
    boot(LIVE_HTML);
    const top = ids(await call({ query: 'tls extensions' })).slice(0, 2);
    expect(top).toContain('tls-extensiontype-values#tls-extensiontype-values-1');
  });

  it('"ip protocol numbers" cannot reach protocol-numbers: "ip" is none of its words', async () => {
    boot(LIVE_HTML);
    const out = await call({ query: 'ip protocol numbers' });
    expect(out.structured).toMatchObject({ totalCount: 4 });
    expect(ids(out)).not.toContain('protocol-numbers#protocol-numbers-1');
  });

  it('"interface types" lists each SMI table once, under both its categories', async () => {
    boot(LIVE_HTML);
    const out = await call({ query: 'interface types', limit: 50 });
    const smi = rows(out).filter((row) => row.registry_id === 'smi-numbers');
    expect(smi.map((row) => row.subregistry_id)).toEqual(['smi-numbers-5', 'smi-numbers-6']);
    for (const row of smi) {
      expect(row.category).toBe(
        'Interface Parameters; Structure of Management Information (SMI) Numbers (MIB Module Registrations)',
      );
    }
    expect(new Set(ids(out)).size).toBe(ids(out).length);
    expect(ids(await call({ query: 'interface parameters mib' }))).toEqual([
      'smi-numbers#smi-numbers-5',
      'smi-numbers#smi-numbers-6',
    ]);
  });

  it('pages "media types" in two offset pages, the short last page ending the list', async () => {
    boot(LIVE_HTML);
    const all = ids(await call({ query: 'media types', limit: 50 }));
    const first = await call({ query: 'media types', limit: 15 });
    const last = await call({ query: 'media types', limit: 15, offset: 15 });
    expect(all).toHaveLength(28);
    expect(first.structured).toMatchObject({ totalCount: 28, shown: 15, next_offset: 15 });
    expect(last.structured).toMatchObject({ totalCount: 28, shown: 13, truncated: false });
    expect(last.structured).not.toHaveProperty('next_offset');
    expect([...ids(first), ...ids(last)]).toEqual(all);
  });

  it('pages every "protocol numbers" match once, none skipped or repeated', async () => {
    boot(LIVE_HTML);
    const paged: string[] = [];
    for (const offset of [0, 50, 100, 150]) {
      const page = await call({ query: 'protocol numbers', limit: 50, offset });
      expect(page.structured).toMatchObject({ totalCount: 189 });
      paged.push(...ids(page));
    }
    expect(paged).toHaveLength(189);
    expect(new Set(paged).size).toBe(189);
    expect(paged[0]).toBe('protocol-numbers#protocol-numbers-1');
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
    ['a negative offset', { query: 'cipher', offset: -1 }],
    ['a fractional offset', { query: 'cipher', offset: 2.5 }],
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
      cap: 15,
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

  it('a body over the 8 MiB ceiling is index_unreadable after one fetch: not retryable, in both surfaces', async () => {
    const s = boot('x'.repeat(8 * 1024 * 1024 + 1));
    const out = await call({ query: 'cipher' });
    expect(out.structured.error).toMatchObject({
      data: {
        reason: 'index_unreadable',
        maxBytes: 8 * 1024 * 1024,
        retryable: false,
        recovery: { hint: BODY_OVER_CEILING_HINT },
      },
    });
    expect(out.text).toContain(`Recovery: ${BODY_OVER_CEILING_HINT}`);
    expect(out.text).toContain('reason index_unreadable · not retryable');
    expect(out.text).not.toContain('attempts');
    expect(s.fetches()).toBe(1);
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
      attempts: 1,
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
