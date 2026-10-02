/**
 * @fileoverview Tests for `iana_lookup_port`: port, service and keyword modes,
 * the transport filter (rows without a transport always kept), range rows
 * and the `port_class` boundaries, the Dynamic/Private, filtered-out, no-service
 * and no-row notices, ordering, `limit` cuts, input validation (blank strings
 * read as unset), the declared error rows, the list-enrichment contract, and
 * `format()` parity and sanitizing. Upstream I/O is a `createFetchMock` fake
 * behind the injected `UpstreamClient`.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupPort } from '@/mcp-server/tools/definitions/lookup-port.tool.js';
import { registryXmlUrl } from '@/services/registry/registry-store.js';
import {
  HOSTILE_PORT_RECORD,
  PORT_PERSON_MARKERS,
  PORT_RECORDS,
  PORTS_XML,
  portRecord,
  portsXml,
} from '../fixtures/port-registry.js';
import { DOCTYPE_XML, EMPTY_XML, WRONG_ROOT_XML } from '../fixtures/registry-xml.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { missingFromText } from '../shared/format-parity.js';
import { callTool, setupTools } from '../shared/tool-harness.js';
import { htmlResponse, xmlResponse } from '../shared/upstream-harness.js';

const PORTS_URL = registryXmlUrl('service-names-port-numbers');

interface Row {
  description?: string;
  notes?: string;
  port?: number;
  port_range?: string;
  references: { id: string; section?: string; type: string; url?: string }[];
  registered?: string;
  service_name?: string;
  state: string;
  transport?: string;
  unauthorized_use?: string;
  updated?: string;
}

type Out = { structured: Record<string, unknown>; text: string };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function boot(xml = PORTS_XML) {
  const s = setupTools();
  s.serve({ [PORTS_URL]: () => xmlResponse(xml) });
  return s;
}

const call = (input: Record<string, unknown>) => callTool(lookupPort, input);
const rows = (out: Out) => out.structured.assignments as Row[];
/** `name/transport@port` per row, for compact order assertions. */
const brief = (out: Out) =>
  rows(out).map(
    (row) =>
      `${row.service_name ?? '-'}/${row.transport ?? '-'}@${row.port ?? row.port_range ?? '-'}`,
  );

