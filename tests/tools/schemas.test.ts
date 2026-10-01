/**
 * @fileoverview Tests for `searchWords`, the token-search input shared by every
 * keyword-style tool parameter.
 */

import { describe, expect, it } from 'vitest';
import { searchWords } from '@/mcp-server/tools/shared/schemas.js';

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
