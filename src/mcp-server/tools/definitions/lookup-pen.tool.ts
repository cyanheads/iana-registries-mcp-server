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

/** The symbolic form of {@link ENTERPRISE_ARC} (`enterprises` is the SNMPv2-SMI spelling). */
const SYMBOLIC_ARC = /^iso\.org\.dod\.internet\.private\.enterprises?\./i;

/** A bare number, or a numeric OID under the enterprise arc with optional arcs below N. */
const PEN_PATTERN = /^(?:\d{1,9}|1\.3\.6\.1\.4\.1\.\d{1,9}(?:\.\d{1,10}){0,64})$/;

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
    pen: blankAsUnset(z.string().regex(PEN_PATTERN).optional(), (trimmed) =>
      trimmed.replace(/^\./, '').replace(SYMBOLIC_ARC, `${ENTERPRISE_ARC}.`),
    ).describe(
      'Enterprise number, e.g. "32473", or an OID under 1.3.6.1.4.1 naming it, e.g. "1.3.6.1.4.1.32473.1.2" (a leading dot and the iso.org.dod.internet.private.enterprise prefix are accepted). Pass this or organization, not both.',
    ),
    organization: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against the names of assigned entries, e.g. "cisco systems"; look up a number with pen to see a reserved or unassigned one. Pass this or pen, not both.',
    ),
    limit: limitInput(100, 25),
    offset: offsetInput('organization'),
  }),
  output: z.object({
    mode: z.enum(['pen', 'organization']).describe('Which lookup ran.'),
    found: z.boolean().describe('True when a returned number is assigned to an organization.'),
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
                'reserved ("Reserved"), unassigned ("Unassigned" or "---none---"), else assigned.',
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
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    if ((input.pen === undefined) === (input.organization === undefined)) {
      throw ctx.fail('mode_required', 'Pass exactly one of pen or organization.');
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
      found: enterprises.length > 0,
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
