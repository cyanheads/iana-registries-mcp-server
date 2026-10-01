/**
 * @fileoverview `iana_lookup_language_tag` — parses and validates a BCP 47
 * language tag against the IANA Language Subtag Registry subtag by subtag, or
 * searches subtag records by description. An unknown or misplaced subtag is a
 * result (`valid: false` plus an issue), never an error.
 * @module mcp-server/tools/definitions/lookup-language-tag
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { analyzeLanguageTag } from '@/services/registry/language-tag.js';
import { getRegistryStore } from '@/services/registry/registry-store.js';
import { compileQuery, matchesQuery, normalizeForSearch } from '@/services/registry/search-text.js';
import type { LanguageRecord } from '@/services/registry/types.js';
import { startCallBudget } from '@/services/upstream/call-budget.js';
import {
  discloseList,
  echo,
  exactFirst,
  offsetIgnored,
  offsetListEnrichment,
  offsetPage,
} from '../shared/list-enrichment.js';
import { inline, joinLines, quote, sourceLines } from '../shared/markdown.js';
import {
  blankAsUnset,
  limitInput,
  offsetInput,
  SourceSchema,
  searchWords,
} from '../shared/schemas.js';

/** Hyphen-separated subtags of 1–8 letters or digits (underscores are converted first). */
const TAG_PATTERN = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

const RECORD_TYPES = [
  'language',
  'extlang',
  'script',
  'region',
  'variant',
  'grandfathered',
  'redundant',
] as const;

/** Registry fields every returned record carries. */
const recordFields = {
  descriptions: z.array(z.string()).describe('Description values; empty when unregistered.'),
  added: z.string().optional().describe('Date added, YYYY-MM-DD.'),
  deprecated: z
    .string()
    .optional()
    .describe('Date deprecated, YYYY-MM-DD; still valid, but prefer preferred_value.'),
  preferred_value: z.string().optional().describe('The subtag or tag to use instead.'),
  suppress_script: z
    .string()
    .optional()
    .describe('Script subtag this language normally omits, e.g. "Latn".'),
  macrolanguage: z.string().optional().describe('Encompassing macrolanguage, e.g. "zh".'),
  scope: z.string().optional().describe('macrolanguage, collection, special, or private-use.'),
  prefixes: z
    .array(z.string())
    .optional()
    .describe('Prefix values: the tags this extlang or variant follows.'),
  comments: z.array(z.string()).optional().describe('Comments values.'),
};

const TypedRecordSchema = z
  .object({
    type: z.enum(RECORD_TYPES).describe('The record Type.'),
    subtag: z
      .string()
      .describe('Subtag; the whole tag for grandfathered/redundant; a range such as "qaa..qtz".'),
    ...recordFields,
  })
  .describe('One registry record.');

