/**
 * @fileoverview Tests for `iana_lookup_language_tag`: tag mode (`_` read as `-`,
 * grandfathered and redundant whole-tag records with a redundant match first in
 * `subtags[]`, well-formed versus valid, every `wrong_position` case, unknown
 * subtags as results, `canonical_tag` on valid tags only, `also_registered_as`
 * on single-subtag input), description mode (exact match ranked first, range
 * records, `limit`, the miss and truncation notices), the ignored-`subtag_type`
 * notice in tag mode, input validation (blank strings read as unset), the
 * declared error rows, the list-enrichment contract, and `format()` parity and
 * sanitizing. Upstream I/O is a `createFetchMock` fake behind the injected
 * `UpstreamClient`; every address in a fixture is invented.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupLanguageTag } from '@/mcp-server/tools/definitions/lookup-language-tag.tool.js';
import { LANGUAGE_REGISTRY_URL } from '@/services/registry/registry-store.js';
import {
  jar,
  LANGUAGE_TAG_EMAIL,
  LANGUAGE_TAGS_HOSTILE_TEXT,
  LANGUAGE_TAGS_TEXT,
} from '../fixtures/language-tags.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { missingFromText } from '../shared/format-parity.js';
import { callTool, setupTools } from '../shared/tool-harness.js';
import { htmlResponse, textResponse } from '../shared/upstream-harness.js';

type Out = Awaited<ReturnType<typeof callTool>>;

interface Part {
  position: string;
  registered: boolean;
  subtag: string;
}
interface Issue {
  kind: string;
  message: string;
  subtag: string;
}
interface Match {
  descriptions: string[];
  subtag: string;
  type: string;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function boot(text = LANGUAGE_TAGS_TEXT) {
  const s = setupTools();
  s.serve({ [LANGUAGE_REGISTRY_URL]: () => textResponse(text) });
  return s;
}

const call = (input: Record<string, unknown>) => callTool(lookupLanguageTag, input);
const subtags = (out: Out) => out.structured.subtags as Part[];
const issues = (out: Out) => out.structured.issues as Issue[];
const matches = (out: Out) => out.structured.matches as Match[];
const also = (out: Out) => out.structured.also_registered_as as Match[];
const positions = (out: Out) => subtags(out).map((part) => `${part.position}:${part.subtag}`);
const matched = (out: Out) => matches(out).map((match) => `${match.type}:${match.subtag}`);

describe('iana_lookup_language_tag: tag mode', () => {
  it('returns a redundant tag as its whole-tag record first, then the tag own subtags', async () => {
    boot();
    const out = await call({ tag: 'zh-Hant-TW' });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      mode: 'tag',
      tag_input: 'zh-Hant-TW',
      well_formed: true,
      valid: true,
      canonical_tag: 'zh-Hant-TW',
      subtags: [
        {
          subtag: 'zh-Hant-TW',
          position: 'redundant',
          registered: true,
          descriptions: ['Chinese written using the Traditional Chinese script in Taiwan'],
          added: '2005-04-11',
        },
        {
          subtag: 'zh',
          position: 'language',
          registered: true,
          descriptions: ['Chinese'],
          added: '2005-10-16',
          scope: 'macrolanguage',
        },
        {
          subtag: 'Hant',
          position: 'script',
          registered: true,
          descriptions: ['Han (Traditional variant)'],
        },
        { subtag: 'TW', position: 'region', registered: true, descriptions: ['Taiwan'] },
      ],
      issues: [],
      source: expect.objectContaining({
        registry_id: 'language-subtag-registry',
        url: LANGUAGE_REGISTRY_URL,
        registry_updated: '2026-09-17',
        stale: false,
      }),
      totalCount: 4,
      shown: 4,
      cap: 25,
      truncated: false,
    });
  });

  it.each([
    ['en_US', 'en-US'],
    ['  en_us ', 'en-us'],
    ['zh_Hant_TW', 'zh-Hant-TW'],
    ['EN_us', 'EN-us'],
  ])('reads %j as %j: underscores are hyphens, case is kept in tag_input', async (tag, read) => {
    boot();
    const out = await call({ tag });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ tag_input: read, well_formed: true, valid: true });
  });

  it('matches case-insensitively and answers in the registry position case', async () => {
    boot();
    const out = await call({ tag: 'ZH-hant-tw' });
    expect(positions(out)).toEqual([
      'redundant:zh-Hant-TW',
      'language:zh',
      'script:Hant',
      'region:TW',
    ]);
    expect(out.structured.canonical_tag).toBe('zh-Hant-TW');
  });

  it('answers a grandfathered tag as the whole answer, with its deprecation and preferred value', async () => {
    boot();
    const out = await call({ tag: 'i-klingon' });
    expect(out.structured).toMatchObject({
      well_formed: true,
      valid: true,
      canonical_tag: 'tlh',
      subtags: [
        {
          subtag: 'i-klingon',
          position: 'grandfathered',
          registered: true,
          descriptions: ['Klingon'],
          added: '1999-05-26',
          deprecated: '2004-02-24',
          preferred_value: 'tlh',
        },
      ],
      issues: [
        {
          subtag: 'i-klingon',
          kind: 'deprecated',
          message: 'i-klingon was deprecated on 2004-02-24; its preferred value is tlh.',
        },
      ],
      totalCount: 1,
      shown: 1,
    });
    expect(out.structured).not.toHaveProperty('also_registered_as');
  });

  it('puts a redundant match first and then parses, so a deprecated redundant tag canonicalizes to its Preferred-Value', async () => {
    boot();
    const out = await call({ tag: 'zh-yue' });
    expect(positions(out)).toEqual(['redundant:zh-yue', 'language:zh', 'extlang:yue']);
    expect(out.structured.canonical_tag).toBe('yue');
    expect(subtags(out)[0]).toMatchObject({ preferred_value: 'yue', deprecated: '2009-07-29' });
    expect(issues(out).map((issue) => issue.kind)).toEqual(['deprecated']);
  });

  it('reports a bare unregistered extension and private-use parts as unregistered subtags with no record fields', async () => {
    boot();
    const out = await call({ tag: 'en-US-a-bbb-x-priv' });
    expect(subtags(out).slice(2)).toEqual([
      { subtag: 'a-bbb', position: 'extension', registered: false, descriptions: [] },
      { subtag: 'x-priv', position: 'privateuse', registered: false, descriptions: [] },
    ]);
    expect(issues(out).map((issue) => issue.kind)).toEqual(['extension_not_validated']);
    expect(out.structured).toMatchObject({ valid: true, canonical_tag: 'en-US-a-bbb-x-priv' });
  });

  it('counts a private-use range as registered', async () => {
    boot();
    const out = await call({ tag: 'qaa-Qaaa-QM' });
    expect(subtags(out).map((part) => part.registered)).toEqual([true, true, true]);
    expect(subtags(out)[0]).toMatchObject({ descriptions: ['Private use'], scope: 'private-use' });
    expect(out.structured).toMatchObject({ valid: true, canonical_tag: 'qaa-Qaaa-QM' });
  });

  it('carries prefixes, macrolanguage, and Suppress-Script on the subtag records', async () => {
    boot();
    const out = await call({ tag: 'zh-cmn-Latn-pinyin' });
    expect(subtags(out)[1]).toMatchObject({
      subtag: 'cmn',
      position: 'extlang',
      prefixes: ['zh'],
      preferred_value: 'cmn',
      macrolanguage: 'zh',
    });
    expect(subtags(out)[3]).toMatchObject({ subtag: 'pinyin', prefixes: ['zh-Latn', 'bo-Latn'] });
    const en = await call({ tag: 'en' });
    expect(subtags(en)[0]).toMatchObject({ suppress_script: 'Latn' });
  });
});

describe('iana_lookup_language_tag: well-formed versus valid', () => {
  it('an unknown subtag is a result: well-formed, not valid, no canonical tag, never an error', async () => {
    boot();
    const out = await call({ tag: 'en-ZZ' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      mode: 'tag',
      well_formed: true,
      valid: false,
      issues: [{ subtag: 'ZZ', kind: 'unknown', message: 'ZZ is not a registered region subtag.' }],
    });
    expect(out.structured).not.toHaveProperty('canonical_tag');
    expect(subtags(out)[1]).toEqual({
      subtag: 'ZZ',
      position: 'region',
      registered: false,
      descriptions: [],
    });
  });

  it('a syntax failure is not well-formed and not valid', async () => {
    boot();
    const out = await call({ tag: 'en-Latn-US-xyz1' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ well_formed: false, valid: false });
    expect(out.structured).not.toHaveProperty('canonical_tag');
    expect(issues(out)).toHaveLength(1);
    expect(issues(out)[0]).toMatchObject({ subtag: 'xyz1', kind: 'wrong_position' });
    expect(out.structured).toMatchObject({ totalCount: 3, shown: 3 });
  });

  it.each([
    ['a script after the region', 'en-US-latn', 'latn', 'script subtag'],
    ['a second script', 'en-Latn-cyrl', 'cyrl', 'script subtag'],
    ['a second region', 'en-US-gb', 'gb', 'region subtag'],
    ['a region after a variant', 'de-1901-de', 'de', 'region subtag'],
    ['an extlang after the script', 'zh-Hant-cmn', 'cmn', 'extended language subtag'],
    ['a digit start', '1901-de', '1901', 'cannot start a tag'],
    ['a one-letter language', 'a-us', 'a', 'cannot start a tag'],
    ['a singleton with nothing after it', 'en-a', 'a', 'starts an extension'],
    ['a private-use x with nothing after it', 'en-x', 'x', 'starts a private-use sequence'],
    ['a subtag with no valid slot', 'en-xyz1', 'xyz1', 'does not fit any subtag position'],
  ])(
    '%s (%s): a wrong_position issue on %s, well_formed false',
    async (_label, tag, subtag, snippet) => {
      boot();
      const out = await call({ tag });
      expect(out.isError).toBe(false);
      expect(out.structured).toMatchObject({ well_formed: false, valid: false });
      expect(out.structured).not.toHaveProperty('canonical_tag');
      const wrong = issues(out).filter((issue) => issue.kind === 'wrong_position');
      expect(wrong).toHaveLength(1);
      expect(wrong[0]?.subtag).toBe(subtag);
      expect(wrong[0]?.message).toContain(snippet);
    },
  );

  it.each([
    ['a second extlang', 'zh-cmn-yue', 'yue'],
    ['an extlang after the wrong language', 'en-cmn', 'cmn'],
    ['a repeated variant', 'de-1901-1901', '1901'],
    ['a repeated extension singleton', 'en-a-bbb-a-ccc', 'a-ccc'],
  ])(
    '%s (%s): wrong_position on %s, still well-formed, invalid, no canonical tag',
    async (_label, tag, subtag) => {
      boot();
      const out = await call({ tag });
      expect(out.structured).toMatchObject({ well_formed: true, valid: false });
      expect(out.structured).not.toHaveProperty('canonical_tag');
      expect(issues(out).filter((issue) => issue.kind === 'wrong_position')).toMatchObject([
        { subtag },
      ]);
    },
  );

  it('stops parsing at the first subtag the grammar cannot place and says later ones were not checked', async () => {
    boot();
    const out = await call({ tag: 'en-US-latn-fonipa' });
    expect(positions(out)).toEqual(['language:en', 'region:US']);
    expect(issues(out)[0]?.message).toMatch(/ Subtags after it were not checked\.$/);
  });

  it('advisory issues do not invalidate the tag, and the canonical tag is still returned', async () => {
    boot();
    const out = await call({ tag: 'en-Latn' });
    expect(out.structured).toMatchObject({
      well_formed: true,
      valid: true,
      canonical_tag: 'en-Latn',
    });
    expect(issues(out).map((issue) => issue.kind)).toEqual(['suppress_script_redundant']);
    const mismatch = await call({ tag: 'en-1901' });
    expect(issues(mismatch).map((issue) => issue.kind)).toEqual(['variant_prefix_mismatch']);
    expect(mismatch.structured).toMatchObject({ valid: true, canonical_tag: 'en-1901' });
  });

  it('replaces a deprecated subtag in the canonical tag and still reports it', async () => {
    boot();
    const out = await call({ tag: 'iw-US' });
    expect(out.structured).toMatchObject({ valid: true, canonical_tag: 'he-US' });
    expect(issues(out)).toEqual([
      {
        subtag: 'iw',
        kind: 'deprecated',
        message: 'iw was deprecated on 1989-01-01; its preferred value is he.',
      },
    ]);
  });

  it('folds the extlang form into the canonical tag', async () => {
    boot();
    const out = await call({ tag: 'zh-cmn-Hans-CN' });
    expect(out.structured.canonical_tag).toBe('cmn-Hans-CN');
  });
});

describe('iana_lookup_language_tag: also_registered_as', () => {
  it('lists the other types registered under a single subtag', async () => {
    boot();
    const out = await call({ tag: 'TW' });
    expect(out.structured).toMatchObject({ valid: true, well_formed: true });
    expect(also(out)).toEqual([{ type: 'region', subtag: 'TW', descriptions: ['Taiwan'] }]);
    expect(out.structured).toMatchObject({ totalCount: 1, shown: 1 });
  });

  it('lists a script under a subtag unknown as a language, and points the issue at it', async () => {
    boot();
    const out = await call({ tag: 'Latn' });
    expect(out.structured).toMatchObject({ well_formed: true, valid: false });
    expect(also(out)).toMatchObject([{ type: 'script', subtag: 'Latn', descriptions: ['Latin'] }]);
    expect(issues(out)[0]?.message).toMatch(
      /It is registered as a script subtag; see also_registered_as\.$/,
    );
  });

  it('lists a region for a subtag that cannot start a tag', async () => {
    boot();
    const out = await call({ tag: '419' });
    expect(out.structured).toMatchObject({ well_formed: false, valid: false, subtags: [] });
    expect(also(out)).toMatchObject([{ type: 'region', subtag: '419' }]);
    expect(out.structured).toMatchObject({ totalCount: 0, shown: 0 });
  });

  it('lists a private-use range record that covers the subtag, with its range as the subtag', async () => {
    boot();
    const out = await call({ tag: 'XA' });
    expect(also(out)).toMatchObject([
      { type: 'region', subtag: 'XA..XZ', descriptions: ['Private use'] },
    ]);
  });

  it('is present and empty when no other type is registered', async () => {
    boot();
    const out = await call({ tag: 'en' });
    expect(out.structured).toHaveProperty('also_registered_as', []);
  });

  it('is absent for a multi-subtag input', async () => {
    boot();
    expect((await call({ tag: 'en-US' })).structured).not.toHaveProperty('also_registered_as');
    expect((await call({ tag: 'i-klingon' })).structured).not.toHaveProperty('also_registered_as');
  });
});

describe('iana_lookup_language_tag: description mode', () => {
  it('ranks an exact description match first, then registry order', async () => {
    boot();
    const out = await call({ description: 'Swiss German' });
    expect(out.isError).toBe(false);
    expect(matched(out)).toEqual(['language:gsw', 'language:sgg']);
    expect(matches(out)[0]).toEqual({
      type: 'language',
      subtag: 'gsw',
      descriptions: ['Swiss German', 'Alemannic', 'Alsatian'],
      added: '2006-03-08',
    });
    expect(out.structured).toMatchObject({
      mode: 'description',
      totalCount: 2,
      shown: 2,
      cap: 25,
      truncated: false,
    });
    expect(out.structured).not.toHaveProperty('notice');
    for (const key of ['tag_input', 'well_formed', 'valid', 'subtags', 'issues']) {
      expect(out.structured).not.toHaveProperty(key);
    }
  });

  it('ranks the exact match first across record types and keeps registry order after it', async () => {
    boot();
    const out = await call({ description: 'german' });
    expect(matched(out)).toEqual([
      'language:de',
      'language:sgg',
      'language:gsw',
      'variant:1901',
      'variant:1996',
    ]);
  });

  it('keeps registry order among several exact matches', async () => {
    boot();
    expect(matched(await call({ description: 'hebrew' }))).toEqual(['language:iw', 'language:he']);
  });

  it('folds case, whitespace, diacritics and punctuation, and matches tokens across Description values', async () => {
    boot();
    for (const description of ['  SWISS   german ', 'swiss-german', 'Swíss Germán']) {
      expect(matched(await call({ description }))).toEqual(['language:gsw', 'language:sgg']);
    }
    expect(matched(await call({ description: 'alsatian swiss' }))).toEqual(['language:gsw']);
    expect(matched(await call({ description: 'alemannic' }))).toEqual(['language:gsw']);
  });

  it('requires whole tokens: a partial word does not match', async () => {
    boot();
    expect(matched(await call({ description: 'swis' }))).toEqual([]);
  });

  it('returns whole-tag records with the tag as subtag', async () => {
    boot();
    const out = await call({ description: 'cantonese' });
    expect(matched(out)).toEqual(['language:yue', 'redundant:zh-yue']);
    expect(matches(out)[1]).toMatchObject({
      type: 'redundant',
      subtag: 'zh-yue',
      deprecated: '2009-07-29',
      preferred_value: 'yue',
    });
    const grandfathered = await call({ description: 'klingon', subtag_type: 'grandfathered' });
    expect(matches(grandfathered)).toMatchObject([
      { type: 'grandfathered', subtag: 'i-klingon', preferred_value: 'tlh' },
    ]);
  });

  it('returns range records, whose subtag reads as the range', async () => {
    boot();
    const out = await call({ description: 'private use' });
    expect(matched(out)).toEqual([
      'language:qaa..qtz',
      'script:Qaaa..Qabx',
      'region:QM..QZ',
      'region:XA..XZ',
    ]);
    expect(matches(out)[0]).toMatchObject({ descriptions: ['Private use'], scope: 'private-use' });
    expect(matched(await call({ description: 'private use', subtag_type: 'script' }))).toEqual([
      'script:Qaaa..Qabx',
    ]);
  });

  it('filters by subtag_type, case-insensitively', async () => {
    boot();
    for (const subtag_type of ['variant', 'Variant', ' VARIANT ']) {
      const out = await call({ description: 'german', subtag_type });
      expect(matched(out)).toEqual(['variant:1901', 'variant:1996']);
      expect(out.structured).toMatchObject({ totalCount: 2, shown: 2 });
    }
    expect(matched(await call({ description: 'chinese', subtag_type: 'extlang' }))).toEqual([
      'extlang:yue',
      'extlang:cmn',
      'extlang:nan',
    ]);
  });

  it('carries prefixes, comments, deprecation, and scope, with addresses in comments scrubbed', async () => {
    boot();
    const sh = (await call({ description: 'serbo croatian' })).structured.matches as Record<
      string,
      unknown
    >[];
    expect(sh[0]).toMatchObject({
      type: 'language',
      subtag: 'sh',
      deprecated: '2000-02-18',
      scope: 'macrolanguage',
      comments: ['Sometimes written to [email removed] for corrections'],
    });
    expect(sh[0]).not.toHaveProperty('preferred_value');
    expect(JSON.stringify(sh)).not.toContain(LANGUAGE_TAG_EMAIL);
    const pinyin = (await call({ description: 'pinyin romanization' })).structured
      .matches as Record<string, unknown>[];
    expect(pinyin[0]).toMatchObject({ prefixes: ['zh-Latn', 'bo-Latn'] });
  });

  it('cuts at limit with the exact match first, and discloses the full count and how to narrow', async () => {
    boot();
    const out = await call({ description: 'chinese', limit: 3 });
    expect(matched(out)).toEqual(['language:zh', 'language:yue', 'language:cmn']);
    expect(out.structured).toMatchObject({
      totalCount: 9,
      shown: 3,
      cap: 3,
      truncated: true,
      notice:
        'Showing 3 of 9 matching records; raise limit (max 100), add words to description, or set subtag_type to narrow.',
    });
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('puts the exact match on the first page when limit is 1', async () => {
    boot();
    expect(matched(await call({ description: 'german', limit: 1 }))).toEqual(['language:de']);
  });

  it('does not truncate when limit equals the match count', async () => {
    boot();
    const out = await call({ description: 'swiss german', limit: 2 });
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2, cap: 2, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('applies a digit-string limit', async () => {
    boot();
    expect((await call({ description: 'chinese', limit: '2' })).structured).toMatchObject({
      cap: 2,
      shown: 2,
      truncated: true,
    });
  });

  it('explains a miss, echoing the words on one line, and a miss under a type filter', async () => {
    boot();
    const out = await call({ description: 'zzzz\n   yyyy' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      mode: 'description',
      matches: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice:
        'No subtag description matched "zzzz yyyy". Try the language\'s English name or an alternative name.',
    });
    const typed = await call({ description: 'zzzz', subtag_type: 'script' });
    expect(typed.structured.notice).toBe(
      'No subtag description matched "zzzz" with type script. Try the language\'s English name or an alternative name.',
    );
    expect(typed.text).toContain(String(typed.structured.notice));
  });

  it('treats a type filter that excludes every match as a miss, not an error', async () => {
    boot();
    const out = await call({ description: 'swiss german', subtag_type: 'region' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ matches: [], totalCount: 0 });
    expect(String(out.structured.notice)).toContain('with type region');
  });
});

describe('iana_lookup_language_tag: limit and subtag_type in tag mode', () => {
  it('ignores limit: every part of the tag is returned, nothing is truncated', async () => {
    boot();
    const out = await call({ tag: 'zh-Hant-TW', limit: 2 });
    expect(subtags(out)).toHaveLength(4);
    expect(out.structured).toMatchObject({ totalCount: 4, shown: 4, cap: 2, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('says subtag_type was ignored, in both surfaces', async () => {
    boot();
    const out = await call({ tag: 'en-US', subtag_type: 'script' });
    expect(out.isError).toBe(false);
    expect(out.structured.notice).toBe(
      'subtag_type applies to description mode only; it was ignored for this tag lookup.',
    );
    expect(out.text).toContain(String(out.structured.notice));
    expect(positions(out)).toEqual(['language:en', 'region:US']);
  });

  it('gives no notice for a blank subtag_type', async () => {
    boot();
    const out = await call({ tag: 'en-US', subtag_type: '  ' });
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_lookup_language_tag: input validation', () => {
  it('reads blank optional inputs as unset: tag mode, default limit', async () => {
    boot();
    const out = await call({ tag: 'en', description: '', subtag_type: ' ', limit: ' ' });
    expect(out.structured).toMatchObject({ mode: 'tag', cap: 25, valid: true });
  });

  it('reads a blank tag as unset: description mode', async () => {
    boot();
    const out = await call({ tag: '   ', description: 'swiss german' });
    expect(out.structured).toMatchObject({ mode: 'description', totalCount: 2 });
  });

  it.each([
    ['a space inside the tag', { tag: 'en US' }],
    ['a doubled hyphen', { tag: 'en--US' }],
    ['a doubled underscore', { tag: 'en__US' }],
    ['a leading hyphen', { tag: '-en' }],
    ['a trailing hyphen', { tag: 'en-' }],
    ['a subtag over 8 characters', { tag: 'abcdefghi' }],
    ['a non-ASCII letter', { tag: 'zh-Hänt' }],
    ['a tag over 100 characters', { tag: `en-${'ab-'.repeat(33)}ab` }],
    ['a one-character description', { description: 'a' }],
    ['a description with no letter or digit', { description: '!!' }],
    ['a punctuation-only description', { description: '- - -' }],
    ['a description over 100 characters', { description: 'a'.repeat(101) }],
    ['an unknown subtag_type', { description: 'german', subtag_type: 'dialect' }],
    ['limit 0', { description: 'german', limit: 0 }],
    ['limit above 100', { description: 'german', limit: 101 }],
    ['a non-numeric limit', { description: 'german', limit: 'many' }],
  ])('rejects %s as invalid arguments, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(s.fetches()).toBe(0);
  });

  it('accepts 8-character subtags, a 100-character tag, and limit 100', async () => {
    boot();
    expect((await call({ tag: 'abcdefgh-ABCDEFGH' })).isError).toBe(false);
    const hundred = `${'abcdefgh-'.repeat(11)}a`;
    expect(hundred).toHaveLength(100);
    expect((await call({ tag: hundred })).isError).toBe(false);
    expect((await call({ tag: `${hundred}b` })).isError).toBe(true);
    expect((await call({ description: 'german', limit: 100 })).structured).toMatchObject({
      cap: 100,
    });
  });
});

describe('iana_lookup_language_tag: mode_required', () => {
  it.each([
    ['neither', {}],
    ['both', { tag: 'en', description: 'english' }],
    ['blank strings only', { tag: '', description: ' ' }],
    ['limit alone', { limit: 5 }],
    ['subtag_type alone', { subtag_type: 'script' }],
  ])('fails %s as mode_required with the recovery, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Pass exactly one of tag or description.',
      data: {
        reason: 'mode_required',
        recovery: {
          hint: 'Pass exactly one of tag or description to iana_lookup_language_tag.',
        },
      },
    });
    expect(out.text).toContain(
      'Recovery: Pass exactly one of tag or description to iana_lookup_language_tag.',
    );
    expect(s.fetches()).toBe(0);
  });
});

describe('iana_lookup_language_tag: list-enrichment contract', () => {
  it('zero-result page (description miss): counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ description: 'zzzz' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      matches: [],
      totalCount: 0,
      shown: 0,
      cap: 25,
      truncated: false,
    });
    expect(out.text).toContain('0 total');
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('zero-result page (a subtag nothing can place): counters parse with no subtags', async () => {
    boot();
    const out = await call({ tag: '1901-de' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      subtags: [],
      totalCount: 0,
      shown: 0,
      cap: 25,
      truncated: false,
    });
  });

  it('under-cap page (description): shown equals the match count and nothing is truncated', async () => {
    boot();
    const out = await call({ description: 'swiss german', limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2, cap: 10, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('under-cap page (tag): the subtag count is both totalCount and shown', async () => {
    boot();
    const out = await call({ tag: 'en-US' });
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2, cap: 25, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_lookup_language_tag: format()', () => {
  it('prints the tag verdict line, the issues, and every part with its record', async () => {
    boot();
    const out = await call({ tag: 'zh-Hant-TW' });
    expect(out.text).toContain(
      '**Mode:** tag · **Tag:** zh-Hant-TW · **Well-formed:** true · **Valid:** true · **Canonical tag:** zh-Hant-TW',
    );
    expect(out.text).toContain('### Issues\nNone.');
    expect(out.text).toContain('### zh-Hant-TW · redundant\n**Registered:** true');
    expect(out.text).toContain(
      '**Descriptions:** Chinese written using the Traditional Chinese script in Taiwan',
    );
    expect(out.text).toContain('### Hant · script');
    expect(out.text).toContain(
      '**Source:** `language-subtag-registry` · registry updated 2026-09-17',
    );
  });

  it('prints issues as list items with subtag, kind, and message', async () => {
    boot();
    const out = await call({ tag: 'en-ZZ' });
    expect(out.text).toContain('**Valid:** false');
    expect(out.text).not.toContain('**Canonical tag:**');
    expect(out.text).toContain('- ZZ · unknown: ZZ is not a registered region subtag.');
    expect(out.text).toContain('### ZZ · region\n**Registered:** false');
  });

  it('prints the also-registered-as records and the description matches', async () => {
    boot();
    const tw = await call({ tag: 'TW' });
    expect(tw.text).toContain('### Also registered as');
    expect(tw.text).toContain('#### TW · region');
    const swiss = await call({ description: 'swiss german' });
    expect(swiss.text).toContain('### gsw · language');
    expect(swiss.text).toContain('**Descriptions:** Swiss German; Alemannic; Alsatian');
    expect(swiss.text).toContain('**Added:** 2006-03-08');
    expect(swiss.text.indexOf('### gsw')).toBeLessThan(swiss.text.indexOf('### sgg'));
  });

  it('prints deprecation, preferred value, Suppress-Script, macrolanguage, scope, prefixes, and comments', async () => {
    boot();
    const sh = await call({ description: 'serbo croatian' });
    expect(sh.text).toContain(
      '**Added:** 2005-10-16 · **Deprecated:** 2000-02-18 · **Scope:** macrolanguage',
    );
    expect(sh.text).toContain(String.raw`> Sometimes written to \[email removed\] for corrections`);
    expect(sh.text).not.toContain(LANGUAGE_TAG_EMAIL);
    const pinyin = await call({ description: 'pinyin romanization' });
    expect(pinyin.text).toContain('**Prefixes:** zh-Latn, bo-Latn');
    const en = await call({ tag: 'en' });
    expect(en.text).toContain('**Suppress-Script:** Latn');
    const iw = await call({ tag: 'iw' });
    expect(iw.text).toContain('**Preferred value:** he');
    const yue = await call({ tag: 'yue' });
    expect(yue.text).toContain('**Macrolanguage:** zh');
  });

  it.each([
    ['a redundant tag', { tag: 'zh-Hant-TW' }],
    ['a grandfathered tag', { tag: 'i-klingon' }],
    ['an invalid tag', { tag: 'en-ZZ' }],
    ['a syntax failure', { tag: 'en-Latn-US-xyz1' }],
    ['a single subtag with other types', { tag: 'TW' }],
    ['a tag with extension and private use', { tag: 'en-US-a-bbb-x-priv' }],
    ['a private-use range', { tag: 'qaa-Qaaa-QM' }],
    ['a description page', { description: 'chinese', limit: 4 }],
    ['a range-record page', { description: 'private use' }],
    ['a description miss', { description: 'zzzz' }],
    ['a tag lookup with an ignored subtag_type', { tag: 'en', subtag_type: 'script' }],
  ])('carries every string and number of structuredContent: %s', async (_label, input) => {
    boot();
    const out = await call(input);
    expect(out.isError).toBe(false);
    expect(missingFromText(out.structured, out.text)).toEqual([]);
  });

  it('keeps hostile registry text verbatim in structuredContent and inert in format()', async () => {
    boot(LANGUAGE_TAGS_HOSTILE_TEXT);
    const out = await call({ description: 'evil' });
    expect(matches(out)).toHaveLength(1);
    const [record] = matches(out) as (Match & { comments: string[]; deprecated: string })[];
    expect(record?.descriptions).toEqual([
      'Evil [x](https://evil.example/) <b>x</b> \\ # Pwned\u202E\u0007',
      'Second\u2028# Heading Injected',
    ]);
    expect(record?.comments).toEqual(['Line one\rLine two']);
    expect(record?.deprecated).toBe('2001-01-01\r# Injected');

    const lines = out.text.split('\n');
    expect(lines.filter((line) => /^#{1,6} /.test(line))).toEqual(['### zzy · language']);
    expect(lines).toContain(
      String.raw`**Descriptions:** Evil \[x\](https://evil.example/) \<b\>x\</b\> \\ # Pwned; Second # Heading Injected`,
    );
    expect(lines).toContain('> Line one');
    expect(lines).toContain('> Line two');
    expect(out.text).not.toMatch(/[\r\u2028\u2029\u202E\u0007]/);
  });

  it('keeps CR/LF in upstream text out of the inline slots of a tag lookup', async () => {
    boot(LANGUAGE_TAGS_HOSTILE_TEXT);
    const out = await call({ tag: 'zzy' });
    expect(out.structured).toMatchObject({ valid: true, well_formed: true });
    const lines = out.text.split('\n');
    expect(lines.filter((line) => /^#{1,6} /.test(line))).toEqual([
      '### Issues',
      '### zzy · language',
    ]);
    expect(out.text).not.toMatch(/[\r\u2028\u2029\u202E\u0007]/);
    expect(lines.some((line) => line.startsWith('# '))).toBe(false);
    expect(lines.find((line) => line.startsWith('- zzy · deprecated'))).toContain(
      'zzy was deprecated on 2001-01-01 # Injected;',
    );
  });
});

describe('iana_lookup_language_tag: sparse registry', () => {
  it('reads a CRLF registry file', async () => {
    boot(LANGUAGE_TAGS_TEXT.replace(/\n/g, '\r\n'));
    const out = await call({ tag: 'en-US' });
    expect(out.structured).toMatchObject({ valid: true, canonical_tag: 'en-US' });
  });

  it('renders a record with no Description without inventing one', async () => {
    boot(
      jar([
        'Type: language\nSubtag: qq\nAdded: 2005-10-16\n',
        'Type: region\nSubtag: US\nDescription: United States',
      ]),
    );
    const out = await call({ tag: 'qq-US' });
    expect(subtags(out)[0]).toEqual({
      subtag: 'qq',
      position: 'language',
      registered: true,
      descriptions: [],
      added: '2005-10-16',
    });
    expect(out.text).toContain('### qq · language');
    expect(out.text).not.toContain('**Descriptions:** \n');
  });

  it('reads a registry of one language as having no other subtags', async () => {
    boot(jar(['Type: language\nSubtag: en\nDescription: English']));
    expect((await call({ tag: 'en-US' })).structured).toMatchObject({ valid: false });
    expect(also(await call({ tag: 'en' }))).toEqual([]);
  });
});

describeFailureContract({
  definition: lookupLanguageTag,
  input: { tag: 'en' },
  url: LANGUAGE_REGISTRY_URL,
  ok: () => textResponse(LANGUAGE_TAGS_TEXT),
  reason: 'upstream_unreadable',
  recovery:
    'The IANA language subtag registry could not be read; retry iana_lookup_language_tag shortly.',
  unreadable: [
    { label: 'an HTML page served as 200', attempts: 3, response: () => htmlResponse('<html/>') },
    {
      label: 'a text body with no records',
      attempts: 3,
      response: () => textResponse('Page not found\n'),
    },
    {
      label: 'a file with a header and no records',
      attempts: 3,
      response: () => textResponse(jar([])),
    },
  ],
});
