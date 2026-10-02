/**
 * @fileoverview `iana_get_registry_records` — read and filter records from any
 * IANA XML registry by id. Reads a known id without the protocol index (the
 * index is consulted only to fix a mis-cased id after a 404), keys every row by
 * its table's key column, matches `value` against that column or the one
 * `field` names (numbers by value, `0x` byte sequences by their digits as
 * written), names the other columns holding a value its key match left out,
 * ranks `contains` hits with an equal field first, pages through an explicit
 * 48,000-character records budget with per-field and per-record caps, and binds
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
  Reference,
  RegistrationRange,
  RegistryNote,
  RegistryRecord,
  RegistryTable,
  XmlRegistry,
} from '@/services/registry/types.js';
import { type CallBudget, startCallBudget } from '@/services/upstream/call-budget.js';
import { discloseList, echo, exactFirst, listEnrichment } from '../shared/list-enrichment.js';
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
/** Most names one record's `cut_fields` lists: every kept field cut at {@link FIELD_MAX}, and as many dropped ones. */
const MAX_CUT_FIELDS = 2 * MAX_FIELDS;
/** Most references a table or a record keeps (probed maximum: 9, on a record). */
const MAX_REFERENCES = 25;
/** Most registration ranges a table keeps (probed maximum: 8). */
const MAX_RANGES = 25;
/** Most columns a table lists (probed maximum: 10). */
const MAX_COLUMNS = 50;
/** Most notes the first page returns, notes and registry_notes together (probed maximum: 19). */
const MAX_NOTES = 25;
/** Most sub-registries a listing or an `unknown_subregistry` error names (probed maximum: 127). */
const MAX_SUBREGISTRIES = 250;
/** Most files a `non_xml_registry` error names (probed maximum: 1). */
const MAX_FILES = 25;

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

/**
 * A reference with each text capped. A URL longer than {@link FIELD_MAX} is
 * dropped rather than cut, since a cut URL would lead somewhere else.
 */
function capReference({ type, id, url, section, label }: Reference): Reference {
  return {
    type,
    id: capped(id),
    ...(url && url.length <= FIELD_MAX ? { url } : {}),
    ...(section ? { section: capped(section) } : {}),
    ...(label ? { label: capped(label) } : {}),
  };
}

/** The first {@link MAX_REFERENCES} references, each capped. */
const capReferences = (references: readonly Reference[]) =>
  references.slice(0, MAX_REFERENCES).map(capReference);

/**
 * A record as returned, keyed by its `valueField` cell (absent when the record
 * has none), and whether its `cut_fields` list passed {@link MAX_CUT_FIELDS}.
 */
function toRecordOutput(entry: RegistryRecord, valueField: string | undefined) {
  const key = valueField === undefined ? undefined : entry.fields[valueField];
  const fields: Record<string, string> = {};
  const cutFields: string[] = [];
  Object.entries(entry.fields).forEach(([name, text], index) => {
    if (index >= MAX_FIELDS) {
      cutFields.push(name);
      return;
    }
    const cut = capText(text);
    fields[capped(name)] = cut.text;
    if (cut.cut) cutFields.push(name);
  });
  const record = {
    ...(key !== undefined ? { value: capped(key) } : {}),
    fields,
    references: capReferences(entry.references),
    ...(entry.registered ? { registered: capped(entry.registered) } : {}),
    ...(entry.updated ? { updated: capped(entry.updated) } : {}),
    ...(cutFields.length > 0 ? { cut_fields: cutFields.slice(0, MAX_CUT_FIELDS).map(capped) } : {}),
  };
  return { record, cutFieldsOver: cutFields.length > MAX_CUT_FIELDS };
}

type RecordOutput = ReturnType<typeof toRecordOutput>['record'];

/** A note with its title and anchor capped. */
const capNote = ({ text, anchor, title }: RegistryNote): RegistryNote => ({
  text,
  ...(anchor ? { anchor: capped(anchor) } : {}),
  ...(title ? { title: capped(title) } : {}),
});

