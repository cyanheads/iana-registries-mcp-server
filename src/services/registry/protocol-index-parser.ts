/**
 * @fileoverview Parses the IANA protocol registry index page
 * (`https://www.iana.org/protocols`), the only published list of registries.
 * Category rows are `tr.dtable__group`; each entry row carries a
 * `div.reg-title` link to `/assignments/<id>(#<sub>)`, defining-document links
 * (`a[data-doc-name]`), and `span.iana-protocol-comment` procedure text whose
 * nested `span.reg-expert` elements (designated-expert names) are removed before
 * any text is read. A pair listed under several categories becomes one entry.
 * A parse under the floor is a layout change, never a short index. Elements are
 * found with `indexOf`, so a parse is linear in the page: a regex over it would
 * retry every unclosed tag against the rest of the page.
 * @module services/registry/protocol-index-parser
 */

import { upstreamUnreadable } from '../upstream/upstream-client.js';
import { scrubEmails } from './personal-data.js';
import { toSearchText } from './search-text.js';
import type { DefiningDocument, IndexEntry, ProtocolIndex } from './types.js';

/** A parse is accepted only with at least this many distinct registry ids… */
export const INDEX_MIN_REGISTRY_IDS = 500;
/** …and at least this many entries. */
export const INDEX_MIN_ENTRIES = 2_000;

const IANA = 'https://www.iana.org';
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

