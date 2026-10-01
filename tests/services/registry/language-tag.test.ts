/**
 * @fileoverview Tests for `analyzeLanguageTag`, a pure function over the parsed
 * Language Subtag Registry: grandfathered and redundant whole-tag records, the
 * RFC 5646 §2.1 grammar (every syntax failure as `wrong_position` on the first
 * subtag the grammar cannot place), per-subtag registration, deprecation,
 * Suppress-Script and variant Prefix checks, private-use ranges, extensions,
 * `also_registered_as` on single-subtag input, and the canonical form (valid
 * tags only).
 */

import { describe, expect, it } from 'vitest';
import { parseLanguageRegistry } from '@/services/registry/language-registry-parser.js';
import { analyzeLanguageTag, type TagAnalysis } from '@/services/registry/language-tag.js';
import { LANGUAGE_TAGS_TEXT } from '../../fixtures/language-tags.js';

const registry = parseLanguageRegistry(
  LANGUAGE_TAGS_TEXT,
  'https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry',
);
const analyze = (tag: string) => analyzeLanguageTag(tag, registry);

/** `position:subtag` per parsed part. */
const parts = (analysis: TagAnalysis) =>
  analysis.subtags.map(({ position, subtag }) => `${position}:${subtag}`);
const kinds = (analysis: TagAnalysis) => analysis.issues.map((issue) => issue.kind);

describe('analyzeLanguageTag: grandfathered tags', () => {
  it('answers a deprecated grandfathered tag as one complete record with its preferred value', () => {
    const analysis = analyze('i-klingon');
    expect(parts(analysis)).toEqual(['grandfathered:i-klingon']);
    expect(analysis.subtags[0]?.record).toBe(registry.byTag.get('i-klingon'));
    expect(analysis).toMatchObject({ wellFormed: true, valid: true, canonicalTag: 'tlh' });
    expect(analysis.issues).toEqual([
      {
        subtag: 'i-klingon',
        kind: 'deprecated',
        message: 'i-klingon was deprecated on 2004-02-24; its preferred value is tlh.',
      },
    ]);
    expect(analysis).not.toHaveProperty('alsoRegisteredAs');
  });

  it('matches case-insensitively and reports the tag as the registry spells it', () => {
    expect(parts(analyze('I-KLINGON'))).toEqual(['grandfathered:i-klingon']);
    expect(parts(analyze('en-gb-OED'))).toEqual(['grandfathered:en-GB-oed']);
  });

  it('canonicalizes to the whole-tag Preferred-Value', () => {
    expect(analyze('art-lojban').canonicalTag).toBe('jbo');
    expect(analyze('en-GB-oed').canonicalTag).toBe('en-GB-oxendict');
  });

  it('keeps the tag itself as canonical when the record has no Preferred-Value, with no issues', () => {
    const analysis = analyze('i-default');
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'i-default', issues: [] });
  });
});

describe('analyzeLanguageTag: redundant tags', () => {
  it('puts the whole-tag record first, then the tag own subtags', () => {
    const analysis = analyze('zh-Hant-TW');
    expect(parts(analysis)).toEqual([
      'redundant:zh-Hant-TW',
      'language:zh',
      'script:Hant',
      'region:TW',
    ]);
    expect(analysis.subtags[0]?.record).toBe(registry.byTag.get('zh-hant-tw'));
    expect(analysis.subtags[1]?.record?.subtag).toBe('zh');
    expect(analysis).toMatchObject({
      wellFormed: true,
      valid: true,
      canonicalTag: 'zh-Hant-TW',
      issues: [],
    });
  });

  it('matches the whole tag in any case and reads the registry casing', () => {
    expect(parts(analyze('ZH-hant-tw'))).toEqual([
      'redundant:zh-Hant-TW',
      'language:zh',
      'script:Hant',
      'region:TW',
    ]);
  });

  it('reports a deprecated redundant tag once and canonicalizes to its Preferred-Value', () => {
    const analysis = analyze('zh-yue');
    expect(parts(analysis)).toEqual(['redundant:zh-yue', 'language:zh', 'extlang:yue']);
    expect(analysis.issues).toEqual([
      {
        subtag: 'zh-yue',
        kind: 'deprecated',
        message: 'zh-yue was deprecated on 2009-07-29; its preferred value is yue.',
      },
    ]);
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'yue' });
  });

  it('checks a redundant variant tag against its Prefix like any other', () => {
    const analysis = analyze('sl-rozaj');
    expect(parts(analysis)).toEqual(['redundant:sl-rozaj', 'language:sl', 'variant:rozaj']);
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'sl-rozaj', issues: [] });
  });

  it('does not set also_registered_as for a multi-subtag input', () => {
    expect(analyze('zh-Hant')).not.toHaveProperty('alsoRegisteredAs');
  });
});