describe('iana_lookup_port: port mode', () => {
  it('returns every transport for the port, with its class, references and counters', async () => {
    boot();
    const out = await call({ port: 22 });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      mode: 'port',
      found: true,
      port_class: { name: 'system', range: '0-1023' },
      assignments: [
        {
          service_name: 'ssh',
          port: 22,
          transport: 'tcp',
          state: 'assigned',
          description: 'The Secure Shell (SSH) Protocol',
          references: [
            { type: 'rfc', id: 'RFC 4251', url: 'https://www.rfc-editor.org/rfc/rfc4251.html' },
          ],
          registered: '2001-01',
          updated: '2021-03-02',
        },
      ],
      source: expect.objectContaining({
        registry_id: 'service-names-port-numbers',
        url: PORTS_URL,
        registry_updated: '2026-09-01',
        stale: false,
      }),
      totalCount: 1,
      shown: 1,
      cap: 25,
      truncated: false,
    });
  });

  it('never carries the assignee or contact person data', async () => {
    boot();
    const out = await call({ port: 22 });
    for (const marker of PORT_PERSON_MARKERS) {
      expect(JSON.stringify(out.structured)).not.toContain(marker);
      expect(out.text).not.toContain(marker);
    }
  });

  it('orders exact rows: named before unnamed, by name, then tcp/udp/sctp/dccp', async () => {
    boot();
    const out = await call({ port: 443 });
    expect(brief(out)).toEqual([
      'example-alt/dccp@443',
      'https/tcp@443',
      'https/udp@443',
      'https/sctp@443',
      '-/tcp@443',
    ]);
    expect(rows(out).at(-1)).toMatchObject({ state: 'unnamed', description: 'De-registered' });
    expect(out.structured).toMatchObject({ found: true, totalCount: 5, shown: 5 });
  });

  it('puts range rows containing the port after the exact rows', async () => {
    boot();
    const out = await call({ port: 6000 });
    expect(brief(out)).toEqual([
      'example-multi/tcp@6000',
      'example-multi/udp@6000',
      '-/-@5990-6010',
    ]);
    expect(rows(out)[2]).toMatchObject({ state: 'unassigned', port_range: '5990-6010' });
    expect(rows(out)[2]).not.toHaveProperty('transport');
    expect(rows(out)[2]).not.toHaveProperty('port');
    expect(out.structured).toMatchObject({ found: true, totalCount: 3 });
  });

  it('reports the registry range rows for an unassigned port, found false, with the no-service notice', async () => {
    boot();
    const out = await call({ port: 1005 });
    expect(brief(out)).toEqual(['-/-@1002-1007', '-/-@1000-1010']);
    expect(rows(out).map((row) => row.state)).toEqual(['unassigned', 'reserved']);
    expect(out.structured).toMatchObject({
      found: false,
      port_class: { name: 'system', range: '0-1023' },
      totalCount: 2,
      truncated: false,
      notice:
        'Port 1005 has no registered service; the registry lists it as unassigned within 1002-1007 and reserved within 1000-1010.',
    });
  });

  it('classifies a reserved row (description exactly "Reserved") and an uppercase UNASSIGNED one', async () => {
    boot();
    const zero = await call({ port: 0 });
    expect(rows(zero).map((row) => row.state)).toEqual(['reserved', 'reserved']);
    expect(zero.structured.notice).toBe(
      'Port 0 has no registered service; the registry lists it as reserved.',
    );
    const single = await call({ port: 1500 });
    expect(rows(single)[0]).toMatchObject({ state: 'unassigned', description: 'UNASSIGNED' });
    expect(single.structured.notice).toBe(
      'Port 1500 has no registered service; the registry lists it as unassigned.',
    );
  });

  it('keeps a row with a service name "assigned" even when its description says Reserved', async () => {
    boot();
    const out = await call({ port: 1600 });
    expect(rows(out)[0]).toMatchObject({
      service_name: 'example-reserved-name',
      state: 'assigned',
    });
    expect(out.structured.found).toBe(true);
  });

  it('reads a row with only an unnamed description as "unnamed" and found false', async () => {
    boot();
    const out = await call({ port: 9 });
    expect(rows(out)).toEqual([
      expect.objectContaining({ port: 9, transport: 'tcp', state: 'unnamed' }),
    ]);
    expect(out.structured).toMatchObject({
      found: false,
      notice: 'Port 9 has no registered service; the registry lists it as unnamed.',
    });
  });

  it('says a port with no row at all has no row in the registry', async () => {
    boot();
    const out = await call({ port: 4 });
    expect(out.structured).toMatchObject({
      found: false,
      assignments: [],
      port_class: { name: 'system' },
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice: 'Port 4 has no row in the IANA port registry.',
    });
  });

  it.each([
    [0, 'system', '0-1023'],
    [1023, 'system', '0-1023'],
    [1024, 'user', '1024-49151'],
    [49151, 'user', '1024-49151'],
    [49152, 'dynamic', '49152-65535'],
    [65535, 'dynamic', '49152-65535'],
  ])('classifies port %i as %s', async (port, name, range) => {
    boot();
    expect((await call({ port })).structured.port_class).toEqual({ name, range });
  });

  it('answers a Dynamic/Private port with the RFC 6335 notice and no rows', async () => {
    boot();
    for (const port of [49152, 50000, 65535]) {
      const out = await call({ port });
      expect(out.structured).toMatchObject({
        found: false,
        assignments: [],
        totalCount: 0,
        notice: `Port ${port} is in the Dynamic/Private range (49152–65535), which IANA does not assign.`,
      });
    }
  });

  it('accepts a digit string, and a blank port falls through to the other mode', async () => {
    boot();
    expect(brief(await call({ port: '22' }))).toEqual(['ssh/tcp@22']);
    expect(brief(await call({ port: ' 22 ' }))).toEqual(['ssh/tcp@22']);
    const out = await call({ port: '', service: 'ssh' });
    expect(out.structured).toMatchObject({ mode: 'service' });
  });

  it('cuts at limit, counts the full row set, and says how to see the rest', async () => {
    boot();
    const out = await call({ port: 443, limit: 2 });
    expect(brief(out)).toEqual(['example-alt/dccp@443', 'https/tcp@443']);
    expect(out.structured).toMatchObject({
      totalCount: 5,
      shown: 2,
      cap: 2,
      truncated: true,
      notice: 'Showing 2 of 5 rows for port 443; raise limit (max 100) to see the rest.',
    });
  });

  it('counts range rows toward the cut, after the exact rows', async () => {
    boot();
    const out = await call({ port: 6000, limit: 2 });
    expect(brief(out)).toEqual(['example-multi/tcp@6000', 'example-multi/udp@6000']);
    expect(out.structured).toMatchObject({ totalCount: 3, shown: 2, truncated: true });
  });

  it('keeps references with their section and a row with no description', async () => {
    boot();
    const udp = rows(await call({ port: 443 })).find((row) => row.transport === 'udp');
    expect(udp?.references).toEqual([
      expect.objectContaining({ id: 'RFC 9114', section: '3.1', type: 'rfc' }),
    ]);
    const bare = rows(await call({ port: 4000 }))[0];
    expect(bare).toMatchObject({ service_name: 'example-bare', state: 'assigned', references: [] });
    expect(bare).not.toHaveProperty('description');
  });

  it('carries the note and the unauthorized-use text', async () => {
    boot();
    const out = await call({ port: 5432 });
    expect(rows(out)).toEqual([
      expect.objectContaining({ transport: 'tcp', notes: 'Only the first note text' }),
      expect.objectContaining({ transport: 'udp', unauthorized_use: 'Used by example malware' }),
    ]);
  });

  it('replaces an email-shaped token in a description', async () => {
    boot();
    const out = await call({ port: 2525 });
    expect(rows(out)[0]?.description).toBe('Mail relay, report abuse to [email removed]');
    expect(out.text).not.toContain('abuse@example.org');
  });
});

