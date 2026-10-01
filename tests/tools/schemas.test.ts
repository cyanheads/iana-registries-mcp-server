/**
 * @fileoverview Tests for `searchWords`, the token-search input shared by every
 * keyword-style tool parameter, and `offsetInput`, the page offset of the list
 * modes.
 */

import { describe, expect, it } from 'vitest';
import { offsetInput, searchWords } from '@/mcp-server/tools/shared/schemas.js';

describe('offsetInput', () => {
  it.each([
    [undefined, 0],
    ['  ', 0],
    [0, 0],
    [25, 25],
    ['100', 100],
    [' 1100 ', 1100],
  ])('parses %j as %j', (value, expected) => {
    expect(offsetInput('keyword').parse(value)).toBe(expected);
  });

  it.each([-1, 1.5, '-1', 'next'])('rejects %j', (value) => {
    expect(offsetInput('keyword').safeParse(value).success).toBe(false);
  });

  it('names the mode it pages and the next_offset to pass', () => {
    expect(offsetInput('keyword').description).toBe(
      'Number of keyword matches to skip; pass the next_offset of the previous response to get the next page. Default 0.',
    );
    expect(offsetInput().description).toBe(
      'Number of matches to skip; pass the next_offset of the previous response to get the next page. Default 0.',
    );
  });
});

describe('searchWords', () => {
  it.each(['株式会社', 'a.', 'ab', '10', 'RFC 9110'])('accepts %j', (value) => {
    expect(searchWords().safeParse(value).success).toBe(true);
  });

  it.each(['!!', '++', '--', '  ', '', 'a', '.-', 'x'.repeat(101)])('rejects %j', (value) => {
    expect(searchWords().safeParse(value).success).toBe(false);
  });

  it('names the missing letter or digit in the error', () => {
    const result = searchWords().safeParse('!!');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Must contain at least one letter or digit');
  });
});