describe('analyzeLanguageTag: valid tags and casing', () => {
  it('analyzes a bare language', () => {
    const analysis = analyze('en');
    expect(parts(analysis)).toEqual(['language:en']);
    expect(analysis.subtags[0]?.record?.descriptions).toEqual(['English']);
    expect(analysis).toMatchObject({
      wellFormed: true,
      valid: true,
      canonicalTag: 'en',
      issues: [],
      alsoRegisteredAs: [],
    });
  });

  it('normalizes case per position: language lower, Script title, REGION upper', () => {
    const analysis = analyze('EN-us');
    expect(parts(analysis)).toEqual(['language:en', 'region:US']);
    expect(analysis.canonicalTag).toBe('en-US');
    expect(parts(analyze('zh-hANT-cn'))).toEqual(['language:zh', 'script:Hant', 'region:CN']);
    expect(analyze('zh-hANT-cn').canonicalTag).toBe('zh-Hant-CN');
  });

  it('keeps variants in order, lowercase', () => {
    const analysis = analyze('DE-1901-1996');
    expect(parts(analysis)).toEqual(['language:de', 'variant:1901', 'variant:1996']);
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'de-1901-1996', issues: [] });
  });

  it('replaces the language with the extlang Preferred-Value (prefix dropped)', () => {
    const analysis = analyze('zh-cmn-Hans-CN');
    expect(parts(analysis)).toEqual(['language:zh', 'extlang:cmn', 'script:Hans', 'region:CN']);
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'cmn-Hans-CN', issues: [] });
    expect(analyze('sgn-ase').canonicalTag).toBe('ase');
  });

  it('replaces a deprecated subtag with its Preferred-Value and reports the deprecation', () => {
    const analysis = analyze('iw-US');
    expect(analysis.canonicalTag).toBe('he-US');
    expect(analysis.issues).toEqual([
      {
        subtag: 'iw',
        kind: 'deprecated',
        message: 'iw was deprecated on 1989-01-01; its preferred value is he.',
      },
    ]);
  });

  it('keeps a deprecated subtag without a Preferred-Value and says so', () => {
    const analysis = analyze('sh');
    expect(analysis.canonicalTag).toBe('sh');
    expect(analysis.issues).toEqual([
      {
        subtag: 'sh',
        kind: 'deprecated',
        message: 'sh was deprecated on 2000-02-18; it has no preferred replacement.',
      },
    ]);
    expect(analysis.valid).toBe(true);
  });

  it('reports a redundant Suppress-Script as advisory and keeps the script in the canonical tag', () => {
    const analysis = analyze('en-Latn');
    expect(analysis.issues).toEqual([
      {
        subtag: 'Latn',
        kind: 'suppress_script_redundant',
        message: 'Latn is the Suppress-Script of en; tags for en normally omit it.',
      },
    ]);
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'en-Latn' });
    expect(kinds(analyze('zh-Latn'))).toEqual([]);
  });
});

