/**
 * @fileoverview Tests for `iana_lookup_http_field`: exact names (case, trailing
 * colon, registry casing), status filtering and its notices, keyword search over
 * names and comments with ranking, input validation (blank strings read as
 * unset), the declared error rows, the list-enrichment contract, and `format()`
 * parity and sanitizing. Upstream I/O is a `createFetchMock` fake behind the
 * injected `UpstreamClient`.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupHttpField } from '@/mcp-server/tools/definitions/lookup-http-field.tool.js';
import { registryXmlUrl } from '@/services/registry/registry-store.js';
import { FIELDS_XML, singleTableXml, xmlEscape } from '../fixtures/http-registries.js';
import { DOCTYPE_XML, EMPTY_XML, WRONG_ROOT_XML } from '../fixtures/registry-xml.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { callTool, setupTools } from '../shared/tool-harness.js';
import { htmlResponse, xmlResponse } from '../shared/upstream-harness.js';

const FIELDS_URL = registryXmlUrl('http-fields');
const TABLE = 'field-names';

interface FieldRow {
  comments?: string;
  name: string;
  references: { id: string; section?: string; type: string; url?: string }[];
  registered?: string;
  status?: string;
  structured_type?: string;
  updated?: string;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function boot(xml = FIELDS_XML) {
  const s = setupTools();
  s.serve({ [FIELDS_URL]: () => xmlResponse(xml) });
  return s;
}

const fieldsXml = (records: string) => singleTableXml('http-fields', TABLE, records);
const record = (name: string, status: string, extra = '') =>
  `<record><value>${name}</value><status>${status}</status>${extra}</record>`;

const call = (input: Record<string, unknown>) => callTool(lookupHttpField, input);
const rows = (out: { structured: Record<string, unknown> }) => out.structured.fields as FieldRow[];
const names = (out: { structured: Record<string, unknown> }) =>
  rows(out).map((field) => field.name);

describe('iana_lookup_http_field: exact name', () => {
  it('returns registry casing, lowercased status, structured type, comments, and references', async () => {
    boot();
    const out = await call({ name: 'cache-status' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      mode: 'name',
      found: true,
      fields: [
        {
          name: 'Cache-Status',
          status: 'permanent',
          structured_type: 'List',
          comments: 'Describes cache handling of the response.',
          references: [
            { type: 'rfc', id: 'RFC 9211', url: 'https://www.rfc-editor.org/rfc/rfc9211.html' },
          ],
        },
      ],
      totalCount: 1,
      shown: 1,
      cap: 25,
      truncated: false,
      source: {
        registry_id: 'http-fields',
        url: FIELDS_URL,
        registry_updated: '2026-03-10',
        stale: false,
      },
    });
  });

  it('matches case-insensitively and reads the registration date', async () => {
    boot();
    for (const name of ['accept', 'ACCEPT', 'Accept']) {
      const [field] = rows(await call({ name }));
      expect(field).toMatchObject({
        name: 'Accept',
        status: 'permanent',
        structured_type: 'List',
        registered: '2022-06-01',
        references: [{ type: 'rfc', id: 'RFC 9110', section: '12.5.1' }],
      });
    }
  });

  it('drops a trailing colon and surrounding whitespace from the name', async () => {
    boot();
    expect(names(await call({ name: 'Content-Type:' }))).toEqual(['Content-Type']);
    expect(names(await call({ name: '  cache-status:  ' }))).toEqual(['Cache-Status']);
  });

  it('lowercases a mixed-case registry status and omits an absent Structured Field type', async () => {
    boot();
    const [field] = rows(await call({ name: 'Content-Type' }));
    expect(field?.status).toBe('permanent');
    expect(field).not.toHaveProperty('structured_type');
    expect(field).not.toHaveProperty('comments');
  });

  it('leaves status out of a row that has no status element', async () => {
    boot();
    const [field] = rows(await call({ name: 'Example-Unrecorded' }));
    expect(field).not.toHaveProperty('status');
  });

  it('returns every row that carries the name, in registry order', async () => {
    boot();
    const out = await call({ name: 'example-dual' });
    expect(rows(out).map((field) => field.status)).toEqual(['permanent', 'deprecated']);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2, truncated: false });
  });

  it('discloses a cut when limit is smaller than the number of rows for the name', async () => {
    boot();
    const out = await call({ name: 'Example-Dual', limit: 1 });
    expect(rows(out)).toHaveLength(1);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 1, cap: 1, truncated: true });
  });

  it('explains a miss and names the keyword fallback', async () => {
    boot();
    const out = await call({ name: 'X-Forwarded-For' });
    expect(out.structured).toMatchObject({
      mode: 'name',
      found: false,
      fields: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice:
        'X-Forwarded-For has no IANA registration. Call iana_lookup_http_field with keyword set to part of the name to find related registered fields.',
    });
    expect(out.text).toContain('**Mode:** name · **Found:** false');
  });

  it('accepts every RFC 9110 token character in a name', async () => {
    boot();
    const out = await call({ name: "X-A!#$%&'*+.^_`|~9" });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ found: false });
  });
});

describe('iana_lookup_http_field: status filter', () => {
  it('keeps the rows with the requested status in name mode', async () => {
    boot();
    const out = await call({ name: 'Example-Dual', status: 'deprecated' });
    expect(rows(out).map((field) => field.status)).toEqual(['deprecated']);
    expect(out.structured).toMatchObject({ totalCount: 1, shown: 1 });
  });

  it('says the status filter excluded a registered name', async () => {
    boot();
    const out = await call({ name: 'Example-Deprecated', status: 'permanent' });
    expect(out.structured).toMatchObject({
      found: false,
      fields: [],
      totalCount: 0,
      notice:
        'Example-Deprecated is registered with status deprecated; the status filter permanent excludes it.',
    });
  });

  it('lists every status of a duplicated name when the filter excludes them all', async () => {
    boot();
    const out = await call({ name: 'Example-Dual', status: 'obsoleted' });
    expect(out.structured.notice).toBe(
      'Example-Dual is registered with status permanent, deprecated; the status filter obsoleted excludes it.',
    );
  });

  it('names an unrecorded status in the exclusion notice', async () => {
    boot();
    const out = await call({ name: 'Example-Unrecorded', status: 'permanent' });
    expect(out.structured.notice).toBe(
      'Example-Unrecorded is registered with status unrecorded; the status filter permanent excludes it.',
    );
  });

  it('filters keyword results and counts after the filter', async () => {
    boot();
    const out = await call({ keyword: 'example', status: 'deprecated' });
    expect(names(out)).toEqual(['Example-Deprecated', 'Example-Dual']);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2 });
  });

  it('echoes the status filter in a keyword miss', async () => {
    boot();
    expect((await call({ keyword: 'zzz', status: 'permanent' })).structured.notice).toBe(
      'No registered field matched "zzz" with status permanent.',
    );
    expect((await call({ keyword: 'zzz' })).structured.notice).toBe(
      'No registered field matched "zzz".',
    );
  });

  it('normalizes the status: case and whitespace', async () => {
    boot();
    expect(names(await call({ keyword: 'example', status: ' PROVISIONAL ' }))).toEqual([
      'Example-Provisional',
    ]);
    expect(names(await call({ name: 'Example-Provisional', status: 'Provisional' }))).toEqual([
      'Example-Provisional',
    ]);
  });
});

describe('iana_lookup_http_field: keyword', () => {
  it('matches whole tokens of the name and the comments', async () => {
    boot();
    expect(names(await call({ keyword: 'cache' }))).toEqual(['Cache-Status']);
    expect(names(await call({ keyword: 'status' }))).toEqual([
      'Cache-Status',
      'Example-Unrecorded',
    ]);
    expect(names(await call({ keyword: 'handling response' }))).toEqual(['Cache-Status']);
    expect(names(await call({ keyword: 'cach' }))).toEqual([]);
  });

  it('lists matches in registry order', async () => {
    boot();
    expect(names(await call({ keyword: 'example' }))).toEqual([
      'Example-Provisional',
      'Example-Deprecated',
      'Example-Obsolete',
      'Example-Dual',
      'Example-Dual',
      'Example-Unrecorded',
    ]);
  });

  it('ranks an exact name hit before earlier matches', async () => {
    boot(fieldsXml(`${record('Alpha-Foo', 'permanent')}${record('Foo', 'permanent')}`));
    expect(names(await call({ keyword: 'foo' }))).toEqual(['Foo', 'Alpha-Foo']);
    expect(names(await call({ keyword: 'FOO' }))).toEqual(['Foo', 'Alpha-Foo']);
  });

  it('cuts at limit, discloses it, counts the full match set, and names the next offset', async () => {
    boot();
    const out = await call({ keyword: 'example', limit: 2 });
    expect(names(out)).toEqual(['Example-Provisional', 'Example-Deprecated']);
    expect(out.structured).toMatchObject({
      totalCount: 6,
      shown: 2,
      cap: 2,
      truncated: true,
      next_offset: 2,
      notice:
        'Showing 2 of 6 matching fields; pass offset 2 for the next page, raise limit (max 100), or add words to keyword to narrow.',
    });
  });

  it('pages by offset in the same order, the last page without next_offset', async () => {
    boot();
    const pages = [];
    for (const offset of [0, 2, 4])
      pages.push(await call({ keyword: 'example', limit: 2, offset }));
    expect(pages.flatMap(names)).toEqual(names(await call({ keyword: 'example' })));
    expect(pages[1]?.structured).toMatchObject({
      next_offset: 4,
      notice:
        'Showing 3–4 of 6 matching fields; pass offset 4 for the next page, raise limit (max 100), or add words to keyword to narrow.',
    });
    expect(pages[2]?.structured).toMatchObject({ shown: 2, truncated: false });
    expect(pages[2]?.structured).not.toHaveProperty('next_offset');
  });

  it('returns an empty page for an offset past the end, still found, with the total', async () => {
    boot();
    const out = await call({ keyword: 'example', offset: 6 });
    expect(out.structured).toMatchObject({
      found: true,
      fields: [],
      totalCount: 6,
      shown: 0,
      notice:
        'Offset 6 is past the 6 matching fields; pass an offset below 6, or omit offset to start over.',
    });
  });

  it('ignores offset in name mode and says so', async () => {
    boot();
    const out = await call({ name: 'Cache-Status', offset: 1 });
    expect(names(out)).toEqual(['Cache-Status']);
    expect(out.structured.notice).toBe(
      'offset applies to keyword mode only; it was ignored for this exact lookup.',
    );
  });

  it('reads blank optional inputs as unset: keyword mode, no status filter, default limit', async () => {
    boot();
    const out = await call({ name: '', keyword: 'cache', status: '  ', limit: '' });
    expect(names(out)).toEqual(['Cache-Status']);
    expect(out.structured).toMatchObject({ mode: 'keyword', cap: 25 });
  });

  it('applies a digit-string limit', async () => {
    boot();
    expect((await call({ keyword: 'example', limit: '3' })).structured).toMatchObject({
      cap: 3,
      shown: 3,
    });
  });
});

describe('iana_lookup_http_field: input validation', () => {
  it.each([
    ['a name with a space', { name: 'Bad Name' }],
    ['a name with a colon inside', { name: 'a:b' }],
    ['a colon-only name', { name: ':' }],
    ['a non-ASCII name', { name: 'Ünï' }],
    ['a name over 100 characters', { name: 'a'.repeat(101) }],
    ['a one-character keyword', { keyword: 'a' }],
    ['a keyword over 100 characters', { keyword: 'a'.repeat(101) }],
    ['an unknown status', { name: 'Accept', status: 'bogus' }],
    ['limit 0', { keyword: 'cache', limit: 0 }],
    ['limit above 100', { keyword: 'cache', limit: 101 }],
    ['a non-numeric limit', { keyword: 'cache', limit: 'many' }],
    ['a negative offset', { keyword: 'cache', offset: -1 }],
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

  it('accepts a 100-character name and limit 100', async () => {
    boot();
    expect((await call({ name: 'a'.repeat(100), limit: 100 })).isError).toBe(false);
  });
});

describe('iana_lookup_http_field: mode_required', () => {
  it.each([
    ['neither', {}],
    ['both', { name: 'Accept', keyword: 'cache' }],
    ['two blank strings', { name: '', keyword: ' ' }],
    ['status alone', { status: 'permanent' }],
  ])('fails %s as mode_required with the recovery, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Pass exactly one of name or keyword.',
      data: {
        reason: 'mode_required',
        recovery: { hint: 'Pass exactly one of name or keyword to iana_lookup_http_field.' },
      },
    });
    expect(out.text).toContain(
      'Recovery: Pass exactly one of name or keyword to iana_lookup_http_field.',
    );
    expect(s.fetches()).toBe(0);
  });
});

describe('iana_lookup_http_field: list-enrichment contract', () => {
  it('zero-result page: counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ keyword: 'zzzz' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      found: false,
      fields: [],
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
    const out = await call({ keyword: 'example', limit: 50 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 6, shown: 6, cap: 50, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_lookup_http_field: registry layout changes surface as unreadable', () => {
  it('a registry without the field-names sub-registry is unreadable, not empty', async () => {
    const s = boot(singleTableXml('http-fields', 'renamed', record('Accept', 'permanent')));
    const out = await call({ name: 'Accept' });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unreadable',
        subregistry: TABLE,
        recovery: {
          hint: 'The IANA HTTP field registry could not be read; retry iana_lookup_http_field shortly.',
        },
      },
    });
    expect(s.fetches()).toBe(1);
  });
});

describe('iana_lookup_http_field: personal data and format()', () => {
  it('replaces an email-shaped token in comments in both surfaces and keeps the link target', async () => {
    boot();
    const out = await call({ name: 'Example-Provisional' });
    const [field] = rows(out);
    expect(field?.comments).toBe(
      'Questions to [email removed] about the spec (https://example.org/spec/provisional).',
    );
    expect(out.text).toContain(String.raw`Questions to \[email removed\] about the spec`);
    expect(out.text).not.toContain('maintainers@example.org');
    expect(field?.updated).toBe('2024-02-02');
    expect(out.text).toContain('**Updated:** 2024-02-02');
  });

  it('carries every structuredContent field of a multi-result page', async () => {
    boot();
    const out = await call({ keyword: 'example' });
    for (const field of rows(out)) {
      expect(out.text).toContain(`### ${field.name}`);
      expect(out.text).toContain(`**Status:** ${field.status ?? 'not recorded'}`);
      if (field.comments) {
        for (const line of field.comments.split('\n'))
          expect(out.text).toContain(`> ${line.replace(/[\\[\]<>]/g, '\\$&')}`);
      }
    }
    expect(out.text).toContain('**Mode:** keyword · **Found:** true');
    expect(out.text).toContain('**Source:** `http-fields` · registry updated 2026-03-10');
  });

  it('prints status, structured type, comments, and references of one field', async () => {
    boot();
    const out = await call({ name: 'Cache-Status' });
    expect(out.text).toContain('### Cache-Status');
    expect(out.text).toContain('**Status:** permanent · **Structured type:** List');
    expect(out.text).toContain('**Comments:**\n> Describes cache handling of the response.');
    expect(out.text).toContain('- RFC 9211 (rfc) <https://www.rfc-editor.org/rfc/rfc9211.html>');
  });

  it('prints "none registered" for an absent Structured Field type and "not recorded" for an absent status', async () => {
    boot();
    expect((await call({ name: 'Content-Type' })).text).toContain(
      '**Structured type:** none registered',
    );
    expect((await call({ name: 'Example-Unrecorded' })).text).toContain('**Status:** not recorded');
  });

  it('renders multi-line comments as one blockquote', async () => {
    boot();
    const out = await call({ name: 'Example-Obsolete' });
    expect(rows(out)[0]?.comments).toBe('Line one\nLine two');
    expect(out.text).toContain('**Comments:**\n> Line one\n> Line two');
  });

  it('keeps hostile upstream text verbatim in structuredContent and inert in format()', async () => {
    const name = xmlEscape('Evil <b>Name</b> [x](https://evil.example/)');
    const hostile = fieldsXml(
      `<record><value>${name}<br/># Injected heading</value>` +
        `<status>permanent<br/>- forged</status>` +
        `<structured>List<br/>## Forged</structured>` +
        `<comments>${xmlEscape('![i](https://evil.example/i.png)')}<br/># Heading<br/>---<br/>${xmlEscape('```')}<br/>${xmlEscape('<script>alert(1)</script>')}\u202E\u0007</comments></record>`,
    );
    boot(hostile);
    const out = await call({ keyword: 'evil' });
    const [field] = rows(out);

    expect(field?.name).toBe('Evil <b>Name</b> [x](https://evil.example/)\n# Injected heading');
    expect(field?.status).toBe('permanent\n- forged');
    expect(field?.structured_type).toBe('List\n## Forged');
    expect(field?.comments).toContain('\n# Heading\n---\n```\n<script>alert(1)</script>');

    const lines = out.text.split('\n');
    expect(lines.filter((line) => line.startsWith('###'))).toEqual([
      String.raw`### Evil \<b\>Name\</b\> \[x\](https://evil.example/) # Injected heading`,
    ]);
    expect(lines).toContain('**Status:** permanent - forged · **Structured type:** List ## Forged');
    const start = lines.indexOf('**Comments:**');
    const comment = lines.slice(
      start + 1,
      lines.findIndex((line, index) => index > start && line === ''),
    );
    expect(comment.length).toBeGreaterThan(4);
    expect(comment.every((line) => line.startsWith('> ') || line === '>')).toBe(true);
    expect(out.text).not.toMatch(/[\u202E\u0007]/);
    expect(lines.some((line) => /^(# |## |- forged|---$)/.test(line))).toBe(false);
  });
});

describeFailureContract({
  definition: lookupHttpField,
  input: { name: 'Accept' },
  url: FIELDS_URL,
  ok: () => xmlResponse(FIELDS_XML),
  reason: 'upstream_unreadable',
  recovery: 'The IANA HTTP field registry could not be read; retry iana_lookup_http_field shortly.',
  unreadable: [
    { label: 'an HTML page served as 200', attempts: 3, response: () => htmlResponse('<html/>') },
    {
      label: 'a body with no registry root',
      attempts: 3,
      response: () => xmlResponse(WRONG_ROOT_XML),
    },
    { label: 'a DOCTYPE', attempts: 3, response: () => xmlResponse(DOCTYPE_XML) },
    { label: 'a registry with zero records', attempts: 3, response: () => xmlResponse(EMPTY_XML) },
  ],
});
