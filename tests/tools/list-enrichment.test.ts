/**
 * @fileoverview Tests for the offset paging the list modes share: the page at an
 * offset and its `next_offset`, the truncation notice that names the offset to
 * pass next (raising `limit` only below its maximum), the past-the-end notice,
 * the ignored-offset notice of exact lookups, and `discloseList` writing
 * `next_offset`.
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  discloseList,
  type ListEnrich,
  offsetIgnored,
  offsetPage,
} from '@/mcp-server/tools/shared/list-enrichment.js';

const matches = Array.from({ length: 114 }, (_, index) => index);
const rows = { noun: 'matching rows', max: 100, narrow: 'add words to keyword to narrow' };

describe('offsetPage', () => {
  it('returns the first page, the next offset, and a notice that also suggests raising limit', () => {
    const page = offsetPage(matches, { ...rows, offset: 0, limit: 25 });
    expect(page.items).toEqual(matches.slice(0, 25));
    expect(page.nextOffset).toBe(25);
    expect(page.notice).toBe(
      'Showing 25 of 114 matching rows; pass offset 25 for the next page, raise limit (max 100), or add words to keyword to narrow.',
    );
  });

  it('drops "raise limit" when limit is at its maximum', () => {
    const page = offsetPage(matches, { ...rows, offset: 0, limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.nextOffset).toBe(100);
    expect(page.notice).toBe(
      'Showing 100 of 114 matching rows; pass offset 100 for the next page, or add words to keyword to narrow.',
    );
  });

  it('names the row range of a middle page', () => {
    const page = offsetPage(matches, { ...rows, offset: 25, limit: 25 });
    expect(page.items).toEqual(matches.slice(25, 50));
    expect(page.nextOffset).toBe(50);
    expect(page.notice).toBe(
      'Showing 26–50 of 114 matching rows; pass offset 50 for the next page, raise limit (max 100), or add words to keyword to narrow.',
    );
  });

  it('ends at the last page with no next offset and no notice', () => {
    const page = offsetPage(matches, { ...rows, offset: 100, limit: 100 });
    expect(page.items).toEqual(matches.slice(100));
    expect(page.nextOffset).toBeUndefined();
    expect(page.notice).toBeUndefined();
  });

  it('keeps to the offset and the next offset alone when there is nothing to narrow', () => {
    const page = offsetPage(matches, { noun: 'matching rows', max: 100, offset: 0, limit: 100 });
    expect(page.notice).toBe(
      'Showing 100 of 114 matching rows; pass offset 100 for the next page.',
    );
  });

  it.each([114, 5_000])(
    'returns an empty page at offset %i with a notice giving the total',
    (offset) => {
      const page = offsetPage(matches, { ...rows, offset, limit: 25 });
      expect(page.items).toEqual([]);
      expect(page.nextOffset).toBeUndefined();
      expect(page.notice).toBe(
        `Offset ${offset} is past the 114 matching rows; pass an offset below 114, or omit offset to start over.`,
      );
    },
  );

  it('leaves an empty match list to the caller’s miss notice', () => {
    const page = offsetPage([], { ...rows, offset: 10, limit: 25 });
    expect(page).toEqual({ items: [] });
  });
});

describe('offsetIgnored', () => {
  it('says offset belongs to the list mode, only when one was passed', () => {
    expect(offsetIgnored(0, 'keyword')).toBe(false);
    expect(offsetIgnored(5, 'keyword')).toBe(
      'offset applies to keyword mode only; it was ignored for this exact lookup.',
    );
  });
});

describe('discloseList with an offset page', () => {
  it('writes next_offset beside the truncation counters', () => {
    const ctx = createMockContext();
    const page = offsetPage(matches, { ...rows, offset: 0, limit: 25 });
    discloseList(ctx.enrich as ListEnrich, {
      total: matches.length,
      shown: page.items.length,
      cap: 25,
      more: page.nextOffset !== undefined,
      nextOffset: page.nextOffset,
      fragments: [page.notice],
    });
    expect(getEnrichment(ctx)).toMatchObject({
      totalCount: 114,
      shown: 25,
      cap: 25,
      truncated: true,
      next_offset: 25,
      notice: page.notice,
    });
  });

  it('writes no next_offset on the last page', () => {
    const ctx = createMockContext();
    const page = offsetPage(matches, { ...rows, offset: 100, limit: 25 });
    discloseList(ctx.enrich as ListEnrich, {
      total: matches.length,
      shown: page.items.length,
      cap: 25,
      more: false,
      nextOffset: page.nextOffset,
      fragments: [page.notice],
    });
    expect(getEnrichment(ctx)).not.toHaveProperty('next_offset');
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 114, shown: 14 });
  });
});