describe('analyzeLanguageTag: unknown subtags are results', () => {
  it.each([
    ['en-ZZ', 'ZZ', 'ZZ is not a registered region subtag.'],
    ['en-Zzzz', 'Zzzz', 'Zzzz is not a registered script subtag.'],
    ['en-zzzzz', 'zzzzz', 'zzzzz is not a registered variant subtag.'],
    ['zh-yuf', 'yuf', 'yuf is not a registered extended language subtag.'],
    ['ww', 'ww', 'ww is not a registered language subtag.'],
    ['abcde-US', 'abcde', 'abcde is not a registered language subtag.'],
  ])('%s: an unregistered subtag is an unknown issue, not a throw', (tag, subtag, message) => {
    const analysis = analyze(tag);
    expect(analysis.wellFormed).toBe(true);
    expect(analysis.valid).toBe(false);
    expect(analysis).not.toHaveProperty('canonicalTag');
    expect(analysis.issues[0]).toEqual({ subtag, kind: 'unknown', message });
  });

  it('keeps an unregistered subtag in subtags[] without a record', () => {
    const analysis = analyze('en-ZZ');
    expect(parts(analysis)).toEqual(['language:en', 'region:ZZ']);
    expect(analysis.subtags[1]).not.toHaveProperty('record');
  });

  it('reports every unknown subtag, in order', () => {
    expect(analyze('en-Zzzz-ZZ').issues.map((issue) => issue.subtag)).toEqual(['Zzzz', 'ZZ']);
  });

  it('notes that four-letter language subtags are reserved', () => {
    expect(analyze('abcd-US').issues[0]?.message).toBe(
      'abcd is not a registered language subtag. Four-letter language subtags are reserved.',
    );
  });

  it('makes a tag invalid only through unknown and wrong_position', () => {
    for (const tag of ['en-Latn', 'iw', 'en-a-bbb', 'en-1901']) {
      expect(analyze(tag).valid).toBe(true);
    }
    expect(analyze('en-1901').canonicalTag).toBe('en-1901');
  });
});

describe('analyzeLanguageTag: private-use ranges count as registered', () => {
  it('matches a language inside qaa..qtz, bounds included', () => {
    expect(analyze('QTZ').valid).toBe(true);
    const analysis = analyze('qaa');
    expect(analysis.subtags[0]?.record?.subtag).toBe('qaa..qtz');
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'qaa' });
  });

  it('rejects a language just outside the range, and a four-letter one inside the letters', () => {
    expect(analyze('qua').valid).toBe(false);
    expect(analyze('qaaa-US').issues[0]?.kind).toBe('unknown');
  });

  it('matches script and region ranges, each by its own length', () => {
    const analysis = analyze('qaa-Qaaa-QM');
    expect(parts(analysis)).toEqual(['language:qaa', 'script:Qaaa', 'region:QM']);
    expect(analysis.subtags.every((subtag) => subtag.record !== undefined)).toBe(true);
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'qaa-Qaaa-QM', issues: [] });
    expect(analyze('en-Qabx').valid).toBe(true);
    expect(analyze('en-Qaby').valid).toBe(false);
    expect(analyze('en-XA').valid).toBe(true);
    expect(analyze('en-XZ').valid).toBe(true);
    expect(analyze('en-QL').valid).toBe(false);
  });
});

