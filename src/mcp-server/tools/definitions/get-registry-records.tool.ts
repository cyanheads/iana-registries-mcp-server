/**
 * @fileoverview `iana_get_registry_records` — read and filter records from any
 * IANA XML registry by id. Reads a known id without the protocol index (the
 * index is consulted only to fix a mis-cased id after a 404), keys every row by
 * its table's key column, matches `value` against that column or the one
 * `field` names (signed ranges and scalar hex by number, byte sequences by
 * their width), names the other columns holding a value its key match left out,
 * ranks `contains` hits with an equal field first, pages whole records by limit, and binds
 * every cursor to the filters that minted it. A table's first page also carries
 * the registry root's notes and the tables it nests, and a registry id that
 * names a table inside another registry's file reads that table.
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
import { compileQuery, matchesQuery, normalizeForSearch } from '@/services/registry/search-text.js';
import type {
  Loaded,
  ProtocolIndex,
  RegistryRecord,
  RegistryTable,
  XmlRegistry,
} from '@/services/registry/types.js';
import { valueMatcher } from '@/services/registry/value-matcher.js';
import { type CallBudget, startCallBudget } from '@/services/upstream/call-budget.js';
import {
  discloseList,
  echo,
  exactFirst,
  initializeList,
  listEnrichment,
} from '../shared/list-enrichment.js';
import {
  datesLine,
  inline,
  joinLines,
  literal,
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

/** Splits the `registry` input into an id and an optional URL fragment. */
function parseRegistryInput(registry: string): { fragment?: string; id: string } {
  const match = REGISTRY_URL.exec(registry);
  if (!match?.[1]) return { id: registry };
  return { id: match[1], ...(match[2] ? { fragment: match[2] } : {}) };
}

/** A complete record, keyed by its table's key column when present. */
function toRecordOutput(entry: RegistryRecord, valueField: string | undefined) {
  const key = valueField === undefined ? undefined : entry.fields[valueField];
  return {
    ...(key !== undefined ? { value: key } : {}),
    fields: entry.fields,
    references: entry.references,
    ...(entry.registered ? { registered: entry.registered } : {}),
    ...(entry.updated ? { updated: entry.updated } : {}),
  };
}

type RecordOutput = ReturnType<typeof toRecordOutput>;

/**
 * The id of the sub-registry that `requested` names when the file read for it
 * has another root id, as when IANA moves a registry into a parent and serves
 * the parent's file at the old address; matched case-insensitively.
 */
function tableNamedBy(model: XmlRegistry, requested: string): string | undefined {
  const wanted = requested.toLowerCase();
  if (model.id.toLowerCase() === wanted) return;
  return model.subregistries.find((table) => table.id.toLowerCase() === wanted)?.id;
}

/** The tables nested directly in `table`; a sub-registry without `parentId` sits under the root. */
function nestedIn(model: XmlRegistry, table: RegistryTable): RegistryTable[] {
  const parentId = table === model.root ? undefined : table.id;
  return model.subregistries.filter((candidate) => candidate.parentId === parentId);
}

/** Every table as named in a listing. */
const listTables = (tables: readonly RegistryTable[]) =>
  tables.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    record_count: candidate.records.length,
  }));

/** The table's key column: `value`, else `number`, else the first column. */
function keyColumn(table: RegistryTable): string | undefined {
  if (table.columns.includes('value')) return 'value';
  if (table.columns.includes('number')) return 'number';
  return table.columns[0];
}

const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();

/** `a`, `a and b`, `a, b, and c`. */
function listWords(words: readonly string[]): string {
  return words.length <= 2
    ? words.join(' and ')
    : `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`;
}

/** Every name in a recovery hint. */
const named = (names: readonly string[]) => names.map(inline).join(', ');

/** A column holding a looked-up value, and in how many rows. */
interface Holder {
  name: string;
  rows: number;
}

/**
 * The listed columns other than `skip` with a cell `holds` accepts in `rows`,
 * each with its row count, most rows first (column order on ties).
 */
