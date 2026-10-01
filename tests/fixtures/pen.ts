/**
 * @fileoverview Synthetic Private Enterprise Number list in the real 2/4/6-indent
 * layout, with the markers (`Reserved`, `Unassigned`, `---none---`), run-in
 * organization lines whose contact name and address were merged in (the `&` form
 * IANA writes for `@`, and a literal `@`), and a record with a missing
 * organization line. Every person and address is invented.
 * @module tests/fixtures/pen
 */

/** One PEN record as the file lays it out. `lines` are the raw indented lines after the number. */
export interface PenFixtureRecord {
  lines: readonly string[];
  number: number | string;
}

/** Builds a PEN record with the standard three indented lines. */
export function penRecord(
  number: number,
  organization: string,
  contact = 'Example Contact',
  email = 'contact&example.org',
): PenFixtureRecord {
  return { number, lines: [`  ${organization}`, `    ${contact}`, `      ${email}`] };
}

/** Wraps records in the file header; `updated` becomes the `(last updated …)` line. */
export function penText(
  records: readonly PenFixtureRecord[],
  { updated = '2026-09-24', eol = '\n' }: { eol?: string; updated?: string | null } = {},
): string {
  const header = [
    'PRIVATE ENTERPRISE NUMBERS',
    ...(updated ? [`(last updated ${updated})`] : []),
    '',
    'SMI Network Management Private Enterprise Codes:',
    '',
    'Decimal',
    '| Organization',
    '| | Contact',
    '| | | Email',
    '| | | |',
  ];
  const body = records.flatMap((record) => [String(record.number), ...record.lines]);
  return `${[...header, ...body, ''].join(eol)}`;
}

/** The default PEN fixture. Numbers 0–7 plus the documentation PEN 32473. */
export const PEN_TEXT = penText([
  penRecord(0, 'Reserved', 'Internet Assigned Numbers Authority', 'iana&example.org'),
  penRecord(1, 'Example Networks Inc.', 'Example Person', 'person&example.org'),
  penRecord(2, 'Unassigned', 'Example Contact', 'contact&example.org'),
  penRecord(3, '---none---', '---none---', '---none---'),
  penRecord(4, 'Example & Sons Ltd', 'Example Person', 'person&example.org'),
  penRecord(
    5,
    'Example Corp Example Person person&example.org',
    'Example Person',
    'person&example.org',
  ),
  penRecord(
    6,
    'Example Corp Example Person person@example.org',
    'Example Person',
    'person&example.org',
  ),
  penRecord(7, 'Réseau Démo', 'Example Person', 'person&example.org'),
  penRecord(32473, 'Documentation Example Org', 'Example Person', 'person&example.org'),
]);
