/**
 * @fileoverview Tests for `iana_lookup_http_status`: exact codes (every class
 * and state), unassigned ranges, codes without a row, keyword search and its
 * ranking, input validation (blank strings read as unset), the declared error
 * rows, the list-enrichment contract on the zero-result and under-cap pages,
 * and `format()` parity and sanitizing. Upstream I/O is a `createFetchMock` fake
 * behind the injected `UpstreamClient`.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupHttpStatus } from '@/mcp-server/tools/definitions/lookup-http-status.tool.js';
import { registryXmlUrl } from '@/services/registry/registry-store.js';
import { STATUS_XML, singleTableXml, xmlEscape } from '../fixtures/http-registries.js';
import { DOCTYPE_XML, EMPTY_XML, WRONG_ROOT_XML } from '../fixtures/registry-xml.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { callTool, setupTools, T0 } from '../shared/tool-harness.js';
import { htmlResponse, xmlResponse } from '../shared/upstream-harness.js';

const STATUS_URL = registryXmlUrl('http-status-codes');
const TABLE = 'http-status-codes-1';

interface StatusRow {
  class: string;
  code: number;
  phrase: string;
  references: { id: string; section?: string; type: string; url?: string }[];
  registered?: string;
  state: string;
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

/** A store over the status fixture (or `xml`); returns the harness. */
function boot(xml = STATUS_XML) {
  const s = setupTools();
  s.serve({ [STATUS_URL]: () => xmlResponse(xml) });
  return s;
}

const statusXml = (records: string) => singleTableXml('http-status-codes', TABLE, records);
const row = (value: string, description: string, extra = '') =>
  `<record><value>${value}</value><description>${description}</description>${extra}</record>`;

const call = (input: Record<string, unknown>) => callTool(lookupHttpStatus, input);
const rows = (out: { structured: Record<string, unknown> }) =>
  out.structured.statuses as StatusRow[];
const codes = (out: { structured: Record<string, unknown> }) =>
  rows(out).map((status) => status.code);

describe('iana_lookup_http_status: exact code', () => {
  it('returns the phrase, class, state, references, and dates of a registered code', async () => {
    boot();
    const out = await call({ code: 100 });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      mode: 'code',
      found: true,
      statuses: [
        {
          code: 100,
          phrase: 'Continue',
          class: 'informational',
          state: 'assigned',
          references: [
            {
              type: 'rfc',
              id: 'RFC 9110',
              section: '15.2.1',
              url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
            },
          ],
          registered: '2020-01-02',
          updated: '2022-06-06',
        },
      ],
      source: {
        registry_id: 'http-status-codes',
        url: STATUS_URL,
        registry_updated: '2025-09-15',
        fetched_at: new Date(T0).toISOString(),
        stale: false,
      },
      totalCount: 1,
      shown: 1,
      cap: 25,
      truncated: false,
    });
  });

  it('reads the section from the label when the xref has no section attribute', async () => {
    boot();
    const [status] = rows(await call({ code: 200 }));
    expect(status?.references).toEqual([
      {
        type: 'rfc',
        id: 'RFC 9110',
        section: '15.3.1',
        url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
      },
    ]);
  });

  it.each([
    [100, 'informational'],
    [200, 'success'],
    [306, 'redirection'],
    [404, 'client_error'],
    [502, 'server_error'],
  ])('classifies %i as %s from its first digit', async (code, statusClass) => {
    boot();
    expect(rows(await call({ code }))[0]?.class).toBe(statusClass);
  });

  it.each([
    [418, '(Unused)', 'unused'],
    [306, '(Unused)', 'unused'],
    [305, 'Use Proxy (OBSOLETED)', 'obsoleted'],
    [
      104,
      'Upload Resumption Supported (TEMPORARY - registered 2024-11-13, expires 2025-11-13)',
      'temporary',
    ],
    [404, 'Not Found', 'assigned'],
  ])(
    'reads the state of %i from the registry marker in its phrase',
    async (code, phrase, state) => {
      boot();
      const [status] = rows(await call({ code }));
      expect(status).toMatchObject({ code, phrase, state });
    },
  );

  it('accepts a digit string and surrounding whitespace for code', async () => {
    boot();
    expect(codes(await call({ code: '429' }))).toEqual([429]);
    expect(codes(await call({ code: ' 404 ' }))).toEqual([404]);
    expect(codes(await call({ code: '0404' }))).toEqual([404]);
  });

  it('fetches the status registry once for repeated calls', async () => {
    const s = boot();
    await call({ code: 200 });
    await call({ code: 404 });
    expect(s.fetched()).toEqual([STATUS_URL]);
  });
});

