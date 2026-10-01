/**
 * @fileoverview `iana_lookup_http_field` — a registered HTTP field (header or
 * trailer) name by exact name, or by keyword over names and comments, with its
 * registration status and Structured Field type. A miss is a result: many
 * widely used headers have no IANA entry.
 * @module mcp-server/tools/definitions/lookup-http-field
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryStore } from '@/services/registry/registry-store.js';
import { requireTable } from '@/services/registry/registry-tables.js';
import { compileQuery, matchesQuery, toSearchText } from '@/services/registry/search-text.js';
import type { RegistryRecord } from '@/services/registry/types.js';
import { startCallBudget } from '@/services/upstream/call-budget.js';
import { discloseList, echo, listEnrichment } from '../shared/list-enrichment.js';
import { datesLine, inline, quote, referenceLines, sourceLines } from '../shared/markdown.js';
import {
  blankAsUnset,
  limitInput,
  ReferenceSchema,
  SourceSchema,
  searchWords,
} from '../shared/schemas.js';

/** The sub-registry holding the field names. */
const FIELD_TABLE = 'field-names';

const STATUSES = ['permanent', 'provisional', 'deprecated', 'obsoleted'] as const;

function toField(record: RegistryRecord) {
  const { fields } = record;
  return {
    name: record.value ?? '',
    ...(fields.status ? { status: fields.status.toLowerCase() } : {}),
    ...(fields.structured ? { structured_type: fields.structured } : {}),
    ...(fields.comments ? { comments: fields.comments } : {}),
    references: record.references,
    ...(record.registered ? { registered: record.registered } : {}),
    ...(record.updated ? { updated: record.updated } : {}),
  };
}

export const lookupHttpField = tool('iana_lookup_http_field', {
  title: 'Look up an HTTP field name',
  description:
    'Look up a registered HTTP field (header or trailer) name. Pass exactly one of `name` (case-insensitive, e.g. "Cache-Status") or `keyword` (words matched against field names and comments). Returns the registration status — permanent, provisional, deprecated, or obsoleted — the Structured Field type when registered, and the defining reference. Many widely used headers are unregistered; a miss means only that IANA has no entry.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    name: blankAsUnset(
      z
        .string()
        .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/)
        .optional(),
      (trimmed) => trimmed.replace(/:$/, ''),
    ).describe(
      'Exact field name, case-insensitive, e.g. "Content-Type" (a trailing ":" is ignored). Pass this or keyword, not both.',
    ),
    keyword: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against field names and registry comments, e.g. "cache". Pass this or name, not both.',
    ),
    status: blankAsUnset(z.enum(STATUSES).optional(), (trimmed) => trimmed.toLowerCase()).describe(
      'Keep only fields with this registration status. Applies to both modes.',
    ),
    limit: limitInput(100, 25),
  }),
  output: z.object({
    mode: z.enum(['name', 'keyword']).describe('Which lookup ran.'),
    found: z.boolean().describe('True when at least one registered field matched.'),
    fields: z
      .array(
        z
          .object({
            name: z.string().describe('The registered field name, registry casing.'),
            status: z
              .string()
              .optional()
              .describe(
                'Registration status, lowercased: permanent, provisional, deprecated, or obsoleted.',
              ),
            structured_type: z
              .string()
              .optional()
              .describe('Structured Field type (List, Dictionary, Item) when registered.'),
            comments: z.string().optional().describe('Registry comments, verbatim.'),
            references: z.array(ReferenceSchema).describe('Defining references.'),
            registered: z.string().optional().describe('Registration date, when recorded.'),
            updated: z
              .string()
              .optional()
              .describe('Last-updated date of the entry, when recorded.'),
          })
          .describe('One registered HTTP field.'),
      )
      .describe('Matching fields: exact name hits first, then registry order.'),
    source: SourceSchema,
  }),
  enrichment: listEnrichment,
  errors: [
    {
      reason: 'mode_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both of name and keyword were given.',
      recovery: 'Pass exactly one of name or keyword to iana_lookup_http_field.',
      severity: 'notice',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The HTTP field registry file could not be fetched or parsed.',
      recovery:
        'The IANA HTTP field registry could not be read; retry iana_lookup_http_field shortly.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue would hold the call longer than its wait budget.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_lookup_http_field again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    if ((input.name === undefined) === (input.keyword === undefined)) {
      throw ctx.fail('mode_required', 'Pass exactly one of name or keyword.');
    }
    const budget = startCallBudget(ctx);
    const loaded = await getRegistryStore().getRegistry('http-fields', budget);
    const { records } = requireTable(loaded, FIELD_TABLE);
    const withStatus = (field: ReturnType<typeof toField>) =>
      input.status === undefined || field.status === input.status;
    const statusNote = input.status ? ` with status ${input.status}` : '';

    if (input.name !== undefined) {
      const wanted = input.name.toLowerCase();
      const named = records.filter((record) => record.value?.toLowerCase() === wanted).map(toField);
      const rows = named.filter(withStatus);
      const fields = rows.slice(0, input.limit);
      const more = rows.length > fields.length;
      const otherStatus = named.length > 0 && rows.length === 0;
      discloseList(ctx.enrich, {
        total: rows.length,
        shown: fields.length,
        cap: input.limit,
        more,
        fragments: [
          otherStatus &&
            `${input.name} is registered with status ${inline(named.map((field) => field.status ?? 'unrecorded').join(', '))}; the status filter ${input.status} excludes it.`,
          named.length === 0 &&
            `${input.name} has no IANA registration. Call iana_lookup_http_field with keyword set to part of the name to find related registered fields.`,
          more &&
            `Showing ${fields.length} of ${rows.length} rows for ${input.name}; raise limit (max 100) to see the rest.`,
        ],
      });
      return { mode: 'name' as const, found: fields.length > 0, fields, source: loaded.source };
    }

    const keyword = input.keyword ?? '';
    const query = compileQuery(keyword);
    const wanted = keyword.toLowerCase();
    const matches = records
      .filter((record) => matchesQuery(toSearchText(record.value, record.fields.comments), query))
      .map(toField)
      .filter(withStatus);
    const ranked = [
      ...matches.filter((field) => field.name.toLowerCase() === wanted),
      ...matches.filter((field) => field.name.toLowerCase() !== wanted),
    ];
    const fields = ranked.slice(0, input.limit);
    const more = ranked.length > fields.length;
    discloseList(ctx.enrich, {
      total: ranked.length,
      shown: fields.length,
      cap: input.limit,
      more,
      fragments: [
        ranked.length === 0 && `No registered field matched "${echo(keyword)}"${statusNote}.`,
        more &&
          `Showing ${fields.length} of ${ranked.length} matching fields; raise limit (max 100) or add words to keyword to narrow.`,
      ],
    });
    return { mode: 'keyword' as const, found: fields.length > 0, fields, source: loaded.source };
  },

  format: (result) => {
    const lines = [`**Mode:** ${result.mode} · **Found:** ${result.found}`];
    for (const field of result.fields) {
      lines.push('', `### ${inline(field.name)}`);
      const facts = [
        `**Status:** ${field.status ? inline(field.status) : 'not recorded'}`,
        field.structured_type
          ? `**Structured type:** ${inline(field.structured_type)}`
          : '**Structured type:** none registered',
      ];
      lines.push(facts.join(' · '));
      const dates = datesLine(field);
      if (dates) lines.push(dates);
      if (field.comments) lines.push('**Comments:**', quote(field.comments));
      if (field.references.length > 0) {
        lines.push('**References:**', ...referenceLines(field.references));
      }
    }
    lines.push('', ...sourceLines(result.source));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
