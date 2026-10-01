/**
 * @fileoverview Synthetic Language Subtag Registry for tag analysis and
 * `iana_lookup_language_tag`: the subtags the RFC 5646 §2.1 grammar cases need
 * (languages with Suppress-Script, a deprecated language with and without a
 * Preferred-Value, extlangs with prefixes, scripts, regions, variants with
 * single and multi-subtag Prefix values, private-use ranges), a subtag shared by
 * three types (`tw` language, `TW` region), grandfathered and redundant
 * whole-tag records, and a hostile record whose text carries markdown, line
 * breaks, and bidi controls. Descriptions are shortened; addresses are invented.
 * @module tests/fixtures/language-tags
 */

/** One record-jar record from `Key: value` pairs; an array value repeats the key. */
export function jarRecord(fields: Record<string, string | readonly string[]>): string {
  return Object.entries(fields)
    .flatMap(([key, value]) =>
      (typeof value === 'string' ? [value] : value).map((item) => `${key}: ${item}`),
    )
    .join('\n');
}

/** A registry file from records: the `File-Date` header, then `%%`-separated records. */
export function jar(records: readonly string[], fileDate = '2026-09-17'): string {
  return `File-Date: ${fileDate}\n%%\n${records.join('\n%%\n')}\n`;
}

const language = (subtag: string, description: string | string[], extra = {}) =>
  jarRecord({ Type: 'language', Subtag: subtag, Description: description, ...extra });
const extlang = (subtag: string, description: string, prefix: string, extra = {}) =>
  jarRecord({
    Type: 'extlang',
    Subtag: subtag,
    Description: description,
    Prefix: prefix,
    'Preferred-Value': subtag,
    ...extra,
  });
const script = (subtag: string, description: string) =>
  jarRecord({ Type: 'script', Subtag: subtag, Description: description });
const region = (subtag: string, description: string) =>
  jarRecord({ Type: 'region', Subtag: subtag, Description: description });
const variant = (subtag: string, description: string, prefixes: string[] = []) =>
  jarRecord({
    Type: 'variant',
    Subtag: subtag,
    Description: description,
    ...(prefixes.length > 0 ? { Prefix: prefixes } : {}),
  });
const whole = (type: 'grandfathered' | 'redundant', tag: string, description: string, extra = {}) =>
  jarRecord({ Type: type, Tag: tag, Description: description, ...extra });