describe('iana_lookup_http_status: unassigned codes and codes without a row', () => {
  it.each([
    [105, '105-199'],
    [150, '105-199'],
    [199, '105-199'],
    [432, '432-450'],
    [440, '432-450'],
    [450, '432-450'],
    [512, '512-599'],
    [599, '512-599'],
  ])('returns found: false with the range row for the unassigned code %i', async (code, range) => {
    boot();
    const out = await call({ code });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      mode: 'code',
      found: false,
      statuses: [],
      unassigned_range: range,
      totalCount: 0,
      shown: 0,
      cap: 25,
      truncated: false,
      notice: `HTTP ${code} is unassigned (registry range ${range}); it has no standard meaning.`,
    });
    expect(out.text).toContain(`**Unassigned range:** ${range}`);
  });

  it.each([451, 307, 599])('says there is no row, and names no range, for %i', async (code) => {
    boot(statusXml(`${row('404', 'Not Found')}${row('200', 'OK')}`));
    const out = await call({ code });
    expect(out.structured).toMatchObject({
      found: false,
      statuses: [],
      totalCount: 0,
      notice: `HTTP ${code} has no row in the IANA status code registry; it has no standard meaning.`,
    });
    expect(out.structured).not.toHaveProperty('unassigned_range');
  });

  it('never returns a range row as a status for an exact code', async () => {
    boot();
    expect(rows(await call({ code: 150 }))).toEqual([]);
  });
});

describe('iana_lookup_http_status: keyword', () => {
  it('matches whole tokens of the phrase and ignores case and punctuation', async () => {
    boot();
    expect(codes(await call({ keyword: 'too many' }))).toEqual([429]);
    expect(codes(await call({ keyword: 'TOO  MANY' }))).toEqual([429]);
    expect(codes(await call({ keyword: 'not-found' }))).toEqual([404]);
    expect(await call({ keyword: 'gate' })).toMatchObject({
      structured: { found: false, statuses: [] },
    });
  });

  it('lists matches in registry order', async () => {
    boot();
    const out = await call({ keyword: 'gateway' });
    expect(codes(out)).toEqual([502, 504]);
    expect(out.structured).toMatchObject({ mode: 'keyword', found: true, totalCount: 2, shown: 2 });
  });

  it('ranks an exact phrase hit before earlier partial matches', async () => {
    boot(statusXml(`${row('503', 'Service Unavailable')}${row('599', 'Unavailable')}`));
    expect(codes(await call({ keyword: 'unavailable' }))).toEqual([599, 503]);
    expect(codes(await call({ keyword: 'UNAVAILABLE' }))).toEqual([599, 503]);
  });

  it('searches the phrase only: not the code, not unassigned rows, not range rows', async () => {
    boot();
    expect(codes(await call({ keyword: '404' }))).toEqual([]);
    expect(codes(await call({ keyword: 'unassigned' }))).toEqual([]);
    expect(codes(await call({ keyword: 'rfc' }))).toEqual([]);
  });

  it('finds (Unused) codes by the marker word', async () => {
    boot();
    const out = await call({ keyword: 'unused' });
    expect(codes(out)).toEqual([306, 418]);
    expect(rows(out).every((status) => status.state === 'unused')).toBe(true);
  });

  it('explains a miss with the 418 hint and echoes the keyword on one line', async () => {
    boot();
    const out = await call({ keyword: ' tea\n\npot ' });
    expect(out.structured).toMatchObject({
      mode: 'keyword',
      found: false,
      statuses: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice:
        'No registered status phrase matched "tea pot". Codes such as 418 are listed only as (Unused); pass code to see them.',
    });
  });

  it('cuts at limit, discloses it, and counts the full match set', async () => {
    boot();
    const out = await call({ keyword: 'gateway', limit: 1 });
    expect(codes(out)).toEqual([502]);
    expect(out.structured).toMatchObject({
      totalCount: 2,
      shown: 1,
      cap: 1,
      truncated: true,
      notice:
        'Showing 1 of 2 matching status codes; raise limit (max 100) or add words to keyword to narrow.',
    });
    expect(out.text).toContain('Showing 1 of 2 matching status codes');
  });

  it('does not truncate when the page holds every match', async () => {
    boot();
    const exact = await call({ keyword: 'gateway', limit: 2 });
    expect(exact.structured).toMatchObject({ totalCount: 2, shown: 2, truncated: false });
    expect(exact.structured).not.toHaveProperty('notice');
  });

  it('reads a blank code as unset, so keyword mode runs', async () => {
    boot();
    const out = await call({ code: '', keyword: 'continue', limit: '' });
    expect(out.structured).toMatchObject({ mode: 'keyword', cap: 25 });
    expect(codes(out)).toEqual([100]);
  });
});

