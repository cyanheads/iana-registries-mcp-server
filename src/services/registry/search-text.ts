/**
 * @fileoverview Strict whole-token keyword matching shared by every search mode:
 * normalize (NFKD, strip diacritics, lowercase, non-alphanumerics → space) and
 * require every query token to appear as a token of the searchable text. No
 * fuzzy fallback. The searchable text also indexes the parts of a camelCase
 * word (`ciscoSystems` → `ciscosystems cisco systems`); queries are never split.
 * @module services/registry/search-text
 */

/** A run of characters that separates words. */
const WORD_GAP = /[^\p{L}\p{M}\p{N}]+/u;

/** A lowercase letter followed by an uppercase one, as in `ciscoSystems`. */
const CAMEL_PAIR = /\p{Ll}\p{Lu}/u;

/** The position between a lowercase and an uppercase letter. */
const CAMEL_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})/u;

/** Normalizes text to space-separated lowercase alphanumeric tokens. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Builds the stored form of a searchable string: normalized and padded with one
 * space on each side, so a token test is a single `includes(' tok ')`. Each
 * camelCase word is indexed joined and split, so `cisco`, `cisco systems`, and
 * `ciscosystems` all find `ciscoSystems`.
 */
export function toSearchText(...parts: readonly (string | undefined)[]): string {
  const text = parts.filter(Boolean).join(' ');
  const splitWords = text
    .split(WORD_GAP)
    .filter((word) => CAMEL_PAIR.test(word))
    .map((word) => word.split(CAMEL_BOUNDARY).join(' '));
  const normalized = normalizeForSearch([text, ...splitWords].join(' '));
  return normalized ? ` ${normalized} ` : '';
}

/** A compiled query: its padded tokens. Empty when the query has no alphanumerics. */
export type SearchQuery = readonly string[];

/** Compiles a keyword query once for matching against many records. */
export function compileQuery(query: string): SearchQuery {
  const normalized = normalizeForSearch(query);
  return normalized ? [...new Set(normalized.split(' '))].map((token) => ` ${token} `) : [];
}

/** True when every query token appears as a whole token of `searchText` (a {@link toSearchText} value). */
export function matchesQuery(searchText: string, query: SearchQuery): boolean {
  if (query.length === 0 || !searchText) return false;
  for (const token of query) if (!searchText.includes(token)) return false;
  return true;
}
