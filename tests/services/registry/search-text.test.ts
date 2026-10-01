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

  it('adds the split form of a word holding a lower-to-upper boundary, keeping the joined word', () => {
    expect(toSearchText('ciscoSystems')).toBe(' ciscosystems cisco systems ');
    expect(toSearchText('Acme ciscoSystems, Inc.')).toBe(' acme ciscosystems inc cisco systems ');
    expect(toSearchText('vnd.ms-excel.sheet.macroEnabled.12')).toBe(
      ' vnd ms excel sheet macroenabled 12 macro enabled ',
    );
  });

  it('indexes a very long word in linear time', () => {
    const long = 'a'.repeat(200_000);
    expect(toSearchText(long)).toBe(` ${long} `);
    expect(toSearchText(`${long}B`)).toBe(` ${long}b ${long} b `);
  });

  it('adds nothing for text without a lower-to-upper boundary', () => {
    expect(toSearchText('ACME Corp', 'Example-Org 2', 'HTTP2 x86')).toBe(
      ' acme corp example org 2 http2 x86 ',
    );
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

  it('matches a camelCase word by its parts and by the joined word', () => {
    const camel = toSearchText('ciscoSystems');
    for (const words of ['cisco', 'systems', 'cisco systems', 'ciscosystems', 'ciscoSystems']) {
      expect(matchesQuery(camel, compileQuery(words))).toBe(true);
    }
    expect(matchesQuery(camel, compileQuery('cisc'))).toBe(false);
  });
});