describe('iana_lookup_http_status: input validation', () => {
  it.each([
    ['code below 100', { code: 99 }],
    ['code above 599', { code: 600 }],
    ['a non-integer code', { code: 1.5 }],
    ['a non-numeric code string', { code: 'abc' }],
    ['a mixed code string', { code: '12a' }],
    ['a negative code', { code: -1 }],
    ['an exponent code string', { code: '1e3' }],
    ['a one-character keyword', { keyword: 'a' }],
    ['a keyword over 100 characters', { keyword: 'a'.repeat(101) }],
    ['limit 0', { code: 200, limit: 0 }],
    ['limit above 100', { code: 200, limit: 101 }],
    ['a fractional limit', { code: 200, limit: 1.5 }],
    ['a non-numeric limit', { code: 200, limit: 'many' }],
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

  it('accepts the bounds: code 100 and 599, limit 1 and 100', async () => {
    boot();
    expect((await call({ code: 100, limit: 1 })).isError).toBe(false);
    expect((await call({ code: 599, limit: 100 })).structured).toMatchObject({ cap: 100 });
    expect((await call({ code: '599', limit: '100' })).isError).toBe(false);
  });

  it('applies a digit-string limit', async () => {
    boot();
    expect((await call({ keyword: 'gateway', limit: '1' })).structured).toMatchObject({
      cap: 1,
      shown: 1,
    });
  });
});

describe('iana_lookup_http_status: mode_required', () => {
  it.each([
    ['neither', {}],
    ['both', { code: 200, keyword: 'ok' }],
    ['two blank strings', { code: '', keyword: '   ' }],
    ['a blank code alone', { code: '  ' }],
  ])('fails %s as mode_required with the recovery, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Pass exactly one of code or keyword.',
      data: {
        reason: 'mode_required',
        recovery: { hint: 'Pass exactly one of code or keyword to iana_lookup_http_status.' },
      },
    });
    expect(out.text).toContain(
      'Recovery: Pass exactly one of code or keyword to iana_lookup_http_status.',
    );
    expect(s.fetches()).toBe(0);
  });
});

