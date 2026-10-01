/**
 * @fileoverview Tests for `iana_lookup_pen`: number input and OID input
 * (numeric, leading dot, the `iso.org.dod.internet.private.enterprise(s).`
 * prefix, sub-arcs echoed as `requested_oid` and `sub_arcs`), reserved and
 * unassigned states, the not-yet-assigned and no-entry notices, organization
 * search with ranking, withheld entries (never searchable, never shown), input
 * validation (blank strings read as unset), the declared error rows, the
 * list-enrichment contract, and `format()` parity and sanitizing. Upstream I/O
 * is a `createFetchMock` fake behind the injected `UpstreamClient`; every
 * person and address in a fixture is invented.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupPen } from '@/mcp-server/tools/definitions/lookup-pen.tool.js';
import { PEN_URL } from '@/services/registry/registry-store.js';
import { PEN_TEXT, penRecord, penText } from '../fixtures/pen.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { missingFromText } from '../shared/format-parity.js';
import { callTool, setupTools } from '../shared/tool-harness.js';
import { htmlResponse, textResponse } from '../shared/upstream-harness.js';

interface Entry {
  number: number;
  oid: string;
  organization?: string;
  organization_withheld?: boolean;
  state: string;
}

type Out = { structured: Record<string, unknown>; text: string };

/** Invented contact data of the default fixture; none of it may reach a result. */
const PEN_PERSON_MARKERS = [
  'Example Person',
  'Example Contact',
  'person@example.org',
  'person&example.org',
  'contact&example.org',
  'iana&example.org',
  'Example Corp',
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function boot(text = PEN_TEXT) {
  const s = setupTools();
  s.serve({ [PEN_URL]: () => textResponse(text) });
  return s;
}

const call = (input: Record<string, unknown>) => callTool(lookupPen, input);
const entries = (out: Out) => out.structured.enterprises as Entry[];
const numbers = (out: Out) => entries(out).map((entry) => entry.number);

/** Acme-style fixture where the exact organization match is not first in number order. */
const RANKING_TEXT = penText([
  penRecord(5, 'Acme Corp'),
  penRecord(10, 'Acme Holdings'),
  penRecord(20, 'Acme'),
  penRecord(30, 'Réseau Démo'),
  penRecord(40, 'Acme Holdings Acme'),
]);

describe('iana_lookup_pen: number input', () => {
  it('returns the organization, OID prefix and state, with source and counters', async () => {
    boot();
    const out = await call({ pen: '32473' });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      mode: 'pen',
      found: true,
      enterprises: [
        {
          number: 32473,
          organization: 'Documentation Example Org',
          oid: '1.3.6.1.4.1.32473',
          state: 'assigned',
        },
      ],
      source: expect.objectContaining({
        registry_id: 'enterprise-numbers',
        url: PEN_URL,
        registry_updated: '2026-09-24',
        stale: false,
      }),
      totalCount: 1,
      shown: 1,
      cap: 25,
      truncated: false,
    });
  });

  it.each(['32473', ' 32473 ', '0032473', 32473])(
    'accepts the number %j (a bare integer arrives as its digits)',
    async (pen) => {
      boot();
      const out = await call({ pen });
      expect(numbers(out)).toEqual([32473]);
      expect(out.structured).not.toHaveProperty('requested_oid');
      expect(out.structured).not.toHaveProperty('sub_arcs');
    },
  );

  it('keeps a non-ASCII organization verbatim', async () => {
    boot();
    expect(entries(await call({ pen: '7' }))[0]?.organization).toBe('Réseau Démo');
  });

  it('keeps an ampersand that is not an address', async () => {
    boot();
    expect(entries(await call({ pen: '4' }))[0]?.organization).toBe('Example & Sons Ltd');
  });

  it('answers reserved numbers with their row, found false, and a notice', async () => {
    boot();
    const out = await call({ pen: '0' });
    expect(entries(out)).toEqual([
      { number: 0, organization: 'Reserved', oid: '1.3.6.1.4.1.0', state: 'reserved' },
    ]);
    expect(out.structured).toMatchObject({
      found: false,
      totalCount: 1,
      shown: 1,
      truncated: false,
      notice: 'PEN 0 is reserved; no organization holds it.',
    });
  });

  it.each([
    [2, 'Unassigned'],
    [3, '---none---'],
  ])(
    'answers unassigned number %i with its row, found false, and a notice',
    async (number, marker) => {
      boot();
      const out = await call({ pen: String(number) });
      expect(entries(out)).toEqual([
        { number, organization: marker, oid: `1.3.6.1.4.1.${number}`, state: 'unassigned' },
      ]);
      expect(out.structured).toMatchObject({
        found: false,
        notice: `PEN ${number} is unassigned; no organization holds it.`,
      });
    },
  );

  it('says a number above the highest assigned is not assigned yet', async () => {
    boot();
    for (const pen of ['32474', '999999999']) {
      const out = await call({ pen });
      expect(out.structured).toMatchObject({
        mode: 'pen',
        found: false,
        enterprises: [],
        totalCount: 0,
        shown: 0,
        truncated: false,
        notice: `PEN ${Number(pen)} is not assigned yet; the registry currently ends at 32473.`,
      });
    }
  });

  it('says a number inside the registry range with no entry has none', async () => {
    boot();
    const out = await call({ pen: '100' });
    expect(out.structured).toMatchObject({
      found: false,
      enterprises: [],
      totalCount: 0,
      notice: 'PEN 100 has no entry in the registry.',
    });
  });

  it('treats the highest number itself as present, not as not-yet-assigned', async () => {
    boot();
    expect((await call({ pen: '32473' })).structured).toMatchObject({ found: true });
    expect((await call({ pen: '32473' })).structured).not.toHaveProperty('notice');
  });

  it('ignores limit (one number is one entry) while echoing it as the cap', async () => {
    boot();
    const out = await call({ pen: '32473', limit: 1 });
    expect(out.structured).toMatchObject({ totalCount: 1, shown: 1, cap: 1, truncated: false });
  });

  it('returns a withheld organization as found, without the organization and without any contact data', async () => {
    boot();
    for (const number of [5, 6]) {
      const out = await call({ pen: String(number) });
      expect(out.structured).toMatchObject({ found: true });
      expect(entries(out)).toEqual([
        {
          number,
          organization_withheld: true,
          oid: `1.3.6.1.4.1.${number}`,
          state: 'assigned',
        },
      ]);
      for (const marker of PEN_PERSON_MARKERS) {
        expect(JSON.stringify(out.structured)).not.toContain(marker);
        expect(out.text).not.toContain(marker);
      }
    }
  });
});

