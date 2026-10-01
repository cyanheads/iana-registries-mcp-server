/**
 * @fileoverview `iana_lookup_http_status` — an HTTP status code from the IANA
 * registry by code, or reason phrases by keyword. An unassigned code is a result
 * (found: false plus the unassigned range it falls in), never an error.
 * @module mcp-server/tools/definitions/lookup-http-status
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryStore } from '@/services/registry/registry-store.js';
import { requireTable } from '@/services/registry/registry-tables.js';
import {
  compileQuery,
  matchesQuery,
  normalizeForSearch,
  toSearchText,
} from '@/services/registry/search-text.js';
import type { RegistryRecord } from '@/services/registry/types.js';
import { startCallBudget } from '@/services/upstream/call-budget.js';
import { upstreamUnreadable } from '@/services/upstream/upstream-client.js';
import { discloseList, echo, listEnrichment } from '../shared/list-enrichment.js';
import { datesLine, inline, referenceLines, sourceLines } from '../shared/markdown.js';
import {
  blankAsUnset,
  digitsToNumber,
  limitInput,
  ReferenceSchema,
  SourceSchema,
  searchWords,
} from '../shared/schemas.js';

/** The sub-registry holding the status codes. */
const STATUS_TABLE = 'http-status-codes-1';

type StatusClass = 'informational' | 'success' | 'redirection' | 'client_error' | 'server_error';
type StatusState = 'assigned' | 'temporary' | 'obsoleted' | 'unused';

const CLASSES: Readonly<Record<string, StatusClass>> = {
  '1': 'informational',
  '2': 'success',
  '3': 'redirection',
  '4': 'client_error',
  '5': 'server_error',
};

const RANGE = /^(\d+)\s*-\s*(\d+)$/;

function isUnassigned(record: RegistryRecord): boolean {
  return /^\s*unassigned\s*$/i.test(record.fields.description ?? '');
}

/** True when the record's key is `code` or a `a-b` range containing it. */
function covers(record: RegistryRecord, code: number): boolean {
  const value = record.value?.trim() ?? '';
  if (value === String(code)) return true;
  const range = RANGE.exec(value);
  return range !== null && Number(range[1]) <= code && code <= Number(range[2]);
}

