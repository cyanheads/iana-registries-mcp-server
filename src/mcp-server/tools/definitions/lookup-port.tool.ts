/**
 * @fileoverview `iana_lookup_port` — service name and transport protocol port
 * assignments from `service-names-port-numbers`, by port number, exact service
 * name, or keyword. A port with no registered service is a result (found: false
 * plus the registry row it falls in and its RFC 6335 class), never an error.
 * `<assignee>` and `<contact>` are never parsed into the model.
 * @module mcp-server/tools/definitions/lookup-port
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
  digitsToNumber,
  limitInput,
  ReferenceSchema,
  SourceSchema,
  searchWords,
} from '../shared/schemas.js';

/** The registry keeps every row at its root. */
const PORT_TABLE = 'service-names-port-numbers';

const TRANSPORTS = ['tcp', 'udp', 'sctp', 'dccp'] as const;

type PortState = 'assigned' | 'reserved' | 'unassigned' | 'unnamed';

/** The RFC 6335 class of a port. */
function classOf(port: number) {
  if (port <= 1023) return { name: 'system', range: '0-1023' } as const;
  if (port <= 49151) return { name: 'user', range: '1024-49151' } as const;
  return { name: 'dynamic', range: '49152-65535' } as const;
}

const RANGE = /^(\d+)\s*-\s*(\d+)$/;

/** `assigned` with a service name; `reserved`/`unassigned` when the description is exactly that word; else `unnamed`. */
function stateOf(name: string | undefined, description: string | undefined): PortState {
  if (name) return 'assigned';
  const word = description?.trim().toLowerCase();
  if (word === 'reserved' || word === 'unassigned') return word;
  return 'unnamed';
}

function toAssignment(record: RegistryRecord) {
  const { fields } = record;
  const name = fields.name?.trim() || undefined;
  const number = fields.number?.trim();
  const transport = fields.protocol?.trim();
  return {
    ...(name ? { service_name: name } : {}),
    ...(number && /^\d+$/.test(number) ? { port: Number(number) } : {}),
    ...(number && !/^\d+$/.test(number) ? { port_range: number } : {}),
    ...(transport ? { transport } : {}),
    state: stateOf(name, fields.description),
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.note ? { notes: fields.note } : {}),
    ...(fields.unauthorized ? { unauthorized_use: fields.unauthorized } : {}),
    references: record.references,
    ...(record.registered ? { registered: record.registered } : {}),
    ...(record.updated ? { updated: record.updated } : {}),
  };
}

type Assignment = ReturnType<typeof toAssignment>;

/** First port a row covers; port-less rows sort last. */
function startOf(assignment: Assignment): number {
  if (assignment.port !== undefined) return assignment.port;
  const start = assignment.port_range ? /^\d+/.exec(assignment.port_range)?.[0] : undefined;
  return start === undefined ? Number.POSITIVE_INFINITY : Number(start);
}

function byPort(a: Assignment, b: Assignment): number {
  return startOf(a) - startOf(b);
}

/** Exact port rows: named before unnamed, by name, then registry transport order. */
function byNameThenTransport(a: Assignment, b: Assignment): number {
  if ((a.service_name === undefined) !== (b.service_name === undefined)) {
    return a.service_name === undefined ? 1 : -1;
  }
  const byName = (a.service_name ?? '').localeCompare(b.service_name ?? '');
  if (byName !== 0) return byName;
  return transportRank(a.transport) - transportRank(b.transport);
}

function transportRank(transport: string | undefined): number {
  const rank = TRANSPORTS.indexOf((transport?.toLowerCase() ?? '') as (typeof TRANSPORTS)[number]);
  return rank === -1 ? TRANSPORTS.length : rank;
}

function covers(record: RegistryRecord, port: number): boolean {
  const range = RANGE.exec(record.fields.number?.trim() ?? '');
  return range !== null && Number(range[1]) <= port && port <= Number(range[2]);
}

/** Distinct transports of the rows, for notices, through `inline()` (`<protocol>` is upstream text). */
function transportsOf(rows: readonly Assignment[]): string {
  return inline([...new Set(rows.map((row) => row.transport ?? 'no transport'))].join(', '));
}

/** `unassigned within 1002-1007` per row, deduplicated, for the no-service notice, through `inline()`. */
function listedAs(rows: readonly Assignment[]): string {
  const phrases = rows.map(
    (row) => `${row.state}${row.port_range ? ` within ${row.port_range}` : ''}`,
  );
  return inline([...new Set(phrases)].join(' and '));
}

