/**
 * @fileoverview `iana_lookup_uri_scheme` — a registered URI scheme by exact name,
 * or by keyword over scheme names and descriptions, from the `uri-schemes-1`
 * sub-registry (the `ipn` allocator sub-registries are left to
 * `iana_get_registry_records`).
 * @module mcp-server/tools/definitions/lookup-uri-scheme
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryStore } from '@/services/registry/registry-store.js';
import { requireTable } from '@/services/registry/registry-tables.js';
import { compileQuery, matchesQuery, toSearchText } from '@/services/registry/search-text.js';
import type { RegistryRecord } from '@/services/registry/types.js';
import { startCallBudget } from '@/services/upstream/call-budget.js';
import { discloseList, echo, listEnrichment } from '../shared/list-enrichment.js';
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
  ReferenceSchema,
  SourceSchema,
  searchWords,
} from '../shared/schemas.js';

/** The sub-registry holding the URI schemes. */
const SCHEME_TABLE = 'uri-schemes-1';

const TEMPLATE_BASE = 'https://www.iana.org/assignments/uri-schemes/';

const STATUSES = ['permanent', 'provisional', 'historical'] as const;

/** `shttp (OBSOLETE)` → scheme `shttp`, note `OBSOLETE`. */
const ANNOTATED = /^(\S+)\s*\((.+)\)$/;