describe('iana_lookup_port: transport filter', () => {
  it('keeps only rows for the transport in port mode, with range rows always kept', async () => {
    boot();
    expect(brief(await call({ port: 443, transport: 'udp' }))).toEqual(['https/udp@443']);
    expect(brief(await call({ port: 6000, transport: 'udp' }))).toEqual([
      'example-multi/udp@6000',
      '-/-@5990-6010',
    ]);
    expect(brief(await call({ port: 1005, transport: 'tcp' }))).toEqual([
      '-/-@1002-1007',
      '-/-@1000-1010',
    ]);
  });

  it('normalizes the transport: case and whitespace', async () => {
    boot();
    expect(brief(await call({ port: 443, transport: ' UDP ' }))).toEqual(['https/udp@443']);
    expect(brief(await call({ port: 443, transport: '' }))).toHaveLength(5);
  });

  it('says the transport filter excluded a registered port', async () => {
    boot();
    const out = await call({ port: 7777, transport: 'tcp' });
    expect(out.structured).toMatchObject({
      found: false,
      assignments: [],
      totalCount: 0,
      notice: 'Port 7777 is registered for udp; the transport filter tcp excludes it.',
    });
  });

  it('lists every excluded transport in the notice, in registry order of first appearance', async () => {
    boot();
    const out = await call({ port: 443, transport: 'sctp' });
    expect(brief(out)).toEqual(['https/sctp@443']);
    const excluded = await call({ port: 5432, transport: 'dccp' });
    expect(excluded.structured.notice).toBe(
      'Port 5432 is registered for tcp, udp; the transport filter dccp excludes it.',
    );
  });

  it('keeps a hostile transport on one line in the excluded-transport notice', async () => {
    boot(
      portsXml(
        portRecord({ name: 'example-hostile', protocol: 'tcp<br/>## Proto', number: '7778' }),
      ),
    );
    const out = await call({ port: 7778, transport: 'udp' });
    expect(out.structured).toMatchObject({
      found: false,
      notice: 'Port 7778 is registered for tcp ## Proto; the transport filter udp excludes it.',
    });
    expect(String(out.structured.notice)).not.toContain('\n');
    expect(out.text.split('\n').some((line) => line.startsWith('## Proto'))).toBe(false);
  });

  it('applies the transport filter to a range row that carries a protocol', async () => {
    boot(
      portsXml(
        portRecord({
          name: 'example-range',
          protocol: 'tcp',
          number: '6100-6110',
          description: 'Example range',
        }),
      ),
    );
    const excluded = await call({ port: 6105, transport: 'udp' });
    expect(excluded.structured).toMatchObject({
      found: false,
      assignments: [],
      notice: 'Port 6105 is registered for tcp; the transport filter udp excludes it.',
    });
    const kept = await call({ port: 6105, transport: 'tcp' });
    expect(kept.structured).toMatchObject({ found: true });
    expect(brief(kept)).toEqual(['example-range/tcp@6100-6110']);
  });

  it('still reports an unnamed-only port when the filter removes its exact row', async () => {
    boot();
    const out = await call({ port: 9, transport: 'udp' });
    expect(out.structured).toMatchObject({
      found: false,
      assignments: [],
      notice: 'Port 9 has no registered service; the registry lists it as unnamed.',
    });
  });

  it('keeps port-less rows in service mode, and drops rows of other transports', async () => {
    boot();
    expect(brief(await call({ service: 'example-multi', transport: 'udp' }))).toEqual([
      'example-multi/udp@5999',
      'example-multi/udp@6000',
      'example-multi/-@-',
    ]);
  });

  it('says the transport filter excluded a registered service', async () => {
    boot();
    const out = await call({ service: 'example-udp', transport: 'tcp' });
    expect(out.structured).toMatchObject({
      found: false,
      assignments: [],
      totalCount: 0,
      notice: 'example-udp is registered for udp; the transport filter tcp excludes it.',
    });
  });

  it('applies to keyword mode and names the transport in a miss', async () => {
    boot();
    expect(brief(await call({ keyword: 'time', transport: 'udp' }))).toEqual([
      'ntp/udp@123',
      'example-clock/-@-',
    ]);
    expect((await call({ keyword: 'zzzz', transport: 'tcp' })).structured.notice).toBe(
      'No assignment matched "zzzz" for transport tcp. Try fewer or different words, or pass a port number.',
    );
  });
});

