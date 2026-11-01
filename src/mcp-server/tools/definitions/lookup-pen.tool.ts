/**
 * @fileoverview `iana_lookup_pen` — Private Enterprise Numbers from
 * `enterprise-numbers.txt`, by number (or an OID under 1.3.6.1.4.1) or by
 * organization words. Contact and email lines are never parsed; an organization
 * line holding an address is withheld whole (`organization_withheld`).
 * @module mcp-server/tools/definitions/lookup-pen
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryStore } from '@/services/registry/registry-store.js';
import { compileQuery, matchesQuery, normalizeForSearch } from '@/services/registry/search-text.js';
import type { PenEntry } from '@/services/registry/types.js';
import { startCallBudget } from '@/services/upstream/call-budget.js';
import {
  discloseList,
  echo,
  exactFirst,
  initializeList,
  offsetIgnored,
  offsetListEnrichment,
  offsetPage,
} from '../shared/list-enrichment.js';
import { inline, sourceLines } from '../shared/markdown.js';
import {
  blankAsUnset,
  limitInput,
  offsetInput,
  SourceSchema,
  searchWords,
} from '../shared/schemas.js';

/** The private enterprise arc; enterprise N's OID is this plus `N`. */
const ENTERPRISE_ARC = '1.3.6.1.4.1';

const SYMBOLIC_PREFIXES = [
  'iso.org.dod.internet.private.enterprises',
  'iso.org.dod.internet.private.enterprise',
  'snmpv2-smi::enterprises',
  'enterprises',
  'iso.3.6.1.4.1',
] as const;
// JSON Schema carries no regex flags, so spell case folding in the pattern itself.
const SYMBOLIC_PATTERN = SYMBOLIC_PREFIXES.map((prefix) =>
  [...prefix]
    .map((letter) =>
      /[a-z]/.test(letter) ? `[${letter}${letter.toUpperCase()}]` : letter === '.' ? '\\.' : letter,
    )
    .join(''),
).join('|');
const RAW_PEN_PATTERN = new RegExp(
  `^(?:\\s*|\\s*\\.?(?:\\d{1,9}|\\d{1,10}(?:\\.\\d{1,10}){2,70}|(?:${SYMBOLIC_PATTERN})(?:\\.\\d{1,9}(?:\\.\\d{1,10}){0,64})?)\\s*)$`,
);
const PEN_SYNTAX_HINT =
  'Pass a PEN of 1–9 digits or a numeric enterprise OID under 1.3.6.1.4.1, with at most 64 sub-arcs of 1–10 digits. Symbolic prefixes iso.3.6.1.4.1, iso.org.dod.internet.private.enterprise(s), enterprises, and SNMPv2-SMI::enterprises are accepted.';