/**
 * The table's notes, then the registry root's, sharing the first
 * {@link MAX_NOTES} notes and {@link NOTES_BUDGET} characters of text; the note
 * that crosses the budget is cut. `notice` discloses a count cut, and is `false`
 * when the budget cut the notes first.
 */
function capNotes(
  tableNotes: readonly RegistryNote[],
  rootNotes: readonly RegistryNote[] = [],
): {
  notes: RegistryNote[];
  registryNotes: RegistryNote[];
  notice: string | false;
  truncated: boolean;
} {
  const all = [...tableNotes, ...rootNotes];
  const kept: RegistryNote[] = [];
  let used = 0;
  let truncated = false;
  for (const note of all.slice(0, MAX_NOTES)) {
    const room = NOTES_BUDGET - used;
    if (note.text.length > room) {
      if (room > 1) kept.push(capNote({ ...note, text: `${note.text.slice(0, room - 1)}…` }));
      truncated = true;
      break;
    }
    kept.push(capNote(note));
    used += note.text.length;
  }
  return {
    notes: kept.slice(0, tableNotes.length),
    registryNotes: kept.slice(tableNotes.length),
    notice: !truncated && cutNotice(all.length, MAX_NOTES, 'notes'),
    truncated,
  };
}

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

/** The first {@link MAX_SUBREGISTRIES} tables, as a listing names them. */
const listTables = (tables: readonly RegistryTable[]) =>
  tables.slice(0, MAX_SUBREGISTRIES).map((candidate) => ({
    id: capped(candidate.id),
    title: capped(candidate.title),
    record_count: candidate.records.length,
  }));

/** The table's key column: `value`, else `number`, else the first column. */
function keyColumn(table: RegistryTable): string | undefined {
  if (table.columns.includes('value')) return 'value';
  if (table.columns.includes('number')) return 'number';
  return table.columns[0];
}

const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();
/** Digits as a number reads them: leading zeros dropped, one `0` kept. */
const unpadded = (digits: string) => digits.replace(/^0+(?=.)/, '');
const DIGITS = /^\d+$/;
const DECIMAL_RANGE = /^(\d{1,15})-(\d{1,15})$/;
const HEX_RANGE = /^0x([0-9a-f]+)-0x([0-9a-f]+)$/;
const HEX_TOKEN = /^0x[0-9a-f]+$/i;

/**
 * The digits of a hex-form text, as written and lowercased: `0x` tokens only,
 * comma- or space-separated, optionally braced (`0x1301`, `0x13,0x01`,
 * `{0x13, 0x01}`, `0x13 0x01`). `undefined` for any other text.
 */
function hexForm(text: string): { digits: string; single: boolean } | undefined {
  let body = text.trim();
  if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1).trim();
  const tokens = body.split(/\s*,\s*|\s+/);
  if (!tokens.every((token) => HEX_TOKEN.test(token))) return;
  return {
    digits: tokens
      .map((token) => token.slice(2))
      .join('')
      .toLowerCase(),
    single: tokens.length === 1,
  };
}

/**
 * Exact cell match: trimmed, case- and whitespace-insensitive. A digit string
 * matches a digit cell by number (`0443` finds `443`) and decimal `a-b` cells by
 * numeric bounds, never a hex cell. One `0x` token matches a one-token hex cell
 * by number (`0x5` finds `0x05`) and `0xA-0xB` cells by numeric bounds; any
 * other pair of hex forms compares the digits as written, so `0x1301` finds
 * `0x13,0x01` and `0x13` misses `0x00,0x13`.
 */