describe('analyzeLanguageTag: also_registered_as on single-subtag input', () => {
  it('lists the other types registered under the subtag', () => {
    const analysis = analyze('tw');
    expect(analysis.valid).toBe(true);
    expect(analysis.alsoRegisteredAs?.map((record) => `${record.type}:${record.subtag}`)).toEqual([
      'region:TW',
    ]);
    expect(analyze('TW').alsoRegisteredAs?.map((record) => record.type)).toEqual(['region']);
    expect(analyze('de').alsoRegisteredAs?.map((record) => record.type)).toEqual(['region']);
    expect(analyze('yue').alsoRegisteredAs?.map((record) => record.type)).toEqual(['extlang']);
  });

  it('is empty, but present, when the subtag has no other type', () => {
    expect(analyze('en')).toHaveProperty('alsoRegisteredAs', []);
  });

  it('lists the other type of a subtag that is unknown as a language, and says so in the issue', () => {
    const analysis = analyze('Latn');
    expect(analysis.valid).toBe(false);
    expect(analysis.wellFormed).toBe(true);
    expect(analysis.alsoRegisteredAs?.map((record) => `${record.type}:${record.subtag}`)).toEqual([
      'script:Latn',
    ]);
    expect(analysis.issues).toEqual([
      {
        subtag: 'latn',
        kind: 'unknown',
        message:
          'latn is not a registered language subtag. Four-letter language subtags are reserved. It is registered as a script subtag; see also_registered_as.',
      },
    ]);
  });

  it('includes a private-use range record that covers the subtag', () => {
    const analysis = analyze('XA');
    expect(analysis.alsoRegisteredAs?.map((record) => `${record.type}:${record.subtag}`)).toEqual([
      'region:XA..XZ',
    ]);
    expect(analysis.issues[0]?.message).toContain('It is registered as a region subtag');
  });

  it('lists a region for a subtag that cannot start a tag', () => {
    const analysis = analyze('419');
    expect(analysis).toMatchObject({ wellFormed: false, valid: false });
    expect(parts(analysis)).toEqual([]);
    expect(analysis.alsoRegisteredAs?.map((record) => record.subtag)).toEqual(['419']);
    expect(analysis.issues).toHaveLength(1);
    expect(analysis.issues[0]).toMatchObject({ kind: 'wrong_position', subtag: '419' });
    expect(analysis.issues[0]?.message).toMatch(/^419 cannot start a tag/);
    expect(analysis.issues[0]?.message).toMatch(
      /It is registered as a region subtag; see also_registered_as\.$/,
    );
  });

  it('is absent for a multi-subtag input', () => {
    expect(analyze('en-US')).not.toHaveProperty('alsoRegisteredAs');
    expect(analyze('i-klingon')).not.toHaveProperty('alsoRegisteredAs');
  });
});

describe('analyzeLanguageTag: syntax failures are wrong_position on the first unplaceable subtag', () => {
  it.each([
    [
      'a script after the region',
      'en-US-latn',
      'latn',
      'latn has the shape of a script subtag, which must come directly after the language (or extended language) subtag.',
      ['language:en', 'region:US'],
    ],
    [
      'a second script',
      'en-Latn-cyrl',
      'cyrl',
      'cyrl has the shape of a script subtag, which must come directly after the language (or extended language) subtag.',
      ['language:en', 'script:Latn'],
    ],
    [
      'a second region',
      'en-US-gb',
      'gb',
      'gb has the shape of a region subtag, which must come after any script and before any variant.',
      ['language:en', 'region:US'],
    ],
    [
      'a region after a variant',
      'de-1901-de',
      'de',
      'de has the shape of a region subtag, which must come after any script and before any variant.',
      ['language:de', 'variant:1901'],
    ],
    [
      'an extlang after the script',
      'zh-Hant-cmn',
      'cmn',
      'cmn has the shape of an extended language subtag, which may only follow a 2–3 letter language subtag.',
      ['language:zh', 'script:Hant'],
    ],
    [
      'an extlang after a language longer than three letters',
      'abcde-xyz',
      'xyz',
      'xyz has the shape of an extended language subtag, which may only follow a 2–3 letter language subtag.',
      ['language:abcde'],
    ],
    [
      'a variant-shaped subtag where a script cannot go',
      'en-US-fonipa-latn',
      'latn',
      'latn has the shape of a script subtag, which must come directly after the language (or extended language) subtag.',
      ['language:en', 'region:US', 'variant:fonipa'],
    ],
  ])(
    '%s (%s): wrong_position on %s, parsing stops, not well-formed',
    (_label, tag, subtag, message, kept) => {
      const analysis = analyze(tag);
      expect(analysis).toMatchObject({ wellFormed: false, valid: false });
      expect(analysis).not.toHaveProperty('canonicalTag');
      expect(parts(analysis)).toEqual(kept);
      const misplaced = analysis.issues.filter((issue) => issue.kind === 'wrong_position');
      expect(misplaced).toHaveLength(1);
      expect(misplaced[0]?.subtag).toBe(subtag);
      expect(misplaced[0]?.message).toBe(message);
    },
  );

  it('names the shape of a misplaced subtag the caller wrote in its usual case (Latn, GB)', () => {
    expect(analyze('en-US-Latn').issues[0]?.message).toContain('has the shape of a script subtag');
    expect(analyze('en-US-GB').issues[0]?.message).toContain('has the shape of a region subtag');
  });

  it('says what the shape of a subtag with no valid slot is', () => {
    const analysis = analyze('en-Latn-US-xyz1');
    expect(analysis).toMatchObject({ wellFormed: false, valid: false });
    expect(parts(analysis)).toEqual(['language:en', 'script:Latn', 'region:US']);
    expect(analysis.issues).toEqual([
      {
        subtag: 'xyz1',
        kind: 'wrong_position',
        message:
          'xyz1 does not fit any subtag position here: after the language come an optional script (4 letters), region (2 letters or 3 digits), variants (5–8 characters, or 4 starting with a digit), extensions (a singleton then 2–8 characters), and private use (x then 1–8 characters).',
      },
    ]);
  });

  it('adds that later subtags were not checked when any follow', () => {
    const analysis = analyze('en-Latn-US-xyz1-fonipa');
    expect(analysis.issues[0]?.message).toMatch(/ Subtags after it were not checked\.$/);
    expect(parts(analysis)).toEqual(['language:en', 'script:Latn', 'region:US']);
    expect(analyze('en-US-Latn').issues[0]?.message).not.toContain('not checked');
  });

  it('echoes the misplaced subtag in the case the caller wrote it', () => {
    expect(analyze('en-us-LATN').issues[0]?.subtag).toBe('LATN');
  });

  it.each([
    ['a digit start', '1901-de'],
    ['a one-letter start', 'a-b'],
    ['a nine-letter language', 'abcdefghi'],
  ])('%s cannot start a tag', (_label, tag) => {
    const analysis = analyze(tag);
    expect(analysis).toMatchObject({ wellFormed: false, valid: false });
    expect(parts(analysis)).toEqual([]);
    expect(analysis.issues).toHaveLength(1);
    expect(analysis.issues[0]?.kind).toBe('wrong_position');
    expect(analysis.issues[0]?.message).toContain('cannot start a tag');
  });

  it('keeps the unplaceable-subtag report from also listing a grammar-position error for the language', () => {
    const analysis = analyze('abcde-xyz');
    expect(kinds(analysis)).toEqual(['unknown', 'wrong_position']);
  });
});

