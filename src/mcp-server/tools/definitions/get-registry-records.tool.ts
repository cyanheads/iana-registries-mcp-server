/**
 * @fileoverview `iana_get_registry_records` — read and filter records from any
 * IANA XML registry by id. Reads a known id without the protocol index (the
 * index is consulted only to fix a mis-cased id after a 404), pages through an
 * explicit 48,000-character records budget with per-field and per-record caps,
 * and binds every cursor to the filters that minted it.
 * @module mcp-server/tools/definitions/get-registry-records
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import {
  getRegistryStore,
  LANGUAGE_REGISTRY_URL,
  PEN_URL,
  type RegistryStore,
} from '@/services/registry/registry-store.js';
import { tablesOf } from '@/services/registry/registry-tables.js';
import { compileQuery, matchesQuery } from '@/services/registry/search-text.js';
import type {
  Loaded,
  ProtocolIndex,
  RegistrationRange,
  RegistryNote,
  RegistryRecord,
  RegistryTable,
  XmlRegistry,
} from '@/services/registry/types.js';
import { type CallBudget, startCallBudget } from '@/services/upstream/call-budget.js';
import { discloseList, echo, listEnrichment } from '../shared/list-enrichment.js';
import {
  datesLine,
  inline,
  joinLines,
  quote,
  referenceLines,
  sourceLines,
} from '../shared/markdown.js';
import {
  blankAsUnset,
  limitInput,
  ReferenceSchema,
  SourceSchema,
  searchWords,
} from '../shared/schemas.js';

/** A registry id or an iana.org/assignments URL (optionally with a `#<sub-registry>` fragment). */
const REGISTRY_INPUT =
  /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}|https?:\/\/(?:www\.)?iana\.org\/assignments\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(?:\/[^\s#]*)?(?:#[A-Za-z0-9_][A-Za-z0-9_.-]{0,99})?)$/;
const REGISTRY_URL =
  /^https?:\/\/(?:www\.)?iana\.org\/assignments\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})(?:\/[^\s#]*)?(?:#([A-Za-z0-9_][A-Za-z0-9_.-]{0,99}))?$/;

/** Ids IANA publishes only as plain text, each read by a curated tool. A `Map`, so a caller's id never reaches an object prototype. */
const PLAIN_TEXT_REGISTRIES: ReadonlyMap<string, { file: string; tool: string }> = new Map([
  ['enterprise-numbers', { file: PEN_URL, tool: 'iana_lookup_pen' }],
  ['language-subtag-registry', { file: LANGUAGE_REGISTRY_URL, tool: 'iana_lookup_language_tag' }],
]);

/** The registry date a cursor may carry; any other `u` is ignored. */
const CURSOR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Serialized `records` array ceiling per page. */
const RECORDS_BUDGET = 48_000;
/** Combined note text on the first page. */
const NOTES_BUDGET = 4_000;
/** Longest field value returned; a longer one is cut to this length, ending in `…`. */
const FIELD_MAX = 2_000;
/** Most fields one record keeps. */
const MAX_FIELDS = 16;
/** Most references a table or a record keeps (probed maximum: 9, on a record). */
const MAX_REFERENCES = 25;
/** Most registration ranges a table keeps (probed maximum: 8). */
const MAX_RANGES = 25;
/** Most sub-registries a listing or an `unknown_subregistry` error names (probed maximum: 127). */
const MAX_SUBREGISTRIES = 250;

/** Splits the `registry` input into an id and an optional URL fragment. */
function parseRegistryInput(registry: string): { fragment?: string; id: string } {
  const match = REGISTRY_URL.exec(registry);
  if (!match?.[1]) return { id: registry };
  return { id: match[1], ...(match[2] ? { fragment: match[2] } : {}) };
}

/** Cuts text to {@link FIELD_MAX} characters ending in `…`, never splitting a surrogate pair. */
function capText(text: string): { cut: boolean; text: string } {
  if (text.length <= FIELD_MAX) return { cut: false, text };
  let end = FIELD_MAX - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { cut: true, text: `${text.slice(0, end)}…` };
}

/** {@link capText}'s text, for a value whose cut is disclosed by its ending `…` alone. */
const capped = (text: string) => capText(text).text;

/** A table's ranges, at most {@link MAX_RANGES}, each text capped. */
function capRanges(ranges: readonly RegistrationRange[]): RegistrationRange[] {
  return ranges.slice(0, MAX_RANGES).map(({ range, procedure, note }) => ({
    range: capped(range),
    ...(procedure ? { procedure: capped(procedure) } : {}),
    ...(note ? { note: capped(note) } : {}),
  }));
}

/** `Showing the first {max} of {total} {noun}.` when a list was cut at `max`. */
const cutNotice = (total: number, max: number, noun: string) =>
  total > max && `Showing the first ${max} of ${total} ${noun}.`;

function toRecordOutput(record: RegistryRecord) {
  const fields: Record<string, string> = {};
  const cutFields: string[] = [];
  Object.entries(record.fields).forEach(([name, text], index) => {
    if (index >= MAX_FIELDS) {
      cutFields.push(name);
      return;
    }
    const cut = capText(text);
    fields[name] = cut.text;
    if (cut.cut) cutFields.push(name);
  });
  return {
    ...(record.value !== undefined ? { value: capped(record.value) } : {}),
    fields,
    references: record.references.slice(0, MAX_REFERENCES),
    ...(record.registered ? { registered: record.registered } : {}),
    ...(record.updated ? { updated: record.updated } : {}),
    ...(cutFields.length > 0 ? { cut_fields: cutFields } : {}),
  };
}

type RecordOutput = ReturnType<typeof toRecordOutput>;

/** Notes up to {@link NOTES_BUDGET} characters of text; the note that crosses it is cut. */
function capNotes(notes: readonly RegistryNote[]): { notes: RegistryNote[]; truncated: boolean } {
  const kept: RegistryNote[] = [];
  let used = 0;
  for (const note of notes) {
    const room = NOTES_BUDGET - used;
    if (note.text.length > room) {
      if (room > 1) kept.push({ ...note, text: `${note.text.slice(0, room - 1)}…` });
      return { notes: kept, truncated: true };
    }
    kept.push(note);
    used += note.text.length;
  }
  return { notes: kept, truncated: false };
}

/** The table's key column: `value`, else `number`, else the first column. */
function keyColumn(table: RegistryTable): string | undefined {
  if (table.columns.includes('value')) return 'value';
  if (table.columns.includes('number')) return 'number';
  return table.columns[0];
}

const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();
const DECIMAL_RANGE = /^(\d{1,15})-(\d{1,15})$/;

/** Exact key match (trimmed, case- and whitespace-insensitive); a decimal also matches `a-b` rows. */
function valueMatcher(value: string): (record: RegistryRecord) => boolean {
  const wanted = squash(value);
  const decimal = /^\d{1,15}$/.test(wanted) ? Number(wanted) : undefined;
  return (record) => {
    if (record.value === undefined) return false;
    const key = squash(record.value);
    if (key === wanted) return true;
    if (decimal === undefined) return false;
    const range = DECIMAL_RANGE.exec(key);
    return range !== null && Number(range[1]) <= decimal && decimal <= Number(range[2]);
  };
}

/** True for the framework's `invalid_cursor` rejection, whose hint names `nextCursor`, not this tool's `next_cursor`. */
function isInvalidCursor(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.InvalidParams &&
    (error.data as { reason?: unknown } | undefined)?.reason === 'invalid_cursor'
  );
}

/** A cursor offset or limit this tool could have minted: a non-negative safe integer. */
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Short FNV-1a fingerprint of the filters a cursor belongs to. */
function filterKey(parts: readonly string[]): string {
  const text = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A table with no records that points at a file published outside the XML. */
const fileOnly = (table: RegistryTable) => table.records.length === 0 && table.files.length > 0;

/** How a file-only table is published, by its first file's type. */
function publishedAs(table: RegistryTable): string {
  const type = table.files[0]?.type;
  if (type === 'legacy') return 'only as plain text';
  if (type === 'mib') return 'as a MIB module';
  return 'as a separate file';
}

/**
 * The index for the 404 retry, or `undefined` when it cannot be loaded. The
 * caller's cancellation, an exhausted budget, and a rate limit are rethrown:
 * those say "not now", not "no index".
 */
async function indexForRetry(
  store: RegistryStore,
  budget: CallBudget,
  ctx: Context,
): Promise<ProtocolIndex | undefined> {
  try {
    return (await store.getIndex(budget)).model;
  } catch (error) {
    const notNow =
      budget.signal.aborted ||
      (error instanceof McpError &&
        (error.code === JsonRpcErrorCode.Timeout || error.code === JsonRpcErrorCode.RateLimited));
    if (notNow) throw error;
    ctx.log.notice('Protocol index unavailable for the case-insensitive registry id retry', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

/**
 * Reads `requested` without needing the index: a cached index fixes the id's
 * case first; otherwise the id is fetched as given, and only a 404 loads the
 * index for one case-insensitive retry. `undefined` when no registry answers.
 */
async function readRegistry(
  requested: string,
  budget: CallBudget,
  ctx: Context,
): Promise<Loaded<XmlRegistry> | undefined> {
  const store = getRegistryStore();
  const cached = store.cachedIndex();
  const first = cached?.registryIds.get(requested.toLowerCase()) ?? requested;
  const loaded = await store.findRegistry(first, budget);
  if (loaded || cached) return loaded;
  const index = await indexForRetry(store, budget, ctx);
  const canonical = index?.registryIds.get(requested.toLowerCase());
  return canonical && canonical !== first ? store.findRegistry(canonical, budget) : undefined;
}

export const getRegistryRecords = tool('iana_get_registry_records', {
  title: 'Read IANA registry records',
  description:
    'Read records from any IANA XML registry by id, e.g. registry "tls-parameters" with subregistry "tls-parameters-4" (TLS Cipher Suites), "protocol-numbers", "http-methods", or "cbor-tags"; an iana.org/assignments URL also works. Filter with `value` (exact match on the registry\'s key column; a decimal value also matches range rows such as "105-199") and `contains` (words in any field). When a registry has several sub-registries and none is given, the response lists them instead of records. Field names are the registry\'s XML element names (e.g. "rec" is the Recommended column). Large registries page through `cursor`. Find ids with iana_search_registries.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    registry: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string().max(200).regex(REGISTRY_INPUT),
      )
      .describe(
        'Registry id, e.g. "tls-parameters", or its https://www.iana.org/assignments/<id> URL (a #fragment selects the sub-registry when subregistry is unset).',
      ),
    subregistry: blankAsUnset(
      z
        .string()
        .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/)
        .optional(),
    ).describe(
      'Sub-registry id, case-insensitive, e.g. "tls-parameters-4". Omit to read the only sub-registry, or to list them when there are several.',
    ),
    value: blankAsUnset(z.string().max(100).optional()).describe(
      'Exact match on the key column (value, else number, else the first field), ignoring case and whitespace, e.g. "0x13,0x01". A decimal also matches range rows such as "105-199".',
    ),
    contains: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against every field and reference id, e.g. "chacha20".',
    ),
    limit: limitInput(100, 25),
    cursor: blankAsUnset(z.string().max(1_000).optional()).describe(
      'next_cursor from the previous page; reuse it only with the same registry, subregistry, value, and contains.',
    ),
  }),
  output: z.object({
    registry_id: z.string().describe('Registry id.'),
    registry_title: z.string().describe('Registry title.'),
    subregistry_id: z.string().optional().describe('Id of the sub-registry the records come from.'),
    subregistry_title: z.string().optional().describe('Title of that sub-registry.'),
    registration_procedure: z
      .string()
      .optional()
      .describe(
        'Registration rule of the table read, or of the registry when listing; at most 2,000 characters.',
      ),
    description: z
      .string()
      .optional()
      .describe(
        'Description of the table read, or of the registry when listing; a YANG module registry names its module file here. At most 2,000 characters.',
      ),
    references: z
      .array(ReferenceSchema)
      .optional()
      .describe('The documents that define the table read, the first 25.'),
    registration_ranges: z
      .array(
        z
          .object({
            range: z.string().describe('Allocation range, e.g. "0x0000-0xBFFF".'),
            procedure: z.string().optional().describe('Registration procedure.'),
            note: z.string().optional().describe('Note on the range.'),
          })
          .describe('One allocation range.'),
      )
      .optional()
      .describe(
        'Allocation ranges, when the table defines them: the first 25, each text at most 2,000 characters.',
      ),
    notes: z
      .array(
        z
          .object({
            title: z.string().optional().describe('Note title, e.g. "WARNING".'),
            anchor: z.string().optional().describe('Anchor that note references point at.'),
            text: z.string().describe('Note text.'),
          })
          .describe('One registry note.'),
      )
      .describe('Notes of the table read, first page only, 4,000 characters at most.'),
    notes_truncated: z
      .boolean()
      .optional()
      .describe('True when notes were cut at 4,000 characters.'),
    columns: z.array(z.string()).describe('Field (XML element) names seen, first-seen order.'),
    value_field: z.string().optional().describe('The key column the value filter matches.'),
    records: z
      .array(
        z
          .object({
            value: z.string().optional().describe('The record key (value_field column).'),
            fields: z
              .record(z.string(), z.string())
              .describe('Values keyed by XML element name, each capped at 2,000 characters.'),
            references: z
              .array(ReferenceSchema)
              .describe('References on the record, the first 25.'),
            registered: z.string().optional().describe('Registration date.'),
            updated: z.string().optional().describe('Last-updated date.'),
            cut_fields: z
              .array(z.string())
              .optional()
              .describe('Fields cut at 2,000 characters (ending in …) or past the 16-field cap.'),
          })
          .describe('One registry record.'),
      )
      .describe('Records in registry order, up to limit and a 48,000-character page budget.'),
    subregistries: z
      .array(
        z
          .object({
            id: z.string().describe('Pass as subregistry.'),
            title: z.string().describe('Sub-registry title.'),
            record_count: z.number().describe('Records it holds.'),
          })
          .describe('One sub-registry.'),
      )
      .optional()
      .describe(
        'Present when a sub-registry must be chosen, the first 250; records is then empty.',
      ),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass as cursor, with the same filters, for the next page.'),
    source: SourceSchema,
  }),
  enrichment: listEnrichment,
  errors: [
    {
      reason: 'unknown_registry',
      code: JsonRpcErrorCode.NotFound,
      when: 'The registry XML returns 404 and no case-insensitive index match exists, or the index is unavailable.',
      recovery:
        'Check the registry id spelling, or call iana_search_registries with a keyword to find the registry id.',
      severity: 'notice',
    },
    {
      reason: 'unknown_subregistry',
      code: JsonRpcErrorCode.NotFound,
      when: 'The subregistry id is not in this registry.',
      recovery:
        'Call iana_get_registry_records again with one of the sub-registry ids listed in this error.',
      severity: 'notice',
    },
    {
      reason: 'non_xml_registry',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The registry, or the sub-registry read, holds no XML records and points at a file published separately, such as plain text or a MIB module.',
      recovery:
        'This registry is published outside its XML; for language subtags call iana_lookup_language_tag, for enterprise numbers call iana_lookup_pen, otherwise read the file named in this error or call iana_search_registries for a related XML registry.',
      severity: 'notice',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The cursor is not one this tool returned: malformed, corrupted, or carrying an offset or limit that is not a whole number of zero or more.',
      recovery:
        'Pass the next_cursor value from the previous response unchanged, or omit cursor to start over.',
      severity: 'notice',
    },
    {
      reason: 'cursor_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor was minted for a different registry, subregistry, value, or contains.',
      recovery:
        'Call iana_get_registry_records again without cursor, or reuse a next_cursor only with the filters that produced it.',
      severity: 'notice',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The registry XML could not be read, was not XML, or was larger than this server accepts.',
      recovery:
        'The IANA registry file could not be read; retry iana_get_registry_records in a minute.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own iana.org request queue is too full for the call to start in time.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_get_registry_records again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ totalCount: 0, shown: 0, cap: input.limit, truncated: false });
    const target = parseRegistryInput(input.registry);
    let cursor: ReturnType<typeof decodeCursor> | undefined;
    if (input.cursor !== undefined) {
      try {
        cursor = decodeCursor(input.cursor, ctx);
      } catch (error) {
        if (!isInvalidCursor(error)) throw error;
      }
      if (!(cursor && isCount(cursor.offset) && isCount(cursor.limit))) {
        throw ctx.fail(
          'invalid_cursor',
          'The cursor is expired, corrupted, or not one this tool returned.',
        );
      }
    }

    const plain = PLAIN_TEXT_REGISTRIES.get(target.id.toLowerCase());
    if (plain) {
      throw ctx.fail(
        'non_xml_registry',
        `${target.id} is published only as plain text (${plain.file}), not as an XML registry.`,
        {
          registry: target.id,
          file: plain.file,
          recovery: { hint: `Call ${plain.tool} instead; it reads ${plain.file}.` },
        },
      );
    }

    const budget = startCallBudget(ctx);
    const loaded = await readRegistry(target.id, budget, ctx);
    if (!loaded) {
      throw ctx.fail('unknown_registry', `No IANA XML registry has the id "${target.id}".`, {
        registry: target.id,
      });
    }
    const { model, source } = loaded;

    const tables = tablesOf(model);
    const selectable = tables.filter((table) => table !== model.root || table.records.length > 0);
    const requestedSub = input.subregistry ?? target.fragment;
    let table: RegistryTable | undefined;
    if (requestedSub !== undefined) {
      const wanted = requestedSub.toLowerCase();
      table = tables.find((candidate) => candidate.id.toLowerCase() === wanted);
      if (!table) {
        const ids = selectable.slice(0, MAX_SUBREGISTRIES).map((candidate) => candidate.id);
        const unnamed = selectable.length - ids.length;
        throw ctx.fail(
          'unknown_subregistry',
          `"${requestedSub}" is not a sub-registry of ${inline(model.id)}.`,
          {
            registry: model.id,
            subregistry: requestedSub,
            subregistries: ids,
            recovery: {
              hint:
                ids.length > 0
                  ? `Call iana_get_registry_records again with subregistry set to one of: ${ids.map(inline).join(', ')}${unnamed > 0 ? `; ${unnamed} more are not named here` : ''}.`
                  : `${inline(model.id)} has no sub-registries; call iana_get_registry_records again without subregistry.`,
            },
          },
        );
      }
    } else {
      const withRecords = tables.filter((candidate) => candidate.records.length > 0);
      const withFiles = tables.filter(fileOnly);
      if (withRecords.length === 1) table = withRecords[0];
      else if (model.subregistries.length === 0) table = model.root;
      else if (model.recordCount === 0 && withFiles.length === 1) table = withFiles[0];
    }

    if (table && fileOnly(table)) {
      const urls = table.files.map((file) => file.url);
      const files = urls.map(inline).join(', ');
      throw ctx.fail(
        'non_xml_registry',
        `${inline(table.id)} is published ${publishedAs(table)} (${files}); its XML file holds no records.`,
        {
          registry: model.id,
          ...(table === model.root ? {} : { subregistry: table.id }),
          file: urls[0],
          recovery: {
            hint: `Read ${files} directly, or call iana_search_registries for a related XML registry.`,
          },
        },
      );
    }

    const filters = [model.id, table?.id ?? '', squash(input.value ?? ''), input.contains ?? ''];
    const key = filterKey(filters);
    if (cursor && cursor.q !== key) {
      throw ctx.fail(
        'cursor_mismatch',
        'This cursor was minted for a different registry, subregistry, value, or contains.',
        { registry: model.id },
      );
    }
    const offset = cursor?.offset ?? 0;
    const firstPage = offset === 0;
    const header = {
      registry_id: model.id,
      registry_title: model.title,
    };

    if (!table) {
      const rootNotes = capNotes(firstPage ? model.root.notes : []);
      discloseList(ctx.enrich, {
        total: 0,
        shown: 0,
        cap: input.limit,
        more: false,
        fragments: [
          `This registry has ${selectable.length} sub-registries; call again with subregistry set to one of the listed ids.`,
          cutNotice(selectable.length, MAX_SUBREGISTRIES, 'sub-registries'),
        ],
      });
      return {
        ...header,
        ...(model.root.registrationRule
          ? { registration_procedure: capped(model.root.registrationRule) }
          : {}),
        ...(model.root.description ? { description: capped(model.root.description) } : {}),
        notes: rootNotes.notes,
        ...(rootNotes.truncated ? { notes_truncated: true } : {}),
        columns: [],
        records: [],
        subregistries: selectable.slice(0, MAX_SUBREGISTRIES).map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          record_count: candidate.records.length,
        })),
        source,
      };
    }

    const valueField = keyColumn(table);
    const matchValue = input.value === undefined ? undefined : valueMatcher(input.value);
    const query = input.contains === undefined ? undefined : compileQuery(input.contains);
    const matches = table.records.filter(
      (record) =>
        (!matchValue || matchValue(record)) && (!query || matchesQuery(record.searchText, query)),
    );

    const records: RecordOutput[] = [];
    let used = 2;
    let budgetCut = false;
    let referencesCut = 0;
    for (const match of matches.slice(offset)) {
      if (records.length >= input.limit) break;
      const record = toRecordOutput(match);
      const size = JSON.stringify(record).length + (records.length > 0 ? 1 : 0);
      if (records.length > 0 && used + size > RECORDS_BUDGET) {
        budgetCut = true;
        break;
      }
      records.push(record);
      used += size;
      if (match.references.length > MAX_REFERENCES) referencesCut++;
    }
    const nextOffset = offset + records.length;
    const more = nextOffset < matches.length;
    const nextCursor = more
      ? encodeCursor({
          offset: nextOffset,
          limit: input.limit,
          q: key,
          ...(source.registry_updated ? { u: source.registry_updated } : {}),
        })
      : undefined;

    const remaining = matches.length - nextOffset;
    const missed = [
      input.value !== undefined && `has ${inline(valueField ?? 'key')} "${echo(input.value)}"`,
      input.contains !== undefined && `contains "${echo(input.contains)}"`,
    ]
      .filter(Boolean)
      .join(' and ');
    const missHint =
      input.value === undefined
        ? 'Try fewer or different words.'
        : `Drop ${input.contains === undefined ? 'value' : 'a filter'}, or check the column names listed in columns.`;
    const mintedFor =
      typeof cursor?.u === 'string' && CURSOR_DATE.test(cursor.u) ? cursor.u : undefined;
    discloseList(ctx.enrich, {
      total: matches.length,
      shown: records.length,
      cap: input.limit,
      more,
      fragments: [
        table.records.length === 0 &&
          (model.recordCount === 0
            ? `${inline(table.id)} publishes no records in its XML.`
            : `${inline(table.id)} holds no records.`),
        table.records.length > 0 &&
          matches.length === 0 &&
          `No record in ${inline(table.id)} ${missed}. ${missHint}`,
        matches.length > 0 &&
          offset >= matches.length &&
          `The cursor's offset ${offset} is past the ${matches.length} matching records; call again without cursor to start over.`,
        mintedFor !== undefined &&
          mintedFor !== (source.registry_updated ?? '') &&
          `The registry was updated since this cursor was minted (${inline(mintedFor)} → ${inline(source.registry_updated ?? 'no date')}); record offsets may have shifted.`,
        cutNotice(table.references.length, MAX_REFERENCES, 'table references'),
        cutNotice(table.ranges.length, MAX_RANGES, 'registration ranges'),
        referencesCut > 0 &&
          (referencesCut === 1
            ? `One record on this page lists more than ${MAX_REFERENCES} references; only the first ${MAX_REFERENCES} are shown.`
            : `${referencesCut} records on this page list more than ${MAX_REFERENCES} references; only the first ${MAX_REFERENCES} of each are shown.`),
        more &&
          (budgetCut
            ? `This page stopped at the ${RECORDS_BUDGET.toLocaleString('en-US')}-character output budget after ${records.length} records; ${remaining} more match. Pass next_cursor as cursor to continue.`
            : `${remaining} more records match; pass next_cursor as cursor to continue${input.limit < 100 ? ', or raise limit (max 100)' : ''}.`),
      ],
    });

    const notes = capNotes(firstPage ? table.notes : []);
    const isRoot = table === model.root;
    return {
      ...header,
      ...(isRoot ? {} : { subregistry_id: table.id, subregistry_title: table.title }),
      ...(table.registrationRule ? { registration_procedure: capped(table.registrationRule) } : {}),
      ...(table.description ? { description: capped(table.description) } : {}),
      ...(table.references.length > 0
        ? { references: table.references.slice(0, MAX_REFERENCES) }
        : {}),
      ...(table.ranges.length > 0 ? { registration_ranges: capRanges(table.ranges) } : {}),
      notes: notes.notes,
      ...(notes.truncated ? { notes_truncated: true } : {}),
      columns: table.columns,
      ...(valueField ? { value_field: valueField } : {}),
      records,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      source,
    };
  },

  format: (result) => {
    const lines = [`## ${inline(result.registry_title)} (${inline(result.registry_id)})`];
    if (result.subregistry_id) {
      lines.push(
        `**Sub-registry:** ${inline(result.subregistry_id)} — ${inline(result.subregistry_title ?? '')}`,
      );
    }
    if (result.registration_procedure) {
      lines.push(`**Registration procedure:** ${inline(result.registration_procedure)}`);
    }
    if (result.description) {
      lines.push('', '**Description:**', quote(result.description));
    }
    if (result.references?.length) {
      lines.push('**Registry references:**', ...referenceLines(result.references));
    }
    if (result.registration_ranges?.length) {
      lines.push('**Registration ranges:**');
      for (const range of result.registration_ranges) {
        const procedure = range.procedure ? ` — ${inline(range.procedure)}` : '';
        const note = range.note ? ` (${inline(range.note)})` : '';
        lines.push(`- ${inline(range.range)}${procedure}${note}`);
      }
    }
    for (const note of result.notes) {
      const title = note.title ? ` (${inline(note.title)})` : '';
      const anchor = note.anchor ? ` [anchor ${inline(note.anchor)}]` : '';
      lines.push('', `**Note${title}${anchor}:**`, quote(note.text));
    }
    if (result.notes_truncated) {
      lines.push(
        `*Notes cut at the ${NOTES_BUDGET.toLocaleString('en-US')}-character budget (notes_truncated: true).*`,
      );
    }
    if (result.subregistries) {
      lines.push('', `**Sub-registries (${result.subregistries.length}):**`);
      for (const sub of result.subregistries) {
        lines.push(`- ${inline(sub.id)} — ${inline(sub.title)} (${sub.record_count} records)`);
      }
    }
    if (result.columns.length > 0) {
      const key = result.value_field ? ` · **Key column:** ${inline(result.value_field)}` : '';
      lines.push('', `**Columns:** ${result.columns.map(inline).join(', ')}${key}`);
    }
    result.records.forEach((record, index) => {
      lines.push('', `#### ${inline(record.value ?? `Record ${index + 1}`)}`);
      for (const [name, text] of Object.entries(record.fields)) {
        if (name === result.value_field && text === record.value) continue;
        const [first = '>', ...rest] = quote(text).split('\n');
        lines.push(`> **${inline(name)}:** ${first.slice(2)}`, ...rest);
      }
      const dates = datesLine(record);
      if (dates) lines.push(dates);
      if (record.cut_fields)
        lines.push(`**Cut fields:** ${record.cut_fields.map(inline).join(', ')}`);
      if (record.references.length > 0) {
        lines.push('**References:**', ...referenceLines(record.references));
      }
    });
    if (result.next_cursor) lines.push('', `**Next cursor:** \`${result.next_cursor}\``);
    lines.push('', ...sourceLines(result.source));
    return [{ type: 'text', text: joinLines(lines) }];
  },
});