describe('iana_lookup_pen: OID input', () => {
  it('accepts the bare numeric OID of the enterprise without echoing arcs', async () => {
    boot();
    const out = await call({ pen: '1.3.6.1.4.1.32473' });
    expect(numbers(out)).toEqual([32473]);
    expect(out.structured).not.toHaveProperty('requested_oid');
    expect(out.structured).not.toHaveProperty('sub_arcs');
  });

  it('echoes the requested OID and the arcs below the enterprise number', async () => {
    boot();
    const out = await call({ pen: '1.3.6.1.4.1.32473.1.2' });
    expect(numbers(out)).toEqual([32473]);
    expect(out.structured).toMatchObject({
      mode: 'pen',
      found: true,
      requested_oid: '1.3.6.1.4.1.32473.1.2',
      sub_arcs: '1.2',
    });
    expect(entries(out)[0]?.oid).toBe('1.3.6.1.4.1.32473');
  });

  it('keeps a zero arc and a single arc', async () => {
    boot();
    expect((await call({ pen: '1.3.6.1.4.1.32473.0' })).structured).toMatchObject({
      sub_arcs: '0',
    });
    expect((await call({ pen: '1.3.6.1.4.1.32473.99' })).structured).toMatchObject({
      sub_arcs: '99',
    });
  });

  it('strips a leading dot, echoing the numeric OID without it', async () => {
    boot();
    expect((await call({ pen: '.1.3.6.1.4.1.32473.1.2' })).structured).toMatchObject({
      requested_oid: '1.3.6.1.4.1.32473.1.2',
      sub_arcs: '1.2',
    });
  });

  it.each([
    'iso.org.dod.internet.private.enterprise.32473.1.2',
    'iso.org.dod.internet.private.enterprises.32473.1.2',
    'ISO.ORG.DOD.INTERNET.PRIVATE.ENTERPRISES.32473.1.2',
    '.iso.org.dod.internet.private.enterprise.32473.1.2',
    '  iso.org.dod.internet.private.enterprise.32473.1.2  ',
  ])('canonicalizes the symbolic prefix: %j', async (pen) => {
    boot();
    const out = await call({ pen });
    expect(numbers(out)).toEqual([32473]);
    expect(out.structured).toMatchObject({
      requested_oid: '1.3.6.1.4.1.32473.1.2',
      sub_arcs: '1.2',
    });
  });

  it('accepts the symbolic prefix with a bare enterprise number', async () => {
    boot();
    const out = await call({ pen: 'iso.org.dod.internet.private.enterprise.32473' });
    expect(numbers(out)).toEqual([32473]);
    expect(out.structured).not.toHaveProperty('requested_oid');
  });

  it('echoes the arcs even when the enterprise number is not assigned yet', async () => {
    boot();
    const out = await call({ pen: '1.3.6.1.4.1.99999.1' });
    expect(out.structured).toMatchObject({
      found: false,
      enterprises: [],
      requested_oid: '1.3.6.1.4.1.99999.1',
      sub_arcs: '1',
      notice: 'PEN 99999 is not assigned yet; the registry currently ends at 32473.',
    });
  });

  it('echoes the arcs for a reserved number, found false', async () => {
    boot();
    const out = await call({ pen: '1.3.6.1.4.1.0.5' });
    expect(out.structured).toMatchObject({
      found: false,
      requested_oid: '1.3.6.1.4.1.0.5',
      sub_arcs: '5',
      notice: 'PEN 0 is reserved; no organization holds it.',
    });
  });

  it('accepts 64 arcs below the enterprise number and a 10-digit arc', async () => {
    boot();
    const arcs = Array.from({ length: 64 }, (_, index) => index);
    const long = await call({ pen: `1.3.6.1.4.1.32473.${arcs.join('.')}` });
    expect(long.structured).toMatchObject({ found: true, sub_arcs: arcs.join('.') });
    expect((await call({ pen: '1.3.6.1.4.1.32473.4294967295' })).structured).toMatchObject({
      sub_arcs: '4294967295',
    });
  });
});

