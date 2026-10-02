/**
 * @fileoverview Tests for `iana_lookup_uri_scheme`: exact schemes (case,
 * trailing `:` and `://`, the annotated `shttp (OBSOLETE)` value, template and
 * well-known fields), the status filter and its notices, keyword search with
 * ranking, input validation (blank strings read as unset), the declared error
 * rows, the list-enrichment contract, and `format()` parity and sanitizing.
 * Upstream I/O is a `createFetchMock` fake behind the injected `UpstreamClient`.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupUriScheme } from '@/mcp-server/tools/definitions/lookup-uri-scheme.tool.js';
import { registryXmlUrl } from '@/services/registry/registry-store.js';
import { SCHEMES_XML, singleTableXml, xmlEscape } from '../fixtures/http-registries.js';
import { DOCTYPE_XML, EMPTY_XML, WRONG_ROOT_XML } from '../fixtures/registry-xml.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { callTool, setupTools } from '../shared/tool-harness.js';
import { htmlResponse, xmlResponse } from '../shared/upstream-harness.js';

const SCHEMES_URL = registryXmlUrl('uri-schemes');
const TABLE = 'uri-schemes-1';
const TEMPLATE_BASE = 'https://www.iana.org/assignments/uri-schemes/';

interface SchemeRow {
  description?: string;
  notes?: string;
  references: { id: string; section?: string; type: string; url?: string }[];
  registered?: string;
  scheme: string;
  status?: string;
  status_note?: string;
  template_url?: string;
  updated?: string;
  well_known_uri_support?: string;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function boot(xml = SCHEMES_XML) {
  const s = setupTools();
  s.serve({ [SCHEMES_URL]: () => xmlResponse(xml) });
  return s;
}

const schemesXml = (records: string) => singleTableXml('uri-schemes', TABLE, records);
const record = (value: string, description: string, status = 'permanent', extra = '') =>
  `<record><value>${value}</value><description>${description}</description><status>${status}</status>${extra}</record>`;

const call = (input: Record<string, unknown>) => callTool(lookupUriScheme, input);
const rows = (out: { structured: Record<string, unknown> }) =>
  out.structured.schemes as SchemeRow[];
const names = (out: { structured: Record<string, unknown> }) => rows(out).map((row) => row.scheme);

describe('iana_lookup_uri_scheme: exact scheme', () => {
  it('returns status, description, template URL, references, and dates', async () => {
    boot();
    const out = await call({ scheme: 'https' });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      mode: 'scheme',
      found: true,
      schemes: [
        {
          scheme: 'https',
          status: 'permanent',
          description: 'Hypertext Transfer Protocol Secure',
          template_url: `${TEMPLATE_BASE}https`,
          references: [
            {
              type: 'rfc',
              id: 'RFC 9110',
              section: '4.2.2',
              url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
            },
          ],
          registered: '2011-12-01',
        },
      ],
      source: expect.objectContaining({
        registry_id: 'uri-schemes',
        url: SCHEMES_URL,
        registry_updated: '2026-01-15',
        stale: false,
      }),
      totalCount: 1,
      shown: 1,
      cap: 25,
      truncated: false,
    });
  });

  it.each(['HTTPS', 'https:', 'https://', 'HTTPS://', '  Https:  '])(
    'ignores case, a trailing ":" or "://", and whitespace: %j',
    async (scheme) => {
      boot();
      expect(names(await call({ scheme }))).toEqual(['https']);
    },
  );

  it('drops the placeholder well-known value "-" and the empty notes element', async () => {
    boot();
    const [row] = rows(await call({ scheme: 'mailto' }));
    expect(row).not.toHaveProperty('well_known_uri_support');
    expect(row).not.toHaveProperty('notes');
    expect(row).not.toHaveProperty('template_url');
  });

  it('splits the annotated value shttp (OBSOLETE) into scheme and status_note', async () => {
    boot();
    const [row] = rows(await call({ scheme: 'shttp' }));
    expect(row).toMatchObject({ scheme: 'shttp', status: 'historical', status_note: 'OBSOLETE' });
  });

  it('keeps a real well-known reference and percent-encodes the template path', async () => {
    boot();
    const [row] = rows(await call({ scheme: 'ws' }));
    expect(row?.well_known_uri_support).toBe('RFC 8615');
    expect(row?.template_url).toBe(`${TEMPLATE_BASE}ws/a%20b`);
  });

  it('keeps notes, and replaces an email-shaped token in the description', async () => {
    boot();
    const out = await call({ scheme: 'example-prov' });
    const [row] = rows(out);
    expect(row).toMatchObject({
      status: 'provisional',
      notes: 'Some registry notes.',
      description: 'Example provisional scheme, contact [email removed]',
    });
    expect(out.text).not.toContain('support@example.org');
  });

  it('leaves status out of a row without a status element', async () => {
    boot();
    expect(rows(await call({ scheme: 'example-bare' }))[0]).not.toHaveProperty('status');
  });

  it('explains a miss with the keyword fallback, naming the normalized scheme', async () => {
    boot();
    const out = await call({ scheme: 'GOPHER://' });
    expect(out.structured).toMatchObject({
      mode: 'scheme',
      found: false,
      schemes: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice:
        'gopher is not a registered URI scheme. Call iana_lookup_uri_scheme with keyword to search descriptions.',
    });
  });

  it('reads only the uri-schemes-1 sub-registry: allocator rows are never schemes', async () => {
    boot();
    expect(names(await call({ keyword: 'allocator' }))).toEqual([]);
    expect(names(await call({ keyword: 'range' }))).toEqual([]);
  });

  it('returns every row for a duplicated scheme', async () => {
    boot(
      schemesXml(`${record('dup', 'first', 'permanent')}${record('dup', 'second', 'historical')}`),
    );
    const out = await call({ scheme: 'dup' });
    expect(rows(out).map((row) => row.description)).toEqual(['first', 'second']);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2, truncated: false });
  });

  it('discloses a cut when limit is smaller than the number of rows for the scheme', async () => {
    boot(schemesXml(`${record('dup', 'first')}${record('dup', 'second')}`));
    const out = await call({ scheme: 'dup', limit: 1 });
    expect(rows(out)).toHaveLength(1);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 1, cap: 1, truncated: true });
  });
});

describe('iana_lookup_uri_scheme: status filter', () => {
  it('keeps rows with the requested status', async () => {
    boot();
    expect(names(await call({ scheme: 'ws', status: 'permanent' }))).toEqual(['ws']);
    expect(names(await call({ keyword: 'secure', status: 'historical' }))).toEqual(['shttp']);
  });

  it('says the status filter excluded a registered scheme', async () => {
    boot();
    const out = await call({ scheme: 'ws', status: 'historical' });
    expect(out.structured).toMatchObject({
      found: false,
      schemes: [],
      totalCount: 0,
      notice: 'ws is registered with status permanent; the status filter historical excludes it.',
    });
  });

  it('names an unrecorded status in the exclusion notice', async () => {
    boot();
    expect((await call({ scheme: 'example-bare', status: 'permanent' })).structured.notice).toBe(
      'example-bare is registered with status unrecorded; the status filter permanent excludes it.',
    );
  });

  it('echoes the status filter in a keyword miss', async () => {
    boot();
    expect((await call({ keyword: 'websocket', status: 'provisional' })).structured.notice).toBe(
      'No URI scheme matched "websocket" with status provisional.',
    );
    expect((await call({ keyword: 'zzz' })).structured.notice).toBe('No URI scheme matched "zzz".');
  });

  it('normalizes the status: case and whitespace', async () => {
    boot();
    expect(names(await call({ keyword: 'example', status: ' PROVISIONAL ' }))).toEqual([
      'example-prov',
    ]);
  });
});

describe('iana_lookup_uri_scheme: keyword', () => {
  it('matches whole tokens of the scheme name and the description', async () => {
    boot();
    expect(names(await call({ keyword: 'websocket' }))).toEqual(['ws', 'wss']);
    expect(names(await call({ keyword: 'encrypted websocket' }))).toEqual(['wss']);
    expect(names(await call({ keyword: 'mailto' }))).toEqual(['mailto']);
    expect(names(await call({ keyword: 'shttp' }))).toEqual(['shttp']);
    expect(names(await call({ keyword: 'sock' }))).toEqual([]);
  });

  it('matches each part of a camelCase description word', async () => {
    boot();
    expect(names(await call({ keyword: 'socket' }))).toEqual(['ws', 'wss']);
    expect(names(await call({ keyword: 'web socket' }))).toEqual(['ws', 'wss']);
  });

  it('lists matches in registry order', async () => {
    boot();
    expect(names(await call({ keyword: 'secure' }))).toEqual(['https', 'shttp']);
    expect(names(await call({ keyword: 'example' }))).toEqual(['example-prov', 'example-bare']);
  });

  it('ranks an exact scheme hit before earlier matches', async () => {
    boot(schemesXml(`${record('dws', 'uses ws internally')}${record('ws', 'WebSocket')}`));
    expect(names(await call({ keyword: 'ws' }))).toEqual(['ws', 'dws']);
    expect(names(await call({ keyword: 'WS' }))).toEqual(['ws', 'dws']);
  });

  it('cuts at limit, discloses it, counts the full match set, and names the next offset', async () => {
    boot();
    const page = await call({ keyword: 'websocket', limit: 1 });
    expect(names(page)).toEqual(['ws']);
    expect(page.structured).toMatchObject({
      totalCount: 2,
      shown: 1,
      cap: 1,
      truncated: true,
      next_offset: 1,
      notice:
        'Showing 1 of 2 matching schemes; pass offset 1 for the next page, raise limit (max 100), or add words to keyword to narrow.',
    });
  });

  it('pages by offset: the next page holds the rest, without next_offset', async () => {
    boot();
    const second = await call({ keyword: 'websocket', limit: 1, offset: 1 });
    expect(names(second)).toEqual(['wss']);
    expect(second.structured).toMatchObject({ found: true, shown: 1, truncated: false });
    expect(second.structured).not.toHaveProperty('next_offset');
  });

  it('returns an empty page for an offset past the end, still found, with the total', async () => {
    boot();
    const out = await call({ keyword: 'websocket', offset: 2 });
    expect(out.structured).toMatchObject({
      found: true,
      schemes: [],
      totalCount: 2,
      shown: 0,
      notice:
        'Offset 2 is past the 2 matching schemes; pass an offset below 2, or omit offset to start over.',
    });
  });

  it('ignores offset in scheme mode and says so', async () => {
    boot();
    const out = await call({ scheme: 'mailto', offset: 1 });
    expect(names(out)).toEqual(['mailto']);
    expect(out.structured.notice).toBe(
      'offset applies to keyword mode only; it was ignored for this exact lookup.',
    );
  });

  it('reads blank optional inputs as unset: keyword mode, no status filter, default limit', async () => {
    boot();
    const out = await call({ scheme: '', keyword: 'websocket', status: '', limit: ' ' });
    expect(names(out)).toEqual(['ws', 'wss']);
    expect(out.structured).toMatchObject({ mode: 'keyword', cap: 25 });
  });

  it('applies a digit-string limit', async () => {
    boot();
    expect((await call({ keyword: 'websocket', limit: '1' })).structured).toMatchObject({
      cap: 1,
      shown: 1,
    });
  });
});

describe('iana_lookup_uri_scheme: input validation', () => {
  it.each([
    ['a scheme with a space', { scheme: 'Bad Scheme' }],
    ['a scheme starting with a digit', { scheme: '1abc' }],
    ['a scheme with a disallowed character', { scheme: 'ht!tp' }],
    ['a scheme over 64 characters', { scheme: 'a'.repeat(65) }],
    ['a delimiter-only scheme', { scheme: '://' }],
    ['a one-character keyword', { keyword: 'a' }],
    ['a keyword over 100 characters', { keyword: 'a'.repeat(101) }],
    ['an unknown status', { scheme: 'https', status: 'bogus' }],
    ['limit 0', { keyword: 'ws', limit: 0 }],
    ['limit above 100', { keyword: 'ws', limit: 101 }],
    ['a non-numeric limit', { keyword: 'ws', limit: 'many' }],
    ['a negative offset', { keyword: 'ws', offset: -1 }],
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

  it('accepts a 64-character scheme and the full scheme character set', async () => {
    boot();
    expect((await call({ scheme: `a${'b'.repeat(63)}` })).isError).toBe(false);
    expect((await call({ scheme: 'a+b.c-d9' })).structured).toMatchObject({ found: false });
  });
});

describe('iana_lookup_uri_scheme: mode_required', () => {
  it.each([
    ['neither', {}],
    ['both', { scheme: 'https', keyword: 'secure' }],
    ['two blank strings', { scheme: '', keyword: ' ' }],
    ['status alone', { status: 'permanent' }],
  ])('fails %s as mode_required with the recovery, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Pass exactly one of scheme or keyword.',
      data: {
        reason: 'mode_required',
        recovery: { hint: 'Pass exactly one of scheme or keyword to iana_lookup_uri_scheme.' },
      },
    });
    expect(out.text).toContain(
      'Recovery: Pass exactly one of scheme or keyword to iana_lookup_uri_scheme.',
    );
    expect(s.fetches()).toBe(0);
  });
});

describe('iana_lookup_uri_scheme: list-enrichment contract', () => {
  it('zero-result page: counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ keyword: 'zzzz' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      found: false,
      schemes: [],
      totalCount: 0,
      shown: 0,
      cap: 25,
      truncated: false,
    });
    expect(out.text).toContain('0 total');
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('under-cap page: shown equals the match count and nothing is truncated', async () => {
    boot();
    const out = await call({ keyword: 'websocket', limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2, cap: 10, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_lookup_uri_scheme: registry layout changes surface as unreadable', () => {
  it('a registry without the uri-schemes-1 sub-registry is unreadable, not empty', async () => {
    const s = boot(singleTableXml('uri-schemes', 'ipn-only', record('https', 'x')));
    const out = await call({ scheme: 'https' });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unreadable',
        subregistry: TABLE,
        recovery: {
          hint: 'The IANA URI scheme registry could not be read; retry iana_lookup_uri_scheme shortly.',
        },
      },
    });
    expect(s.fetches()).toBe(1);
  });
});

describe('iana_lookup_uri_scheme: format()', () => {
  it('prints every structuredContent field of one scheme', async () => {
    boot();
    const out = await call({ scheme: 'ws' });
    expect(out.text).toContain('### ws');
    expect(out.text).toContain('**Status:** permanent');
    expect(out.text).toContain('**Description:**\n> WebSocket connections');
    expect(out.text).toContain('**Well-known URI support:** RFC 8615');
    expect(out.text).toContain(`**Template:** <${TEMPLATE_BASE}ws/a%20b>`);
    expect(out.text).toContain('**Mode:** scheme · **Found:** true');
    expect(out.text).toContain('**Source:** `uri-schemes` · registry updated 2026-01-15');
  });

  it('prints the annotation, notes, dates, and references', async () => {
    boot();
    expect((await call({ scheme: 'shttp' })).text).toContain('### shttp (OBSOLETE)');
    expect((await call({ scheme: 'example-prov' })).text).toContain(
      '**Notes:**\n> Some registry notes.',
    );
    const https = (await call({ scheme: 'https' })).text;
    expect(https).toContain('**Registered:** 2011-12-01');
    expect(https).toContain(
      '- RFC 9110 (rfc) §4.2.2 <https://www.rfc-editor.org/rfc/rfc9110.html>',
    );
  });

  it('prints "not recorded" for an absent status', async () => {
    boot();
    expect((await call({ scheme: 'example-bare' })).text).toContain('**Status:** not recorded');
  });

  it('carries every field of a multi-result page', async () => {
    boot();
    const out = await call({ keyword: 'websocket' });
    for (const row of rows(out)) {
      expect(out.text).toContain(`### ${row.scheme}`);
      expect(out.text).toContain(`> ${row.description}`);
    }
  });

  it('keeps hostile upstream text verbatim in structuredContent and inert in format()', async () => {
    const value = `${xmlEscape('evil <b>x</b> [x](https://evil.example/)')}<br/># Pwned`;
    const description = `${xmlEscape('![i](https://evil.example/i.png) <script>alert(1)</script>')}<br/># Heading<br/>---<br/>${xmlEscape('```')}\u202E\u0007`;
    const wellKnown = `RFC<br/>## Forged ${xmlEscape('[y](z)')}`;
    const notes = `n1<br/># Notes heading<br/>- item`;
    const file = xmlEscape('a)b>[c] d');
    boot(
      schemesXml(
        `<record><value>${value}</value><description>${description}</description>` +
          `<status>permanent</status><well-known>${wellKnown}</well-known>` +
          `<notes>${notes}</notes><file type="template">${file}</file></record>`,
      ),
    );
    const out = await call({ keyword: 'evil' });
    const [row] = rows(out);

    expect(row?.scheme).toBe('evil <b>x</b> [x](https://evil.example/)\n# Pwned');
    expect(row?.description).toContain(
      '![i](https://evil.example/i.png) <script>alert(1)</script>\n# Heading',
    );
    expect(row?.well_known_uri_support).toBe('RFC\n## Forged [y](z)');
    expect(row?.template_url).toBe(`${TEMPLATE_BASE}a)b%3E%5Bc%5D%20d`);

    const lines = out.text.split('\n');
    expect(lines.filter((line) => line.startsWith('###'))).toEqual([
      String.raw`### evil \<b\>x\</b\> \[x\](https://evil.example/) # Pwned`,
    ]);
    expect(lines).toContain(String.raw`**Well-known URI support:** RFC ## Forged \[y\](z)`);
    expect(lines).toContain(`**Template:** <${TEMPLATE_BASE}a%29b%3E%5Bc%5D%20d>`);
    expect(lines).toContain('> # Heading');
    expect(lines).toContain('> # Notes heading');
    expect(lines.some((line) => /^(# |## |- item|---$)/.test(line))).toBe(false);
    expect(out.text).not.toMatch(/[\u202E\u0007]/);
  });
});

describeFailureContract({
  definition: lookupUriScheme,
  input: { scheme: 'https' },
  url: SCHEMES_URL,
  ok: () => xmlResponse(SCHEMES_XML),
  reason: 'upstream_unreadable',
  recovery: 'The IANA URI scheme registry could not be read; retry iana_lookup_uri_scheme shortly.',
  unreadable: [
    { label: 'an HTML page served as 200', attempts: 1, response: () => htmlResponse('<html/>') },
    {
      label: 'a body with no registry root',
      attempts: 3,
      response: () => xmlResponse(WRONG_ROOT_XML),
    },
    { label: 'a DOCTYPE', attempts: 3, response: () => xmlResponse(DOCTYPE_XML) },
    { label: 'a registry with zero records', attempts: 3, response: () => xmlResponse(EMPTY_XML) },
  ],
});