function holdersOf(
  columns: readonly { name: string; match: (cell: string | undefined) => boolean }[],
  rows: readonly RegistryRecord[],
  skip: string | undefined,
  holds: (record: RegistryRecord) => boolean,
): Holder[] {
  return columns
    .filter(({ name }) => name !== skip)
    .map(({ name, match }) => ({
      name,
      rows: rows.filter((row) => match(row.fields[name]) && holds(row)).length,
    }))
    .filter((holder) => holder.rows > 0)
    .sort((a, b) => b.rows - a.rows);
}

/** `{noun} a (2 rows) holds "v"` or `{noun}s a (2 rows) and b (1 row) hold "v"`. */
function holding(holders: readonly Holder[], value: string, noun: 'Column' | 'column'): string {
  const names = listWords(
    holders.map(({ name, rows }) => `${inline(name)} (${rows} ${rows === 1 ? 'row' : 'rows'})`),
  );
  return holders.length === 1
    ? `${noun} ${names} holds "${echo(value)}"`
    : `${noun}s ${names} hold "${echo(value)}"`;
}

/** The `field` setting that reaches the holders: the one column, or a pointer to the list. */
function fieldFor(holders: readonly Holder[]): string {
  const [only] = holders;
  return holders.length === 1 && only ? inline(only.name) : 'one of those columns';
}

/** The miss hint naming the other columns that hold `value`. */
const holdersHint = (holders: readonly Holder[], value: string) =>
  `${holding(holders, value, 'Column')}; call again with field set to ${fieldFor(holders)}.`;

/** The hit notice for rows a key match skipped because they have no `keyName` cell. */
const keylessHint = (holders: readonly Holder[], keyName: string, value: string) =>
  `Rows with no ${keyName} cell are left out of a key match, and ${holding(holders, value, 'column')} in them; call again with field set to ${fieldFor(holders)} to include them.`;

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

/** One `<note>` or `<footnote>`, as `notes` and `registry_notes` return it. */
const NoteSchema = z
  .object({
    title: z.string().optional().describe('Note title, e.g. "WARNING".'),
    anchor: z.string().optional().describe('Anchor that note references point at.'),
    text: z.string().describe('Note text.'),
  })
  .describe('One registry note.');