describe('iana_lookup_port: service mode', () => {
  it('matches the service name case-insensitively and sorts by port', async () => {
    boot();
    for (const service of ['postgresql', 'POSTGRESQL', ' PostgreSQL ']) {
      const out = await call({ service });
      expect(brief(out)).toEqual(['postgresql/tcp@5432', 'postgresql/udp@5432']);
      expect(out.structured).toMatchObject({ mode: 'service', found: true, totalCount: 2 });
      expect(out.structured).not.toHaveProperty('port_class');
    }
  });

  it('sorts by port ascending with port-less rows last', async () => {
    boot();
    expect(brief(await call({ service: 'example-multi' }))).toEqual([
      'example-multi/udp@5999',
      'example-multi/udp@6000',
      'example-multi/tcp@6000',
      'example-multi/-@-',
    ]);
  });

  it('returns a service registered without a port, with the DNS-SD style row', async () => {
    boot();
    const out = await call({ service: 'example-dnssd' });
    expect(rows(out)).toEqual([
      expect.objectContaining({
        service_name: 'example-dnssd',
        transport: 'tcp',
        state: 'assigned',
      }),
    ]);
    expect(rows(out)[0]).not.toHaveProperty('port');
    expect(out.structured.found).toBe(true);
  });

  it.each(['whois++', 'sql*net', 'WHOIS++'])('accepts the historic name %s', async (service) => {
    boot();
    expect((await call({ service })).structured).toMatchObject({ found: true, totalCount: 1 });
  });

  it('explains a miss with the keyword fallback', async () => {
    boot();
    const out = await call({ service: 'nosuchsvc' });
    expect(out.structured).toMatchObject({
      mode: 'service',
      found: false,
      assignments: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice:
        'No service is registered under the name "nosuchsvc". Call iana_lookup_port with keyword set to a word from the protocol\'s name to search descriptions.',
    });
  });

  it('cuts at limit, counts the full row set, and says how to see the rest', async () => {
    boot();
    const out = await call({ service: 'example-multi', limit: 2 });
    expect(brief(out)).toEqual(['example-multi/udp@5999', 'example-multi/udp@6000']);
    expect(out.structured).toMatchObject({
      totalCount: 4,
      shown: 2,
      cap: 2,
      truncated: true,
      notice:
        'Showing 2 of 4 rows for service example-multi; raise limit (max 100) to see the rest.',
    });
  });

  it('does not match a name that merely contains the service', async () => {
    boot();
    expect((await call({ service: 'example' })).structured.found).toBe(false);
  });
});