describe('analyzeLanguageTag: invalid but well-formed (parsing continues)', () => {
  it('flags a second extlang as wrong_position and keeps it in subtags[]', () => {
    const analysis = analyze('zh-cmn-yue');
    expect(parts(analysis)).toEqual(['language:zh', 'extlang:cmn', 'extlang:yue']);
    expect(analysis).toMatchObject({ wellFormed: true, valid: false });
    expect(analysis).not.toHaveProperty('canonicalTag');
    expect(analysis.issues).toEqual([
      {
        subtag: 'yue',
        kind: 'wrong_position',
        message:
          'Only one extended language subtag is permitted; yue sits in a permanently reserved position.',
      },
    ]);
  });

  it('flags a third extlang as well', () => {
    const analysis = analyze('zh-cmn-yue-nan');
    expect(analysis).toMatchObject({ wellFormed: true, valid: false });
    expect(analysis.issues.map((issue) => issue.subtag)).toEqual(['yue', 'nan']);
    expect(parts(analysis)).toEqual(['language:zh', 'extlang:cmn', 'extlang:yue', 'extlang:nan']);
    expect(analysis.issues.every((issue) => issue.kind === 'wrong_position')).toBe(true);
  });

  it('stops at a fourth extlang: the grammar cannot place it', () => {
    const analysis = analyze('zh-cmn-yue-nan-ase');
    expect(analysis.wellFormed).toBe(false);
    expect(analysis.issues.map((issue) => issue.subtag)).toEqual(['yue', 'nan', 'ase']);
    expect(analysis.issues.at(-1)?.message).toBe(
      'ase has the shape of an extended language subtag, which may only follow a 2–3 letter language subtag.',
    );
    expect(parts(analysis)).toEqual(['language:zh', 'extlang:cmn', 'extlang:yue', 'extlang:nan']);
  });

  it('flags an extlang that follows the wrong language', () => {
    const analysis = analyze('en-cmn');
    expect(analysis).toMatchObject({ wellFormed: true, valid: false });
    expect(analysis.issues).toEqual([
      {
        subtag: 'cmn',
        kind: 'wrong_position',
        message: 'cmn is an extended language subtag for zh; it cannot follow en.',
      },
    ]);
    expect(analyze('zh-ase').issues[0]?.message).toBe(
      'ase is an extended language subtag for sgn; it cannot follow zh.',
    );
  });

  it('accepts an extlang after its own prefix, case-insensitively', () => {
    expect(analyze('ZH-CMN').valid).toBe(true);
    expect(analyze('sgn-ase').valid).toBe(true);
  });

  it('flags a repeated variant', () => {
    const analysis = analyze('de-1901-1901');
    expect(analysis).toMatchObject({ wellFormed: true, valid: false });
    expect(analysis.issues).toEqual([
      {
        subtag: '1901',
        kind: 'wrong_position',
        message: '1901 appears more than once; a variant may appear only once in a tag.',
      },
    ]);
  });
});

