/**
 * @fileoverview Parses the Language Subtag Registry record-jar: a `File-Date`
 * record, then records separated by `%%`, `Key: value` lines with
 * leading-whitespace continuation lines. `Description`, `Prefix`, and
 * `Comments` repeat.
 * @module services/registry/language-registry-parser
 */

import { upstreamUnreadable } from '../upstream/upstream-client.js';
import { scrubEmails } from './personal-data.js';
import { toSearchText } from './search-text.js';
import type {
  LanguageRange,
  LanguageRecord,
  LanguageRegistry,
  LanguageSubtagType,
} from './types.js';

const TYPES: ReadonlySet<string> = new Set<LanguageSubtagType>([
  'language',
  'extlang',
  'script',
  'region',
  'variant',
  'grandfathered',
  'redundant',
]);

/** Splits one record's lines into `[key, value]` pairs, folding continuation lines. */
function fieldsOf(lines: readonly string[]): [string, string][] {
  const fields: [string, string][] = [];
  for (const line of lines) {
    const last = fields.at(-1);
    if (/^\s/.test(line)) {
      if (last && line.trim()) last[1] = `${last[1]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) fields.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return fields;
}

function toRecord(fields: readonly [string, string][]): LanguageRecord | undefined {
  const single = new Map<string, string>();
  const descriptions: string[] = [];
  const prefixes: string[] = [];
  const comments: string[] = [];
  for (const [key, value] of fields) {
    if (key === 'Description') descriptions.push(scrubEmails(value));
    else if (key === 'Prefix') prefixes.push(value);
    else if (key === 'Comments') comments.push(scrubEmails(value));
    else if (!single.has(key)) single.set(key, value);
  }
  const type = single.get('Type');
  if (!type || !TYPES.has(type)) return;

  const optional = (key: string) => single.get(key) || undefined;
  const subtag = optional('Subtag');
  const tag = optional('Tag');
  const added = optional('Added');
  const deprecated = optional('Deprecated');
  const preferredValue = optional('Preferred-Value');
  const suppressScript = optional('Suppress-Script');
  const macrolanguage = optional('Macrolanguage');
  const scope = optional('Scope');
  return {
    type: type as LanguageSubtagType,
    descriptions,
    prefixes,
    comments,
    searchText: toSearchText(...descriptions),
    ...(subtag ? { subtag } : {}),
    ...(tag ? { tag } : {}),
    ...(added ? { added } : {}),
    ...(deprecated ? { deprecated } : {}),
    ...(preferredValue ? { preferredValue } : {}),
    ...(suppressScript ? { suppressScript } : {}),
    ...(macrolanguage ? { macrolanguage } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** Parses the registry. Throws `upstream_unreadable` when no record parses. */
export function parseLanguageRegistry(text: string, url: string): LanguageRegistry {
  const chunks = text.split(/\r?\n%%\r?\n/);
  const fileDate = /^File-Date:\s*(\S+)/m.exec(chunks[0] ?? '')?.[1];

  const records: LanguageRecord[] = [];
  const bySubtag = new Map<string, LanguageRecord[]>();
  const byTag = new Map<string, LanguageRecord>();
  const ranges: LanguageRange[] = [];

  for (const chunk of chunks.slice(1)) {
    const record = toRecord(fieldsOf(chunk.split(/\r?\n/)));
    if (!record) continue;
    records.push(record);
    if (record.tag) byTag.set(record.tag.toLowerCase(), record);
    if (!record.subtag) continue;
    const [start, end] = record.subtag.toLowerCase().split('..');
    if (start && end) {
      ranges.push({ start, end, record });
      continue;
    }
    const key = record.subtag.toLowerCase();
    const existing = bySubtag.get(key);
    if (existing) existing.push(record);
    else bySubtag.set(key, [record]);
  }
  if (records.length === 0) throw upstreamUnreadable(`${url} parsed to zero records.`, { url });

  return { records, bySubtag, byTag, ranges, ...(fileDate ? { fileDate } : {}) };
}
