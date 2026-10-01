/**
 * @fileoverview BCP 47 (RFC 5646) language tag analysis over the parsed Language
 * Subtag Registry: the whole-tag grandfathered/redundant lookup, the §2.1
 * position grammar, per-subtag registration, deprecation, prefix, duplicate,
 * and Suppress-Script checks, and the canonical form of a valid tag. Pure: the
 * registry model is passed in, and an unknown subtag is an issue in the result,
 * never a throw.
 * @module services/registry/language-tag
 */

import type {
  LanguageRange,
  LanguageRecord,
  LanguageRegistry,
  LanguageSubtagType,
} from './types.js';

/** Where a subtag sits in a tag, or the whole-tag record that matched it. */
export type SubtagPosition =
  | 'language'
  | 'extlang'
  | 'script'
  | 'region'
  | 'variant'
  | 'extension'
  | 'privateuse'
  | 'grandfathered'
  | 'redundant';

/** What an issue reports. Only `unknown` and `wrong_position` make a tag invalid. */
export type TagIssueKind =
  | 'unknown'
  | 'deprecated'
  | 'wrong_position'
  | 'variant_prefix_mismatch'
  | 'suppress_script_redundant'
  | 'extension_not_validated';

/** One positioned part of the analyzed tag. */
export interface AnalyzedSubtag {
  position: SubtagPosition;
  /** The registry record (a range record for a private-use range). Absent when unregistered, and for extension and private-use parts. */
  record?: LanguageRecord;
  /** The subtag in its position's case; the whole sequence for an extension or private-use part. */
  subtag: string;
}

/** One finding about the tag. */
export interface TagIssue {
  kind: TagIssueKind;
  message: string;
  subtag: string;
}

/** The result of {@link analyzeLanguageTag}. */
export interface TagAnalysis {
  /** Records of other types registered under a single-subtag input. Absent for a multi-subtag input. */
  alsoRegisteredAs?: LanguageRecord[];
  /** The canonical form, set only when the tag is valid. */
  canonicalTag?: string;
  issues: TagIssue[];
  /** Parsed subtags in tag order; parsing stops at the first subtag the grammar cannot place. */
  subtags: AnalyzedSubtag[];
  valid: boolean;
  wellFormed: boolean;
}

/** Positions that are checked against the registry. */
type RegisteredPosition = 'language' | 'extlang' | 'script' | 'region' | 'variant';

const SHAPE = {
  language: /^[a-z]{2,8}$/,
  extlang: /^[a-z]{3}$/,
  script: /^[a-z]{4}$/,
  region: /^(?:[a-z]{2}|\d{3})$/,
  variant: /^(?:[a-z\d]{5,8}|\d[a-z\d]{3})$/,
  singleton: /^[\da-wyz]$/,
  extensionPart: /^[a-z\d]{2,8}$/,
} as const;

const POSITION_NAMES: Readonly<Record<RegisteredPosition, string>> = {
  language: 'language',
  extlang: 'extended language',
  script: 'script',
  region: 'region',
  variant: 'variant',
};

const INVALIDATING: ReadonlySet<TagIssueKind> = new Set(['unknown', 'wrong_position']);

/** The subtag in the case RFC 5646 §2.1.1 recommends for its position. */
function casing(subtag: string, position: SubtagPosition): string {
  if (position === 'script') return `${subtag.charAt(0).toUpperCase()}${subtag.slice(1)}`;
  if (position === 'region') return subtag.toUpperCase();
  return subtag;
}

function inRange(subtag: string, range: LanguageRange): boolean {
  return subtag.length === range.start.length && subtag >= range.start && subtag <= range.end;
}

/** The record registered for `subtag` (lowercase) as `type`, including private-use ranges. */
function lookup(
  registry: LanguageRegistry,
  subtag: string,
  type: LanguageSubtagType,
): LanguageRecord | undefined {
  return (
    registry.bySubtag.get(subtag)?.find((record) => record.type === type) ??
    registry.ranges.find((range) => range.record.type === type && inRange(subtag, range))?.record
  );
}

function deprecationIssue(subtag: string, record: LanguageRecord): TagIssue {
  const replacement = record.preferredValue
    ? `; its preferred value is ${record.preferredValue}`
    : '; it has no preferred replacement';
  return {
    subtag,
    kind: 'deprecated',
    message: `${subtag} was deprecated on ${record.deprecated}${replacement}.`,
  };
}

/**
 * Why a subtag that fits no slot at its position is misplaced, judged by the
 * shape of its lowercase form; the message keeps the caller's spelling.
 */
function misplacedReason(subtag: string): string {
  const lower = subtag.toLowerCase();
  if (SHAPE.script.test(lower)) {
    return `${subtag} has the shape of a script subtag, which must come directly after the language (or extended language) subtag.`;
  }
  if (SHAPE.region.test(lower)) {
    return `${subtag} has the shape of a region subtag, which must come after any script and before any variant.`;
  }
  if (SHAPE.extlang.test(lower)) {
    return `${subtag} has the shape of an extended language subtag, which may only follow a 2–3 letter language subtag.`;
  }
  if (SHAPE.variant.test(lower)) {
    return `${subtag} has the shape of a variant subtag, which must come after the region and before any extension or private-use part.`;
  }
  return `${subtag} does not fit any subtag position here: after the language come an optional script (4 letters), region (2 letters or 3 digits), variants (5–8 characters, or 4 starting with a digit), extensions (a singleton then 2–8 characters), and private use (x then 1–8 characters).`;
}

