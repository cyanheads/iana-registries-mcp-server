/**
 * @fileoverview Zod pieces every tool shares: the blank-as-unset input wrapper
 * (form clients submit every optional field, blank), digit-string integers, the
 * token-search input, the `limit` and `offset` inputs, and the `source` and
 * `references` output shapes.
 * @module mcp-server/tools/shared/schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import { normalizeForSearch } from '@/services/registry/search-text.js';

/**
 * Wraps an optional input so a blank or whitespace-only string parses as unset.
 * A non-blank string is trimmed, then passed through `normalize` (case-fold,
 * prefix/suffix strip, digit-string → number) before the inner schema checks it.
 */
export function blankAsUnset<T extends z.ZodType>(
  schema: T,
  normalize: (trimmed: string) => unknown = (trimmed) => trimmed,
) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : normalize(trimmed);
  }, schema);
}

/** Digit strings (`"443"`) become numbers; anything else reaches the integer check unchanged. */
export function digitsToNumber(trimmed: string): unknown {
  return /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/**
 * A token-search input (`keyword`, `organization`, `description`, `contains`,
 * `query`): 2–100 characters holding at least one letter or digit. Punctuation
 * and spaces alone compile to no search tokens and would match nothing. A
 * refinement, not a `pattern`: `\p{L}` needs the `u` flag, and an ASCII class
 * would reject the CJK names the search normalizer keeps.
 */
export function searchWords() {
  return z
    .string()
    .min(2)
    .max(100)
    .refine(
      (text) => normalizeForSearch(text) !== '',
      'Must contain at least one letter or digit; punctuation and spaces alone match nothing.',
    );
}

/** A `limit` input: integer 1–`max`, blank or a digit string accepted, default `fallback`. */
export function limitInput(max: number, fallback: number) {
  return blankAsUnset(z.number().int().min(1).max(max).default(fallback), digitsToNumber).describe(
    `Maximum number of results to return, 1–${max}. Default ${fallback}.`,
  );
}

/**
 * An `offset` input for a list mode: integer 0 or more, blank or a digit string
 * accepted, default 0. `mode` names the list mode it pages when the tool also
 * has exact-value modes, which ignore it.
 */
export function offsetInput(mode?: string) {
  const matches = mode ? `${mode} matches` : 'matches';
  return blankAsUnset(z.number().int().min(0).default(0), digitsToNumber).describe(
    `Number of ${matches} to skip; pass the next_offset of the previous response to get the next page. Default 0.`,
  );
}

/** Provenance every registry-backed output carries. */
export const SourceSchema = z
  .object({
    registry_id: z.string().describe('Id of the registry file that answered.'),
    url: z.string().describe('The file fetched from iana.org.'),
    registry_updated: z
      .string()
      .optional()
      .describe("The registry's own last-updated date; absent for the protocol index."),
    fetched_at: z.string().describe('ISO 8601 time of the last successful fetch or revalidation.'),
    stale: z
      .boolean()
      .describe('True when a refresh failed and a cached copy up to 7 days old answered.'),
  })
  .describe('Provenance and freshness of the answer.');

/** One normalized registry reference. */
export const ReferenceSchema = z
  .object({
    type: z
      .enum(['rfc', 'draft', 'uri', 'registry', 'rfc-errata', 'note', 'text'])
      .describe('Reference kind.'),
    id: z.string().describe('E.g. "RFC 9110", a draft name, a registry id, or a URL.'),
    section: z.string().optional().describe('Section, e.g. "15.5.5".'),
    label: z.string().optional().describe('Label text, when it adds to id and section.'),
    url: z.string().optional().describe('URL of the reference.'),
  })
  .describe('A defining reference.');
