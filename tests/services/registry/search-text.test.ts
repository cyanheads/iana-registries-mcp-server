/**
 * @fileoverview Tests for the whole-token search helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  compileQuery,
  matchesQuery,
  normalizeForSearch,
  toSearchText,
} from '@/services/registry/search-text.js';

describe('normalizeForSearch', () => {
  it.each([
    ['Hello, World!', 'hello world'],
    ['  padded   spaces  ', 'padded spaces'],
    ['Crème Brûlée', 'creme brulee'],
    ['text/html; charset=utf-8', 'text html charset utf 8'],
    ['draft-ietf-example-01', 'draft ietf example 01'],
    ['日本語 text', '日本語 text'],
    ['', ''],
    ['---', ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeForSearch(input)).toBe(expected);
  });
});

describe('toSearchText', () => {
  it('pads the normalized, joined parts with one space on each side', () => {
    expect(toSearchText('Alpha Beta', undefined, 'GAMMA')).toBe(' alpha beta gamma ');
  });

  it('is empty when there is nothing searchable', () => {
    expect(toSearchText()).toBe('');
    expect(toSearchText(undefined, '')).toBe('');
    expect(toSearchText('---', '!!')).toBe('');
  });
});

describe('compileQuery and matchesQuery', () => {
  const text = toSearchText('Hypertext Transfer Protocol', 'RFC 9110', '200 OK');

  it('compiles to padded unique tokens', () => {
    expect(compileQuery('Foo foo BAR')).toEqual([' foo ', ' bar ']);
  });

  it('compiles a query without alphanumerics to nothing', () => {
    expect(compileQuery('  !? ')).toEqual([]);
  });

  it('matches only whole tokens, never substrings', () => {
    expect(matchesQuery(text, compileQuery('transfer'))).toBe(true);
    expect(matchesQuery(text, compileQuery('trans'))).toBe(false);
    expect(matchesQuery(text, compileQuery('protocol'))).toBe(true);
    expect(matchesQuery(text, compileQuery('proto'))).toBe(false);
  });

  it('requires every token (AND), in any order', () => {
    expect(matchesQuery(text, compileQuery('ok 200'))).toBe(true);
    expect(matchesQuery(text, compileQuery('ok 404'))).toBe(false);
  });

  it('matches punctuation-split ids as separate tokens', () => {
    expect(matchesQuery(text, compileQuery('RFC-9110'))).toBe(true);
  });

  it('never matches an empty query or empty text', () => {
    expect(matchesQuery(text, compileQuery(''))).toBe(false);
    expect(matchesQuery('', compileQuery('anything'))).toBe(false);
  });

  it('ignores case and diacritics on both sides', () => {
    expect(matchesQuery(toSearchText('Éclair'), compileQuery('ECLAIR'))).toBe(true);
  });
});