describe('iana_lookup_port: keyword mode', () => {
  it('matches whole tokens of the name and the description, sorted by port with port-less last', async () => {
    boot();
    const out = await call({ keyword: 'time' });
    expect(brief(out)).toEqual([
      'example-time/tcp@37',
      'ntp/udp@123',
      'ntp/tcp@123',
      'example-clock/-@-',
    ]);
    expect(out.structured).toMatchObject({ mode: 'keyword', found: true, totalCount: 4 });
  });

  it('requires every token, in any order, and no partial tokens', async () => {
    boot();
    expect(brief(await call({ keyword: 'time network' }))).toEqual(['ntp/udp@123', 'ntp/tcp@123']);
    expect(brief(await call({ keyword: 'network tim' }))).toEqual([]);
    expect(brief(await call({ keyword: 'secure shell' }))).toEqual(['ssh/tcp@22']);
  });

  it('matches the service name itself, ignoring case and punctuation', async () => {
    boot();
    expect(brief(await call({ keyword: 'POSTGRESQL' }))).toEqual([
      'postgresql/tcp@5432',
      'postgresql/udp@5432',
    ]);
    expect(brief(await call({ keyword: 'whois' }))).toEqual(['whois++/tcp@63']);
  });

  it('matches each part of a camelCase description word', async () => {
    boot();
    expect(brief(await call({ keyword: 'sql database' }))).toEqual([
      'postgresql/tcp@5432',
      'postgresql/udp@5432',
    ]);
  });

  it('does not match text outside the name and description (references, notes)', async () => {
    boot();
    expect(brief(await call({ keyword: 'rfc' }))).toEqual([]);
    expect(brief(await call({ keyword: 'first note text' }))).toEqual([]);
    expect(brief(await call({ keyword: 'malware' }))).toEqual([]);
  });

  it('reports found false when only range or unnamed rows match', async () => {
    boot();
    const out = await call({ keyword: 'unassigned' });
    expect(brief(out).every((row) => row.startsWith('-/'))).toBe(true);
    expect(out.structured).toMatchObject({ found: false });
    expect(out.structured.totalCount).toBeGreaterThan(0);
  });

  it('cuts at limit with the keyword guidance and the next offset', async () => {
    boot();
    const out = await call({ keyword: 'time', limit: 1 });
    expect(brief(out)).toEqual(['example-time/tcp@37']);
    expect(out.structured).toMatchObject({
      totalCount: 4,
      shown: 1,
      cap: 1,
      truncated: true,
      next_offset: 1,
      notice:
        'Showing 1 of 4 matching rows; pass offset 1 for the next page, raise limit (max 100), or add words to keyword to narrow.',
    });
  });

  it('pages by offset in the same order, the last page without next_offset', async () => {
    boot();
    const pages = [
      await call({ keyword: 'time', limit: 2 }),
      await call({ keyword: 'time', limit: 2, offset: 2 }),
    ];
    expect(pages.flatMap(brief)).toEqual(brief(await call({ keyword: 'time' })));
    expect(pages[0]?.structured).toMatchObject({ next_offset: 2, truncated: true });
    expect(pages[1]?.structured).toMatchObject({ totalCount: 4, shown: 2, truncated: false });
    expect(pages[1]?.structured).not.toHaveProperty('next_offset');
    expect(pages[1]?.structured).not.toHaveProperty('notice');
  });

  it('returns an empty page with the total for an offset past the end', async () => {
    boot();
    const out = await call({ keyword: 'time', offset: 4 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      mode: 'keyword',
      found: false,
      assignments: [],
      totalCount: 4,
      shown: 0,
      truncated: false,
      notice:
        'Offset 4 is past the 4 matching rows; pass an offset below 4, or omit offset to start over.',
    });
  });

  it('explains a miss, echoing the keyword on one line', async () => {
    boot();
    const out = await call({ keyword: 'zzzz\n  yyyy' });
    expect(out.structured).toMatchObject({
      found: false,
      assignments: [],
      totalCount: 0,
      notice:
        'No assignment matched "zzzz yyyy". Try fewer or different words, or pass a port number.',
    });
    expect(String(out.structured.notice)).not.toContain('\n');
  });

  it('rejects a symbol-only keyword as invalid arguments, before any fetch', async () => {
    const s = boot();
    const out = await call({ keyword: '!!' });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(out.text).toContain('Must contain at least one letter or digit');
    expect(s.fetches()).toBe(0);
  });
});