const TITLE_CELL = '<div class="reg-title">';
/** Sticky: whitespace, then an `<a` start tag, read where a title cell ends. */
const TITLE_LINK_OPEN = /\s*<a(?!\w)/y;
const COMMENT_OPEN = '<span class="iana-protocol-comment">';
const EXPERT_CLASS = /\bclass="reg-expert"/;
const DOC_NAME = /\bdata-doc-name\s*=/;
const WORD_CHAR = /\w/;
const TAG = /<[^>]*>/g;
const LINE_BREAK = /<br\s*\/?>/i;
/** The lookbehind tries a name only where it starts, never again inside it. */
const ATTRIBUTE = /(?<![-A-Za-z0-9_:.])([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Trailing separators; the lookbehind tries the match only where a run starts. */
const TRAILING_SEPARATORS = /(?<![\s;])[\s;]+$/;

/** A `Map`, so an entity named after an object member (`&constructor;`) stays as written. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['times', '×'],
]);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES.get(entity.toLowerCase()) ?? match;
  });
}

/**
 * Tag-stripped, entity-decoded, whitespace-collapsed text. Tags are stripped only
 * up to the last `>`: a `<` after it opens no tag, and the tag pattern would scan
 * the rest of the text again for each one.
 */
function textOf(html: string): string {
  const end = html.lastIndexOf('>') + 1;
  return decodeEntities(`${html.slice(0, end).replace(TAG, ' ')}${html.slice(end)}`)
    .replace(/\s+/g, ' ')
    .trim();
}

interface StartTag {
  /** The text between the tag name and the `>` that closes the tag. */
  attributes: string;
  /** Index just past that `>`. */
  end: number;
  /** Index of the tag's `<`. */
  start: number;
}

/**
 * `<name …>` start tags in document order. A `<name` inside an earlier tag's
 * attribute text is not a tag of its own, and a tag with no `>` after it ends the
 * scan, since no later tag can close either.
 */
function* startTags(html: string, name: string): Generator<StartTag> {
  const open = `<${name}`;
  let at = html.indexOf(open);
  while (at !== -1) {
    const afterName = at + open.length;
    if (WORD_CHAR.test(html.charAt(afterName))) {
      at = html.indexOf(open, afterName);
      continue;
    }
    const close = html.indexOf('>', afterName);
    if (close === -1) return;
    yield { attributes: html.slice(afterName, close), end: close + 1, start: at };
    at = html.indexOf(open, close + 1);
  }
}

/**
 * Each `<tr …>` row's attribute text and its content up to the next `</tr>`. A
 * row with no `</tr>` after it ends the scan.
 */
function* rows(html: string): Generator<[attributes: string, content: string]> {
  let next = 0;
  for (const tag of startTags(html, 'tr')) {
    if (tag.start < next) continue;
    const close = html.indexOf('</tr>', tag.end);
    if (close === -1) return;
    yield [tag.attributes, html.slice(tag.end, close)];
    next = close + '</tr>'.length;
  }
}

/** The link opening the first `div.reg-title` that starts with one: its attribute text and content. */
function titleLink(row: string): { attributes: string; content: string } | undefined {
  let at = row.indexOf(TITLE_CELL);
  while (at !== -1) {
    TITLE_LINK_OPEN.lastIndex = at + TITLE_CELL.length;
    if (TITLE_LINK_OPEN.test(row)) {
      const afterName = TITLE_LINK_OPEN.lastIndex;
      const close = row.indexOf('>', afterName);
      if (close === -1) return;
      const end = row.indexOf('</a>', close + 1);
      if (end === -1) return;
      return { attributes: row.slice(afterName, close), content: row.slice(close + 1, end) };
    }
    at = row.indexOf(TITLE_CELL, at + TITLE_CELL.length);
  }
  return;
}

/** `html` without its `span.reg-expert` elements, each cut through the next `</span>`. */
function withoutExperts(html: string): string {
  const kept: string[] = [];
  let next = 0;
  for (const tag of startTags(html, 'span')) {
    if (tag.start < next || !EXPERT_CLASS.test(tag.attributes)) continue;
    const close = html.indexOf('</span>', tag.end);
    if (close === -1) break;
    kept.push(html.slice(next, tag.start));
    next = close + '</span>'.length;
  }
  kept.push(html.slice(next));
  return kept.join('');
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const [, name, doubleQuoted, singleQuoted] = match;
    if (name)
      attributes.set(name.toLowerCase(), decodeEntities(doubleQuoted ?? singleQuoted ?? ''));
  }
  return attributes;
}

function definingDocuments(html: string): DefiningDocument[] {
  const documents: DefiningDocument[] = [];
  for (const tag of startTags(html, 'a')) {
    if (!DOC_NAME.test(tag.attributes)) continue;
    const attributes = attributesOf(tag.attributes);
    const id = attributes.get('data-doc-name')?.trim();
    if (!id) continue;
    const title = attributes.get('title')?.trim();
    const href = attributes.get('href');
    documents.push({
      id,
      ...(title ? { title: scrubEmails(title) } : {}),
      ...(href?.startsWith('/') ? { url: `${IANA}${href}` } : {}),
    });
  }
  return documents;
}

/**
 * Comment spans joined with `; `, `<br/>` → `; `. Returns `undefined` when an
 * expert span survived removal (unexpected nesting), so no fragment of a
 * designated expert's name can leak through.
 */
function registrationProcedure(docHtml: string): string | undefined {
  const html = withoutExperts(docHtml);
  if (html.includes('reg-expert')) return;
  const parts: string[] = [];
  let at = html.indexOf(COMMENT_OPEN);
  while (at !== -1) {
    const start = at + COMMENT_OPEN.length;
    const end = html.indexOf('</span>', start);
    if (end === -1) break;
    for (const piece of html.slice(start, end).split(LINE_BREAK)) {
      const text = textOf(piece).replace(TRAILING_SEPARATORS, '');
      if (text) parts.push(text);
    }
    at = html.indexOf(COMMENT_OPEN, end + '</span>'.length);
  }
  return parts.length > 0 ? scrubEmails(parts.join('; ')) : undefined;
}

/** One listing of a registry/sub-registry pair: an entry before its category and search text are set. */
type Listing = Omit<IndexEntry, 'category' | 'searchText'>;

function parseListing(row: string): Listing | undefined {
  const title = titleLink(row);
  if (!title) return;
  const href = attributesOf(title.attributes).get('href') ?? '';
  if (!href.startsWith('/assignments/')) return;
  const [path = '', fragment] = href.slice('/assignments/'.length).split('#');
  const registryId = path.split('/')[0] ?? '';
  if (!ID_PATTERN.test(registryId)) return;
  const subregistryId = fragment && ID_PATTERN.test(fragment) ? fragment : undefined;

  const docStart = row.indexOf('class="reg-doc"');
  const docHtml = docStart === -1 ? '' : row.slice(docStart);
  const procedure = registrationProcedure(docHtml);
  return {
    registryId,
    title: scrubEmails(textOf(title.content)),
    definingDocuments: definingDocuments(docHtml),
    pageUrl: `${IANA}/assignments/${registryId}${subregistryId ? `#${subregistryId}` : ''}`,
    xmlUrl: `${IANA}/assignments/${registryId}/${registryId}.xml`,
    ...(subregistryId ? { subregistryId } : {}),
    ...(procedure ? { registrationProcedure: procedure } : {}),
  };
}

/**
 * Parses the index page into entries; the floor is checked by
 * {@link indexFloorError}. A registry/sub-registry pair listed more than once
 * is one entry at its first position, showing its first listing: its
 * categories are joined with `"; "`, and every distinct title and category it
 * is listed under is searchable.
 */
export function parseProtocolIndex(html: string): ProtocolIndex {
  const byPair = new Map<string, { categories: string[]; listing: Listing; titles: string[] }>();
  let category = '';
  let categoryCount = 0;
  for (const [attributes, row] of rows(html)) {
    if (/\bclass="[^"]*\bdtable__group\b/.test(attributes)) {
      category = scrubEmails(textOf(row));
      categoryCount++;
      continue;
    }
    if (!row.includes('class="reg-title"')) continue;
    const listing = parseListing(row);
    if (!listing) continue;
    const pair = `${listing.registryId}#${listing.subregistryId ?? ''}`;
    const listed = byPair.get(pair);
    if (!listed) {
      byPair.set(pair, { listing, categories: [category], titles: [listing.title] });
      continue;
    }
    if (!listed.categories.includes(category)) listed.categories.push(category);
    if (!listed.titles.includes(listing.title)) listed.titles.push(listing.title);
  }
  const entries = [...byPair.values()].map(({ listing, categories, titles }): IndexEntry => {
    const joined = categories.join('; ');
    return {
      ...listing,
      category: joined,
      searchText: toSearchText(...titles, joined, listing.registryId, listing.subregistryId),
    };
  });
  const registryIds = new Map<string, string>();
  for (const entry of entries) registryIds.set(entry.registryId.toLowerCase(), entry.registryId);
  return { entries, registryIds, categoryCount };
}

/**
 * The `index_unreadable` error (not retryable — the page is deterministic) for a
 * parse under {@link INDEX_MIN_REGISTRY_IDS} ids or {@link INDEX_MIN_ENTRIES}
 * entries; `undefined` when the parse clears the floor.
 */
export function indexFloorError(index: ProtocolIndex, url: string) {
  const registryIds = index.registryIds.size;
  const entries = index.entries.length;
  if (registryIds >= INDEX_MIN_REGISTRY_IDS && entries >= INDEX_MIN_ENTRIES) return;
  return upstreamUnreadable(
    `${url} parsed to ${registryIds} registry ids and ${entries} entries, under the ${INDEX_MIN_REGISTRY_IDS}-id / ${INDEX_MIN_ENTRIES}-entry floor; the page layout has likely changed.`,
    { url, registryIds, entries, retryable: false },
    { reason: 'index_unreadable' },
  );
}