function toScheme(record: RegistryRecord) {
  const { fields } = record;
  const value = record.value?.trim() ?? '';
  const annotated = ANNOTATED.exec(value);
  const wellKnown = fields['well-known']?.trim();
  return {
    scheme: annotated?.[1] ?? value,
    ...(fields.status ? { status: fields.status.toLowerCase() } : {}),
    ...(annotated?.[2] ? { status_note: annotated[2] } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(wellKnown && wellKnown !== '-' ? { well_known_uri_support: wellKnown } : {}),
    ...(fields.notes ? { notes: fields.notes } : {}),
    ...(fields.file
      ? {
          template_url: `${TEMPLATE_BASE}${fields.file.trim().split('/').map(encodeURIComponent).join('/')}`,
        }
      : {}),
    references: record.references,
    ...(record.registered ? { registered: record.registered } : {}),
    ...(record.updated ? { updated: record.updated } : {}),
  };
}

export const lookupUriScheme = tool('iana_lookup_uri_scheme', {
  title: 'Look up a URI scheme',
  description:
    'Look up a registered URI scheme. Pass exactly one of `scheme` (e.g. "mailto"; a trailing ":" or "://" is ignored) or `keyword` (words matched against scheme names and descriptions). Returns the status — permanent, provisional, or historical — description, references, and well-known URI support.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    scheme: blankAsUnset(
      z
        .string()
        .regex(/^[a-z][a-z0-9+.-]{0,63}$/)
        .optional(),
      (trimmed) => trimmed.replace(/:(?:\/\/)?$/, '').toLowerCase(),
    ).describe(
      'Exact scheme name, case-insensitive, e.g. "https" (a trailing ":" or "://" is ignored). Pass this or keyword, not both.',
    ),
    keyword: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against scheme names and descriptions, e.g. "websocket". Pass this or scheme, not both.',
    ),
    status: blankAsUnset(z.enum(STATUSES).optional(), (trimmed) => trimmed.toLowerCase()).describe(
      'Keep only schemes with this registration status. Applies to both modes.',
    ),
    limit: limitInput(100, 25),
  }),
  output: z.object({
    mode: z.enum(['scheme', 'keyword']).describe('Which lookup ran.'),
    found: z.boolean().describe('True when at least one registered scheme matched.'),
    schemes: z
      .array(
        z
          .object({
            scheme: z.string().describe('The registered scheme name.'),
            status: z
              .string()
              .optional()
              .describe('Registration status, lowercased: permanent, provisional, or historical.'),
            status_note: z
              .string()
              .optional()
              .describe('Annotation the registry attaches to the name, e.g. "OBSOLETE".'),
            description: z.string().optional().describe('Registry description, verbatim.'),
            well_known_uri_support: z
              .string()
              .optional()
              .describe('Reference defining well-known URI support for the scheme, when any.'),
            notes: z.string().optional().describe('Registry notes, verbatim, when present.'),
            template_url: z
              .string()
              .optional()
              .describe(
                'URL of the scheme registration template on iana.org, when one is published.',
              ),
            references: z.array(ReferenceSchema).describe('Defining references.'),
            registered: z.string().optional().describe('Registration date, when recorded.'),
            updated: z
              .string()
              .optional()
              .describe('Last-updated date of the entry, when recorded.'),
          })
          .describe('One registered URI scheme.'),
      )
      .describe('Matching schemes: exact scheme hits first, then registry order.'),
    source: SourceSchema,
  }),
  enrichment: listEnrichment,
  errors: [
    {
      reason: 'mode_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both of scheme and keyword were given.',
      recovery: 'Pass exactly one of scheme or keyword to iana_lookup_uri_scheme.',
      severity: 'notice',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The URI scheme registry file could not be fetched or parsed.',
      recovery:
        'The IANA URI scheme registry could not be read; retry iana_lookup_uri_scheme shortly.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue is too full for the call to start in time.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_lookup_uri_scheme again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    if ((input.scheme === undefined) === (input.keyword === undefined)) {
      throw ctx.fail('mode_required', 'Pass exactly one of scheme or keyword.');
    }
    const budget = startCallBudget(ctx);
    const loaded = await getRegistryStore().getRegistry('uri-schemes', budget);
    const { records } = requireTable(loaded, SCHEME_TABLE);
    const withStatus = (scheme: ReturnType<typeof toScheme>) =>
      input.status === undefined || scheme.status === input.status;
    const statusNote = input.status ? ` with status ${input.status}` : '';

    if (input.scheme !== undefined) {
      const wanted = input.scheme;
      const named = records
        .map(toScheme)
        .filter((scheme) => scheme.scheme.toLowerCase() === wanted);
      const rows = named.filter(withStatus);
      const schemes = rows.slice(0, input.limit);
      const more = rows.length > schemes.length;
      const otherStatus = named.length > 0 && rows.length === 0;
      discloseList(ctx.enrich, {
        total: rows.length,
        shown: schemes.length,
        cap: input.limit,
        more,
        fragments: [
          otherStatus &&
            `${wanted} is registered with status ${inline(named.map((scheme) => scheme.status ?? 'unrecorded').join(', '))}; the status filter ${input.status} excludes it.`,
          named.length === 0 &&
            `${wanted} is not a registered URI scheme. Call iana_lookup_uri_scheme with keyword to search descriptions.`,
          more &&
            `Showing ${schemes.length} of ${rows.length} rows for ${wanted}; raise limit (max 100) to see the rest.`,
        ],
      });
      return { mode: 'scheme' as const, found: schemes.length > 0, schemes, source: loaded.source };
    }

    const keyword = input.keyword ?? '';
    const query = compileQuery(keyword);
    const wanted = keyword.toLowerCase();
    const matches = records
      .map(toScheme)
      .filter(
        (scheme) =>
          withStatus(scheme) &&
          matchesQuery(toSearchText(scheme.scheme, scheme.description), query),
      );
    const ranked = [
      ...matches.filter((scheme) => scheme.scheme.toLowerCase() === wanted),
      ...matches.filter((scheme) => scheme.scheme.toLowerCase() !== wanted),
    ];
    const schemes = ranked.slice(0, input.limit);
    const more = ranked.length > schemes.length;
    discloseList(ctx.enrich, {
      total: ranked.length,
      shown: schemes.length,
      cap: input.limit,
      more,
      fragments: [
        ranked.length === 0 && `No URI scheme matched "${echo(keyword)}"${statusNote}.`,
        more &&
          `Showing ${schemes.length} of ${ranked.length} matching schemes; raise limit (max 100) or add words to keyword to narrow.`,
      ],
    });
    return { mode: 'keyword' as const, found: schemes.length > 0, schemes, source: loaded.source };
  },

  format: (result) => {
    const lines = [`**Mode:** ${result.mode} · **Found:** ${result.found}`];
    for (const scheme of result.schemes) {
      const note = scheme.status_note ? ` (${inline(scheme.status_note)})` : '';
      lines.push('', `### ${inline(scheme.scheme)}${note}`);
      lines.push(`**Status:** ${scheme.status ? inline(scheme.status) : 'not recorded'}`);
      if (scheme.description) lines.push('**Description:**', quote(scheme.description));
      if (scheme.well_known_uri_support) {
        lines.push(`**Well-known URI support:** ${inline(scheme.well_known_uri_support)}`);
      }
      if (scheme.notes) lines.push('**Notes:**', quote(scheme.notes));
      if (scheme.template_url) lines.push(`**Template:** <${url(scheme.template_url)}>`);
      const dates = datesLine(scheme);
      if (dates) lines.push(dates);
      if (scheme.references.length > 0) {
        lines.push('**References:**', ...referenceLines(scheme.references));
      }
    }
    lines.push('', ...sourceLines(result.source));
    return [{ type: 'text', text: joinLines(lines) }];
  },
});