export const lookupPort = tool('iana_lookup_port', {
  title: 'Look up a port assignment',
  description:
    'Look up IANA service name and transport protocol port assignments. Pass exactly one of `port` (a number, 0–65535), `service` (an exact service name such as "postgresql"), or `keyword` (words matched against service names and descriptions). Results list every transport (tcp, udp, sctp, dccp) separately, report the registry range row containing an unassigned port, and classify the port as System (0–1023), User (1024–49151), or Dynamic/Private (49152–65535). Service names registered without a port (DNS-SD names) appear with no port.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    port: blankAsUnset(z.number().int().min(0).max(65535).optional(), digitsToNumber).describe(
      'Port number, 0–65535 (a digit string such as "443" also works). Returns every row for that port plus the range row containing it. Pass exactly one of port, service, or keyword.',
    ),
    service: blankAsUnset(
      z
        .string()
        .regex(/^[A-Za-z0-9+*/._-]{1,15}$/)
        .optional(),
      (trimmed) => trimmed.toLowerCase(),
    ).describe(
      'Exact service name, case-insensitive, up to 15 characters, e.g. "postgresql" or "whois++". Pass exactly one of port, service, or keyword.',
    ),
    keyword: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against service names and descriptions, e.g. "network time". Pass exactly one of port, service, or keyword.',
    ),
    transport: blankAsUnset(z.enum(TRANSPORTS).optional(), (trimmed) =>
      trimmed.toLowerCase(),
    ).describe(
      'Keep only rows for this transport protocol. Rows without a transport (most range rows and every service name without a port) are always kept. Applies to every mode.',
    ),
    limit: limitInput(100, 25),
  }),
  output: z.object({
    mode: z.enum(['port', 'service', 'keyword']).describe('Which lookup ran.'),
    found: z
      .boolean()
      .describe('True when at least one returned row carries a registered service name.'),
    port_class: z
      .object({
        name: z
          .enum(['system', 'user', 'dynamic'])
          .describe('RFC 6335 class: system, user, or dynamic (Dynamic/Private).'),
        range: z.string().describe('The class range, e.g. "0-1023".'),
      })
      .optional()
      .describe('The class of the requested port. Port mode only.'),
    assignments: z
      .array(
        z
          .object({
            service_name: z
              .string()
              .optional()
              .describe('Registered service name. Absent on range rows and unnamed rows.'),
            port: z.number().optional().describe('Port number of a single-port row.'),
            port_range: z
              .string()
              .optional()
              .describe('Port range of a range row, e.g. "1002-1007".'),
            transport: z
              .string()
              .optional()
              .describe('Transport protocol: tcp, udp, sctp, or dccp. Absent on range rows.'),
            state: z
              .enum(['assigned', 'reserved', 'unassigned', 'unnamed'])
              .describe(
                'assigned when a service name is present; reserved or unassigned when the description is exactly that word; else unnamed (e.g. "De-registered").',
              ),
            description: z
              .string()
              .optional()
              .describe('Registry description, verbatim. Absent when the row has none.'),
            notes: z.string().optional().describe('Registry note on the row, verbatim.'),
            unauthorized_use: z
              .string()
              .optional()
              .describe('Known unauthorized use of the port, as the registry records it.'),
            references: z.array(ReferenceSchema).describe('Defining references.'),
            registered: z.string().optional().describe('Registration date, when recorded.'),
            updated: z.string().optional().describe('Last-updated date of the row, when recorded.'),
          })
          .describe('One registry row.'),
      )
      .describe(
        'Matching rows. Port mode: rows for the exact port (by service name, then transport), then range rows containing it. Service and keyword modes: ascending by port, rows without a port last.',
      ),
    source: SourceSchema,
  }),
  enrichment: listEnrichment,
  errors: [
    {
      reason: 'mode_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None, or more than one, of port, service, and keyword was given.',
      recovery: 'Pass exactly one of port, service, or keyword to iana_lookup_port.',
      severity: 'notice',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The port registry file could not be fetched, was over its size ceiling, or parsed to zero records.',
      recovery: 'The IANA registry file could not be read; retry iana_lookup_port in a minute.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue would hold the call longer than its wait budget.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_lookup_port again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    const modes = [input.port, input.service, input.keyword].filter((key) => key !== undefined);
    if (modes.length !== 1) {
      throw ctx.fail('mode_required', 'Pass exactly one of port, service, or keyword.');
    }
    const budget = startCallBudget(ctx);
    const loaded = await getRegistryStore().getRegistry('service-names-port-numbers', budget);
    const { records } = requireTable(loaded, PORT_TABLE);
    const wantedTransport = input.transport;
    const withTransport = (row: Assignment) =>
      wantedTransport === undefined ||
      row.transport === undefined ||
      row.transport.toLowerCase() === wantedTransport;
    const transportNote = wantedTransport ? ` for transport ${wantedTransport}` : '';

    if (input.port !== undefined) {
      const port = input.port;
      const portClass = classOf(port);
      const exact = records
        .filter((record) => record.fields.number?.trim() === String(port))
        .map(toAssignment);
      const ranged = records.filter((record) => covers(record, port)).map(toAssignment);
      const all = [...exact.sort(byNameThenTransport), ...ranged];
      const rows = all.filter(withTransport);
      const named = all.filter((row) => row.service_name !== undefined);
      const assignments = rows.slice(0, input.limit);
      const found = assignments.some((row) => row.service_name !== undefined);
      const more = rows.length > assignments.length;
      const unnamed = rows.length > 0 ? rows : all;
      discloseList(ctx.enrich, {
        total: rows.length,
        shown: assignments.length,
        cap: input.limit,
        more,
        fragments: [
          portClass.name === 'dynamic' &&
            `Port ${port} is in the Dynamic/Private range (49152–65535), which IANA does not assign.`,
          portClass.name !== 'dynamic' &&
            named.length > 0 &&
            !rows.some((row) => row.service_name !== undefined) &&
            `Port ${port} is registered for ${transportsOf(named)}; the transport filter ${wantedTransport} excludes it.`,
          portClass.name !== 'dynamic' &&
            named.length === 0 &&
            unnamed.length > 0 &&
            `Port ${port} has no registered service; the registry lists it as ${listedAs(unnamed)}.`,
          portClass.name !== 'dynamic' &&
            all.length === 0 &&
            `Port ${port} has no row in the IANA port registry.`,
          more &&
            `Showing ${assignments.length} of ${rows.length} rows for port ${port}; raise limit (max 100) to see the rest.`,
        ],
      });
      return {
        mode: 'port' as const,
        found,
        port_class: portClass,
        assignments,
        source: loaded.source,
      };
    }

    if (input.service !== undefined) {
      const service = input.service;
      const named = records
        .filter((record) => record.fields.name?.trim().toLowerCase() === service)
        .map(toAssignment);
      const rows = named.filter(withTransport).sort(byPort);
      const assignments = rows.slice(0, input.limit);
      const more = rows.length > assignments.length;
      discloseList(ctx.enrich, {
        total: rows.length,
        shown: assignments.length,
        cap: input.limit,
        more,
        fragments: [
          named.length === 0 &&
            `No service is registered under the name "${service}". Call iana_lookup_port with keyword set to a word from the protocol's name to search descriptions.`,
          named.length > 0 &&
            rows.length === 0 &&
            `${service} is registered for ${transportsOf(named)}; the transport filter ${wantedTransport} excludes it.`,
          more &&
            `Showing ${assignments.length} of ${rows.length} rows for service ${service}; raise limit (max 100) to see the rest.`,
        ],
      });
      return {
        mode: 'service' as const,
        found: assignments.length > 0,
        assignments,
        source: loaded.source,
      };
    }

    const keyword = input.keyword ?? '';
    const query = compileQuery(keyword);
    const rows = records
      .filter(
        (record) =>
          matchesQuery(record.searchText, query) &&
          matchesQuery(toSearchText(record.fields.name, record.fields.description), query),
      )
      .map(toAssignment)
      .filter(withTransport)
      .sort(byPort);
    const assignments = rows.slice(0, input.limit);
    const more = rows.length > assignments.length;
    discloseList(ctx.enrich, {
      total: rows.length,
      shown: assignments.length,
      cap: input.limit,
      more,
      fragments: [
        rows.length === 0 &&
          `No assignment matched "${echo(keyword)}"${transportNote}. Try fewer or different words, or pass a port number.`,
        more &&
          `Showing ${assignments.length} of ${rows.length} matching rows; raise limit (max 100) or add words to keyword to narrow.`,
      ],
    });
    return {
      mode: 'keyword' as const,
      found: assignments.some((row) => row.service_name !== undefined),
      assignments,
      source: loaded.source,
    };
  },

  format: (result) => {
    const lines = [`**Mode:** ${result.mode} · **Found:** ${result.found}`];
    if (result.port_class) {
      lines.push(`**Port class:** ${result.port_class.name} (${result.port_class.range})`);
    }
    for (const row of result.assignments) {
      const name = row.service_name ? inline(row.service_name) : '(no service name)';
      const where =
        [
          row.port === undefined ? undefined : String(row.port),
          row.port_range ? `ports ${inline(row.port_range)}` : undefined,
        ]
          .filter(Boolean)
          .join(' ') || 'no port';
      const transport = row.transport ? `/${inline(row.transport)}` : '';
      lines.push('', `### ${name} · ${where}${transport}`);
      lines.push(`**State:** ${row.state}`);
      if (row.description) lines.push('**Description:**', quote(row.description));
      if (row.notes) lines.push('**Notes:**', quote(row.notes));
      if (row.unauthorized_use) lines.push('**Unauthorized use:**', quote(row.unauthorized_use));
      const dates = datesLine(row);
      if (dates) lines.push(dates);
      if (row.references.length > 0) {
        lines.push('**References:**', ...referenceLines(row.references));
      }
    }
    lines.push('', ...sourceLines(result.source));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