/**
 * True when every subtag of `prefix` appears in the tag before the variant, in
 * order, with the prefix's first subtag among the language and extlang subtags.
 */
function prefixMatches(prefix: string, preceding: readonly string[], languageEnd: number): boolean {
  const [head = '', ...rest] = prefix.toLowerCase().split('-');
  let at = preceding.slice(0, languageEnd).indexOf(head);
  if (at < 0) return false;
  for (const subtag of rest) {
    at = preceding.indexOf(subtag, at + 1);
    if (at < 0) return false;
  }
  return true;
}

/** The canonical form of a valid parsed langtag (RFC 5646 §4.5), Suppress-Script kept. */
function canonicalize(subtags: readonly AnalyzedSubtag[]): string {
  let language = '';
  let script = '';
  let region = '';
  const variants: string[] = [];
  const extensions: string[] = [];
  let privateUse = '';
  for (const { position, record, subtag } of subtags) {
    const preferred = record?.preferredValue ?? subtag;
    switch (position) {
      case 'language':
      case 'extlang':
        language = preferred.toLowerCase();
        break;
      case 'script':
        script = casing(preferred.toLowerCase(), 'script');
        break;
      case 'region':
        region = preferred.toUpperCase();
        break;
      case 'variant':
        variants.push(preferred.toLowerCase());
        break;
      case 'extension':
        extensions.push(subtag);
        break;
      case 'privateuse':
        privateUse = subtag;
        break;
      default:
        break;
    }
  }
  extensions.sort();
  return [language, script, region, ...variants, ...extensions, privateUse]
    .filter(Boolean)
    .join('-');
}

/**
 * Walks the §2.1 `langtag` / `privateuse` grammar over lowercase `parts`;
 * `original` holds the same parts as the caller cased them, for messages about
 * a subtag the grammar cannot place.
 */
