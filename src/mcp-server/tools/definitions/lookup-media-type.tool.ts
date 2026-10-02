/**
 * @fileoverview `iana_lookup_media_type` — registered media (MIME) types from
 * the `media-types` registry's eleven top-level sub-registries, by exact type or
 * keyword. The record `<name>` mixes the subtype with a status annotation
 * (`vnd.gmx - DEPRECATED`, `javascript (OBSOLETED in favor of text/javascript)`),
 * parsed here into status, note, and replacement. An exact lookup also reads the
 * registration template through `MediaTemplateReader`, which returns three
 * labelled statements and nothing else, or `available: false` when IANA
 * publishes no template for the type. Keyword mode never reads templates, so it
 * cannot match file extensions; a one-word keyword shaped like one says so.
 * @module mcp-server/tools/definitions/lookup-media-type
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getMediaTemplateReader,
  type MediaTemplate,
} from '@/services/media-template/media-template-reader.js';
import { getRegistryStore } from '@/services/registry/registry-store.js';
import { requireTable, tablesOf } from '@/services/registry/registry-tables.js';
import {
  compileQuery,
  matchesQuery,
  normalizeForSearch,
  toSearchText,
} from '@/services/registry/search-text.js';
import type { RegistryRecord } from '@/services/registry/types.js';
import { startCallBudget } from '@/services/upstream/call-budget.js';
import {
  discloseList,
  echo,
  exactFirst,
  offsetIgnored,
  offsetListEnrichment,
  offsetPage,
} from '../shared/list-enrichment.js';
import {
  datesLine,
  inline,
  joinLines,
  quote,
  referenceLines,
  sourceLines,
  url,
} from '../shared/markdown.js';
import {
  blankAsUnset,
  limitInput,
  offsetInput,
  ReferenceSchema,
  SourceSchema,
  searchWords,
} from '../shared/schemas.js';

const TEMPLATE_BASE = 'https://www.iana.org/assignments/media-types/';

const TOP_LEVELS = [
  'application',
  'audio',
  'example',
  'font',
  'haptics',
  'image',
  'message',
  'model',
  'multipart',
  'text',
  'video',
] as const;

/** A lowercased `type/subtype` (RFC 6838 restricted-name characters). */
const TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The type or bare subtype after "in favor of", when it is the whole rest of the
 * annotation, trailing dots aside. The name ends on a character other than a
 * dot, so trailing dots fall to `\.*` without the lazy retry that made a long run
 * of dots quadratic.
 */