describe('analyzeLanguageTag: variant Prefix matching', () => {
  it.each([
    'de-1901',
    'de-DE-1901',
    'sl-rozaj-biske',
    'en-fonipa',
    'zh-Latn-pinyin',
    'bo-Latn-pinyin',
    'zh-cmn-Latn-pinyin',
  ])('%s: the Prefix matches, no issue', (tag) => {
    expect(kinds(analyze(tag))).toEqual([]);
    expect(analyze(tag).valid).toBe(true);
  });

  it.each([
    ['en-1901', '1901 is registered for use after de; here it follows en.'],
    ['sl-biske', 'biske is registered for use after sl-rozaj; here it follows sl.'],
    ['zh-pinyin', 'pinyin is registered for use after zh-Latn or bo-Latn; here it follows zh.'],
    [
      'zh-Hant-pinyin',
      'pinyin is registered for use after zh-Latn or bo-Latn; here it follows zh-hant.',
    ],
    [
      'yue-Latn-pinyin',
      'pinyin is registered for use after zh-Latn or bo-Latn; here it follows yue-latn.',
    ],
    ['en-DE-1901', '1901 is registered for use after de; here it follows en-de.'],
  ])('%s: a Prefix mismatch is an advisory variant_prefix_mismatch', (tag, message) => {
    const analysis = analyze(tag);
    expect(analysis.issues).toHaveLength(1);
    expect(analysis.issues[0]).toMatchObject({ kind: 'variant_prefix_mismatch', message });
    expect(analysis.wellFormed).toBe(true);
    expect(analysis.valid).toBe(true);
    expect(analysis.canonicalTag).toBeDefined();
  });

  it('requires the Prefix head to be the language or extlang, not a region that spells it', () => {
    expect(kinds(analyze('en-DE-1901'))).toEqual(['variant_prefix_mismatch']);
    expect(kinds(analyze('de-DE-1901'))).toEqual([]);
  });
});