function valueMatcher(value: string): (cell: string | undefined) => boolean {
  const wanted = squash(value);
  const digits = DIGITS.test(wanted) ? unpadded(wanted) : undefined;
  const decimal = digits !== undefined && digits.length <= 15 ? Number(digits) : undefined;
  const hex = hexForm(value);
  const point = hex?.single ? unpadded(hex.digits) : undefined;
  const pointValue = point === undefined ? undefined : BigInt(`0x${point}`);
  return (cell) => {
    if (cell === undefined) return false;
    const key = squash(cell);
    if (key === wanted) return true;
    if (digits !== undefined) {
      if (DIGITS.test(key)) return unpadded(key) === digits;
      const range = DECIMAL_RANGE.exec(key);
      return (
        decimal !== undefined &&
        range !== null &&
        Number(range[1]) <= decimal &&
        decimal <= Number(range[2])
      );
    }
    if (!hex) return false;
    const form = hexForm(cell);
    if (form) {
      return point !== undefined && form.single
        ? unpadded(form.digits) === point
        : form.digits === hex.digits;
    }
    if (pointValue === undefined) return false;
    const range = HEX_RANGE.exec(key);
    return (
      range !== null &&
      BigInt(`0x${range[1]}`) <= pointValue &&
      pointValue <= BigInt(`0x${range[2]}`)
    );
  };
}

/** `a`, `a and b`, `a, b, and c`. */
function listWords(words: readonly string[]): string {
  return words.length <= 2
    ? words.join(' and ')
    : `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`;
}

/** `a, b, c`, then `; {r} more are not named here` when `total` passes the names given. */
const namedFirst = (names: readonly string[], total: number) =>
  `${names.map(inline).join(', ')}${total > names.length ? `; ${total - names.length} more are not named here` : ''}`;

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
  columns: readonly string[],
  rows: readonly RegistryRecord[],
  skip: string | undefined,
  holds: (record: RegistryRecord, cell: string | undefined) => boolean,
): Holder[] {
  return columns
    .slice(0, MAX_COLUMNS)
    .filter((name) => name !== skip)
    .map((name) => ({ name, rows: rows.filter((row) => holds(row, row.fields[name])).length }))
    .filter((holder) => holder.rows > 0)
    .sort((a, b) => b.rows - a.rows);
}

/** `{noun} a (2 rows) holds "v"` or `{noun}s a (2 rows) and b (1 row) hold "v"`. */
function holding(holders: readonly Holder[], value: string, noun: 'Column' | 'column'): string {
  const names = listWords(
    holders.map(
      ({ name, rows }) => `${inline(capped(name))} (${rows} ${rows === 1 ? 'row' : 'rows'})`,
    ),
  );
  return holders.length === 1
    ? `${noun} ${names} holds "${echo(value)}"`
    : `${noun}s ${names} hold "${echo(value)}"`;
}