const REPLACEMENT =
  /in favou?r of\s+([A-Za-z0-9](?:[A-Za-z0-9!#$&^_.+/-]*[A-Za-z0-9!#$&^_+/-])?)\.*\s*$/i;

/** A document reference ("RFC9999", "BCP47"), which names no type. */
const DOCUMENT_REFERENCE = /^(?:rfc|bcp|std)\d*$/i;

/** Characters kept raw in a template URL path segment; everything else is percent-encoded. */
const PATH_UNSAFE = /[^A-Za-z0-9!$&'()*+,;=:@._~-]/g;

/**
 * A keyword shaped like a file extension: one word of 2–5 letters or digits,
 * after an optional "*" and ".". The capture drops the "*", which would pair
 * with the one the miss text echoes into markdown emphasis.
 */
const EXTENSION_SHAPED = /^\*?(\.?[a-z0-9]{2,5})$/i;

type MediaStatus = 'current' | 'deprecated' | 'obsoleted';

/** A type-mode row's `template`: how the read went and the statements it kept. */
const TemplateSchema = z.object({
  fetched: z.boolean().describe('False when the template could not be read.'),
  available: z
    .boolean()
    .optional()
    .describe(
      'True when a template was read; false when IANA publishes no registration template for this type, so its references are its defining documents. Absent when fetched is false.',
    ),
  file_extensions: z
    .string()
    .optional()
    .describe('The "File extension(s)" statement as written, e.g. ".json".'),
  intended_usage: z.string().optional().describe('The "Intended usage" statement, e.g. "COMMON".'),
  deprecated_aliases: z
    .string()
    .optional()
    .describe('The "Deprecated alias names for this type" statement.'),
});

/** `vnd.gmx - DEPRECATED` → `vnd.gmx` + `DEPRECATED`; `json` → `json` alone. */
function splitName(name: string): { annotation?: string; subtype: string } {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(name);
  if (!match) return { subtype: name };
  const annotation = (match[2] ?? '')
    .trim()
    .replace(/^-\s*/, '')
    .replace(/^\(([\s\S]*)\)$/, '$1')
    .trim();
  return { subtype: match[1] ?? name, ...(annotation ? { annotation } : {}) };
}

function statusOf(annotation: string | undefined): MediaStatus {
  if (!annotation) return 'current';
  if (/\bobsoleted?\b/i.test(annotation)) return 'obsoleted';
  if (/\bdeprecated\b/i.test(annotation)) return 'deprecated';
  return 'current';
}

/**
 * The type the annotation ends with after "in favor of", when it is well formed; a
 * bare subtype takes the record's top-level type. Prose or a document reference
 * after "in favor of" names no replacement.
 */
function replacementOf(annotation: string | undefined, topLevel: string): string | undefined {
  const named = annotation ? REPLACEMENT.exec(annotation)?.[1] : undefined;
  if (!named || DOCUMENT_REFERENCE.test(named)) return;
  const type = named.includes('/') ? named : `${topLevel}/${named}`;
  return TYPE_PATTERN.test(type.toLowerCase()) ? type : undefined;
}

/**
 * The template URL under {@link TEMPLATE_BASE}. `.` and `..` segments are dropped,
 * since the URL parser would resolve them and send the template read elsewhere
 * on iana.org; a `%` is encoded, so no escaped dot can stand in for one.
 */
function templateUrlOf(path: string): string {
  const segments = path
    .split('/')
    .filter((segment) => segment !== '.' && segment !== '..')
    .map((segment) => segment.replace(PATH_UNSAFE, (char) => encodeURIComponent(char)));
  return `${TEMPLATE_BASE}${segments.join('/')}`;
}

/**
 * The registry name is the `<file name>` attribute when present (an alias such
 * as `image/x-emf`, sharing its target's template), else the `<file>` text.
 */
function toMediaType(record: RegistryRecord, topLevel: string) {
  const { subtype: nameSubtype, annotation } = splitName(
    (record.fields.name ?? record.value ?? '').trim(),
  );
  const file = record.fields.file?.trim();
  const alias = record.fieldAttributes?.file?.name?.trim();
  const type = alias || file || `${topLevel}/${nameSubtype}`;
  const slash = type.indexOf('/');
  const replacedBy = replacementOf(annotation, topLevel);
  return {
    type,
    top_level: topLevel,
    subtype: slash === -1 ? type : type.slice(slash + 1),
    status: statusOf(annotation),
    ...(annotation ? { status_note: annotation } : {}),
    ...(replacedBy ? { replaced_by: replacedBy } : {}),
    template_url: templateUrlOf(file || type),
    references: record.references,
    ...(record.registered ? { registered: record.registered } : {}),
    ...(record.updated ? { updated: record.updated } : {}),
  };
}

function toTemplate(template: MediaTemplate): z.infer<typeof TemplateSchema> {
  if (!template.fetched) return { fetched: false };
  if (!template.available) return { fetched: true, available: false };
  return {
    fetched: true,
    available: true,
    ...(template.fileExtensions ? { file_extensions: template.fileExtensions } : {}),
    ...(template.intendedUsage ? { intended_usage: template.intendedUsage } : {}),
    ...(template.deprecatedAliases ? { deprecated_aliases: template.deprecatedAliases } : {}),
  };
}

export const lookupMediaType = tool('iana_lookup_media_type', {
  title: 'Look up a media type',
  description:
    'Look up registered media (MIME) types. Pass exactly one of `type` (a full name such as "application/json"; parameters after ";" are ignored) or `keyword` (words matched against registered type names and status annotations, e.g. "geo json"; never against file extensions). An exact `type` lookup also reads the registration template and returns its file-extension, intended-usage, and deprecated-alias statements as written, each only when the template has it. Some registered types have no registration template (`template.available: false`); their references are the defining documents. Deprecated and obsoleted types are reported with their replacement when the registry names one. Unregistered "x-" types are not in the registry.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    type: blankAsUnset(z.string().regex(TYPE_PATTERN).optional(), (trimmed) =>
      (trimmed.split(';')[0] ?? '').trim().toLowerCase(),
    ).describe(
      'Full media type, case-insensitive, e.g. "application/json" ("; charset=utf-8" and other parameters are dropped). Pass this or keyword, not both.',
    ),
    keyword: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against registered type names and status annotations, e.g. "geo json". File extensions are not searched: look up the expected type with type to read its template\'s file-extension statement, when the template has one. Pass this or type, not both.',
    ),
    top_level: blankAsUnset(z.enum(TOP_LEVELS).optional(), (trimmed) =>
      trimmed.toLowerCase(),
    ).describe('Keep only types under this top-level type, e.g. "image". Keyword mode only.'),
    limit: limitInput(100, 25),
    offset: offsetInput('keyword'),
  }),
  output: z.object({
    mode: z.enum(['type', 'keyword']).describe('Which lookup ran.'),
    found: z.boolean().describe('True when a registered media type matched.'),
    normalized_type: z
      .string()
      .optional()
      .describe('Type mode: the type looked up, lowercased, parameters removed.'),
    media_types: z
      .array(
        z
          .object({
            type: z.string().describe('type/subtype in registry casing, e.g. "application/json".'),
            top_level: z.string().describe('Top-level type, e.g. "application".'),
            subtype: z.string().describe('Subtype, e.g. "json".'),
            status: z
              .enum(['current', 'deprecated', 'obsoleted'])
              .describe('From the registry annotation (OBSOLETE(D), DEPRECATED); else current.'),
            status_note: z
              .string()
              .optional()
              .describe('The status annotation, e.g. "OBSOLETED in favor of text/javascript".'),
            replaced_by: z
              .string()
              .optional()
              .describe('The replacement type the annotation names.'),
            template_url: z.string().describe('Registration template URL.'),
            references: z.array(ReferenceSchema).describe('Defining references.'),
            registered: z.string().optional().describe('Registration date.'),
            updated: z.string().optional().describe('Last-updated date.'),
            template: TemplateSchema.optional().describe(
              'Type mode: the registration template read; each statement absent when the template lacks it.',
            ),
          })
          .describe('One registered media type.'),
      )
      .describe('Matching media types: exact name hits first, then registry order.'),
    source: SourceSchema,
  }),
  enrichment: offsetListEnrichment,
  errors: [
    {
      reason: 'mode_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both of type and keyword were given.',
      recovery: 'Pass exactly one of type or keyword to iana_lookup_media_type.',
      severity: 'notice',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The media type registry file could not be fetched or parsed.',
      recovery:
        'The IANA media type registry could not be read; retry iana_lookup_media_type in a minute.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue is too full for the call to start in time.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_lookup_media_type again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    if ((input.type === undefined) === (input.keyword === undefined)) {
      throw ctx.fail('mode_required', 'Pass exactly one of type or keyword.');
    }
    const budget = startCallBudget(ctx);
    const loaded = await getRegistryStore().getRegistry('media-types', budget);
    const all = tablesOf(loaded.model).flatMap((table) =>
      table.records.map((record) => toMediaType(record, table.id)),
    );

    if (input.type !== undefined) {
      const wanted = input.type;
      const matches = all.filter((mediaType) => mediaType.type.toLowerCase() === wanted);
      const shown = matches.slice(0, input.limit);
      const reader = getMediaTemplateReader();
      const mediaTypes = await Promise.all(
        shown.map(async (mediaType) => ({
          ...mediaType,
          template: toTemplate(await reader.read(mediaType.template_url, budget)),
        })),
      );
      const untemplated = mediaTypes.find((mediaType) => mediaType.template.available === false);
      discloseList(ctx.enrich, {
        total: matches.length,
        shown: mediaTypes.length,
        cap: input.limit,
        more: matches.length > mediaTypes.length,
        fragments: [
          matches.length === 0 &&
            `${wanted} is not a registered media type. Unregistered x- types and vendor types never submitted to IANA are absent. Call iana_lookup_media_type with keyword set to the subtype's words to find registered neighbours.`,
          mediaTypes.some((mediaType) => !mediaType.template.fetched) &&
            'The registration template could not be read; registry fields are complete, template statements are missing.',
          untemplated &&
            `IANA publishes no registration template for ${inline(untemplated.type)}; its defining documents are the references.`,
          input.top_level !== undefined &&
            'top_level applies to keyword mode only; it was ignored for this exact lookup.',
          offsetIgnored(input.offset, 'keyword'),
        ],
      });
      return {
        mode: 'type' as const,
        found: mediaTypes.length > 0,
        normalized_type: wanted,
        media_types: mediaTypes,
        source: loaded.source,
      };
    }

    const keyword = input.keyword ?? '';
    const topLevel = input.top_level;
    if (topLevel !== undefined) requireTable(loaded, topLevel);
    const query = compileQuery(keyword);
    const wanted = normalizeForSearch(keyword);
    const matches = all.filter(
      (mediaType) =>
        (topLevel === undefined || mediaType.top_level === topLevel) &&
        matchesQuery(toSearchText(mediaType.type, mediaType.status_note), query),
    );
    const ranked = exactFirst(
      matches,
      (mediaType) =>
        normalizeForSearch(mediaType.type) === wanted ||
        normalizeForSearch(mediaType.subtype) === wanted,
    );
    const page = offsetPage(ranked, {
      offset: input.offset,
      limit: input.limit,
      max: 100,
      noun: 'matching media types',
      narrow: 'add words to keyword to narrow',
    });
    const mediaTypes = page.items;
    const miss = ranked.length === 0;
    const extension = EXTENSION_SHAPED.exec(keyword)?.[1];
    const extensionShaped =
      extension !== undefined &&
      !(TOP_LEVELS as readonly string[]).includes(wanted) &&
      !all.some((mediaType) => normalizeForSearch(mediaType.subtype) === wanted);
    discloseList(ctx.enrich, {
      total: ranked.length,
      shown: mediaTypes.length,
      cap: input.limit,
      more: page.nextOffset !== undefined,
      nextOffset: page.nextOffset,
      fragments: [
        miss &&
          `No registered media type matched "${echo(keyword)}"${topLevel ? ` in ${topLevel}` : ''}.`,
        miss && query.length > 1 && `Try fewer words${topLevel ? ' or drop top_level' : ''}.`,
        miss &&
          query.length === 1 &&
          topLevel !== undefined &&
          'Drop top_level to search every top-level type.',
        miss &&
          query.length === 1 &&
          topLevel === undefined &&
          !extensionShaped &&
          'Keyword matches whole words of registered type names; try part of the name, or split a joined word ("geo json" finds geo+json).',
        extensionShaped &&
          `If "${extension}" is a file extension: keyword search reads registered type names, never file extensions; look up the type you expect with type to read its registration template's file-extension statement, when the template has one.`,
        page.notice,
      ],
    });
    return {
      mode: 'keyword' as const,
      found: ranked.length > 0,
      media_types: mediaTypes,
      source: loaded.source,
    };
  },

  format: (result) => {
    const lines = [`**Mode:** ${result.mode} · **Found:** ${result.found}`];
    if (result.normalized_type) {
      lines.push(`**Looked up:** ${inline(result.normalized_type)}`);
    }
    for (const mediaType of result.media_types) {
      lines.push('', `### ${inline(mediaType.type)}`);
      lines.push(
        `**Top level:** ${inline(mediaType.top_level)} · **Subtype:** ${inline(mediaType.subtype)} · **Status:** ${mediaType.status}`,
      );
      if (mediaType.status_note) lines.push(`**Status note:** ${inline(mediaType.status_note)}`);
      if (mediaType.replaced_by) lines.push(`**Replaced by:** ${inline(mediaType.replaced_by)}`);
      lines.push(`**Template:** ${url(mediaType.template_url)}`);
      const dates = datesLine(mediaType);
      if (dates) lines.push(dates);
      if (mediaType.references.length > 0) {
        lines.push('**References:**', ...referenceLines(mediaType.references));
      }
      const { template } = mediaType;
      if (template) {
        lines.push(
          template.available === false
            ? '**Template published:** no — IANA publishes no registration template for this type; its defining documents are the references'
            : `**Template read:** ${template.fetched ? 'yes' : 'no — the template could not be read'}`,
        );
        if (template.file_extensions) {
          lines.push('**File extensions:**', quote(template.file_extensions));
        }
        if (template.intended_usage) {
          lines.push('**Intended usage:**', quote(template.intended_usage));
        }
        if (template.deprecated_aliases) {
          lines.push('**Deprecated aliases:**', quote(template.deprecated_aliases));
        }
      }
    }
    lines.push('', ...sourceLines(result.source));
    return [{ type: 'text', text: joinLines(lines) }];
  },
});