describe('analyzeLanguageTag: extensions and private use', () => {
  it('reads an extension as one part, syntax-checked only', () => {
    const analysis = analyze('en-a-bbb-ccc');
    expect(parts(analysis)).toEqual(['language:en', 'extension:a-bbb-ccc']);
    expect(analysis.subtags[1]).not.toHaveProperty('record');
    expect(analysis.issues).toEqual([
      {
        subtag: 'a-bbb-ccc',
        kind: 'extension_not_validated',
        message:
          "Extension a-bbb-ccc is checked for syntax only; its content is defined by the extension's own specification.",
      },
    ]);
    expect(analysis).toMatchObject({ valid: true, canonicalTag: 'en-a-bbb-ccc' });
  });

  it('accepts a digit singleton', () => {
    expect(parts(analyze('en-1-abc'))).toEqual(['language:en', 'extension:1-abc']);
  });

  it('sorts extensions by singleton in the canonical tag', () => {
    const analysis = analyze('en-b-ddd-a-bbb');
    expect(parts(analysis)).toEqual(['language:en', 'extension:b-ddd', 'extension:a-bbb']);
    expect(analysis.canonicalTag).toBe('en-a-bbb-b-ddd');
  });

  it('flags a repeated singleton as wrong_position, keeping the second extension', () => {
    const analysis = analyze('en-a-bbb-a-ccc');
    expect(analysis).toMatchObject({ wellFormed: true, valid: false });
    expect(analysis.issues.map((issue) => `${issue.kind}:${issue.subtag}`)).toEqual([
      'extension_not_validated:a-bbb',
      'wrong_position:a-ccc',
      'extension_not_validated:a-ccc',
    ]);
    expect(analysis.issues[1]?.message).toBe(
      'The extension singleton a appears more than once; each singleton may appear only once in a tag.',
    );
  });

  it.each([
    ['en-a', 'a'],
    ['en-a-b', 'a'],
  ])(
    '%s: a singleton with no 2–8 character subtag after it is wrong_position on %s',
    (tag, subtag) => {
      const analysis = analyze(tag);
      expect(analysis).toMatchObject({ wellFormed: false, valid: false });
      expect(analysis.issues).toHaveLength(1);
      expect(analysis.issues[0]).toMatchObject({ kind: 'wrong_position', subtag });
      expect(analysis.issues[0]?.message).toContain(
        'starts an extension and must be followed by at least one subtag of 2–8 letters or digits.',
      );
      expect(parts(analysis)).toEqual(['language:en']);
    },
  );

  it('reads private use as one part with no record, after the extensions', () => {
    const analysis = analyze('en-US-a-bbb-x-priv-use');
    expect(parts(analysis)).toEqual([
      'language:en',
      'region:US',
      'extension:a-bbb',
      'privateuse:x-priv-use',
    ]);
    expect(analysis.subtags[3]).not.toHaveProperty('record');
    expect(analysis.canonicalTag).toBe('en-US-a-bbb-x-priv-use');
  });

  it('accepts a private-use-only tag', () => {
    const analysis = analyze('X-Foo-Bar');
    expect(parts(analysis)).toEqual(['privateuse:x-foo-bar']);
    expect(analysis).toMatchObject({
      wellFormed: true,
      valid: true,
      canonicalTag: 'x-foo-bar',
      issues: [],
    });
    expect(analysis).not.toHaveProperty('alsoRegisteredAs');
  });

  it('accepts private use after a private-use language', () => {
    expect(analyze('qaa-x-foo').canonicalTag).toBe('qaa-x-foo');
  });

  it.each(['x', 'en-x'])('%s: x with nothing after it is wrong_position', (tag) => {
    const analysis = analyze(tag);
    expect(analysis).toMatchObject({ wellFormed: false, valid: false });
    expect(analysis.issues).toHaveLength(1);
    expect(analysis.issues[0]).toMatchObject({ kind: 'wrong_position', subtag: 'x' });
    expect(analysis.issues[0]?.message).toContain(
      'starts a private-use sequence and must be followed by at least one subtag',
    );
  });
});

describe('analyzeLanguageTag: canonical form', () => {
  it('is set only when the tag is valid', () => {
    for (const tag of ['en-ZZ', 'en-US-Latn', 'zh-cmn-yue', 'en-a-bbb-a-ccc', 'de-1901-1901']) {
      expect(analyze(tag).valid).toBe(false);
      expect(analyze(tag)).not.toHaveProperty('canonicalTag');
    }
    for (const tag of ['en', 'zh-Hant-TW', 'i-klingon', 'x-foo', 'iw', 'en-Latn']) {
      expect(analyze(tag).canonicalTag).toBeTypeOf('string');
    }
  });

  it('folds the extlang form and a deprecated language together', () => {
    expect(analyze('zh-cmn-Hant').canonicalTag).toBe('cmn-Hant');
    expect(analyze('iw-US').canonicalTag).toBe('he-US');
  });
});