/** The `field` setting that reaches the holders: the one column, or a pointer to the list. */
function fieldFor(holders: readonly Holder[]): string {
  const [only] = holders;
  return holders.length === 1 && only ? inline(capped(only.name)) : 'one of those columns';
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
    'Read records from any IANA XML registry by id, e.g. registry "tls-parameters" with subregistry "tls-parameters-4" (TLS Cipher Suites), "protocol-numbers", "http-methods", or "cbor-tags"; an iana.org/assignments URL also works. Filter with `value` (exact match on the key column, or on the column `field` names; digits compare by number with a cell of digits ("0443" finds "443") and one 0x token with a one-token 0x cell ("0x5" finds "0x05"), each also matching its own kind of range row ("105-199", "0x11-0xff"); other 0x forms compare their digits as written, in any comma, space, or brace spelling) and `contains` (words in any field; records with a field equal to the words come first). When a registry has several sub-registries and none is given, the response lists them instead of records; a table that nests tables lists them too. Field names are the registry\'s XML element names (e.g. "rec" is the Recommended column). Large registries page through `cursor`. Find ids with iana_search_registries.',
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
      'Exact match on the key column named by value_field (value, else number, else the first column), or on field when set; case and whitespace are ignored. A value of digits compares by number with a cell of digits, so "0443" finds "443", and also matches range rows such as "105-199"; it never matches a 0x cell. One 0x token compares by number with a one-token 0x cell, so "0x5" finds "0x05", and also matches range rows such as "0x11-0xff". Any other pair of 0x forms compares the digits as written: "0x1301", "{0x13,0x01}", and "0x13 0x01" all find "0x13,0x01", while "0x13" never finds "0x00,0x13".',
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
      .array(NoteSchema)
      .describe(
        'Notes of the table read (of the registry, when listing), first page only. With registry_notes: the first 25 and 4,000 characters at most, these first.',
      ),
    registry_notes: z
      .array(NoteSchema)
      .optional()
      .describe(
        "The registry root's notes and footnotes, on the first page of a sub-registry read; records cite them by anchor. Shares the notes caps, after notes.",
      ),
    notes_truncated: z
      .boolean()
      .optional()
      .describe('True when notes or registry_notes were cut at 4,000 characters.'),
    columns: z
      .array(z.string())
      .describe('Field (XML element) names seen, first-seen order, the first 50.'),
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
              .describe('Values keyed by XML element name, each capped at 2,000 characters.'),
            references: z
              .array(ReferenceSchema)
              .describe('References on the record, the first 25.'),
            registered: z.string().optional().describe('Registration date.'),
            updated: z.string().optional().describe('Last-updated date.'),
            cut_fields: z
              .array(z.string())
              .optional()
              .describe(
                'Fields cut at 2,000 characters (ending in …) or past the 16-field cap, the first 32.',
              ),
          })
          .describe('One registry record.'),
      )
      .describe(
        'Records in registry order (with contains, records with a field equal to the words first), up to limit and a 48,000-character page budget.',
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
        'Tables to read next, the first 250: every sub-registry when one must be chosen (records is then empty), or the tables nested directly in the table read, on its first page.',
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
    const registryId = capped(model.id);

    const tables = tablesOf(model);
    const selectable = tables.filter((table) => table !== model.root || table.records.length > 0);
    const requestedSub = input.subregistry ?? target.fragment ?? tableNamedBy(model, target.id);
    let table: RegistryTable | undefined;
    if (requestedSub !== undefined) {
      const wanted = requestedSub.toLowerCase();
      table = tables.find((candidate) => candidate.id.toLowerCase() === wanted);
      if (!table) {
        const ids = selectable.slice(0, MAX_SUBREGISTRIES).map((candidate) => capped(candidate.id));
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
                  ? `Call iana_get_registry_records again with subregistry set to one of: ${namedFirst(ids, selectable.length)}.`
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
      const tableId = capped(table.id);
      const urls = table.files.slice(0, MAX_FILES).map((file) => capped(file.url));
      throw ctx.fail(
        'non_xml_registry',
        `${inline(tableId)} is published ${publishedAs(table)} (${namedFirst(urls, table.files.length)}); its XML file holds no records.`,
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
        const tableId = capped(table.id);
        const columns = table.columns.slice(0, MAX_COLUMNS).map(capped);
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
                  ? `Call iana_get_registry_records again with field set to one of: ${namedFirst(columns, table.columns.length)}.`
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
      registry_title: capped(model.title),
    };

    if (!table) {
      const rootNotes = capNotes(firstPage ? model.root.notes : []);
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
          cutNotice(selectable.length, MAX_SUBREGISTRIES, 'sub-registries'),
          rootNotes.notice,
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
        subregistries: listTables(selectable),
        source,
      };
    }

    const valueField = keyColumn(table);
    const column = field ?? valueField;
    const matchValue = input.value === undefined ? undefined : valueMatcher(input.value);
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
    const matches =
      words === undefined
        ? filtered
        : exactFirst(filtered, (record) =>
            Object.values(record.fields).some((text) => normalizeForSearch(text) === words),
          );
    const holdersIn = (rows: readonly RegistryRecord[]) =>
      matchValue
        ? holdersOf(
            table.columns,
            rows,
            column,
            (record, cell) => matchValue(cell) && passesContains(record),
          )
        : [];
    const holders = matches.length === 0 ? holdersIn(table.records) : [];
    const keylessHolders = matches.length > 0 && keyless.length > 0 ? holdersIn(keyless) : [];

    const records: RecordOutput[] = [];
    let used = 2;
    let budgetCut = false;
    let referencesCut = 0;
    let cutFieldsCut = 0;
    for (const match of matches.slice(offset)) {
      if (records.length >= input.limit) break;
      const { record, cutFieldsOver } = toRecordOutput(match, valueField);
      const size = JSON.stringify(record).length + (records.length > 0 ? 1 : 0);
      if (records.length > 0 && used + size > RECORDS_BUDGET) {
        budgetCut = true;
        break;
      }
      records.push(record);
      used += size;
      if (match.references.length > MAX_REFERENCES) referencesCut++;
      if (cutFieldsOver) cutFieldsCut++;
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
    const columnName = inline(column === undefined ? 'key' : capped(column));
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
    const tableId = capped(table.id);
    const notes = capNotes(
      firstPage ? table.notes : [],
      firstPage && !isRoot ? model.root.notes : [],
    );
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
        cutNotice(nested.length, MAX_SUBREGISTRIES, 'sub-registries'),
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
        cutNotice(table.references.length, MAX_REFERENCES, 'table references'),
        cutNotice(table.ranges.length, MAX_RANGES, 'registration ranges'),
        notes.notice,
        cutNotice(table.columns.length, MAX_COLUMNS, 'columns'),
        referencesCut > 0 &&
          (referencesCut === 1
            ? `One record on this page lists more than ${MAX_REFERENCES} references; only the first ${MAX_REFERENCES} are shown.`
            : `${referencesCut} records on this page list more than ${MAX_REFERENCES} references; only the first ${MAX_REFERENCES} of each are shown.`),
        cutFieldsCut > 0 &&
          (cutFieldsCut === 1
            ? `One record on this page has more than ${MAX_CUT_FIELDS} cut fields; its cut_fields names only the first ${MAX_CUT_FIELDS}.`
            : `${cutFieldsCut} records on this page have more than ${MAX_CUT_FIELDS} cut fields; cut_fields names only the first ${MAX_CUT_FIELDS} of each.`),
        more &&
          (budgetCut
            ? `This page stopped at the ${RECORDS_BUDGET.toLocaleString('en-US')}-character output budget after ${records.length} records; ${remaining} more match. Pass next_cursor as cursor to continue.`
            : `${remaining} more records match; pass next_cursor as cursor to continue${input.limit < 100 ? ', or raise limit (max 100)' : ''}.`),
      ],
    });

    return {
      ...header,
      ...(isRoot ? {} : { subregistry_id: tableId, subregistry_title: capped(table.title) }),
      ...(table.registrationRule ? { registration_procedure: capped(table.registrationRule) } : {}),
      ...(table.description ? { description: capped(table.description) } : {}),
      ...(table.references.length > 0 ? { references: capReferences(table.references) } : {}),
      ...(table.ranges.length > 0 ? { registration_ranges: capRanges(table.ranges) } : {}),
      notes: notes.notes,
      ...(notes.registryNotes.length > 0 ? { registry_notes: notes.registryNotes } : {}),
      ...(notes.truncated ? { notes_truncated: true } : {}),
      columns: table.columns.slice(0, MAX_COLUMNS).map(capped),
      ...(valueField === undefined ? {} : { value_field: capped(valueField) }),
      records,
      ...(nested.length > 0 ? { subregistries: listTables(nested) } : {}),
      ...(firstPage ? {} : { offset }),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      source,
    };
  },

  format: (result) => {
    const lines = [`## ${inline(result.registry_title)} (${inline(result.registry_id)})`];
    const titled = (title: string | undefined) => (title ? ` — ${inline(title)}` : '');
    if (result.subregistry_id) {
      lines.push(
        `**Sub-registry:** ${inline(result.subregistry_id)}${titled(result.subregistry_title)}`,
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
    const notes = [
      ...result.notes.map((note) => ({ label: 'Note', note })),
      ...(result.registry_notes ?? []).map((note) => ({ label: 'Registry note', note })),
    ];
    for (const { label, note } of notes) {
      const title = note.title ? ` (${inline(note.title)})` : '';
      const anchor = note.anchor ? ` [anchor ${inline(note.anchor)}]` : '';
      lines.push('', `**${label}${title}${anchor}:**`, quote(note.text));
    }
    if (result.notes_truncated) {
      lines.push(
        `*Notes cut at the ${NOTES_BUDGET.toLocaleString('en-US')}-character budget (notes_truncated: true).*`,
      );
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