/** The wire shape of a registry record's fields. */
function toRecordFields(record: LanguageRecord | undefined) {
  if (!record) return { descriptions: [] as string[] };
  return {
    descriptions: record.descriptions,
    ...(record.added ? { added: record.added } : {}),
    ...(record.deprecated ? { deprecated: record.deprecated } : {}),
    ...(record.preferredValue ? { preferred_value: record.preferredValue } : {}),
    ...(record.suppressScript ? { suppress_script: record.suppressScript } : {}),
    ...(record.macrolanguage ? { macrolanguage: record.macrolanguage } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
    ...(record.prefixes.length > 0 ? { prefixes: record.prefixes } : {}),
    ...(record.comments.length > 0 ? { comments: record.comments } : {}),
  };
}

function toTypedRecord(record: LanguageRecord) {
  return {
    type: record.type,
    subtag: record.subtag ?? record.tag ?? '',
    ...toRecordFields(record),
  };
}

/** A record's fields as `format()` receives them. */
interface RecordView {
  added?: string | undefined;
  comments?: string[] | undefined;
  deprecated?: string | undefined;
  descriptions: string[];
  macrolanguage?: string | undefined;
  preferred_value?: string | undefined;
  prefixes?: string[] | undefined;
  scope?: string | undefined;
  suppress_script?: string | undefined;
}

function recordLines(record: RecordView): string[] {
  const lines: string[] = [];
  if (record.descriptions.length > 0) {
    lines.push(`**Descriptions:** ${record.descriptions.map(inline).join('; ')}`);
  }
  const facts = [
    record.added && `**Added:** ${inline(record.added)}`,
    record.deprecated && `**Deprecated:** ${inline(record.deprecated)}`,
    record.preferred_value && `**Preferred value:** ${inline(record.preferred_value)}`,
    record.suppress_script && `**Suppress-Script:** ${inline(record.suppress_script)}`,
    record.macrolanguage && `**Macrolanguage:** ${inline(record.macrolanguage)}`,
    record.scope && `**Scope:** ${inline(record.scope)}`,
  ].filter(Boolean);
  if (facts.length > 0) lines.push(facts.join(' · '));
  if (record.prefixes?.length)
    lines.push(`**Prefixes:** ${record.prefixes.map(inline).join(', ')}`);
  if (record.comments?.length) lines.push('**Comments:**', ...record.comments.map(quote));
  return lines;
}

export const lookupLanguageTag = tool('iana_lookup_language_tag', {
  title: 'Validate a BCP 47 language tag',
  description:
    'Parse and validate a BCP 47 language tag against the IANA Language Subtag Registry, or search subtags by description. Pass exactly one of `tag` (e.g. "zh-Hant-TW", "sr-Latn", "en_US") or `description` (e.g. "Swiss German"). A tag is split into language, extlang, script, region, variant, extension, and private-use parts; each part is checked, deprecated subtags report their preferred value, and a canonical tag is returned when the tag is valid. A single subtag registered under several types (e.g. "TW") lists the other types.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    tag: blankAsUnset(z.string().max(100).regex(TAG_PATTERN).optional(), (trimmed) =>
      trimmed.replace(/_/g, '-'),
    ).describe(
      'A language tag to validate, e.g. "zh-Hant-TW", "sr-Latn", "i-klingon". Underscores are read as hyphens ("en_US" → "en-US"); matching ignores case. Pass this or description, not both.',
    ),
    description: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against subtag descriptions, e.g. "Swiss German" or "Cyrillic". Pass this or tag, not both.',
    ),
    subtag_type: blankAsUnset(z.enum(RECORD_TYPES).optional(), (trimmed) =>
      trimmed.toLowerCase(),
    ).describe('Description mode only: return only records of this Type.'),
    limit: limitInput(100, 25).describe(
      'Maximum number of description matches to return, 1–100. Default 25. Tag mode always returns every part of the tag.',
    ),
    offset: offsetInput('description'),
  }),
  output: z.object({
    mode: z.enum(['tag', 'description']).describe('Which lookup ran.'),
    tag_input: z
      .string()
      .optional()
      .describe('Tag mode: the tag as read, after underscores became hyphens.'),
    well_formed: z
      .boolean()
      .optional()
      .describe('Tag mode: true when the tag follows RFC 5646 syntax or is grandfathered.'),
    valid: z
      .boolean()
      .optional()
      .describe(
        'Tag mode: true when well-formed, every subtag is registered and correctly placed, and no variant or singleton repeats.',
      ),
    canonical_tag: z
      .string()
      .optional()
      .describe(
        'Tag mode, valid tags only: canonical form (preferred values applied, extlang reduced, case normalized).',
      ),
    subtags: z
      .array(
        z
          .object({
            subtag: z
              .string()
              .describe(
                'Subtag in canonical case; the whole sequence of an extension or private-use part; the whole tag for grandfathered/redundant.',
              ),
            position: z
              .enum([
                'language',
                'extlang',
                'script',
                'region',
                'variant',
                'extension',
                'privateuse',
                'grandfathered',
                'redundant',
              ])
              .describe('Position in the tag; grandfathered/redundant for a whole-tag record.'),
            registered: z
              .boolean()
              .describe(
                'True when a record covers the subtag at this position (private-use ranges count); always false for extension and private-use parts.',
              ),
            ...recordFields,
          })
          .describe('One part of the tag.'),
      )
      .optional()
      .describe(
        'Tag mode: the parts in order, after any whole-tag record; parsing stops at the first part the syntax cannot place.',
      ),
    issues: z
      .array(
        z
          .object({
            subtag: z.string().describe('The subtag or sequence the issue is about.'),
            kind: z
              .enum([
                'unknown',
                'deprecated',
                'wrong_position',
                'variant_prefix_mismatch',
                'suppress_script_redundant',
                'extension_not_validated',
              ])
              .describe(
                'unknown (not registered for its position) and wrong_position (misplaced, repeated, or an extlang after the wrong language) make the tag invalid; the rest are advisory.',
              ),
            message: z.string().describe('What is wrong and what to use instead.'),
          })
          .describe('One finding about the tag.'),
      )
      .optional()
      .describe('Tag mode: findings; empty for a clean tag.'),
    also_registered_as: z
      .array(TypedRecordSchema)
      .optional()
      .describe(
        'Tag mode, single-subtag input: records of other types under the same subtag, e.g. region "TW" beside language "tw".',
      ),
    matches: z
      .array(TypedRecordSchema)
      .optional()
      .describe(
        'Description mode: matching records, exact description matches first, then registry order.',
      ),
    source: SourceSchema,
  }),
  enrichment: offsetListEnrichment,
  errors: [
    {
      reason: 'mode_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both of tag and description were given.',
      recovery: 'Pass exactly one of tag or description to iana_lookup_language_tag.',
      severity: 'notice',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The language subtag registry could not be fetched or parsed to zero records.',
      recovery:
        'The IANA language subtag registry could not be read; retry iana_lookup_language_tag shortly.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue is too full for the call to start in time.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_lookup_language_tag again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    if ((input.tag === undefined) === (input.description === undefined)) {
      throw ctx.fail('mode_required', 'Pass exactly one of tag or description.');
    }
    const budget = startCallBudget(ctx);
    const loaded = await getRegistryStore().getLanguageRegistry(budget);

    if (input.tag !== undefined) {
      const analysis = analyzeLanguageTag(input.tag, loaded.model);
      const subtags = analysis.subtags.map(({ subtag, position, record }) => ({
        subtag,
        position,
        registered: record !== undefined,
        ...toRecordFields(record),
      }));
      discloseList(ctx.enrich, {
        total: subtags.length,
        shown: subtags.length,
        cap: input.limit,
        more: false,
        fragments: [
          input.subtag_type !== undefined &&
            'subtag_type applies to description mode only; it was ignored for this tag lookup.',
          offsetIgnored(input.offset, 'description'),
        ],
      });
      return {
        mode: 'tag' as const,
        tag_input: input.tag,
        well_formed: analysis.wellFormed,
        valid: analysis.valid,
        ...(analysis.canonicalTag ? { canonical_tag: analysis.canonicalTag } : {}),
        subtags,
        issues: analysis.issues,
        ...(analysis.alsoRegisteredAs
          ? { also_registered_as: analysis.alsoRegisteredAs.map(toTypedRecord) }
          : {}),
        source: loaded.source,
      };
    }

    const description = input.description ?? '';
    const query = compileQuery(description);
    const wanted = normalizeForSearch(description);
    const hits = loaded.model.records.filter(
      (record) =>
        (input.subtag_type === undefined || record.type === input.subtag_type) &&
        matchesQuery(record.searchText, query),
    );
    const ranked = exactFirst(hits, (record) =>
      record.descriptions.some((text) => normalizeForSearch(text) === wanted),
    );
    const page = offsetPage(ranked, {
      offset: input.offset,
      limit: input.limit,
      max: 100,
      noun: 'matching records',
      narrow: 'add words to description or set subtag_type to narrow',
    });
    const matches = page.items.map(toTypedRecord);
    const typeClause = input.subtag_type ? ` with type ${input.subtag_type}` : '';
    discloseList(ctx.enrich, {
      total: ranked.length,
      shown: matches.length,
      cap: input.limit,
      more: page.nextOffset !== undefined,
      nextOffset: page.nextOffset,
      fragments: [
        ranked.length === 0 &&
          `No subtag description matched "${echo(description)}"${typeClause}. Try the language's English name or an alternative name.`,
        page.notice,
      ],
    });
    return { mode: 'description' as const, matches, source: loaded.source };
  },

  format: (result) => {
    const head = [`**Mode:** ${result.mode}`];
    if (result.tag_input !== undefined) head.push(`**Tag:** ${inline(result.tag_input)}`);
    if (result.well_formed !== undefined) head.push(`**Well-formed:** ${result.well_formed}`);
    if (result.valid !== undefined) head.push(`**Valid:** ${result.valid}`);
    if (result.canonical_tag) head.push(`**Canonical tag:** ${inline(result.canonical_tag)}`);
    const lines = [head.join(' · ')];

    if (result.issues) {
      lines.push('', '### Issues');
      if (result.issues.length === 0) lines.push('None.');
      for (const issue of result.issues) {
        lines.push(`- ${inline(issue.subtag)} · ${issue.kind}: ${inline(issue.message)}`);
      }
    }
    for (const subtag of result.subtags ?? []) {
      lines.push(
        '',
        `### ${inline(subtag.subtag)} · ${subtag.position}`,
        `**Registered:** ${subtag.registered}`,
        ...recordLines(subtag),
      );
    }
    if (result.also_registered_as?.length) {
      lines.push('', '### Also registered as');
      for (const record of result.also_registered_as) {
        lines.push('', `#### ${inline(record.subtag)} · ${record.type}`, ...recordLines(record));
      }
    }
    for (const record of result.matches ?? []) {
      lines.push('', `### ${inline(record.subtag)} · ${record.type}`, ...recordLines(record));
    }
    lines.push('', ...sourceLines(result.source));
    return [{ type: 'text', text: joinLines(lines) }];
  },
});