describe('iana_lookup_http_status: list-enrichment contract', () => {
  it('zero-result page: counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ keyword: 'zzzz' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      found: false,
      statuses: [],
      totalCount: 0,
      shown: 0,
      cap: 25,
      truncated: false,
    });
    expect(typeof out.structured.notice).toBe('string');
    expect(out.text).toContain('0 total');
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('under-cap page: shown equals the match count and nothing is truncated', async () => {
    boot();
    const out = await call({ keyword: 'gateway', limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      totalCount: 2,
      shown: 2,
      cap: 10,
      truncated: false,
    });
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('exact-code hit: counters read 1 of 1', async () => {
    boot();
    expect((await call({ code: 404 })).structured).toMatchObject({
      totalCount: 1,
      shown: 1,
      cap: 25,
      truncated: false,
    });
  });
});

describe('iana_lookup_http_status: registry layout changes surface as unreadable', () => {
  const unreadableHint =
    'The IANA HTTP status registry could not be read; retry iana_lookup_http_status shortly.';

  it('a registry without the http-status-codes-1 sub-registry is unreadable, not empty', async () => {
    const s = boot(singleTableXml('http-status-codes', 'renamed-table', row('200', 'OK')));
    const out = await call({ code: 200 });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unreadable',
        subregistry: TABLE,
        recovery: { hint: unreadableHint },
      },
    });
    expect(s.fetches()).toBe(1);
  });

  it.each([
    ['a non-numeric key', 'abc'],
    ['a key above the status classes', '700'],
  ])('%s on a matching row is unreadable in keyword mode', async (_label, key) => {
    boot(statusXml(`${row('200', 'OK')}${row(key, 'Weird Row')}`));
    const out = await call({ keyword: 'weird' });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable' },
    });
    expect(out.text).toContain(`Recovery: ${unreadableHint}`);
  });
});

describe('iana_lookup_http_status: format()', () => {
  it('carries every structuredContent field of a multi-result page', async () => {
    boot();
    const out = await call({ keyword: 'gateway' });
    for (const status of rows(out)) {
      expect(out.text).toContain(`### ${status.code} ${status.phrase}`);
      expect(out.text).toContain(`**Class:** ${status.class} · **State:** ${status.state}`);
      for (const ref of status.references) {
        expect(out.text).toContain(
          `- ${ref.id} (${ref.type})${ref.section ? ` §${ref.section}` : ''}`,
        );
        if (ref.url) expect(out.text).toContain(`<${ref.url}>`);
      }
    }
    expect(out.text).toContain('**Mode:** keyword · **Found:** true');
    expect(out.text).toContain('**Source:** `http-status-codes` · registry updated 2025-09-15');
    expect(out.text).toContain(STATUS_URL);
  });

  it('prints the registered and updated dates', async () => {
    boot();
    expect((await call({ code: 100 })).text).toContain(
      '**Registered:** 2020-01-02 · **Updated:** 2022-06-06',
    );
  });

  it('prints the miss: found false, no status sections, the range', async () => {
    boot();
    const out = await call({ code: 440 });
    expect(out.text).toContain('**Mode:** code · **Found:** false');
    expect(out.text).not.toContain('###');
  });

  it('keeps hostile upstream phrases verbatim in structuredContent and inert in format()', async () => {
    const hostile = `${xmlEscape('Bad <b>Gateway</b> [x](https://evil.example/) ![i](https://evil.example/i.png)\u202E\u0007')}<br/># Injected heading<br/>- item`;
    boot(statusXml(row('502', hostile)));
    const out = await call({ code: 502 });

    const [status] = rows(out);
    expect(status?.phrase).toContain('<b>Gateway</b> [x](https://evil.example/)');
    expect(status?.phrase).toContain('\u202E');
    expect(status?.phrase).toContain('\n# Injected heading\n- item');

    const lines = out.text.split('\n');
    const headings = lines.filter((line) => line.startsWith('###'));
    expect(headings).toHaveLength(1);
    expect(lines.some((line) => /^(# Injected|- item)/.test(line))).toBe(false);
    expect(out.text).toContain(
      String.raw`\<b\>Gateway\</b\> \[x\](https://evil.example/) !\[i\](https://evil.example/i.png)`,
    );
    expect(out.text).not.toMatch(/[\u202E\u0007]/);
  });

  it('replaces an email-shaped token in a phrase with the placeholder in both surfaces', async () => {
    boot(statusXml(row('502', 'Bad Gateway, report to ops@example.org')));
    const out = await call({ code: 502 });
    expect(rows(out)[0]?.phrase).toBe('Bad Gateway, report to [email removed]');
    expect(out.text).not.toContain('ops@example.org');
  });
});

describeFailureContract({
  definition: lookupHttpStatus,
  input: { code: 418 },
  url: STATUS_URL,
  ok: () => xmlResponse(STATUS_XML),
  reason: 'upstream_unreadable',
  recovery:
    'The IANA HTTP status registry could not be read; retry iana_lookup_http_status shortly.',
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
