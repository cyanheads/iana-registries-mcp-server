/**
 * @fileoverview Parses `enterprise-numbers.txt`: a decimal line, then the
 * organization line indented two spaces. The contact (4 spaces) and email
 * (6 spaces) lines are never read. An organization line holding an
 * email-shaped token (`@` or IANA's `&` form) is withheld whole. Lines end at
 * LF, CRLF, or a lone CR, so a stray CR can never fold the contact line into the
 * organization; a U+2028 or U+2029 inside a line is kept as part of it.
 * @module services/registry/pen-parser
 */

import { upstreamUnreadable } from '../upstream/upstream-client.js';
import { hasEmailToken } from './personal-data.js';
import { toSearchText } from './search-text.js';
import type { PenEntry, PenRegistry, PenState } from './types.js';

const HEADER_END = /^\|\s\|\s\|\s\|/;
const NUMBER_LINE = /^\d+$/;
const ORGANIZATION_LINE = /^ {2}(?! )(.*)$/s;

function stateOf(organization: string | undefined): PenState {
  if (organization === 'Reserved') return 'reserved';
  if (organization === 'Unassigned' || organization === '---none---') return 'unassigned';
  return 'assigned';
}

function toEntry(number: number, line: string | undefined): PenEntry {
  const organization = line?.trim() || undefined;
  if (organization && hasEmailToken(organization)) {
    return { number, organizationWithheld: true, state: 'assigned', searchText: '' };
  }
  return {
    number,
    state: stateOf(organization),
    searchText: toSearchText(organization),
    ...(organization ? { organization } : {}),
  };
}

/** Parses the PEN file. Throws `upstream_unreadable` when no record parses. */
export function parsePen(text: string, url: string): PenRegistry {
  const lines = text.split(/\r\n?|\n/);
  const updated = /\(last updated (\d{4}-\d{2}-\d{2})\)/.exec(text.slice(0, 2_000))?.[1];
  const start = lines.findIndex((line) => HEADER_END.test(line));
  if (start === -1) throw upstreamUnreadable(`${url} has no record header.`, { url });

  const entries: PenEntry[] = [];
  let number: number | undefined;
  let organization: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (NUMBER_LINE.test(line)) {
      if (number !== undefined) entries.push(toEntry(number, organization));
      number = Number(line);
      organization = undefined;
    } else if (number !== undefined && organization === undefined) {
      organization = ORGANIZATION_LINE.exec(line)?.[1];
    }
  }
  if (number !== undefined) entries.push(toEntry(number, organization));
  if (entries.length === 0) throw upstreamUnreadable(`${url} parsed to zero records.`, { url });

  entries.sort((a, b) => a.number - b.number);
  return {
    entries,
    byNumber: new Map(entries.map((entry) => [entry.number, entry])),
    maxNumber: entries.at(-1)?.number ?? 0,
    withheldCount: entries.filter((entry) => entry.organizationWithheld).length,
    ...(updated ? { updated } : {}),
  };
}
