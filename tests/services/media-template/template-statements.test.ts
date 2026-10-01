/**
 * @fileoverview Tests for `extractTemplateStatements`: the three labels (plain,
 * numbered, spaced before the colon), the extent rule (a blank line, another
 * label line, or 300 characters), the line filter (email-shaped tokens in the
 * `@`, `mailto:` and `&` forms, and contact-word openers), and the three
 * template layouts the design names. Every person and address in a fixture is
 * invented.
 */

import { describe, expect, it } from 'vitest';
import {
  extractTemplateStatements,
  STATEMENT_MAX_CHARS,
} from '@/services/media-template/template-statements.js';
import {
  TEMPLATE_BARE,
  TEMPLATE_HOSTILE,
  TEMPLATE_LABELLED,
  TEMPLATE_NO_LABELS,
  TEMPLATE_NUMBERED,
  TEMPLATE_PERSON_MARKERS,
} from '../../fixtures/media-registry.js';

const extract = extractTemplateStatements;

describe('extractTemplateStatements: the three template layouts', () => {
  it('reads the labelled layout, stopping at the next label and at blank lines', () => {
    expect(extract(TEMPLATE_LABELLED)).toEqual({
      fileExtensions: '.json',
      intendedUsage: 'COMMON',
      deprecatedAliases: 'n/a',
    });
  });

  it('reads the numbered vendor layout: numbered labels, a space before the colon, a continuation line', () => {
    expect(extract(TEMPLATE_NUMBERED)).toEqual({
      fileExtensions: 'kml\nand sometimes kmz',
      intendedUsage: 'COMMON',
      deprecatedAliases: 'none',
    });
  });

  it('reads the bare Name/Email layout without taking its head lines or the Author line', () => {
    expect(extract(TEMPLATE_BARE)).toEqual({
      fileExtensions: 'ex1',
      intendedUsage: 'LIMITED USE',
    });
  });

  it.each([
    ['Intended usage:\n   Limited Use', { intendedUsage: 'Limited Use' }],
    ['File extension(s):\n   Not Applicable', { fileExtensions: 'Not Applicable' }],
    ['Intended usage: COMMON\n   Example Person', { intendedUsage: 'COMMON' }],
  ])(
    'keeps a Title-Case statement word on a continuation line, still dropping a name: %j',
    (text, expected) => {
      expect(extract(text)).toEqual(expected);
    },
  );

  it.each([
    ['labelled', TEMPLATE_LABELLED],
    ['numbered', TEMPLATE_NUMBERED],
    ['bare', TEMPLATE_BARE],
    ['hostile', TEMPLATE_HOSTILE],
  ])('the %s layout yields no invented person name or address', (_layout, text) => {
    const statements = JSON.stringify(extract(text));
    for (const marker of TEMPLATE_PERSON_MARKERS) expect(statements).not.toContain(marker);
  });

  it('returns an empty object when the template carries none of the three labels', () => {
    expect(extract(TEMPLATE_NO_LABELS)).toEqual({});
    expect(extract('')).toEqual({});
  });
});

describe('extractTemplateStatements: label matching', () => {
  it.each([
    ['File extension(s): a', 'a'],
    ['File extension: a', 'a'],
    ['File extensions: a', 'a'],
    ['FILE EXTENSION(S): a', 'a'],
    ['file extension(s) : a', 'a'],
    ['   File extension(s):   a  ', 'a'],
    ['2. File extension(s) : a', 'a'],
    ['12.File extension(s): a', 'a'],
  ])('matches the file-extension label in %j', (line, expected) => {
    expect(extract(line)).toEqual({ fileExtensions: expected });
  });

  it('matches the other two labels case-insensitively, with numbering and a spaced colon', () => {
    expect(extract('3. INTENDED USAGE : COMMON')).toEqual({ intendedUsage: 'COMMON' });
    expect(extract('intended usage:limited use')).toEqual({ intendedUsage: 'limited use' });
    expect(extract('4. Deprecated alias names for this type : x/y')).toEqual({
      deprecatedAliases: 'x/y',
    });
  });

  it('does not match a label that is not at the start of its line', () => {
    expect(extract('See the File extension(s): .json entry')).toEqual({});
    expect(extract('The Intended usage: is COMMON')).toEqual({});
  });

  it('does not match other labels or near-miss labels', () => {
    expect(extract('Magic number(s): n/a')).toEqual({});
    expect(extract('File extensions list: .json')).toEqual({});
    expect(extract('Intended usages: COMMON')).toEqual({});
    expect(extract('File extension (s): .json')).toEqual({});
  });

  it('takes the first occurrence when a label repeats', () => {
    expect(extract('File extension(s): first\n\nFile extension(s): second')).toEqual({
      fileExtensions: 'first',
    });
  });

  it('reads all three labels from one template in any order', () => {
    const text =
      'Intended usage: COMMON\n\nDeprecated alias names for this type: old/x\n\nFile extension(s): .x';
    expect(extract(text)).toEqual({
      intendedUsage: 'COMMON',
      deprecatedAliases: 'old/x',
      fileExtensions: '.x',
    });
  });

  it('reads a value that starts on the line after an empty label', () => {
    expect(extract('File extension(s):\n   .png\n   .apng\n\nIntended usage: COMMON')).toEqual({
      fileExtensions: '.png\n.apng',
      intendedUsage: 'COMMON',
    });
  });

  it('yields no statement for a label whose value is empty and followed by a blank line', () => {
    expect(extract('File extension(s):\n\n.png')).toEqual({});
    expect(extract('Intended usage:   ')).toEqual({});
  });
});