describe('iana_lookup_pen: organization search', () => {
  it('matches whole tokens of the organization line, in number order', async () => {
    boot();
    const out = await call({ organization: 'example' });
    expect(numbers(out)).toEqual([1, 4, 32473]);
    expect(out.structured).toMatchObject({ mode: 'organization', found: true, totalCount: 3 });
    expect(out.structured).not.toHaveProperty('requested_oid');
    expect(out.structured).not.toHaveProperty('sub_arcs');
  });

  it('requires every token, in any order, and no partial tokens', async () => {
    boot();
    expect(numbers(await call({ organization: 'networks example' }))).toEqual([1]);
    expect(numbers(await call({ organization: 'example org' }))).toEqual([32473]);
    expect(numbers(await call({ organization: 'netw' }))).toEqual([]);
  });

  it('folds case and diacritics', async () => {
    boot();
    for (const organization of ['reseau', 'RÉSEAU', 'Réseau Démo', 'reseau demo']) {
      expect(numbers(await call({ organization }))).toEqual([7]);
    }
  });

  it('ranks an exact organization match first, then number order', async () => {
    boot(RANKING_TEXT);
    expect(numbers(await call({ organization: 'acme' }))).toEqual([20, 5, 10, 40]);
    expect(numbers(await call({ organization: '  ACME ' }))).toEqual([20, 5, 10, 40]);
    expect(numbers(await call({ organization: 'acme holdings' }))).toEqual([10, 40]);
  });

  it('ranks an exact match with diacritics and punctuation folded', async () => {
    boot(penText([penRecord(1, 'Reseau-Demo Extra'), penRecord(2, 'Réseau, Démo!')]));
    expect(numbers(await call({ organization: 'reseau demo' }))).toEqual([2, 1]);
  });

  it('finds a camelCase organization by its words and by the joined word', async () => {
    boot(
      penText([
        penRecord(9, 'ciscoSystems'),
        penRecord(20, 'Cisco Example Networks'),
        penRecord(30, 'Example Systems Ltd'),
      ]),
    );
    expect(numbers(await call({ organization: 'cisco' }))).toEqual([9, 20]);
    for (const organization of ['cisco systems', 'ciscosystems', 'ciscoSystems']) {
      expect(numbers(await call({ organization }))).toEqual([9]);
    }
    expect(entries(await call({ organization: 'cisco systems' }))[0]?.organization).toBe(
      'ciscoSystems',
    );
  });

  it('ranks a camelCase organization exact on its joined word', async () => {
    boot(penText([penRecord(5, 'ciscoSystems Example Lab'), penRecord(9, 'ciscoSystems')]));
    expect(numbers(await call({ organization: 'ciscosystems' }))).toEqual([9, 5]);
    expect(numbers(await call({ organization: 'CiscoSystems' }))).toEqual([9, 5]);
  });

  it('never matches or shows a withheld entry, whichever words of its line are searched', async () => {
    boot();
    for (const organization of [
      'person',
      'corp',
      'example corp',
      'example person',
      'example.org',
    ]) {
      const out = await call({ organization });
      expect(numbers(out)).not.toContain(5);
      expect(numbers(out)).not.toContain(6);
      for (const marker of PEN_PERSON_MARKERS) {
        expect(JSON.stringify(out.structured)).not.toContain(marker);
        expect(out.text).not.toContain(marker);
      }
    }
    expect(numbers(await call({ organization: 'example', limit: 100 }))).toEqual([1, 4, 32473]);
  });

  it('never matches the contact or email lines', async () => {
    boot();
    for (const organization of ['contact', 'example contact', 'iana', 'authority']) {
      expect(numbers(await call({ organization }))).toEqual([]);
    }
  });

  it('cuts at limit, counts the full match set, and names the next offset', async () => {
    boot();
    const out = await call({ organization: 'example', limit: 2 });
    expect(numbers(out)).toEqual([1, 4]);
    expect(out.structured).toMatchObject({
      totalCount: 3,
      shown: 2,
      cap: 2,
      truncated: true,
      next_offset: 2,
      notice:
        'Showing 2 of 3 matching organizations; pass offset 2 for the next page, raise limit (max 100), or add words to organization to narrow.',
    });
  });

  it('reaches every match past the maximum limit through offset', async () => {
    boot(
      penText(
        Array.from({ length: 130 }, (_, index) =>
          penRecord(index + 1, `Example University ${index + 1}`),
        ),
      ),
    );
    const first = await call({ organization: 'university', limit: 100 });
    expect(first.structured).toMatchObject({
      totalCount: 130,
      shown: 100,
      truncated: true,
      next_offset: 100,
      notice:
        'Showing 100 of 130 matching organizations; pass offset 100 for the next page, or add words to organization to narrow.',
    });
    const last = await call({ organization: 'university', limit: 100, offset: 100 });
    expect(numbers(last)).toEqual(Array.from({ length: 30 }, (_, index) => index + 101));
    expect(last.structured).toMatchObject({ totalCount: 130, shown: 30, truncated: false });
    expect(last.structured).not.toHaveProperty('next_offset');
    expect(last.structured).not.toHaveProperty('notice');
  });

  it('returns an empty page for an offset past the end, with the total', async () => {
    boot();
    const out = await call({ organization: 'example', offset: 3 });
    expect(out.structured).toMatchObject({
      mode: 'organization',
      enterprises: [],
      totalCount: 3,
      shown: 0,
      notice:
        'Offset 3 is past the 3 matching organizations; pass an offset below 3, or omit offset to start over.',
    });
  });

  it('ignores offset in pen mode and says so', async () => {
    boot();
    const out = await call({ pen: '1', offset: 5 });
    expect(numbers(out)).toEqual([1]);
    expect(String(out.structured.notice)).toContain(
      'offset applies to organization mode only; it was ignored for this exact lookup.',
    );
  });

  it('puts the exact match on the first page when a limit cuts the list', async () => {
    boot(RANKING_TEXT);
    expect(numbers(await call({ organization: 'acme', limit: 1 }))).toEqual([20]);
  });

  it('explains a miss, echoing the words on one line', async () => {
    boot();
    const out = await call({ organization: 'zzzz\n   yyyy' });
    expect(out.structured).toMatchObject({
      mode: 'organization',
      found: false,
      enterprises: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice:
        'No organization matched "zzzz yyyy". Try a shorter or alternative name (registrants use legal names, abbreviations, and former names).',
    });
  });

  it.each(['reserved', 'unassigned'])(
    'does not match placeholder rows: an organization query of %j is a miss',
    async (organization) => {
      boot();
      const out = await call({ organization });
      expect(out.structured).toMatchObject({
        mode: 'organization',
        found: false,
        enterprises: [],
        totalCount: 0,
        notice: `No organization matched "${organization}". Try a shorter or alternative name (registrants use legal names, abbreviations, and former names).`,
      });
    },
  );

  it('rejects a symbol-only organization as invalid arguments, before any fetch', async () => {
    const s = boot();
    const out = await call({ organization: '!!' });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(out.text).toContain('Must contain at least one letter or digit');
    expect(s.fetches()).toBe(0);
  });

  it('reads blank optional inputs as unset: organization mode, default limit', async () => {
    boot();
    const out = await call({ pen: '', organization: 'example', limit: ' ' });
    expect(out.structured).toMatchObject({ mode: 'organization', cap: 25, totalCount: 3 });
  });

  it('applies a digit-string limit', async () => {
    boot();
    expect((await call({ organization: 'example', limit: '1' })).structured).toMatchObject({
      cap: 1,
      shown: 1,
      truncated: true,
    });
  });
});

