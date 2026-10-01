/**
 * @fileoverview Tests for the PEN list parser: records, markers, withheld
 * organization lines, contact/email lines never read, and the unreadable cases.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { parsePen } from '@/services/registry/pen-parser.js';
import { PEN_TEXT, type PenFixtureRecord, penRecord, penText } from '../../fixtures/pen.js';
import { asMcpError } from '../../shared/upstream-harness.js';

const URL_ = 'https://www.iana.org/assignments/enterprise-numbers.txt';
const parse = (text: string) => parsePen(text, URL_);

function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a throw.');
}

describe('parsePen', () => {
  const pen = parse(PEN_TEXT);

  it('reads the update date, the highest number and one entry per record in ascending order', () => {
    expect(pen.updated).toBe('2026-09-24');
    expect(pen.maxNumber).toBe(32473);
    expect(pen.entries.map((entry) => entry.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 32473]);
    expect(pen.byNumber.get(32473)?.organization).toBe('Documentation Example Org');
    expect(pen.byNumber.get(99)).toBeUndefined();
  });

  it('classifies the markers: Reserved, Unassigned and ---none---', () => {
    expect(pen.byNumber.get(0)).toMatchObject({ state: 'reserved', organization: 'Reserved' });
    expect(pen.byNumber.get(2)).toMatchObject({ state: 'unassigned', organization: 'Unassigned' });
    expect(pen.byNumber.get(3)).toMatchObject({ state: 'unassigned', organization: '---none---' });
    expect(pen.byNumber.get(1)).toMatchObject({
      state: 'assigned',
      organization: 'Example Networks Inc.',
    });
  });

  it('keeps the organization line verbatim, including an ampersand that is not an address', () => {
    expect(pen.byNumber.get(4)).toMatchObject({
      state: 'assigned',
      organization: 'Example & Sons Ltd',
    });
    expect(pen.byNumber.get(4)).not.toHaveProperty('organizationWithheld');
  });

  it('withholds an organization line run together with a contact address, in either form', () => {
    for (const number of [5, 6]) {
      const entry = pen.byNumber.get(number);
      expect(entry).toEqual({
        number,
        organizationWithheld: true,
        state: 'assigned',
        searchText: '',
      });
      expect(entry).not.toHaveProperty('organization');
    }
    expect(pen.withheldCount).toBe(2);
  });

  it('drops the whole line when withholding, so no fragment of the run-in name is searchable', () => {
    const text = JSON.stringify(pen);
    expect(text).not.toContain('Example Person');
    expect(text).not.toContain('example.org');
    expect(
      pen.entries.filter((entry) => entry.organizationWithheld).every((e) => e.searchText === ''),
    ).toBe(true);
  });

  it('builds padded whole-token search text from the organization', () => {
    expect(pen.byNumber.get(1)?.searchText).toBe(' example networks inc ');
    expect(pen.byNumber.get(7)?.searchText).toBe(' reseau demo ');
    expect(pen.byNumber.get(4)?.searchText).toBe(' example sons ltd ');
  });

  it('never reads the contact or email lines into any entry', () => {
    const text = JSON.stringify(pen.entries);
    expect(text).not.toContain('Example Contact');
    expect(text).not.toContain('Internet Assigned Numbers Authority');
    expect(text).not.toContain('contact&');
  });

  it('indexes every entry by number', () => {
    expect(pen.byNumber.size).toBe(pen.entries.length);
    for (const entry of pen.entries) expect(pen.byNumber.get(entry.number)).toBe(entry);
  });
});

describe('layout edge cases', () => {
  it('parses CRLF line endings', () => {
    const pen = parse(
      penText([penRecord(1, 'Example Org'), penRecord(2, 'Other Org')], { eol: '\r\n' }),
    );
    expect(pen.entries.map((entry) => entry.organization)).toEqual(['Example Org', 'Other Org']);
  });

  it('sorts records that arrive out of order and takes the maximum number', () => {
    const pen = parse(penText([penRecord(10, 'Ten'), penRecord(2, 'Two'), penRecord(7, 'Seven')]));
    expect(pen.entries.map((entry) => entry.number)).toEqual([2, 7, 10]);
    expect(pen.maxNumber).toBe(10);
  });

  it('takes a record with no organization line as assigned with no organization, never reading the contact as one', () => {
    const missing: PenFixtureRecord = {
      number: 9,
      lines: ['    Example Contact', '      contact&example.org'],
    };
    const pen = parse(penText([missing, penRecord(10, 'Next Org')]));
    expect(pen.byNumber.get(9)).toEqual({ number: 9, state: 'assigned', searchText: '' });
    expect(pen.byNumber.get(10)?.organization).toBe('Next Org');
  });

  it.each([
    ['U+2028', 'Foo\u{2028}Bar'],
    ['U+2029', 'Foo\u{2029}Bar'],
  ])('keeps a %s inside the organization line as part of it', (_name, organization) => {
    const pen = parse(penText([penRecord(1, organization), penRecord(2, 'Next Org')]));
    expect(pen.byNumber.get(1)?.organization).toBe(organization);
    expect(pen.byNumber.get(2)?.organization).toBe('Next Org');
  });

  it('ends the organization line at a lone CR', () => {
    const pen = parse(penText([penRecord(1, 'Foo\rBar'), penRecord(2, 'Next Org')]));
    expect(pen.byNumber.get(1)?.organization).toBe('Foo');
    expect(pen.byNumber.get(2)?.organization).toBe('Next Org');
  });

  it('reads a record with lone-CR line endings without folding its contact into the organization', () => {
    const text = penText(
      [
        { number: 1, lines: ['  Org', '    Example Person', '      person&example.org'] },
        penRecord(2, 'Next Org'),
      ],
      { eol: '\r' },
    );
    const pen = parse(text);
    expect(pen.byNumber.get(1)).toMatchObject({ organization: 'Org', state: 'assigned' });
    expect(pen.byNumber.get(1)).not.toHaveProperty('organizationWithheld');
    expect(JSON.stringify(pen.entries)).not.toMatch(/Example Person|person&example\.org/);
  });

  it('parses a last record that ends the file without a trailing newline', () => {
    const text = penText([penRecord(1, 'First'), penRecord(2, 'Last')]).trimEnd();
    expect(parse(text).byNumber.get(2)?.organization).toBe('Last');
  });

  it('parses the file with no update line', () => {
    const pen = parse(penText([penRecord(1, 'Org')], { updated: null }));
    expect(pen).not.toHaveProperty('updated');
    expect(pen.entries).toHaveLength(1);
  });

  it('reads the update date only from the head of the file', () => {
    const filler = Array.from({ length: 300 }, (_, index) => penRecord(index, `Org ${index}`));
    filler.push(penRecord(300, 'Org (last updated 1999-01-01)'));
    expect(parse(penText(filler, { updated: null }))).not.toHaveProperty('updated');
  });

  it('does not mistake an indented, digits-only contact line for the next record number', () => {
    const record: PenFixtureRecord = {
      number: 1,
      lines: ['  Example Org', '    12345', '      contact&example.org'],
    };
    expect(parse(penText([record, penRecord(2, 'Two')])).entries).toHaveLength(2);
  });
});

describe('unreadable text', () => {
  it.each([
    ['an HTML page', '<html><body>Not found</body></html>', /no record header/],
    ['an empty body', '', /no record header/],
    ['a header with no records', penText([]), /zero records/],
  ])('rejects %s as upstream_unreadable', (_name, text, message) => {
    const error = asMcpError(catching(() => parse(text)));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', url: URL_ });
    expect(error.message).toMatch(message);
  });
});
