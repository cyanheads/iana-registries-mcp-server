/**
 * @fileoverview The `enrichment` block every tool with a `limit` declares, and
 * the end-of-handler write that discloses counts, truncation, and the call's one
 * composed notice. `ctx.enrich.truncated()` also writes `notice` and the last
 * write wins, so a handler collects its notice fragments and writes them once,
 * here. List modes rank exact matches first ({@link exactFirst}) and page by
 * `offset`: {@link offsetPage} cuts the page and words its notice, and
 * {@link discloseList} writes its `next_offset`.
 * @module mcp-server/tools/shared/list-enrichment
 */

import { type EnrichHelpers, z } from '@cyanheads/mcp-ts-core';

/**
 * List counters, all required. Each handler writes
 * `ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false })`
 * as its first statement so every path parses, then calls {@link discloseList}.
 */
export const listEnrichment = {
  totalCount: z.number().describe('Matches before the limit was applied.'),
  shown: z.number().describe('Results returned.'),
  cap: z.number().describe('The limit applied.'),
  truncated: z.boolean().describe('True when more matches exist than were returned.'),
  notice: z.string().optional().describe('Guidance on a miss, a cut list, or another condition.'),
};

/** {@link listEnrichment} plus the `next_offset` of a tool whose list modes page by `offset`. */
export const offsetListEnrichment = {
  ...listEnrichment,
  next_offset: z
    .number()
    .optional()
    .describe('Pass as offset for the next page; absent on the last.'),
};

/** `ctx.enrich` of a tool declaring {@link listEnrichment} or {@link offsetListEnrichment}. */
export type ListEnrich = EnrichHelpers &
  ((fields: { next_offset?: number; shown?: number }) => void);

/** The end-of-call disclosure. */
export interface ListPage {
  cap: number;
  /** Notice fragments in reading order; falsy entries are skipped. */
  fragments: readonly (string | false | undefined)[];
  /** True when matches remain past this response. */
  more: boolean;
  /** The offset of the next page, from {@link offsetPage}; written as `next_offset`. */
  nextOffset?: number | undefined;
  shown: number;
  total: number;
}

/**
 * Writes `totalCount`, `shown`, and `next_offset` when a next page exists, sets
 * `truncated` when matches remain, and writes the composed notice once: as the
 * truncation guidance when the list was cut, else as a plain notice when any
 * fragment is present.
 */
export function discloseList(enrich: ListEnrich, page: ListPage): void {
  enrich.total(page.total);
  if (page.nextOffset !== undefined) enrich({ next_offset: page.nextOffset });
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

/** The matches `isExact` accepts, then the rest, each group in its original order. */
export function exactFirst<T>(matches: readonly T[], isExact: (match: T) => boolean): T[] {
  const exact: T[] = [];
  const rest: T[] = [];
  for (const match of matches) (isExact(match) ? exact : rest).push(match);
  return [...exact, ...rest];
}

/** Where a list mode's page starts, how long it may be, and how its notice reads. */
export interface OffsetPageOptions {
  limit: number;
  /** The tool's maximum `limit`; the notice suggests raising `limit` only below it. */
  max: number;
  /** Narrowing advice that ends the notice, e.g. "add words to keyword to narrow". */
  narrow?: string;
  /** What the matches are, plural, e.g. "matching rows". */
  noun: string;
  offset: number;
}

/** One page of a list mode's matches. */
export interface OffsetPage<T> {
  items: T[];
  /** The offset of the first match past this page; absent on the last page. */
  nextOffset?: number;
  /** The cut or past-the-end notice fragment; absent when the page reaches the last match. */
  notice?: string;
}

/**
 * The page of `matches` at `offset`. A cut page names the offset to pass next,
 * suggests raising `limit` only while it is below `max`, then `narrow`. An
 * offset past the last match returns no items and a notice giving the total.
 * An empty `matches` returns a bare empty page: the caller's miss notice
 * explains it.
 */
export function offsetPage<T>(matches: readonly T[], options: OffsetPageOptions): OffsetPage<T> {
  const { limit, max, narrow, noun, offset } = options;
  const total = matches.length;
  const items = matches.slice(offset, offset + limit);
  if (total > 0 && offset >= total) {
    return {
      items,
      notice: `Offset ${offset} is past the ${total} ${noun}; pass an offset below ${total}, or omit offset to start over.`,
    };
  }
  const end = offset + items.length;
  if (end >= total) return { items };
  const shown = offset === 0 ? String(items.length) : `${offset + 1}–${end}`;
  const steps = [
    `pass offset ${end} for the next page`,
    ...(limit < max ? [`raise limit (max ${max})`] : []),
    ...(narrow ? [narrow] : []),
  ];
  const last = steps.pop();
  const advice = steps.length > 0 ? `${steps.join(', ')}, or ${last}` : last;
  return { items, nextOffset: end, notice: `Showing ${shown} of ${total} ${noun}; ${advice}.` };
}

/** The notice of an exact lookup given an `offset`, which only `listMode` pages; `false` for offset 0. */
export function offsetIgnored(offset: number, listMode: string): string | false {
  return (
    offset > 0 && `offset applies to ${listMode} mode only; it was ignored for this exact lookup.`
  );
}

/** Collapses whitespace in an echoed input so a notice stays one line. */
export function echo(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