describe('iana_lookup_pen: input validation', () => {
  it.each([
    ['a non-numeric pen', { pen: 'abc' }],
    ['a pen with trailing text', { pen: '12abc' }],
    ['a negative pen', { pen: '-1' }],
    ['a fractional pen', { pen: '1.5' }],
    ['a pen over 9 digits', { pen: '1234567890' }],
    ['an OID outside the enterprise arc', { pen: '1.3.6.1.4.2.1' }],
    ['the enterprise arc without a number', { pen: '1.3.6.1.4.1' }],
    ['the enterprise arc with a trailing dot', { pen: '1.3.6.1.4.1.' }],
    ['an OID with a trailing dot', { pen: '1.3.6.1.4.1.32473.' }],
    ['an OID with an empty arc', { pen: '1.3.6.1.4.1.32473..2' }],
    ['an OID whose enterprise number has 10 digits', { pen: '1.3.6.1.4.1.1234567890' }],
    ['an OID with an 11-digit arc', { pen: '1.3.6.1.4.1.32473.12345678901' }],
    [
      'an OID with 65 arcs below the enterprise number',
      { pen: `1.3.6.1.4.1.32473.${Array.from({ length: 65 }, () => 1).join('.')}` },
    ],
    ['the symbolic prefix without a number', { pen: 'iso.org.dod.internet.private.enterprise.' }],
    ['a partial symbolic prefix', { pen: 'iso.org.dod.internet.private.32473' }],
    ['a one-character organization', { organization: 'a' }],
    ['an organization over 100 characters', { organization: 'a'.repeat(101) }],
    ['limit 0', { organization: 'example', limit: 0 }],
    ['limit above 100', { organization: 'example', limit: 101 }],
    ['a non-numeric limit', { organization: 'example', limit: 'many' }],
    ['a negative offset', { organization: 'example', offset: -1 }],
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

  it('accepts 9-digit numbers and 100-character organizations', async () => {
    boot();
    expect((await call({ pen: '999999999' })).isError).toBe(false);
    expect((await call({ organization: 'a '.repeat(50).trim() })).isError).toBe(false);
  });
});

describe('iana_lookup_pen: mode_required', () => {
  it.each([
    ['neither', {}],
    ['both', { pen: '32473', organization: 'example' }],
    ['blank strings only', { pen: '', organization: ' ' }],
    ['limit alone', { limit: 5 }],
  ])('fails %s as mode_required with the recovery, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Pass exactly one of pen or organization.',
      data: {
        reason: 'mode_required',
        recovery: { hint: 'Pass exactly one of pen or organization to iana_lookup_pen.' },
      },
    });
    expect(out.text).toContain(
      'Recovery: Pass exactly one of pen or organization to iana_lookup_pen.',
    );
    expect(s.fetches()).toBe(0);
  });

  it('counts PEN 0 as a given pen, not as unset', async () => {
    boot();
    expect((await call({ pen: 0, organization: 'example' })).structured.error).toMatchObject({
      data: { reason: 'mode_required' },
    });
  });
});

