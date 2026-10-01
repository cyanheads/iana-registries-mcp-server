/**
 * @fileoverview Tests for the Language Subtag Registry record-jar parser.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { parseLanguageRegistry } from '@/services/registry/language-registry-parser.js';
import {
  LANGUAGE_REGISTRY_CRLF,
  LANGUAGE_REGISTRY_TEXT,
} from '../../fixtures/language-registry.js';
import { asMcpError } from '../../shared/upstream-harness.js';

const URL_ = 'https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry';
const parse = (text: string) => parseLanguageRegistry(text, URL_);

const jar = (...records: string[]) => `File-Date: 2026-01-01\n%%\n${records.join('\n%%\n')}\n`;

describe('parseLanguageRegistry', () => {
  const registry = parse(LANGUAGE_REGISTRY_TEXT);

  it('reads File-Date and every typed record in registry order', () => {
    expect(registry.fileDate).toBe('2026-09-17');
    expect(registry.records.map((record) => record.type)).toEqual([
      'language',
      'language',
      'extlang',
      'language',
      'language',
      'script',
      'region',
      'variant',
      'grandfathered',
      'redundant',
    ]);
  });

  it('skips records with an unknown or missing Type', () => {
    expect(registry.records.some((record) => record.subtag === 'zz')).toBe(false);
    expect(registry.records.some((record) => record.subtag === 'orphan')).toBe(false);
  });

  it('reads the single-valued fields', () => {
    const aa = registry.bySubtag.get('aa')?.[0];
    expect(aa).toMatchObject({
      type: 'language',
      subtag: 'aa',
      added: '2005-10-16',
      suppressScript: 'Latn',
      scope: 'individual',
    });
    expect(registry.bySubtag.get('tw')?.[0]).toMatchObject({ macrolanguage: 'ak' });
    expect(registry.bySubtag.get('sh')?.[0]).toMatchObject({ deprecated: '2000-02-18' });
    expect(registry.byTag.get('i-example')).toMatchObject({
      preferredValue: 'ex',
      deprecated: '2002-02-02',
    });
  });

  it('omits optional fields a record does not carry', () => {
    const aa = registry.bySubtag.get('aa')?.[0];
    expect(aa).not.toHaveProperty('deprecated');
    expect(aa).not.toHaveProperty('preferredValue');
    expect(aa).not.toHaveProperty('macrolanguage');
    expect(aa).not.toHaveProperty('tag');
  });

  it('collects repeatable Description, Prefix and Comments in order', () => {
    expect(registry.bySubtag.get('latn')?.[0]?.descriptions).toEqual(['Latin', 'Roman alphabet']);
    expect(registry.bySubtag.get('sh')?.[0]?.prefixes).toEqual(['sr', 'hr']);
    expect(registry.bySubtag.get('aa')?.[0]).toMatchObject({
      descriptions: ['Afar'],
      prefixes: [],
      comments: [],
    });
  });

  it('folds a continuation line into the previous value with one space', () => {
    expect(registry.bySubtag.get('latn')?.[0]?.descriptions[1]).toBe('Roman alphabet');
    expect(registry.bySubtag.get('1901')?.[0]?.comments[0]).toBe(
      'Contact [email removed] for details',
    );
  });

  it('replaces email-shaped tokens in descriptions and comments', () => {
    expect(registry.bySubtag.get('sh')?.[0]?.comments[0]).toBe(
      'Sometimes written to [email removed] for corrections',
    );
    const withMail = parse(jar('Type: language\nSubtag: xx\nDescription: Mail person@example.org'));
    expect(withMail.records[0]?.descriptions).toEqual(['Mail [email removed]']);
  });

  it('indexes by lowercase subtag and keeps the registry casing on the record', () => {
    expect(registry.bySubtag.get('latn')?.[0]?.subtag).toBe('Latn');
    expect(registry.bySubtag.get('de')?.[0]?.subtag).toBe('DE');
    expect(registry.bySubtag.has('Latn')).toBe(false);
  });

  it('keeps every record registered under one subtag (a subtag shared across types)', () => {
    expect(registry.bySubtag.get('tw')?.map((record) => record.type)).toEqual([
      'language',
      'extlang',
    ]);
  });

  it('indexes whole-tag records by lowercase tag, outside bySubtag', () => {
    expect(registry.byTag.get('zh-hant')).toMatchObject({ type: 'redundant', tag: 'zh-Hant' });
    expect(registry.byTag.get('i-example')?.type).toBe('grandfathered');
    expect(registry.bySubtag.has('zh-hant')).toBe(false);
    expect(registry.byTag.size).toBe(2);
  });

  it('keeps private-use range records out of bySubtag and in ranges, lowercase', () => {
    expect(registry.ranges).toHaveLength(1);
    expect(registry.ranges[0]).toMatchObject({ start: 'qaa', end: 'qtz' });
    expect(registry.ranges[0]?.record.subtag).toBe('qaa..qtz');
    expect(registry.bySubtag.has('qaa..qtz')).toBe(false);
    expect(registry.bySubtag.has('qaa')).toBe(false);
    expect(registry.records.some((record) => record.subtag === 'qaa..qtz')).toBe(true);
  });

  it('builds search text over the descriptions only', () => {
    expect(registry.bySubtag.get('latn')?.[0]?.searchText).toBe(' latin roman alphabet ');
    expect(registry.bySubtag.get('sh')?.[0]?.searchText).toBe(' serbo croatian ');
  });

  it('parses CRLF line endings the same as LF', () => {
    const crlf = parse(LANGUAGE_REGISTRY_CRLF);
    expect(crlf.fileDate).toBe('2026-09-17');
    expect(crlf.records).toEqual(registry.records);
    expect(crlf.bySubtag.get('latn')?.[0]?.descriptions).toEqual(['Latin', 'Roman alphabet']);
  });
});

describe('record-jar edge cases', () => {
  it('keeps the first occurrence of a single-valued key', () => {
    const registry = parse(
      jar('Type: language\nSubtag: xx\nDescription: X\nAdded: 2001-01-01\nAdded: 2002-02-02'),
    );
    expect(registry.records[0]?.added).toBe('2001-01-01');
  });

  it('reads a registry with no File-Date', () => {
    const registry = parse('Header: none\n%%\nType: language\nSubtag: xx\nDescription: X\n');
    expect(registry).not.toHaveProperty('fileDate');
    expect(registry.records).toHaveLength(1);
  });

  it('ignores blank continuation lines and lines with no colon', () => {
    const registry = parse(
      jar('Type: language\nSubtag: xx\nDescription: X\n   \nnot a field\nAdded: 2001-01-01'),
    );
    expect(registry.records[0]).toMatchObject({ descriptions: ['X'], added: '2001-01-01' });
  });

  it('splits a value on the first colon only', () => {
    const registry = parse(jar('Type: language\nSubtag: xx\nDescription: Ratio 1:2 language'));
    expect(registry.records[0]?.descriptions).toEqual(['Ratio 1:2 language']);
  });

  it('omits an empty optional value', () => {
    const registry = parse(jar('Type: language\nSubtag: xx\nDescription: X\nDeprecated:'));
    expect(registry.records[0]).not.toHaveProperty('deprecated');
  });
});

describe('unreadable text', () => {
  it.each([
    ['an HTML page', '<html><body>Not found</body></html>'],
    ['an empty body', ''],
    ['a header with no records', 'File-Date: 2026-01-01\n'],
    ['only records of unknown type', jar('Type: mystery\nSubtag: zz')],
  ])('rejects %s as upstream_unreadable', (_name, text) => {
    let thrown: unknown;
    try {
      parse(text);
    } catch (error) {
      thrown = error;
    }
    const error = asMcpError(thrown);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', url: URL_ });
    expect(error.message).toContain('zero records');
  });
});