describe('iana_lookup_port: input validation', () => {
  it.each([
    ['a port above 65535', { port: 65536 }],
    ['a negative port', { port: -1 }],
    ['a fractional port', { port: 1.5 }],
    ['a non-numeric port', { port: 'https' }],
    ['a service with a space', { service: 'bad name' }],
    ['a service over 15 characters', { service: 'a'.repeat(16) }],
    ['a service with a disallowed character', { service: 'ht!tp' }],
    ['a one-character keyword', { keyword: 'a' }],
    ['a keyword over 100 characters', { keyword: 'a'.repeat(101) }],
    ['an unknown transport', { port: 22, transport: 'icmp' }],
    ['limit 0', { port: 22, limit: 0 }],
    ['limit above 100', { port: 22, limit: 101 }],
    ['a non-numeric limit', { port: 22, limit: 'many' }],
    ['a negative offset', { keyword: 'time', offset: -1 }],
    ['a fractional offset', { keyword: 'time', offset: 0.5 }],
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

  it('accepts the boundary values: port 0, port 65535, a 15-character service, limit 1 and 100', async () => {
    boot();
    expect((await call({ port: 0 })).isError).toBe(false);
    expect((await call({ port: 65535 })).isError).toBe(false);
    expect((await call({ service: 'a'.repeat(15) })).isError).toBe(false);
    expect((await call({ port: 22, limit: 1 })).structured).toMatchObject({ cap: 1 });
    expect((await call({ port: 22, limit: 100 })).structured).toMatchObject({ cap: 100 });
  });

  it('reads blank optional inputs as unset: keyword mode, no transport, default limit', async () => {
    boot();
    const out = await call({ port: '', service: '  ', keyword: 'time', transport: '', limit: ' ' });
    expect(out.structured).toMatchObject({ mode: 'keyword', totalCount: 4, cap: 25 });
  });

  it.each([
    ['port', { port: 443 }],
    ['service', { service: 'ntp' }],
  ])('ignores offset in %s mode and says so', async (_mode, input) => {
    boot();
    const plain = await call(input);
    const out = await call({ ...input, offset: 3 });
    expect(rows(out)).toEqual(rows(plain));
    expect(out.structured).not.toHaveProperty('next_offset');
    expect(String(out.structured.notice)).toContain(
      'offset applies to keyword mode only; it was ignored for this exact lookup.',
    );
  });

  it('applies a digit-string limit', async () => {
    boot();
    expect((await call({ keyword: 'time', limit: '2' })).structured).toMatchObject({
      cap: 2,
      shown: 2,
      truncated: true,
    });
  });
});

describe('iana_lookup_port: mode_required', () => {
  it.each([
    ['none', {}],
    ['port and service', { port: 22, service: 'ssh' }],
    ['port and keyword', { port: 22, keyword: 'secure' }],
    ['service and keyword', { service: 'ssh', keyword: 'secure' }],
    ['all three', { port: 22, service: 'ssh', keyword: 'secure' }],
    ['blank strings only', { port: '', service: ' ', keyword: '' }],
    ['transport alone', { transport: 'tcp' }],
  ])('fails %s as mode_required with the recovery, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Pass exactly one of port, service, or keyword.',
      data: {
        reason: 'mode_required',
        recovery: { hint: 'Pass exactly one of port, service, or keyword to iana_lookup_port.' },
      },
    });
    expect(out.text).toContain(
      'Recovery: Pass exactly one of port, service, or keyword to iana_lookup_port.',
    );
    expect(s.fetches()).toBe(0);
  });

  it('counts port 0 as a given port, not as unset', async () => {
    boot();
    expect((await call({ port: 0, service: 'ssh' })).structured.error).toMatchObject({
      data: { reason: 'mode_required' },
    });
  });
});

