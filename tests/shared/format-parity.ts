/**
 * @fileoverview The `format()`/`structuredContent` parity check: every string
 * and number a result carries (counters, booleans and the framework-appended
 * enrichment aside) must reach the markdown text, so a client reading only
 * `content[]` has the same data as one reading `structuredContent`.
 * @module tests/shared/format-parity
 */

/** Keys whose values are not printed by `format()` itself (enrichment counters are appended by the framework). */
const SKIPPED_KEYS = new Set(['totalCount', 'shown', 'cap', 'truncated', 'notice']);

/** Every string and number leaf of `value`, multi-line strings split into their non-empty lines. */
export function leaves(value: unknown, key?: string): string[] {
  if (key !== undefined && SKIPPED_KEYS.has(key)) return [];
  if (typeof value === 'string') return value.split('\n').filter((line) => line.trim() !== '');
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([entryKey, entry]) => leaves(entry, entryKey));
  }
  return [];
}

/** The leaves of `structured` that `text` does not carry; empty when the two surfaces agree. */
export function missingFromText(structured: Record<string, unknown>, text: string): string[] {
  return leaves(structured).filter((leaf) => !text.includes(leaf));
}
