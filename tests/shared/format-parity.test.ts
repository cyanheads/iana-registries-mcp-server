/**
 * @fileoverview Tests for the parity helper the tool suites rely on: it must
 * name a leaf missing from the text, split multi-line strings, and skip the
 * framework-appended enrichment keys.
 */

import { describe, expect, it } from 'vitest';
import { leaves, missingFromText } from './format-parity.js';

describe('format parity helper', () => {
  it('collects strings and numbers, ignoring booleans and enrichment keys', () => {
    expect(
      leaves({
        found: true,
        totalCount: 3,
        notice: 'framework text',
        rows: [{ name: 'a', port: 22, nested: { id: 'RFC 1' } }],
      }),
    ).toEqual(['a', '22', 'RFC 1']);
  });

  it('splits a multi-line string into its non-empty lines', () => {
    expect(leaves({ text: 'one\n\n two \nthree' })).toEqual(['one', ' two ', 'three']);
  });

  it('names exactly the leaves the text lacks', () => {
    expect(missingFromText({ a: 'present', b: 'absent', c: 7 }, 'present and 7')).toEqual([
      'absent',
    ]);
    expect(missingFromText({ a: 'present' }, 'present')).toEqual([]);
  });
});
