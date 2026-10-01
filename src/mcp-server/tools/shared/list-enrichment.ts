/**
 * @fileoverview The `enrichment` block every tool with a `limit` declares, and
 * the end-of-handler write that discloses counts, truncation, and the call's one
 * composed notice. `ctx.enrich.truncated()` also writes `notice` and the last
 * write wins, so a handler collects its notice fragments and writes them once,
 * here.
 * @module mcp-server/tools/shared/list-enrichment
 */

import { type EnrichHelpers, z } from '@cyanheads/mcp-ts-core';

/**
 * List counters, all required. Each handler writes
 * `ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false })`
 * as its first statement so every path parses, then calls {@link discloseList}.
 */
export const listEnrichment = {
  totalCount: z.number().describe('Number of matches before the limit was applied.'),
  shown: z.number().describe('Number of results returned in this response.'),
  cap: z.number().describe('The limit that was applied.'),
  truncated: z.boolean().describe('True when more matches exist than this response returned.'),
  notice: z
    .string()
    .optional()
    .describe('Guidance for a miss, a cut list, or a condition worth knowing about this result.'),
};

/** `ctx.enrich` of a tool declaring {@link listEnrichment}. */
export type ListEnrich = EnrichHelpers & ((fields: { shown: number }) => void);

/** The end-of-call disclosure. */
export interface ListPage {
  cap: number;
  /** Notice fragments in reading order; falsy entries are skipped. */
  fragments: readonly (string | false | undefined)[];
  /** True when matches remain past this response. */
  more: boolean;
  shown: number;
  total: number;
}

/**
 * Writes `totalCount` and `shown`, sets `truncated` when matches remain, and
 * writes the composed notice once: as the truncation guidance when the list was
 * cut, else as a plain notice when any fragment is present.
 */
export function discloseList(enrich: ListEnrich, page: ListPage): void {
  enrich.total(page.total);
  const notice = page.fragments
    .filter((fragment): fragment is string => typeof fragment === 'string' && fragment !== '')
    .join(' ');
  if (page.more) {
    enrich.truncated({ shown: page.shown, cap: page.cap, ...(notice ? { guidance: notice } : {}) });
    return;
  }
  enrich({ shown: page.shown });
  if (notice) enrich.notice(notice);
}

/** Collapses whitespace in an echoed input so a notice stays one line. */
export function echo(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
