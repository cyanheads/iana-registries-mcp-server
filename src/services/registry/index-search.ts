/**
 * @fileoverview Ranked keyword search over the protocol index, for
 * `iana_search_registries` alone. Query words match whole tokens, as in every
 * search, but with singular and plural folded ({@link foldToken}) on the query
 * and on every title, category, and id token; matches order by exact id, title
 * distance, missing query words, then index position. The fold stays out of
 * the shared normalizer: in the port, URI scheme, and record corpora a trailing
 * "s" usually names a different protocol (`https`, `ldaps`, `coaps`). Each
 * parsed index is prepared once, on its first search, so no index token is
 * folded again per call.
 * @module services/registry/index-search
 */

import { matchesQuery, normalizeForSearch, type SearchQuery, toSearchText } from './search-text.js';
import type { IndexEntry, ProtocolIndex } from './types.js';

/** Words that count neither for nor against a title match. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'by',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

const LETTERS_ONLY = /^\p{L}+$/u;
/** `-sses`, `-xes`, `-ches`, `-shes`, `-tuses`: plurals that add `es`. */
const ES_PLURAL = /(?:ss|x|ch|sh|tus)es$/;
/** Endings whose final `s` belongs to the singular. */
const SINGULAR_S = /(?:ss|us|sis|xis)$/;

/**
 * The singular key of one normalized token. A letters-only token of four or
 * more characters maps `-ies` to `-y`, drops the `es` of `-sses`, `-xes`,
 * `-ches`, `-shes`, and `-tuses`, and drops any other final `s` unless it ends
 * `ss`, `us`, `sis`, or `xis`; `ids` is `id`. Shorter tokens (`dns`, `tls`,
 * `ips`) and tokens holding a digit stay as written.
 */
export function foldToken(token: string): string {
  if (token === 'ids') return 'id';
  if (token.length < 4 || !LETTERS_ONLY.test(token)) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (ES_PLURAL.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !SINGULAR_S.test(token)) return token.slice(0, -1);
  return token;
}

/** The folded tokens of normalized text (a {@link normalizeForSearch} or {@link toSearchText} value). */
const foldedTokens = (normalized: string) => normalized.split(' ').filter(Boolean).map(foldToken);

/** An index entry with what ranking reads, computed once per parsed index. */
interface PreparedEntry {
  readonly entry: IndexEntry;
  /** The registry id's folded tokens, space-joined: `protocol-numbers` → `protocol number`. */
  readonly idKey: string;
  /** Lowercase registry and sub-registry ids, for the exact-id tier. */
  readonly ids: readonly string[];
  readonly position: number;
  /** Folded title words, camelCase parts included, stopwords left out. */
  readonly titleWords: ReadonlySet<string>;
  /** Folded tokens of the titles, categories, and ids, space-padded for {@link matchesQuery}. */
  readonly tokens: string;
}

const preparedIndexes = new WeakMap<ProtocolIndex, readonly PreparedEntry[]>();

function prepare(index: ProtocolIndex): readonly PreparedEntry[] {
  const cached = preparedIndexes.get(index);
  if (cached) return cached;
  const entries = index.entries.map((entry, position) => ({
    entry,
    position,
    idKey: foldedTokens(normalizeForSearch(entry.registryId)).join(' '),
    ids: [entry.registryId, entry.subregistryId ?? '']
      .filter(Boolean)
      .map((id) => id.toLowerCase()),
    tokens: ` ${foldedTokens(entry.searchText).join(' ')} `,
    titleWords: new Set(
      foldedTokens(toSearchText(entry.title)).filter((word) => !STOPWORDS.has(word)),
    ),
  }));
  preparedIndexes.set(index, entries);
  return entries;
}

/**
 * The index entries `query` matches, best first. An entry matches when every
 * folded query token is one of its folded tokens, or when the query is its
 * registry or sub-registry id. Order: (1) exact id — the query equals a
 * registry or sub-registry id, case-insensitively, or its folded form equals a
 * registry id's (`protocol numbers` → `protocol-numbers`; a sub-registry id
 * never enters this tier that way); (2) title distance — query words missing
 * from the title plus title words missing from the query, stopwords aside;
 * (3) query words missing from the title; (4) index position, which makes the
 * order total, so offset pages neither skip nor repeat.
 */
export function searchIndex(index: ProtocolIndex, query: string): IndexEntry[] {
  const folded = foldedTokens(normalizeForSearch(query));
  if (folded.length === 0) return [];
  const words = [...new Set(folded)];
  const content = words.filter((word) => !STOPWORDS.has(word));
  const queryKey = folded.join(' ');
  const wanted = query.toLowerCase();
  const required: SearchQuery = words.map((word) => ` ${word} `);

  const ranked: {
    entry: IndexEntry;
    exact: number;
    distance: number;
    missing: number;
    position: number;
  }[] = [];
  for (const prepared of prepare(index)) {
    const exactId = prepared.ids.includes(wanted);
    if (!exactId && !matchesQuery(prepared.tokens, required)) continue;
    const inTitle = content.filter((word) => prepared.titleWords.has(word)).length;
    const missing = content.length - inTitle;
    ranked.push({
      entry: prepared.entry,
      exact: exactId || prepared.idKey === queryKey ? 0 : 1,
      distance: missing + prepared.titleWords.size - inTitle,
      missing,
      position: prepared.position,
    });
  }
  ranked.sort(
    (a, b) =>
      a.exact - b.exact ||
      a.distance - b.distance ||
      a.missing - b.missing ||
      a.position - b.position,
  );
  return ranked.map(({ entry }) => entry);
}