/** The records of {@link LANGUAGE_TAGS_TEXT}, in file order. */
export const LANGUAGE_TAG_RECORDS: readonly string[] = [
  language('en', 'English', { Added: '2005-10-16', 'Suppress-Script': 'Latn' }),
  language('de', 'German', { Added: '2005-10-16', 'Suppress-Script': 'Latn' }),
  language('sgg', 'Swiss-German Sign Language', { Added: '2009-07-29' }),
  language('gsw', ['Swiss German', 'Alemannic', 'Alsatian'], { Added: '2006-03-08' }),
  language('zh', 'Chinese', { Added: '2005-10-16', Scope: 'macrolanguage' }),
  language('yue', ['Yue Chinese', 'Cantonese'], { Added: '2009-07-29', Macrolanguage: 'zh' }),
  language('cmn', 'Mandarin Chinese', { Added: '2009-07-29', Macrolanguage: 'zh' }),
  language('sl', 'Slovenian', { Added: '2005-10-16' }),
  language('sr', 'Serbian', { Added: '2005-10-16', Macrolanguage: 'sh' }),
  language('sh', 'Serbo-Croatian', {
    Added: '2005-10-16',
    Deprecated: '2000-02-18',
    Comments: 'Sometimes written to person@example.org for corrections',
    Scope: 'macrolanguage',
  }),
  language('iw', 'Hebrew', {
    Added: '2005-10-16',
    Deprecated: '1989-01-01',
    'Preferred-Value': 'he',
  }),
  language('he', 'Hebrew', { Added: '2005-10-16' }),
  language('tw', 'Twi', { Added: '2005-10-16', Macrolanguage: 'ak' }),
  language('bo', 'Tibetan', { Added: '2005-10-16' }),
  language('sgn', 'Sign languages', { Added: '2005-10-16', Scope: 'collection' }),
  language('tlh', 'Klingon', { Added: '2005-10-16' }),
  language('jbo', 'Lojban', { Added: '2005-10-16' }),
  language('nan', 'Min Nan Chinese', { Added: '2009-07-29', Macrolanguage: 'zh' }),
  language('qaa..qtz', 'Private use', { Added: '2005-10-16', Scope: 'private-use' }),
  extlang('yue', 'Yue Chinese', 'zh', { Added: '2009-07-29', Macrolanguage: 'zh' }),
  extlang('cmn', 'Mandarin Chinese', 'zh', { Added: '2009-07-29', Macrolanguage: 'zh' }),
  extlang('nan', 'Min Nan Chinese', 'zh', { Added: '2009-07-29', Macrolanguage: 'zh' }),
  extlang('ase', 'American Sign Language', 'sgn', { Added: '2009-07-29' }),
  script('Latn', 'Latin'),
  script('Cyrl', 'Cyrillic'),
  script('Hans', 'Han (Simplified variant)'),
  script('Hant', 'Han (Traditional variant)'),
  jarRecord({ Type: 'script', Subtag: 'Qaaa..Qabx', Description: 'Private use' }),
  region('TW', 'Taiwan'),
  region('CN', 'China'),
  region('US', 'United States'),
  region('GB', 'United Kingdom'),
  region('CH', 'Switzerland'),
  region('DE', 'Germany'),
  region('419', 'Latin America and the Caribbean'),
  jarRecord({ Type: 'region', Subtag: 'QM..QZ', Description: 'Private use' }),
  jarRecord({ Type: 'region', Subtag: 'XA..XZ', Description: 'Private use' }),
  variant('1901', 'Traditional German orthography', ['de']),
  variant('1996', 'German orthography of 1996', ['de']),
  variant('rozaj', 'Resian', ['sl']),
  variant('biske', 'The San Giorgio dialect of Resian', ['sl-rozaj']),
  variant('fonipa', 'International Phonetic Alphabet'),
  variant('pinyin', 'Pinyin romanization', ['zh-Latn', 'bo-Latn']),
  whole('grandfathered', 'i-klingon', 'Klingon', {
    Added: '1999-05-26',
    Deprecated: '2004-02-24',
    'Preferred-Value': 'tlh',
  }),
  whole('grandfathered', 'art-lojban', 'Lojban', {
    Added: '2001-11-11',
    Deprecated: '2003-09-02',
    'Preferred-Value': 'jbo',
  }),
  whole('grandfathered', 'i-default', 'Default Language', { Added: '1998-03-10' }),
  whole('grandfathered', 'en-GB-oed', 'English, Oxford English Dictionary spelling', {
    Added: '2003-07-09',
    Deprecated: '2015-04-17',
    'Preferred-Value': 'en-GB-oxendict',
  }),
  whole('redundant', 'zh-Hant', 'Chinese written using the Traditional Chinese script', {
    Added: '2005-04-11',
  }),
  whole(
    'redundant',
    'zh-Hant-TW',
    'Chinese written using the Traditional Chinese script in Taiwan',
    {
      Added: '2005-04-11',
    },
  ),
  whole('redundant', 'sl-rozaj', 'Resian', { Added: '2005-10-16' }),
  whole('redundant', 'zh-yue', 'Cantonese', {
    Added: '2001-03-26',
    Deprecated: '2009-07-29',
    'Preferred-Value': 'yue',
  }),
];

/** The default registry text, LF line endings. */
export const LANGUAGE_TAGS_TEXT = jar(LANGUAGE_TAG_RECORDS);

/** A language record whose text is hostile to a markdown renderer. */
export const HOSTILE_LANGUAGE_RECORD = jarRecord({
  Type: 'language',
  Subtag: 'zzy',
  Description: [
    'Evil [x](https://evil.example/) <b>x</b> \\ # Pwned\u202E\u0007',
    'Second\u2028# Heading Injected',
  ],
  Added: '2005-10-16',
  Deprecated: '2001-01-01\r# Injected',
  Comments: 'Line one\rLine two',
});

/** The default registry plus {@link HOSTILE_LANGUAGE_RECORD}. */
export const LANGUAGE_TAGS_HOSTILE_TEXT = jar([...LANGUAGE_TAG_RECORDS, HOSTILE_LANGUAGE_RECORD]);

/** Invented contact data in the fixtures; none of it may reach a result. */
export const LANGUAGE_TAG_EMAIL = 'person@example.org';