describe('extractTemplateStatements: extent', () => {
  it('stops at a blank line', () => {
    expect(extract('File extension(s): .a\n   .b\n\n   .c')).toEqual({ fileExtensions: '.a\n.b' });
  });

  it('stops at a whitespace-only line', () => {
    expect(extract('File extension(s): .a\n   \n   .b')).toEqual({ fileExtensions: '.a' });
  });

  it('stops at another label line, with or without numbering', () => {
    expect(extract('File extension(s): .a\n   .b\nMagic number(s): n/a\n   more')).toEqual({
      fileExtensions: '.a\n.b',
    });
    expect(extract('1. File extension(s): .a\n2. Required parameters: none')).toEqual({
      fileExtensions: '.a',
    });
    expect(extract('File extension(s): .a\nPerson & email address to contact: x')).toEqual({
      fileExtensions: '.a',
    });
  });

  it('keeps a continuation line that has no colon', () => {
    expect(extract('Intended usage: COMMON\n   and widely deployed')).toEqual({
      intendedUsage: 'COMMON\nand widely deployed',
    });
  });

  it('runs to the end of the text when nothing ends the statement', () => {
    expect(extract('Intended usage: COMMON\n   line two\n   line three')).toEqual({
      intendedUsage: 'COMMON\nline two\nline three',
    });
  });

  it('cuts a statement at 300 characters, and keeps exactly 300', () => {
    expect(STATEMENT_MAX_CHARS).toBe(300);
    expect(extract(`File extension(s): ${'x'.repeat(300)}`).fileExtensions).toBe('x'.repeat(300));
    expect(extract(`File extension(s): ${'x'.repeat(301)}`).fileExtensions).toBe('x'.repeat(300));
    expect(extract(`File extension(s): ${'x'.repeat(5_000)}`).fileExtensions).toHaveLength(300);
  });

  it('counts the 300 characters across continuation lines, newlines included', () => {
    const text = `Intended usage: ${'a'.repeat(250)}\n   ${'b'.repeat(100)}`;
    const statement = extract(text).intendedUsage ?? '';
    expect(statement).toBe(`${'a'.repeat(250)}\n${'b'.repeat(49)}`);
    expect(statement).toHaveLength(300);
  });

  it('counts characters, not UTF-16 units', () => {
    const statement = extract(`File extension(s): ${'😀'.repeat(310)}`).fileExtensions ?? '';
    expect(Array.from(statement)).toHaveLength(300);
    expect(statement).toBe('😀'.repeat(300));
  });

  it('reads CRLF, bare CR and LF line endings alike', () => {
    const expected = { fileExtensions: '.a\n.b', intendedUsage: 'COMMON' };
    for (const eol of ['\r\n', '\r', '\n']) {
      const text = ['File extension(s): .a', '   .b', '', 'Intended usage: COMMON'].join(eol);
      expect(extract(text)).toEqual(expected);
    }
  });
});