function normalizePen(raw: string): string {
  const text = raw.startsWith('.') ? raw.slice(1) : raw;
  const lower = text.toLowerCase();
  for (const prefix of SYMBOLIC_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}.`))
      return `${ENTERPRISE_ARC}${text.slice(prefix.length)}`;
  }
  return text;
}

function validPen(raw: string): boolean {
  if (!RAW_PEN_PATTERN.test(raw)) return false;
  const normalized = normalizePen(raw.trim());
  if (!normalized.startsWith(`${ENTERPRISE_ARC}.`)) return true;
  const arcs = normalized.slice(ENTERPRISE_ARC.length + 1).split('.');
  return (arcs[0]?.length ?? 0) <= 9 && arcs.length <= 65;
}

function toEnterprise(entry: PenEntry) {
  return {
    number: entry.number,
    ...(entry.organization ? { organization: entry.organization } : {}),
    ...(entry.organizationWithheld ? { organization_withheld: true } : {}),
    oid: `${ENTERPRISE_ARC}.${entry.number}`,
    state: entry.state,
  };
}

export const lookupPen = tool('iana_lookup_pen', {
  title: 'Look up a Private Enterprise Number',
  description:
    'Look up a Private Enterprise Number (PEN). Pass exactly one of `pen` (a number such as 32473, or an OID under 1.3.6.1.4.1 such as 1.3.6.1.4.1.32473.1.2) or `organization` (words matched against organization names). Returns the organization and its OID prefix. Arcs below the enterprise number are assigned by the enterprise, not IANA. Contact details are not returned.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    // Refinement gives readable syntax errors; metadata advertises the same raw grammar.
    pen: blankAsUnset(z.string().refine(validPen, PEN_SYNTAX_HINT).optional())
      .meta({ pattern: RAW_PEN_PATTERN.source })
      .describe(
        'Enterprise number, e.g. "32473", or an OID under 1.3.6.1.4.1 naming it, e.g. "1.3.6.1.4.1.32473.1.2". A leading dot, case-insensitive iso.3.6.1.4.1, iso.org.dod.internet.private.enterprise(s), enterprises, and SNMPv2-SMI::enterprises prefixes are accepted. Pass this or organization, not both.',
      ),
    organization: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against the names of assigned entries, e.g. "cisco systems"; look up a number with pen to see a reserved or unassigned one. Pass this or pen, not both.',
    ),
    limit: limitInput(100, 25),
    offset: offsetInput('organization'),
  }),
  output: z.object({
    mode: z.enum(['pen', 'organization']).describe('Which lookup ran.'),
    found: z
      .boolean()
      .describe(
        'True when the number is assigned, or any assigned organization matches before paging.',
      ),
    requested_oid: z
      .string()
      .optional()
      .describe('The OID as requested, when it named arcs below the enterprise number.'),
    sub_arcs: z
      .string()
      .optional()
      .describe('Arcs below the enterprise number, e.g. "1.2"; the enterprise assigns these.'),
    enterprises: z
      .array(
        z
          .object({
            number: z.number().describe('The Private Enterprise Number.'),
            organization: z
              .string()
              .optional()
              .describe('Organization line; absent when withheld or missing.'),
            organization_withheld: z
              .boolean()
              .optional()
              .describe('True when the line mixes in contact details and is withheld.'),
            oid: z.string().describe('The enterprise OID prefix, e.g. "1.3.6.1.4.1.32473".'),
            state: z
              .enum(['assigned', 'reserved', 'unassigned'])
              .describe(
                'reserved ("Reserved"), unassigned ("Unassigned" or "---none---"), matched as whole markers case-insensitively; else assigned.',
              ),
          })
          .describe('One enterprise number entry.'),
      )
      .describe('Matching entries: exact organization-name hits first, then number order.'),
    source: SourceSchema,
  }),
  enrichment: offsetListEnrichment,
  errors: [
    {
      reason: 'outside_enterprise_arc',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The numeric OID is outside the private enterprise arc 1.3.6.1.4.1.',
      recovery:
        'Pass an enterprise OID under 1.3.6.1.4.1 or call iana_search_registries with query "smi" to find the SMI registries.',
      severity: 'notice',
    },
    {
      reason: 'enterprise_number_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The OID names the enterprise arc itself without an enterprise number.',
      recovery:
        'Append the enterprise number to 1.3.6.1.4.1, or call iana_search_registries with query "smi" to find the SMI registries.',
      severity: 'notice',
    },
    {
      reason: 'mode_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both of pen and organization were given.',
      recovery: 'Pass exactly one of pen or organization to iana_lookup_pen.',
      severity: 'notice',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The enterprise number file could not be fetched or parsed to zero records.',
      recovery:
        'The IANA enterprise number file could not be read; retry iana_lookup_pen in a minute.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue is too full for the call to start in time.",
      recovery: 'Wait the retryAfter seconds given in this error, then call iana_lookup_pen again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    input = { ...input, limit: initializeList(ctx.enrich, input.limit, 100) };
    if ((input.pen === undefined) === (input.organization === undefined)) {
      throw ctx.fail('mode_required', 'Pass exactly one of pen or organization.');
    }
    if (input.pen !== undefined) {
      input = { ...input, pen: normalizePen(input.pen) };
      if (input.pen === ENTERPRISE_ARC)
        throw ctx.fail(
          'enterprise_number_required',
          'The enterprise arc needs an enterprise number.',
        );
      if (input.pen?.includes('.') && !input.pen.startsWith(`${ENTERPRISE_ARC}.`))
        throw ctx.fail(
          'outside_enterprise_arc',
          'This OID is outside the private enterprise arc 1.3.6.1.4.1.',
        );
    }
    const budget = startCallBudget(ctx);
    const loaded = await getRegistryStore().getPen(budget);
    const { model } = loaded;

    if (input.pen !== undefined) {
      const requested = input.pen;
      const [numberText = requested, ...arcs] = requested.startsWith(`${ENTERPRISE_ARC}.`)
        ? requested.slice(ENTERPRISE_ARC.length + 1).split('.')
        : [requested];
      const number = Number(numberText);
      const entry = model.byNumber.get(number);
      const enterprises = entry ? [toEnterprise(entry)] : [];
      discloseList(ctx.enrich, {
        total: enterprises.length,
        shown: enterprises.length,
        cap: input.limit,
        more: false,
        fragments: [
          !entry &&
            number > model.maxNumber &&
            `PEN ${number} is not assigned yet; the registry currently ends at ${model.maxNumber}.`,
          !entry && number <= model.maxNumber && `PEN ${number} has no entry in the registry.`,
          entry?.state === 'reserved' && `PEN ${number} is reserved; no organization holds it.`,
          entry?.state === 'unassigned' && `PEN ${number} is unassigned; no organization holds it.`,
          offsetIgnored(input.offset, 'organization'),
        ],
      });
      return {
        mode: 'pen' as const,
        found: entry?.state === 'assigned',
        ...(arcs.length > 0 ? { requested_oid: requested, sub_arcs: arcs.join('.') } : {}),
        enterprises,
        source: loaded.source,
      };
    }

    const organization = input.organization ?? '';
    const query = compileQuery(organization);
    const wanted = normalizeForSearch(organization);
    const matches = model.entries.filter(
      (entry) => entry.state === 'assigned' && matchesQuery(entry.searchText, query),
    );
    const ranked = exactFirst(
      matches,
      (entry) =>
        entry.organization !== undefined && normalizeForSearch(entry.organization) === wanted,
    );
    const page = offsetPage(ranked, {
      offset: input.offset,
      limit: input.limit,
      max: 100,
      noun: 'matching organizations',
      narrow: 'add words to organization to narrow',
    });
    const enterprises = page.items.map(toEnterprise);
    discloseList(ctx.enrich, {
      total: ranked.length,
      shown: enterprises.length,
      cap: input.limit,
      more: page.nextOffset !== undefined,
      nextOffset: page.nextOffset,
      fragments: [
        ranked.length === 0 &&
          `No organization matched "${echo(organization)}". Try a shorter or alternative name (registrants use legal names, abbreviations, and former names).`,
        page.notice,
      ],
    });
    return {
      mode: 'organization' as const,
      found: ranked.length > 0,
      enterprises,
      source: loaded.source,
    };
  },

  format: (result) => {
    const lines = [`**Mode:** ${result.mode} · **Found:** ${result.found}`];
    if (result.requested_oid) lines.push(`**Requested OID:** ${inline(result.requested_oid)}`);
    if (result.sub_arcs) {
      lines.push(
        `**Arcs below the enterprise number:** ${inline(result.sub_arcs)} (assigned by the enterprise, not IANA)`,
      );
    }
    for (const enterprise of result.enterprises) {
      const name = enterprise.organization ? ` · ${inline(enterprise.organization)}` : '';
      lines.push('', `### PEN ${enterprise.number}${name}`);
      lines.push(`**OID:** ${enterprise.oid} · **State:** ${enterprise.state}`);
      if (enterprise.organization_withheld) {
        lines.push(
          '**Organization withheld:** the registry entry mixes contact details into this line',
        );
      }
    }
    lines.push('', ...sourceLines(result.source));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