/** The registry's own markers in the phrase: `(Unused)`, `(OBSOLETED)`, `(TEMPORARY - …)`. */
function stateOf(phrase: string): StatusState {
  if (/\(unused\)/i.test(phrase)) return 'unused';
  if (/\(obsoleted\)/i.test(phrase)) return 'obsoleted';
  if (/\(temporary\b/i.test(phrase)) return 'temporary';
  return 'assigned';
}

/** The class from the first digit; a non-numeric or out-of-range key means the layout changed. */
function classOf(record: RegistryRecord, code: number, url: string): StatusClass {
  const statusClass = /^[1-5]\d\d$/.test(String(code))
    ? CLASSES[String(code).charAt(0)]
    : undefined;
  if (!statusClass) {
    throw upstreamUnreadable(`${url} lists a status row keyed "${record.value}", not a code.`, {
      url,
    });
  }
  return statusClass;
}

function toStatus(record: RegistryRecord, url: string) {
  const code = Number(record.value);
  const phrase = record.fields.description ?? '';
  return {
    code,
    phrase,
    class: classOf(record, code, url),
    state: stateOf(phrase),
    references: record.references,
    ...(record.registered ? { registered: record.registered } : {}),
    ...(record.updated ? { updated: record.updated } : {}),
  };
}

export const lookupHttpStatus = tool('iana_lookup_http_status', {
  title: 'Look up an HTTP status code',
  description:
    'Look up an HTTP status code in the IANA registry, or search reason phrases. Pass exactly one of `code` (100–599) or `keyword` (e.g. "too many"). Returns the registered phrase, its class, defining reference with section, and whether it is temporary, obsoleted, or unused; an unassigned code returns found: false with the unassigned range it falls in.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    code: blankAsUnset(z.number().int().min(100).max(599).optional(), digitsToNumber).describe(
      'Status code to look up, 100–599 (a digit string such as "429" also works). Pass this or keyword, not both.',
    ),
    keyword: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against registered reason phrases, e.g. "too many" or "gateway". Pass this or code, not both.',
    ),
    limit: limitInput(100, 25),
  }),
  output: z.object({
    mode: z.enum(['code', 'keyword']).describe('Which lookup ran.'),
    found: z.boolean().describe('True when at least one registered status matched.'),
    statuses: z
      .array(
        z
          .object({
            code: z.number().describe('The status code.'),
            phrase: z
              .string()
              .describe(
                'The registered description verbatim, including markers such as "(Unused)".',
              ),
            class: z
              .enum(['informational', 'success', 'redirection', 'client_error', 'server_error'])
              .describe('Status class from the first digit.'),
            state: z
              .enum(['assigned', 'temporary', 'obsoleted', 'unused'])
              .describe(
                'From the registry markers: "(Unused)" → unused, "(OBSOLETED)" → obsoleted, "(TEMPORARY - …)" → temporary, else assigned.',
              ),
            references: z.array(ReferenceSchema).describe('Defining references.'),
            registered: z
              .string()
              .optional()
              .describe('Registration date, when the registry records one.'),
            updated: z
              .string()
              .optional()
              .describe('Last-updated date of the entry, when recorded.'),
          })
          .describe('One registered status code.'),
      )
      .describe('Matching status codes: exact phrase hits first, then registry order.'),
    unassigned_range: z
      .string()
      .optional()
      .describe('For an unassigned code, the registry row it falls in, e.g. "432-450".'),
    source: SourceSchema,
  }),
  enrichment: listEnrichment,
  errors: [
    {
      reason: 'mode_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both of code and keyword were given.',
      recovery: 'Pass exactly one of code or keyword to iana_lookup_http_status.',
      severity: 'notice',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The HTTP status registry file could not be fetched or parsed.',
      recovery:
        'The IANA HTTP status registry could not be read; retry iana_lookup_http_status shortly.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue is too full for the call to start in time.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_lookup_http_status again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    if ((input.code === undefined) === (input.keyword === undefined)) {
      throw ctx.fail('mode_required', 'Pass exactly one of code or keyword.');
    }
    const budget = startCallBudget(ctx);
    const loaded = await getRegistryStore().getRegistry('http-status-codes', budget);
    const { records } = requireTable(loaded, STATUS_TABLE);

    if (input.code !== undefined) {
      const code = input.code;
      const row = records.find((record) => covers(record, code));
      if (!row || isUnassigned(row)) {
        const range = row?.value?.trim();
        discloseList(ctx.enrich, {
          total: 0,
          shown: 0,
          cap: input.limit,
          more: false,
          fragments: [
            range
              ? `HTTP ${code} is unassigned (registry range ${inline(range)}); it has no standard meaning.`
              : `HTTP ${code} has no row in the IANA status code registry; it has no standard meaning.`,
          ],
        });
        return {
          mode: 'code' as const,
          found: false,
          statuses: [],
          ...(range ? { unassigned_range: range } : {}),
          source: loaded.source,
        };
      }
      discloseList(ctx.enrich, {
        total: 1,
        shown: 1,
        cap: input.limit,
        more: false,
        fragments: [],
      });
      return {
        mode: 'code' as const,
        found: true,
        statuses: [toStatus(row, loaded.source.url)],
        source: loaded.source,
      };
    }

    const keyword = input.keyword ?? '';
    const query = compileQuery(keyword);
    const wanted = normalizeForSearch(keyword);
    const matches = records
      .filter(
        (record) =>
          !isUnassigned(record) &&
          !RANGE.test(record.value ?? '') &&
          matchesQuery(toSearchText(record.fields.description), query),
      )
      .map((record) => toStatus(record, loaded.source.url));
    const ranked = [
      ...matches.filter((status) => normalizeForSearch(status.phrase) === wanted),
      ...matches.filter((status) => normalizeForSearch(status.phrase) !== wanted),
    ];
    const statuses = ranked.slice(0, input.limit);
    const more = ranked.length > statuses.length;
    discloseList(ctx.enrich, {
      total: ranked.length,
      shown: statuses.length,
      cap: input.limit,
      more,
      fragments: [
        ranked.length === 0 &&
          `No registered status phrase matched "${echo(keyword)}". Codes such as 418 are listed only as (Unused); pass code to see them.`,
        more &&
          `Showing ${statuses.length} of ${ranked.length} matching status codes; raise limit (max 100) or add words to keyword to narrow.`,
      ],
    });
    return {
      mode: 'keyword' as const,
      found: statuses.length > 0,
      statuses,
      source: loaded.source,
    };
  },

  format: (result) => {
    const lines = [`**Mode:** ${result.mode} · **Found:** ${result.found}`];
    if (result.unassigned_range) {
      lines.push(`**Unassigned range:** ${inline(result.unassigned_range)}`);
    }
    for (const status of result.statuses) {
      lines.push('', `### ${status.code} ${inline(status.phrase)}`);
      lines.push(`**Class:** ${status.class} · **State:** ${status.state}`);
      const dates = datesLine(status);
      if (dates) lines.push(dates);
      if (status.references.length > 0) {
        lines.push('**References:**', ...referenceLines(status.references));
      }
    }
    lines.push('', ...sourceLines(result.source));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