function parseLangtag(
  parts: readonly string[],
  original: readonly string[],
  registry: LanguageRegistry,
  redundant: LanguageRecord | undefined,
): TagAnalysis {
  const subtags: AnalyzedSubtag[] = [];
  const issues: TagIssue[] = [];
  const part = (index: number) => parts[index] ?? '';
  let i = 0;

  if (redundant) {
    const tag = redundant.tag ?? parts.join('-');
    subtags.push({ subtag: tag, position: 'redundant', record: redundant });
    if (redundant.deprecated) issues.push(deprecationIssue(tag, redundant));
  }

  const misplaced = (at: number, reason: (subtag: string) => string): TagAnalysis => {
    const subtag = original[at] ?? '';
    const rest = at < parts.length - 1 ? ' Subtags after it were not checked.' : '';
    issues.push({ subtag, kind: 'wrong_position', message: `${reason(subtag)}${rest}` });
    return { subtags, issues, wellFormed: false, valid: false };
  };

  const add = (raw: string, position: RegisteredPosition): LanguageRecord | undefined => {
    const subtag = casing(raw, position);
    const record = lookup(registry, raw, position);
    subtags.push({ subtag, position, ...(record ? { record } : {}) });
    if (!record) {
      const reserved =
        position === 'language' && raw.length === 4
          ? ' Four-letter language subtags are reserved.'
          : '';
      issues.push({
        subtag,
        kind: 'unknown',
        message: `${subtag} is not a registered ${POSITION_NAMES[position]} subtag.${reserved}`,
      });
    } else if (record.deprecated) {
      issues.push(deprecationIssue(subtag, record));
    }
    return record;
  };

  let languageRecord: LanguageRecord | undefined;
  let script: string | undefined;
  if (part(0) !== 'x') {
    const language = part(0);
    if (!SHAPE.language.test(language)) {
      return misplaced(
        0,
        (subtag) =>
          `${subtag} cannot start a tag: a tag starts with a language subtag of 2–8 letters, or with x for a private-use tag.`,
      );
    }
    languageRecord = add(language, 'language');
    i = 1;

    const extlangLimit = language.length <= 3 ? 4 : 1;
    while (i < extlangLimit && SHAPE.extlang.test(part(i))) {
      const raw = part(i);
      const record = add(raw, 'extlang');
      const prefix = record?.prefixes[0];
      if (i > 1) {
        issues.push({
          subtag: raw,
          kind: 'wrong_position',
          message: `Only one extended language subtag is permitted; ${raw} sits in a permanently reserved position.`,
        });
      } else if (prefix && prefix.toLowerCase() !== language) {
        issues.push({
          subtag: raw,
          kind: 'wrong_position',
          message: `${raw} is an extended language subtag for ${prefix}; it cannot follow ${language}.`,
        });
      }
      i++;
    }
    const languageEnd = i;

    if (SHAPE.script.test(part(i))) {
      script = part(i);
      add(script, 'script');
      i++;
    }
    if (SHAPE.region.test(part(i))) {
      add(part(i), 'region');
      i++;
    }

    const variants = new Set<string>();
    for (; SHAPE.variant.test(part(i)); i++) {
      const raw = part(i);
      const record = add(raw, 'variant');
      const preceding = parts.slice(0, i);
      if (variants.has(raw)) {
        issues.push({
          subtag: raw,
          kind: 'wrong_position',
          message: `${raw} appears more than once; a variant may appear only once in a tag.`,
        });
      } else if (
        record &&
        record.prefixes.length > 0 &&
        !record.prefixes.some((prefix) => prefixMatches(prefix, preceding, languageEnd))
      ) {
        issues.push({
          subtag: raw,
          kind: 'variant_prefix_mismatch',
          message: `${raw} is registered for use after ${record.prefixes.join(' or ')}; here it follows ${preceding.join('-')}.`,
        });
      }
      variants.add(raw);
    }

    const singletons = new Set<string>();
    while (SHAPE.singleton.test(part(i))) {
      const start = i;
      const singleton = part(start);
      i++;
      while (SHAPE.extensionPart.test(part(i))) i++;
      if (i === start + 1) {
        return misplaced(
          start,
          (subtag) =>
            `${subtag} starts an extension and must be followed by at least one subtag of 2–8 letters or digits.`,
        );
      }
      const sequence = parts.slice(start, i).join('-');
      subtags.push({ subtag: sequence, position: 'extension' });
      if (singletons.has(singleton)) {
        issues.push({
          subtag: sequence,
          kind: 'wrong_position',
          message: `The extension singleton ${singleton} appears more than once; each singleton may appear only once in a tag.`,
        });
      }
      issues.push({
        subtag: sequence,
        kind: 'extension_not_validated',
        message: `Extension ${sequence} is checked for syntax only; its content is defined by the extension's own specification.`,
      });
      singletons.add(singleton);
    }
  }

  if (part(i) === 'x') {
    if (i === parts.length - 1) {
      return misplaced(
        i,
        (subtag) =>
          `${subtag} starts a private-use sequence and must be followed by at least one subtag of 1–8 letters or digits.`,
      );
    }
    subtags.push({ subtag: parts.slice(i).join('-'), position: 'privateuse' });
    i = parts.length;
  }
  if (i < parts.length) return misplaced(i, misplacedReason);

  const suppress = languageRecord?.suppressScript;
  if (script && suppress?.toLowerCase() === script) {
    const language = part(0);
    issues.push({
      subtag: casing(script, 'script'),
      kind: 'suppress_script_redundant',
      message: `${suppress} is the Suppress-Script of ${language}; tags for ${language} normally omit it.`,
    });
  }

  const valid = !issues.some((issue) => INVALIDATING.has(issue.kind));
  const canonicalTag = !valid
    ? undefined
    : (redundant?.preferredValue ??
      canonicalize(subtags.filter((s) => s.position !== 'redundant')));
  return { subtags, issues, wellFormed: true, valid, ...(canonicalTag ? { canonicalTag } : {}) };
}

/** Records of every type except `parsedType` registered under one subtag, ranges included. */
function otherTypes(
  registry: LanguageRegistry,
  subtag: string,
  parsedType: LanguageSubtagType | undefined,
): LanguageRecord[] {
  return [
    ...(registry.bySubtag.get(subtag) ?? []).filter((record) => record.type !== parsedType),
    ...registry.ranges
      .filter((range) => range.record.type !== parsedType && inRange(subtag, range))
      .map((range) => range.record),
  ];
}

/**
 * Analyzes a hyphen-separated tag (underscores already converted). A
 * grandfathered or redundant whole-tag record matches first; a grandfathered tag
 * is then complete, and a redundant one is also parsed subtag by subtag.
 */
export function analyzeLanguageTag(tag: string, registry: LanguageRegistry): TagAnalysis {
  const lower = tag.toLowerCase();
  const parts = lower.split('-');
  const whole = registry.byTag.get(lower);

  if (whole?.type === 'grandfathered') {
    const registered = whole.tag ?? tag;
    return {
      subtags: [{ subtag: registered, position: 'grandfathered', record: whole }],
      issues: whole.deprecated ? [deprecationIssue(registered, whole)] : [],
      wellFormed: true,
      valid: true,
      canonicalTag: whole.preferredValue ?? registered,
    };
  }

  const analysis = parseLangtag(parts, tag.split('-'), registry, whole);
  if (parts.length !== 1) return analysis;

  const subtag = parts[0] ?? '';
  const parsedType = analysis.subtags[0]?.position === 'language' ? 'language' : undefined;
  const others = otherTypes(registry, subtag, parsedType);
  const first = analysis.issues[0];
  if (others.length > 0 && first && (first.kind === 'unknown' || first.kind === 'wrong_position')) {
    const types = [...new Set(others.map((record) => record.type))].join(' and ');
    first.message = `${first.message} It is registered as a ${types} subtag; see also_registered_as.`;
  }
  return { ...analysis, alsoRegisteredAs: others };
}
