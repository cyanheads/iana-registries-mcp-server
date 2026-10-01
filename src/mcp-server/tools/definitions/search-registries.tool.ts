/**
 * @fileoverview `iana_search_registries` — find IANA protocol registries and
 * sub-registries by keyword over the protocol registry index (titles,
 * categories, ids). Returns the ids `iana_get_registry_records` reads.
 * @module mcp-server/tools/definitions/search-registries
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryStore } from '@/services/registry/registry-store.js';
import { compileQuery, matchesQuery } from '@/services/registry/search-text.js';
import type { IndexEntry } from '@/services/registry/types.js';
import { startCallBudget } from '@/services/upstream/call-budget.js';
import { discloseList, echo, listEnrichment } from '../shared/list-enrichment.js';
import { inline, sourceLines, url } from '../shared/markdown.js';
import { limitInput, SourceSchema, searchWords } from '../shared/schemas.js';

function toRegistry(entry: IndexEntry) {
  return {
    registry_id: entry.registryId,
    ...(entry.subregistryId ? { subregistry_id: entry.subregistryId } : {}),
    title: entry.title,
    category: entry.category,
    ...(entry.registrationProcedure ? { registration_procedure: entry.registrationProcedure } : {}),
    defining_documents: entry.definingDocuments,
    page_url: entry.pageUrl,
    xml_url: entry.xmlUrl,
  };
}

export const searchRegistries = tool('iana_search_registries', {
  title: 'Search IANA registries',
  description:
    'Find IANA protocol registries and sub-registries by keyword over their titles and protocol categories, e.g. "tls cipher", "dns resource record", "ip protocol numbers". Returns the registry and sub-registry ids that iana_get_registry_records reads, with registration procedure and defining documents. Covers every registry linked from the IANA protocol registries index.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .preprocess((value) => (typeof value === 'string' ? value.trim() : value), searchWords())
      .describe(
        'Words matched as whole tokens against registry titles, categories, and ids, e.g. "tls cipher". An exact registry or sub-registry id ranks first.',
      ),
    limit: limitInput(50, 20),
  }),
  output: z.object({
    registries: z
      .array(
        z
          .object({
            registry_id: z
              .string()
              .describe('Registry id to pass as registry to iana_get_registry_records.'),
            subregistry_id: z
              .string()
              .optional()
              .describe('Sub-registry id to pass as subregistry to iana_get_registry_records.'),
            title: z.string().describe('Registry or sub-registry title.'),
            category: z.string().describe('Protocol category the index lists the entry under.'),
            registration_procedure: z
              .string()
              .optional()
              .describe('Registration procedure from the index, e.g. "IETF Review".'),
            defining_documents: z
              .array(
                z
                  .object({
                    id: z.string().describe('Document id, e.g. "RFC8446".'),
                    title: z.string().optional().describe('Document title.'),
                    url: z.string().optional().describe('Link to the document via iana.org.'),
                  })
                  .describe('A defining document.'),
              )
              .describe('Documents that define the registry.'),
            page_url: z.string().describe('The registry page on iana.org.'),
            xml_url: z.string().describe('The registry XML file.'),
          })
          .describe('One registry or sub-registry index entry.'),
      )
      .describe('Matching index entries: exact id hits first, then index order.'),
    source: SourceSchema,
  }),
  enrichment: listEnrichment,
  errors: [
    {
      reason: 'index_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The IANA protocol index page could not be read, or it listed far fewer registries than a complete index holds, and no good copy up to 7 days old is cached.',
      recovery:
        'The IANA registry index could not be read; call iana_get_registry_records directly with a known registry id such as tls-parameters.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue is too full for the call to start in time.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_search_registries again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    const budget = startCallBudget(ctx);
    const { model, source } = await getRegistryStore().getIndex(budget);

    const query = compileQuery(input.query);
    const wanted = input.query.toLowerCase();
    const isExact = (entry: IndexEntry) =>
      entry.registryId.toLowerCase() === wanted || entry.subregistryId?.toLowerCase() === wanted;
    const exact = model.entries.filter(isExact);
    const rest = model.entries.filter(
      (entry) => !isExact(entry) && matchesQuery(entry.searchText, query),
    );
    const matches = [...exact, ...rest];
    const registries = matches.slice(0, input.limit).map(toRegistry);
    const more = matches.length > registries.length;

    discloseList(ctx.enrich, {
      total: matches.length,
      shown: registries.length,
      cap: input.limit,
      more,
      fragments: [
        matches.length === 0 &&
          `No registry title matched "${echo(input.query)}". Use the protocol's name or acronym (e.g. "DHCP options"); the curated tools cover ports, media types, HTTP status codes and fields, URI schemes, enterprise numbers, and language tags.`,
        more &&
          `Showing ${registries.length} of ${matches.length} matching registries; add words to query to narrow, or raise limit (max 50).`,
      ],
    });
    return { registries, source };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const entry of result.registries) {
      lines.push(`### ${inline(entry.title)}`);
      const sub = entry.subregistry_id ? ` · **Subregistry:** \`${entry.subregistry_id}\`` : '';
      lines.push(`**Registry:** \`${entry.registry_id}\`${sub}`);
      lines.push(`**Category:** ${inline(entry.category)}`);
      if (entry.registration_procedure) {
        lines.push(`**Registration procedure:** ${inline(entry.registration_procedure)}`);
      }
      if (entry.defining_documents.length > 0) {
        lines.push('**Defining documents:**');
        for (const doc of entry.defining_documents) {
          const title = doc.title ? ` — ${inline(doc.title)}` : '';
          const link = doc.url ? ` <${url(doc.url)}>` : '';
          lines.push(`- ${inline(doc.id)}${title}${link}`);
        }
      }
      lines.push(`**Page:** <${url(entry.page_url)}> · **XML:** <${url(entry.xml_url)}>`, '');
    }
    lines.push(...sourceLines(result.source));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
