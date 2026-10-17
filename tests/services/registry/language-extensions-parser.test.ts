/**
 * @fileoverview Extension record-jar parser: RFC references, continuations,
 * complete-copy checks and explicit privacy allowlist.
 */
import { describe, expect, it } from 'vitest';
import { parseLanguageExtensions } from '@/services/registry/language-extensions-parser.js';
import { LANGUAGE_EXTENSIONS_URL } from '@/services/registry/registry-store.js';
import { LANGUAGE_EXTENSIONS_TEXT } from '../../fixtures/language-registry.js';

const parse = (text: string) => parseLanguageExtensions(text, LANGUAGE_EXTENSIONS_URL);

describe('Language Tag Extensions parser', () => {
  it.each(['\n', '\r\n'])(
    'reads both allocations and RFCs with %j separators, dropping contacts',
    (newline) => {
      const model = parse(LANGUAGE_EXTENSIONS_TEXT.replaceAll('\n', newline));
      expect([...model.bySingleton.values()]).toEqual([
        {
          singleton: 't',
          descriptions: ['Specifying Transformed Content'],
          authority: 'Unicode Consortium',
          references: [
            { type: 'rfc', id: 'RFC 6497', url: 'https://www.rfc-editor.org/rfc/rfc6497.html' },
          ],
        },
        {
          singleton: 'u',
          descriptions: ['Unicode Locale'],
          authority: 'Unicode Consortium',
          references: [
            { type: 'rfc', id: 'RFC 6067', url: 'https://www.rfc-editor.org/rfc/rfc6067.html' },
          ],
        },
      ]);
      expect(model.fileDate).toBe('2014-04-02');
      expect(JSON.stringify([...model.bySingleton.values()])).not.toMatch(
        /private|Contact|Mailing/,
      );
      expect(model.bySingleton.has('a')).toBe(false);
    },
  );
  it('folds only allowed continuation fields and withholds an email-shaped authority', () => {
    const model = parse(
      LANGUAGE_EXTENSIONS_TEXT.replace(
        'Description: Unicode Locale',
        'Description: Unicode\n  Locale',
      )
        .replaceAll('Authority: Unicode Consortium', 'Authority: name&example.org')
        .replaceAll(
          'Contact_Email: private&example.org',
          'Comments: Private Person\n  must not survive\nContact: Another Person\nURL: https://private.example.org\nContact_Email: private&example.org',
        ),
    );
    expect([...model.bySingleton.values()]).toEqual([
      {
        singleton: 't',
        descriptions: ['Specifying Transformed Content'],
        references: [
          { type: 'rfc', id: 'RFC 6497', url: 'https://www.rfc-editor.org/rfc/rfc6497.html' },
        ],
      },
      {
        singleton: 'u',
        descriptions: ['Unicode Locale'],
        references: [
          { type: 'rfc', id: 'RFC 6067', url: 'https://www.rfc-editor.org/rfc/rfc6067.html' },
        ],
      },
    ]);
  });
  it.each(['private@example.org', 'private&example.org'])(
    'withholds descriptions containing an email-shaped token: %s',
    (address) => {
      const model = parse(
        LANGUAGE_EXTENSIONS_TEXT.replace(
          'Description: Unicode Locale',
          `Description: Unicode Locale ${address}`,
        ),
      );
      expect(JSON.stringify([...model.bySingleton.values()])).not.toContain(address);
      expect(model.bySingleton.get('u')?.descriptions).toEqual(['[email removed]']);
    },
  );
  it.each(['t', 'u'])('rejects a copy missing the established %s allocation', (singleton) => {
    const records = LANGUAGE_EXTENSIONS_TEXT.split('%%');
    const incomplete = records
      .filter((record) => !record.includes(`Identifier: ${singleton}`))
      .join('%%');
    expect(() => parse(incomplete)).toThrow();
  });
  it.each([
    '',
    'hello',
    'File-Date: 2014-04-02\n%%\n',
    LANGUAGE_EXTENSIONS_TEXT.replace('[RFC6067]', 'RFC6067'),
    LANGUAGE_EXTENSIONS_TEXT.replace('Identifier: u', 'Identifier: x'),
    LANGUAGE_EXTENSIONS_TEXT.replace('Identifier: u', 'Identifier: t'),
    LANGUAGE_EXTENSIONS_TEXT.replace('File-Date: 2014-04-02\n', ''),
  ])('rejects an unusable copy instead of establishing nonallocation: %j', (text) => {
    expect(() => parse(text)).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'upstream_unreadable' }) }),
    );
  });
});