describe('iana_lookup_port: list-enrichment contract', () => {
  it('zero-result page: counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ keyword: 'zzzz' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      found: false,
      assignments: [],
      totalCount: 0,
      shown: 0,
      cap: 25,
      truncated: false,
    });
    expect(out.text).toContain('0 total');
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('zero-result page in port mode (a Dynamic/Private port) parses with its notice', async () => {
    boot();
    const out = await call({ port: 60000 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 0, shown: 0, truncated: false });
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('under-cap page: shown equals the match count and nothing is truncated', async () => {
    boot();
    const out = await call({ keyword: 'time', limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 4, shown: 4, cap: 10, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('under-cap page in service and port modes carries no notice', async () => {
    boot();
    for (const input of [{ service: 'ssh' }, { port: 22 }]) {
      const out = await call(input);
      expect(out.structured).toMatchObject({ totalCount: 1, shown: 1, truncated: false });
      expect(out.structured).not.toHaveProperty('notice');
    }
  });
});

describe('iana_lookup_port: registry layout changes surface as unreadable', () => {
  it('a registry whose root is not the port registry is unreadable, not empty', async () => {
    const s = boot(PORTS_XML.replace(/id="service-names-port-numbers"/, 'id="something-else"'));
    const out = await call({ port: 22 });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable' },
    });
    expect(s.fetches()).toBeGreaterThanOrEqual(1);
  });
});

describe('iana_lookup_port: sparse and odd upstream rows', () => {
  it('survives a registry of one range row: port mode lists it, service mode misses', async () => {
    boot(portsXml(portRecord({ number: '10-20', description: 'Unassigned' })));
    const port = await call({ port: 15 });
    expect(brief(port)).toEqual(['-/-@10-20']);
    expect((await call({ service: 'ssh' })).structured).toMatchObject({ found: false });
  });

  it('reads an empty <name/> as absent: the row is unnamed, never an empty service name', async () => {
    boot(
      portsXml(
        '<record><name/><protocol>tcp</protocol><number>9</number><description>Empty name</description></record>',
      ),
    );
    const row = rows(await call({ port: 9 }))[0];
    expect(row).not.toHaveProperty('service_name');
    expect(row?.state).toBe('unnamed');
  });

  it('keeps a port-less row out of port mode, and sorts a range row among numbered rows by its start', async () => {
    boot(
      portsXml(
        [
          portRecord({ name: 'zz', protocol: 'tcp', number: '300', description: 'late word' }),
          portRecord({ number: '200-250', description: 'late word' }),
          portRecord({ name: 'aa', description: 'late word' }),
          portRecord({ name: 'bb', protocol: 'tcp', number: '100', description: 'late word' }),
        ].join(''),
      ),
    );
    expect(brief(await call({ keyword: 'late word' }))).toEqual([
      'bb/tcp@100',
      '-/-@200-250',
      'zz/tcp@300',
      'aa/-@-',
    ]);
  });
});

describe('iana_lookup_port: format()', () => {
  it('prints every structuredContent field of one row', async () => {
    boot();
    const out = await call({ port: 22 });
    expect(out.text).toContain('**Mode:** port · **Found:** true');
    expect(out.text).toContain('**Port class:** system (0-1023)');
    expect(out.text).toContain('### ssh · 22/tcp');
    expect(out.text).toContain('**State:** assigned');
    expect(out.text).toContain('**Description:**\n> The Secure Shell (SSH) Protocol');
    expect(out.text).toContain('**Registered:** 2001-01 · **Updated:** 2021-03-02');
    expect(out.text).toContain('- RFC 4251 (rfc) <https://www.rfc-editor.org/rfc/rfc4251.html>');
    expect(out.text).toContain(
      `**Source:** \`service-names-port-numbers\` · registry updated 2026-09-01`,
    );
  });

  it('prints notes and unauthorized use as blockquotes', async () => {
    boot();
    const out = await call({ port: 5432 });
    expect(out.text).toContain('**Notes:**\n> Only the first note text');
    expect(out.text).toContain('**Unauthorized use:**\n> Used by example malware');
  });

  it('prints a range row, an unnamed row and a port-less row with their placeholders', async () => {
    boot();
    expect((await call({ port: 1005 })).text).toContain('### (no service name) · ports 1002-1007');
    expect((await call({ port: 9 })).text).toContain('### (no service name) · 9/tcp');
    const dnssd = (await call({ service: 'example-dnssd' })).text;
    expect(dnssd).toContain('### example-dnssd · no port/tcp');
    expect(dnssd).not.toContain('**Port class:**');
  });

  it.each([
    ['a port with references, dates and notes', { port: 22 }],
    ['a multi-transport port', { port: 443 }],
    ['a port with a note and unauthorized use', { port: 5432 }],
    ['a range-only port', { port: 1005 }],
    ['a service with a port-less row', { service: 'example-multi' }],
    ['a keyword page', { keyword: 'time' }],
  ])('carries every string and number of structuredContent: %s', async (_label, input) => {
    boot();
    const out = await call(input);
    expect(out.isError).toBe(false);
    expect(missingFromText(out.structured, out.text)).toEqual([]);
  });

  it('carries every row of a multi-row page', async () => {
    boot();
    const out = await call({ port: 443 });
    for (const row of rows(out)) {
      expect(out.text).toContain(
        `### ${row.service_name ?? '(no service name)'} · 443/${row.transport}`,
      );
      expect(out.text).toContain(`> ${row.description}`);
    }
  });

  it('prints the notice and counters the framework appends', async () => {
    boot();
    const out = await call({ port: 1005 });
    expect(out.text).toContain(String(out.structured.notice));
    expect(out.text).toContain('2 total');
  });

  it('keeps hostile upstream text verbatim in structuredContent and inert in format()', async () => {
    boot(portsXml(`${PORT_RECORDS}\n${HOSTILE_PORT_RECORD}`));
    const out = await call({ keyword: 'evil' });
    const evil = rows(out).find((row) => row.service_name?.startsWith('evil'));

    expect(evil?.service_name).toBe('evil[1]\n# Pwned <b>x</b>');
    expect(evil?.transport).toBe('tcp\n## Proto');
    expect(evil?.port_range).toBe('x[1]\n- item');
    expect(evil?.description).toContain(
      '![i](https://evil.example/i.png) <script>alert(1)</script>\n# Heading\n---',
    );
    expect(evil?.notes).toBe('note\n# Note heading');
    expect(evil?.unauthorized_use).toBe('unauth\n- listed [l](m)');

    const lines = out.text.split('\n');
    expect(lines.filter((line) => line.startsWith('###'))).toEqual([
      String.raw`### evil\[1\] # Pwned \<b\>x\</b\> · ports x\[1\] - item/tcp ## Proto`,
    ]);
    expect(lines).toContain('> # Heading');
    expect(lines).toContain('> ---');
    expect(lines).toContain('> # Note heading');
    expect(lines).toContain(String.raw`> - listed \[l\](m)`);
    expect(lines.some((line) => /^(# |## |- item|---$)/.test(line))).toBe(false);
    expect(out.text).not.toMatch(/[\u{202E}\u0007]/u);
  });
});

describeFailureContract({
  definition: lookupPort,
  input: { port: 22 },
  url: PORTS_URL,
  ok: () => xmlResponse(PORTS_XML),
  reason: 'upstream_unreadable',
  recovery: 'The IANA registry file could not be read; retry iana_lookup_port in a minute.',
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