export const getRegistryRecords = tool('iana_get_registry_records', {
  title: 'Read IANA registry records',
  description:
    'Read records from any IANA XML registry by id, e.g. registry "tls-parameters" with subregistry "tls-parameters-4" (TLS Cipher Suites), "protocol-numbers", "http-methods", or "cbor-tags"; an iana.org/assignments URL also works. Filter with `value` on the key column or the column `field` names: signed decimal points match exact cells, inclusive ranges and strict open bounds; scalar 0x points also compare with decimal cells and established bare-hex columns. Two-byte 0x points match byte-pair ranges and wildcards with their width preserved. An implicit range-only key match yields a miss and a field pointer when another column holds the value exactly. Filter with `contains` for words in any field; records with an equal field come first. When a registry has several sub-registries and none is given, the response lists them instead of records; a table that nests tables lists them too. Field names are the registry\'s XML element names (e.g. "rec" is the Recommended column). Large registries page through `cursor`. Find ids with iana_search_registries.',
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
      'Match the key column named by value_field (value, else number, else first column), or field when set; case and whitespace are ignored. Signed decimal points compare without precision loss with exact integers, inclusive a-b or a to b ranges, and strict less than / greater than bounds. Decimal input never gains hexadecimal meaning. One 0x token also compares numerically with decimal cells and ranges; bare hex is recognized only in ieee-802-numbers-1/type_hex and ppp-numbers-2/value. Hex byte forms keep their written width: 0x1301, {0x13,0x01}, and 0x13 0x01 find 0x13,0x01; 0x0013 finds 0x00,0x13 but 0x13 does not. Two-byte points also match 0xHH,0xLL-MM, 0xHH,* and 0xAA-BB,* rows. Scalar hex ranges such as 0x11-0xff and literal range equality remain supported. An implicit range-only match with an exact alternate-column hit returns a miss naming field; explicit field selection is authoritative.',
    ),
    field: blankAsUnset(z.string().max(100).optional()).describe(
      'Column for value to match instead of the key column, case-insensitive, one of the names in columns: e.g. "type" for a DNS RR type mnemonic, or "name" for every row of a service name. Ignored without value.',
    ),
    contains: blankAsUnset(searchWords().optional()).describe(
      'Words matched as whole tokens against every field and reference id, e.g. "chacha20". Records with a field equal to the words come first.',
    ),
    limit: limitInput(100, 25),
    cursor: blankAsUnset(z.string().max(1_000).optional()).describe(
      'next_cursor from the previous page; reuse it only with the same registry, subregistry, value, field, and contains.',
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
      .describe('Registration rule of the table read, or of the registry when listing.'),
    description: z
      .string()
      .optional()
      .describe(
        'Description of the table read, or of the registry when listing; a YANG module registry names its module file here.',
      ),
    references: z
      .array(ReferenceSchema)
      .optional()
      .describe('The documents that define the table read.'),
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
      .describe('Allocation ranges, when the table defines them.'),
    notes: z
      .array(NoteSchema)
      .describe('Notes of the table read (of the registry, when listing), first page only.'),
    registry_notes: z
      .array(NoteSchema)
      .optional()
      .describe(
        "The registry root's notes and footnotes, on the first page of a sub-registry read; records cite them by anchor.",
      ),
    notes_truncated: z
      .boolean()
      .optional()
      .describe('Indicates truncated notes when present; omitted for whole notes.'),
    columns: z.array(z.string()).describe('Field (XML element) names seen, in first-seen order.'),
    value_field: z
      .string()
      .optional()
      .describe(
        "The table's key column: each record's value comes from it, and the value filter matches it unless field names another.",
      ),
    records: z
      .array(
        z
          .object({
            value: z
              .string()
              .optional()
              .describe("The record's value_field cell; absent when the record has none."),
            fields: z
              .record(z.string(), z.string())
              .describe('Whole values keyed by XML element name.'),
            references: z.array(ReferenceSchema).describe('References on the record.'),
            registered: z.string().optional().describe('Registration date.'),
            updated: z.string().optional().describe('Last-updated date.'),
            cut_fields: z
              .array(z.string())
              .optional()
              .describe('Names of cut fields when present; omitted for whole records.'),
          })
          .describe('One registry record.'),
      )
      .describe(
        'Whole records in registry order (with contains, records with a field equal to the words first), up to limit.',
      ),
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
        'Tables to read next: every sub-registry when one must be chosen (records is then empty), or the tables nested directly in the table read, on its first page.',
      ),
    offset: z
      .number()
      .optional()
      .describe('Matching records before this page, on pages after the first.'),
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
      reason: 'unknown_field',
      code: JsonRpcErrorCode.NotFound,
      when: 'The field, given with value, is not a column of the table read.',
      recovery:
        'Call iana_get_registry_records again with field set to one of the columns listed in this error, or without field.',
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
      when: 'The cursor was minted for a different registry, subregistry, value, field, or contains.',
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
    input = { ...input, limit: initializeList(ctx.enrich, input.limit, 100) };
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
    const registryId = model.id;

    const tables = tablesOf(model);
    const selectable = tables.filter((table) => table !== model.root || table.records.length > 0);
    const requestedSub = input.subregistry ?? target.fragment ?? tableNamedBy(model, target.id);
    let table: RegistryTable | undefined;
    if (requestedSub !== undefined) {
      const wanted = requestedSub.toLowerCase();
      table = tables.find((candidate) => candidate.id.toLowerCase() === wanted);
      if (!table) {
        const ids = selectable.map((candidate) => candidate.id);
        throw ctx.fail(
          'unknown_subregistry',
          `"${requestedSub}" is not a sub-registry of ${inline(registryId)}.`,
          {
            registry: registryId,
            subregistry: requestedSub,
            subregistries: ids,
            recovery: {
              hint:
                ids.length > 0
                  ? `Call iana_get_registry_records again with subregistry set to one of: ${named(ids)}.`
                  : `${inline(registryId)} has no sub-registries; call iana_get_registry_records again without subregistry.`,
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
    const isRoot = table === model.root;

    if (table && fileOnly(table)) {
      const tableId = table.id;
      const urls = table.files.map((file) => file.url);
      throw ctx.fail(
        'non_xml_registry',
        `${inline(tableId)} is published ${publishedAs(table)} (${named(urls)}); its XML file holds no records.`,
        {
          registry: registryId,
          ...(isRoot ? {} : { subregistry: tableId }),
          file: urls[0],
          recovery: {
            hint: `Read ${urls.map(inline).join(', ')} directly, or call iana_search_registries for a related XML registry.`,
          },
        },
      );
    }

    let field: string | undefined;
    if (
      table &&
      input.value !== undefined &&
      input.field !== undefined &&
      table.records.length > 0
    ) {
      const wanted = input.field.toLowerCase();
      field = table.columns.find((column) => column.toLowerCase() === wanted);
      if (field === undefined) {
        const tableId = table.id;
        const columns = table.columns;
        throw ctx.fail(
          'unknown_field',
          `"${inline(echo(input.field))}" is not a column of ${inline(tableId)}.`,
          {
            registry: registryId,
            ...(isRoot ? {} : { subregistry: tableId }),
            field: input.field,
            columns,
            recovery: {
              hint:
                columns.length > 0
                  ? `Call iana_get_registry_records again with field set to one of: ${named(columns)}.`
                  : `${inline(tableId)} has no columns; call iana_get_registry_records again without field.`,
            },
          },
        );
      }
    }

    /** `exact-first` marks the ranked `contains` order, so a cursor minted before that ranking fails `cursor_mismatch`. */
    const filters = [
      model.id,
      table?.id ?? '',
      squash(input.value ?? ''),
      input.contains ?? '',
      ...(input.contains === undefined ? [] : ['exact-first']),
      ...(field === undefined ? [] : [field.toLowerCase()]),
    ];
    const key = filterKey(filters);
    if (cursor && cursor.q !== key) {
      throw ctx.fail(
        'cursor_mismatch',
        'This cursor was minted for a different registry, subregistry, value, field, or contains.',
        { registry: registryId },
      );
    }
    const offset = cursor?.offset ?? 0;
    const firstPage = offset === 0;
    const header = {
      registry_id: registryId,
      registry_title: model.title,
    };

    if (!table) {
      const unapplied = [
        input.value !== undefined && 'value',
        input.contains !== undefined && 'contains',
        input.field !== undefined && 'field',
      ].filter((name): name is string => typeof name === 'string');
      discloseList(ctx.enrich, {
        total: 0,
        shown: 0,
        cap: input.limit,
        more: false,
        fragments: [
          `This registry has ${selectable.length} sub-registries; call again with subregistry set to one of the listed ids.`,
          unapplied.length > 0 &&
            `${listWords(unapplied)} ${unapplied.length === 1 ? 'was' : 'were'} not applied; filters apply only to the records of one sub-registry.`,
        ],
      });
      return {
        ...header,
        ...(model.root.registrationRule
          ? { registration_procedure: model.root.registrationRule }
          : {}),
        ...(model.root.description ? { description: model.root.description } : {}),
        notes: firstPage ? model.root.notes : [],
        columns: [],
        records: [],
        subregistries: listTables(selectable),
        source,
      };
    }

    const valueField = keyColumn(table);
    const column = field ?? valueField;
    const bareHexColumn = (name: string | undefined) =>
      (table.id === 'ieee-802-numbers-1' && name === 'type_hex') ||
      (table.id === 'ppp-numbers-2' && name === 'value');
    const matchValue =
      input.value === undefined ? undefined : valueMatcher(input.value, bareHexColumn(column));
    const exactValue =
      input.value === undefined
        ? undefined
        : valueMatcher(input.value, bareHexColumn(column), false);
    const query = input.contains === undefined ? undefined : compileQuery(input.contains);
    const passesContains = (record: RegistryRecord) =>
      !query || matchesQuery(record.searchText, query);
    /** Rows with no key cell, which a key match skips; scanned for the value only after a hit. */
    const keyless: RegistryRecord[] = [];
    const filtered = table.records.filter((record) => {
      if (matchValue) {
        const cell = column === undefined ? undefined : record.fields[column];
        if (!matchValue(cell)) {
          if (cell === undefined && column !== undefined && field === undefined) {
            keyless.push(record);
          }
          return false;
        }
      }
      return passesContains(record);
    });
    const words = input.contains === undefined ? undefined : normalizeForSearch(input.contains);
    let matches =
      words === undefined
        ? filtered
        : exactFirst(filtered, (record) =>
            Object.values(record.fields).some((text) => normalizeForSearch(text) === words),
          );
    const holdersIn = (rows: readonly RegistryRecord[], ranges = true) => {
      if (input.value === undefined) return [];
      const value = input.value;
      const matchers = table.columns.map((name) => ({
        name,
        match: valueMatcher(value, bareHexColumn(name), ranges),
      }));
      return holdersOf(matchers, rows, column, passesContains);
    };
    /** An alternate exact cell must not silently resolve to an unrelated key range. */
    if (
      field === undefined &&
      input.value !== undefined &&
      matches.length > 0 &&
      !matches.some((record) =>
        exactValue?.(column === undefined ? undefined : record.fields[column]),
      )
    ) {
      const alternate = holdersIn(table.records, false);
      if (alternate.length > 0) matches = [];
    }
    const holders = matches.length === 0 ? holdersIn(table.records) : [];
    const keylessHolders = matches.length > 0 && keyless.length > 0 ? holdersIn(keyless) : [];

    const records: RecordOutput[] = matches
      .slice(offset, offset + input.limit)
      .map((record) => toRecordOutput(record, valueField));
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
    const columnName = inline(column === undefined ? 'key' : column);
    const missed = listWords(
      [
        input.value !== undefined && `has ${columnName} "${echo(input.value)}"`,
        input.contains !== undefined && `contains "${echo(input.contains)}"`,
      ].filter((phrase): phrase is string => typeof phrase === 'string'),
    );
    const missHint =
      input.value === undefined
        ? 'Try fewer or different words.'
        : holders.length > 0
          ? holdersHint(holders, input.value)
          : `Drop ${input.contains === undefined ? 'value' : 'a filter'}, or check the column names listed in columns.`;
    const keylessNotice =
      input.value !== undefined &&
      keylessHolders.length > 0 &&
      keylessHint(keylessHolders, columnName, input.value);
    const mintedFor =
      typeof cursor?.u === 'string' && CURSOR_DATE.test(cursor.u) ? cursor.u : undefined;
    const tableId = table.id;
    const registryNotes = firstPage && !isRoot ? model.root.notes : [];
    const nested = firstPage ? nestedIn(model, table) : [];
    discloseList(ctx.enrich, {
      total: matches.length,
      shown: records.length,
      cap: input.limit,
      more,
      fragments: [
        table.records.length === 0 &&
          (model.recordCount === 0
            ? `${inline(tableId)} publishes no records in its XML.`
            : `${inline(tableId)} holds no records.`),
        table.records.length === 0 &&
          nested.length > 0 &&
          `It nests ${nested.length} ${nested.length === 1 ? 'table' : 'tables'}; call again with subregistry set to one of the listed ids.`,
        table.records.length > 0 &&
          matches.length === 0 &&
          `No record in ${inline(tableId)} ${missed}. ${missHint}`,
        keylessNotice,
        input.field !== undefined &&
          input.value === undefined &&
          'field applies only with value; it was ignored.',
        matches.length > 0 &&
          offset >= matches.length &&
          `The cursor's offset ${offset} is past the ${matches.length} matching records; call again without cursor to start over.`,
        mintedFor !== undefined &&
          mintedFor !== (source.registry_updated ?? '') &&
          `The registry was updated since this cursor was minted (${inline(mintedFor)} → ${inline(source.registry_updated ?? 'no date')}); record offsets may have shifted.`,
        more &&
          `${remaining} more records match; pass next_cursor as cursor to continue${input.limit < 100 ? ', or raise limit (max 100)' : ''}.`,
      ],
    });

    return {
      ...header,
      ...(isRoot ? {} : { subregistry_id: tableId, subregistry_title: table.title }),
      ...(table.registrationRule ? { registration_procedure: table.registrationRule } : {}),
      ...(table.description ? { description: table.description } : {}),
      ...(table.references.length > 0 ? { references: table.references } : {}),
      ...(table.ranges.length > 0 ? { registration_ranges: table.ranges } : {}),
      notes: firstPage ? table.notes : [],
      ...(registryNotes.length > 0 ? { registry_notes: registryNotes } : {}),
      columns: table.columns,
      ...(valueField === undefined ? {} : { value_field: valueField }),
      records,
      ...(nested.length > 0 ? { subregistries: listTables(nested) } : {}),
      ...(firstPage ? {} : { offset }),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      source,
    };
  },

  format: (result) => {
    const whitespaceSensitive = (text: string) => /[\t\r\n]| {2}|^ | $|`/.test(text);
    const renderText = (text: string) => (whitespaceSensitive(text) ? literal(text) : quote(text));
    const lines = [`## ${inline(result.registry_title)} (${inline(result.registry_id)})`];
    const titled = (title: string | undefined) => (title ? ` — ${inline(title)}` : '');
    if (result.subregistry_id) {
      lines.push(
        `**Sub-registry:** ${inline(result.subregistry_id)}${titled(result.subregistry_title)}`,
      );
    }
    if (result.registration_procedure) {
      if (whitespaceSensitive(result.registration_procedure)) {
        lines.push('', '**Registration procedure:**', literal(result.registration_procedure));
      } else lines.push(`**Registration procedure:** ${inline(result.registration_procedure)}`);
    }
    if (result.description) {
      lines.push('', '**Description:**', renderText(result.description));
    }
    if (result.references?.length) {
      lines.push('**Registry references:**', ...referenceLines(result.references));
    }
    if (result.registration_ranges?.length) {
      lines.push('**Registration ranges:**');
      for (const range of result.registration_ranges) {
        if (
          [range.range, range.procedure, range.note].some(
            (text) => text !== undefined && whitespaceSensitive(text),
          )
        ) {
          lines.push('', '**Range:**', renderText(range.range));
          if (range.procedure) lines.push('**Procedure:**', renderText(range.procedure));
          if (range.note) lines.push('**Range note:**', renderText(range.note));
          continue;
        }
        const procedure = range.procedure ? ` — ${inline(range.procedure)}` : '';
        const note = range.note ? ` (${inline(range.note)})` : '';
        lines.push(`- ${inline(range.range)}${procedure}${note}`);
      }
    }
    const notes = [
      ...result.notes.map((note) => ({ label: 'Note', note })),
      ...(result.registry_notes ?? []).map((note) => ({ label: 'Registry note', note })),
    ];
    for (const { label, note } of notes) {
      const title = note.title ? ` (${inline(note.title)})` : '';
      const anchor = note.anchor ? ` [anchor ${inline(note.anchor)}]` : '';
      lines.push('', `**${label}${title}${anchor}:**`, renderText(note.text));
    }
    if (result.notes_truncated) {
      lines.push('*Notes were truncated (notes_truncated: true).*');
    }
    if (result.subregistries) {
      lines.push('', `**Sub-registries (${result.subregistries.length}):**`);
      for (const sub of result.subregistries) {
        lines.push(`- ${inline(sub.id)}${titled(sub.title)} (${sub.record_count} records)`);
      }
    }
    if (result.columns.length > 0) {
      const key = result.value_field ? ` · **Key column:** ${inline(result.value_field)}` : '';
      lines.push('', `**Columns:** ${result.columns.map(inline).join(', ')}${key}`);
    }
    const before = result.offset ?? 0;
    if (result.offset !== undefined) {
      lines.push('', `**Offset:** ${result.offset} (matching records before this page)`);
    }
    result.records.forEach((record, index) => {
      lines.push('', `#### ${inline(record.value ?? `Record ${before + index + 1}`)}`);
      for (const [name, text] of Object.entries(record.fields)) {
        if (name === result.value_field && text === record.value && !whitespaceSensitive(text))
          continue;
        if (whitespaceSensitive(text)) {
          lines.push('', `**${inline(name)}:**`, literal(text));
          continue;
        }
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