describe('extractTemplateStatements: line filter', () => {
  it.each([
    ['an @ address', 'File extension(s): .a, ask person@example.org'],
    ['a mailto: link', 'File extension(s): .a mailto:person@example.org'],
    ['a mailto: link without an address', 'File extension(s): .a, see mailto:someone'],
    ["IANA's & substitution", 'File extension(s): .a, ask person&example.org'],
    ['a bare @', 'File extension(s): .a @ example'],
  ])('drops a one-line statement holding %s, leaving the label absent', (_label, line) => {
    expect(extract(line)).toEqual({});
  });

  it('drops only the offending line of a multi-line statement', () => {
    expect(
      extract('Intended usage: COMMON\n   contact&example.org\n   and widely deployed'),
    ).toEqual({ intendedUsage: 'COMMON\nand widely deployed' });
    expect(extract('Intended usage: COMMON\n   ask person@example.org\n   more')).toEqual({
      intendedUsage: 'COMMON\nmore',
    });
  });

  it('keeps an ampersand that is not between word characters', () => {
    expect(extract('Intended usage: COMMON & LIMITED')).toEqual({
      intendedUsage: 'COMMON & LIMITED',
    });
  });

  it.each([
    'Person to ask',
    'Contact the maintainers',
    'Author unknown',
    'Name of the format',
    'Email the list',
    'E-mail the list',
    'Change controller is the IETF',
    'CONTACT the maintainers',
    '  contact the maintainers',
  ])('drops a continuation line opening with a contact word: %j', (line) => {
    expect(extract(`Intended usage: COMMON\n   ${line}\n   and widely deployed`)).toEqual({
      intendedUsage: 'COMMON\nand widely deployed',
    });
  });

  it('drops a value on the label line itself when it opens with a contact word', () => {
    expect(extract('Intended usage: Contact the maintainers')).toEqual({});
    expect(extract('Intended usage: Contact the maintainers\n   COMMON')).toEqual({
      intendedUsage: 'COMMON',
    });
  });

  it('keeps a line that merely mentions a contact word', () => {
    expect(extract('Intended usage: used by the contact app\n   an author tool')).toEqual({
      intendedUsage: 'used by the contact app\nan author tool',
    });
  });

  it('drops a numbered continuation line opening with a contact word', () => {
    expect(extract('Intended usage: COMMON\n   2. Contact the maintainers')).toEqual({
      intendedUsage: 'COMMON',
    });
  });

  it('removes a statement entirely when every line is filtered, keeping the other labels', () => {
    const text =
      'File extension(s): contact&example.org\n   Contact the list\n\nIntended usage: COMMON';
    expect(extract(text)).toEqual({ intendedUsage: 'COMMON' });
  });

  it('filters lines before the 300-character cut, so a dropped label line cannot use up the budget', () => {
    expect(extract(`File extension(s): .a, ask person&example.org\n   ${'y'.repeat(400)}`)).toEqual(
      {
        fileExtensions: 'y'.repeat(300),
      },
    );
  });

  it('drops a label line that holds an email-shaped token past the 300th character', () => {
    expect(extract(`File extension(s): ${'x'.repeat(290)} ping person&example.org`)).toEqual({});
  });

  it('reads a numbered label with a spaced colon followed by a bare-name line', () => {
    expect(extract('2. File extension(s) : kml\n   Example Person')).toEqual({
      fileExtensions: 'kml',
    });
  });

  it('drops continuation lines made only of two to four capitalized name words', () => {
    expect(
      extract("File extension(s): .a\n   J. Example\n   Mary-Ann O'Example\n   Mac OS X"),
    ).toEqual({ fileExtensions: '.a\nMac OS X' });
    expect(extract('File extension(s):\n   Example Person\n   .kml')).toEqual({
      fileExtensions: '.kml',
    });
  });

  it('never name-filters the label line itself', () => {
    expect(extract('Intended usage: Example Person')).toEqual({ intendedUsage: 'Example Person' });
  });

  it('keeps a continuation line that is not a bare name', () => {
    expect(extract('Intended usage: COMMON\n   Authorized use only')).toEqual({
      intendedUsage: 'COMMON\nAuthorized use only',
    });
  });

  it('matches contact words as whole words', () => {
    expect(extract('Intended usage: COMMON\n   Authors x')).toEqual({ intendedUsage: 'COMMON' });
    expect(extract('Intended usage: COMMON\n   Contacting the list is optional')).toEqual({
      intendedUsage: 'COMMON\nContacting the list is optional',
    });
  });

  it('applies the filter to a statement of the hostile layout, keeping markdown-looking lines verbatim', () => {
    expect(extract(TEMPLATE_HOSTILE)).toEqual({
      fileExtensions:
        '.evil\n# Forged heading\n- forged item\n[x](https://evil.example/)\n<b>bold</b>\u{202E}\u0007',
      intendedUsage: 'COMMON',
    });
  });
});
