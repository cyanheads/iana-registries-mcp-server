/**
 * @fileoverview Parses the IANA protocol registry index page
 * (`https://www.iana.org/protocols`), the only published list of registries.
 * Category rows are `tr.dtable__group`; each entry row carries a
 * `div.reg-title` link to `/assignments/<id>(#<sub>)`, defining-document links
 * (`a[data-doc-name]`), and `span.iana-protocol-comment` procedure text whose
 * nested `span.reg-expert` elements (designated-expert names) are removed before
 * any text is read. A parse under the floor is a layout change, never a short
 * index.
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

const ROW = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
const TITLE_LINK = /<div class="reg-title">\s*<a\b([^>]*)>([\s\S]*?)<\/a>/;
const DOC_LINK = /<a\b([^>]*\bdata-doc-name\s*=[^>]*)>/g;
const EXPERT_SPAN = /<span\b[^>]*\bclass="reg-expert"[^>]*>[\s\S]*?<\/span>/g;
const COMMENT_SPAN = /<span class="iana-protocol-comment">([\s\S]*?)<\/span>/g;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

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

/** Tag-stripped, entity-decoded, whitespace-collapsed text. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
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
  for (const match of html.matchAll(DOC_LINK)) {
    const attributes = attributesOf(match[1] ?? '');
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
function registrationProcedure(html: string): string | undefined {
  const withoutExperts = html.replace(EXPERT_SPAN, '');
  if (withoutExperts.includes('reg-expert')) return;
  const parts: string[] = [];
  for (const match of withoutExperts.matchAll(COMMENT_SPAN)) {
    for (const piece of (match[1] ?? '').split(/<br\s*\/?>/i)) {
      const text = textOf(piece).replace(/[\s;]+$/, '');
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? scrubEmails(parts.join('; ')) : undefined;
}

function parseEntry(row: string, category: string): IndexEntry | undefined {
  const title = TITLE_LINK.exec(row);
  if (!title) return;
  const href = attributesOf(title[1] ?? '').get('href') ?? '';
  if (!href.startsWith('/assignments/')) return;
  const [path = '', fragment] = href.slice('/assignments/'.length).split('#');
  const registryId = path.split('/')[0] ?? '';
  if (!ID_PATTERN.test(registryId)) return;
  const subregistryId = fragment && ID_PATTERN.test(fragment) ? fragment : undefined;

  const docStart = row.indexOf('class="reg-doc"');
  const docHtml = docStart === -1 ? '' : row.slice(docStart);
  const entryTitle = scrubEmails(textOf(title[2] ?? ''));
  const procedure = registrationProcedure(docHtml);
  return {
    registryId,
    title: entryTitle,
    category,
    definingDocuments: definingDocuments(docHtml),
    pageUrl: `${IANA}/assignments/${registryId}${subregistryId ? `#${subregistryId}` : ''}`,
    xmlUrl: `${IANA}/assignments/${registryId}/${registryId}.xml`,
    searchText: toSearchText(entryTitle, category, registryId, subregistryId),
    ...(subregistryId ? { subregistryId } : {}),
    ...(procedure ? { registrationProcedure: procedure } : {}),
  };
}

/** Parses the index page into entries; the floor is checked by {@link indexFloorError}. */
export function parseProtocolIndex(html: string): ProtocolIndex {
  const entries: IndexEntry[] = [];
  let category = '';
  let categoryCount = 0;
  for (const [, attributes = '', row = ''] of html.matchAll(ROW)) {
    if (/\bclass="[^"]*\bdtable__group\b/.test(attributes)) {
      category = scrubEmails(textOf(row));
      categoryCount++;
      continue;
    }
    if (!row.includes('class="reg-title"')) continue;
    const entry = parseEntry(row, category);
    if (entry) entries.push(entry);
  }
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