describe('iana_lookup_pen: list-enrichment contract', () => {
  it('zero-result page (organization miss): counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ organization: 'zzzz' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      found: false,
      enterprises: [],
      totalCount: 0,
      shown: 0,
      cap: 25,
      truncated: false,
    });
    expect(out.text).toContain('0 total');
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('zero-result page (number not assigned yet): counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ pen: '40000' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 0, shown: 0, truncated: false });
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('under-cap page (organization): shown equals the match count and nothing is truncated', async () => {
    boot();
    const out = await call({ organization: 'example', limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 3, shown: 3, cap: 10, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('under-cap page (number): one match, one shown, no notice', async () => {
    boot();
    const out = await call({ pen: '1' });
    expect(out.structured).toMatchObject({ totalCount: 1, shown: 1, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_lookup_pen: sparse registry', () => {
  it('renders an entry with no organization line without inventing one', async () => {
    boot(penText([{ number: 9, lines: [] }, penRecord(10, 'Example Networks Inc.')]));
    const out = await call({ pen: '9' });
    expect(out.isError).toBe(false);
    const [entry] = entries(out);
    expect(entry).toMatchObject({ number: 9, oid: '1.3.6.1.4.1.9' });
    expect(entry).not.toHaveProperty('organization');
    expect(out.text).toContain('### PEN 9\n');
  });

  it('reads a CRLF registry file', async () => {
    boot(
      penText([penRecord(1, 'Example Networks Inc.'), penRecord(2, 'Example Labs')], {
        eol: '\r\n',
      }),
    );
    expect(numbers(await call({ organization: 'example' }))).toEqual([1, 2]);
  });

  it('reports a registry of reserved and unassigned entries only as never found', async () => {
    boot(penText([penRecord(0, 'Reserved'), penRecord(1, 'Unassigned')]));
    expect((await call({ pen: '0' })).structured.found).toBe(false);
    expect((await call({ pen: '1' })).structured.found).toBe(false);
    expect((await call({ pen: '2' })).structured.notice).toBe(
      'PEN 2 is not assigned yet; the registry currently ends at 1.',
    );
  });
});

describe('iana_lookup_pen: format()', () => {
  it('prints every structuredContent field of one entry', async () => {
    boot();
    const out = await call({ pen: '32473' });
    expect(out.text).toContain('**Mode:** pen · **Found:** true');
    expect(out.text).toContain('### PEN 32473 · Documentation Example Org');
    expect(out.text).toContain('**OID:** 1.3.6.1.4.1.32473 · **State:** assigned');
    expect(out.text).toContain('**Source:** `enterprise-numbers` · registry updated 2026-09-24');
    expect(out.text).not.toContain('Requested OID');
  });

  it('prints the requested OID and the sub-arcs with the ownership note', async () => {
    boot();
    const out = await call({ pen: '1.3.6.1.4.1.32473.1.2' });
    expect(out.text).toContain('**Requested OID:** 1.3.6.1.4.1.32473.1.2');
    expect(out.text).toContain(
      '**Arcs below the enterprise number:** 1.2 (assigned by the enterprise, not IANA)',
    );
  });

  it('prints the withheld notice instead of an organization, and never the withheld line', async () => {
    boot();
    const out = await call({ pen: '5' });
    expect(out.text).toContain('### PEN 5\n');
    expect(out.text).toContain(
      '**Organization withheld:** the registry entry mixes contact details into this line',
    );
    for (const marker of PEN_PERSON_MARKERS) expect(out.text).not.toContain(marker);
  });

  it('prints reserved and unassigned entries with their state and the notice', async () => {
    boot();
    const reserved = await call({ pen: '0' });
    expect(reserved.text).toContain('### PEN 0 · Reserved');
    expect(reserved.text).toContain('**State:** reserved');
    expect(reserved.text).toContain('**Mode:** pen · **Found:** false');
    expect(reserved.text).toContain(String(reserved.structured.notice));
    expect((await call({ pen: '3' })).text).toContain('**State:** unassigned');
  });

  it.each([
    ['an assigned number', { pen: '32473' }],
    ['an OID with sub-arcs', { pen: '1.3.6.1.4.1.32473.1.2' }],
    ['a withheld entry', { pen: '5' }],
    ['a reserved number', { pen: '0' }],
    ['an organization page', { organization: 'example' }],
  ])('carries every string and number of structuredContent: %s', async (_label, input) => {
    boot();
    const out = await call(input);
    expect(out.isError).toBe(false);
    expect(missingFromText(out.structured, out.text)).toEqual([]);
  });

  it('carries every entry of a multi-result page', async () => {
    boot();
    const out = await call({ organization: 'example' });
    for (const entry of entries(out)) {
      expect(out.text).toContain(`### PEN ${entry.number} · `);
      expect(out.text).toContain(`**OID:** ${entry.oid}`);
    }
  });

  it('prints the notice and counters the framework appends', async () => {
    boot();
    const out = await call({ pen: '40000' });
    expect(out.text).toContain(String(out.structured.notice));
    expect(out.text).toContain('0 total');
  });

  it('keeps hostile organization text verbatim in structuredContent and inert in format()', async () => {
    const organization = 'Evil [x](https://evil.example/) <b>x</b> \\ # Pwned\u{202E}\u0007';
    boot(penText([penRecord(1, organization)]));
    const out = await call({ pen: '1' });
    expect(entries(out)[0]?.organization).toBe(organization);

    const lines = out.text.split('\n');
    expect(lines.filter((line) => line.startsWith('###'))).toEqual([
      String.raw`### PEN 1 · Evil \[x\](https://evil.example/) \<b\>x\</b\> \\ # Pwned`,
    ]);
    expect(lines.some((line) => /^#(?!##)/.test(line))).toBe(false);
    expect(out.text).not.toMatch(/[\u{202E}\u0007]/u);
  });
});

describeFailureContract({
  definition: lookupPen,
  input: { pen: '32473' },
  url: PEN_URL,
  ok: () => textResponse(PEN_TEXT),
  reason: 'upstream_unreadable',
  recovery: 'The IANA enterprise number file could not be read; retry iana_lookup_pen in a minute.',
  unreadable: [
    { label: 'an HTML page served as 200', attempts: 3, response: () => htmlResponse('<html/>') },
    {
      label: 'a text body with no record header',
      attempts: 3,
      response: () => textResponse('Page not found\n'),
    },
    {
      label: 'a file with a header and no records',
      attempts: 3,
      response: () => textResponse(penText([])),
    },
  ],
});
