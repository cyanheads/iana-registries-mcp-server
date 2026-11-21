/** @fileoverview Generic registry filters, ranking, and matching-row counts for recovery notices. */

import { addressMatcher, isKnownAddressColumn } from '@/services/registry/address-matcher.js';
import {
  compileQuery,
  matchesQuery,
  normalizeForSearch,
  toSearchText,
} from '@/services/registry/search-text.js';
import type { RegistryRecord, RegistryTable } from '@/services/registry/types.js';
import { valueMatcher } from '@/services/registry/value-matcher.js';
import { exactFirst } from './list-enrichment.js';
import { searchWords } from './schemas.js';

/** A column and the number of distinct rows in it that matched. */
export interface Holder {
  name: string;
  rows: number;
}

const retrySearch = searchWords();

/** A missing column on one row never falls through to an inherited property. */
const ownColumn = <T>(columns: Record<string, T> | undefined, name: string | undefined) =>
  columns && name !== undefined && Object.hasOwn(columns, name) ? columns[name] : undefined;

const isBareHexColumn = (tableId: string, column: string | undefined) =>
  (tableId === 'ieee-802-numbers-1' && column === 'type_hex') ||
  (tableId === 'ppp-numbers-2' && column === 'value');

function matchesCell(
  display: string | undefined,
  alternatives: readonly string[] | undefined,
  match: (cell: string | undefined) => boolean,
): boolean {
  return match(display) || alternatives?.some(match) === true;
}

function matchAddress(
  display: string | undefined,
  alternatives: readonly string[] | undefined,
  match: NonNullable<ReturnType<typeof addressMatcher>>,
) {
  let best = display === undefined ? undefined : match(display);
  for (const candidate of alternatives ?? []) {
    const other = match(candidate);
    if (other && (!best || other.span < best.span)) best = other;
  }
  return best;
}

/** Selects and ranks rows before paging. Holder counts apply the original contains filter. */
export function matchRegistryRecords(
  table: RegistryTable,
  registryId: string,
  column: string | undefined,
  explicitField: boolean,
  value: string | undefined,
  contains: string | undefined,
  firstPage: boolean,
) {
  const query = contains === undefined ? undefined : compileQuery(contains);
  const passesContains = (record: RegistryRecord) =>
    !query || matchesQuery(record.searchText, query);
  const words = contains === undefined ? undefined : normalizeForSearch(contains);
  const sortedByContains = (rows: RegistryRecord[]) =>
    words === undefined
      ? rows
      : exactFirst(rows, (record) =>
          Object.values(record.fields).some((text) => normalizeForSearch(text) === words),
        );
  if (value === undefined) {
    return {
      matches: query ? sortedByContains(table.records.filter(passesContains)) : table.records,
      holders: [],
      keylessHolders: [],
      tokenHolders: [],
      addressLookup: false,
    };
  }

  const address = addressMatcher(table.id, column, value, registryId);
  const bareHex = isBareHexColumn(table.id, column);
  const valueMatches = valueMatcher(value, bareHex);
  const valueEquals = valueMatcher(value, bareHex, false);
  const keyless: RegistryRecord[] = [];
  const spans = address ? new Map<RegistryRecord, bigint>() : undefined;
  let hasExact = false;
  let matches = table.records.filter((record) => {
    const cell = ownColumn(record.fields, column);
    if (cell === undefined) {
      if (column !== undefined && !explicitField) keyless.push(record);
      return false;
    }
    const alternatives = ownColumn(record.comparisonValues, column);
    const block = address && matchAddress(cell, alternatives, address);
    if (!block && !matchesCell(cell, alternatives, valueMatches)) return false;
    if (!passesContains(record)) return false;
    if (block) spans?.set(record, block.span);
    if (!explicitField)
      hasExact ||= block?.exact === true || matchesCell(cell, alternatives, valueEquals);
    return true;
  });

  const holdersIn = (rows: readonly RegistryRecord[], ranges: boolean): Holder[] =>
    table.columns
      .filter((name) => name !== column)
      .map((name) => {
        const equivalent = valueMatcher(value, isBareHexColumn(table.id, name), ranges);
        const addressInColumn = addressMatcher(table.id, name, value, registryId);
        let count = 0;
        for (const row of rows) {
          if (!passesContains(row)) continue;
          const cell = ownColumn(row.fields, name);
          const alternatives = ownColumn(row.comparisonValues, name);
          const block = addressInColumn && matchAddress(cell, alternatives, addressInColumn);
          if ((block && (ranges || block.exact)) || matchesCell(cell, alternatives, equivalent))
            count++;
        }
        return { name, rows: count };
      })
      .filter((holder) => holder.rows > 0)
      .sort((a, b) => b.rows - a.rows);

  /** An exact alternate value beats implicit key containment. With an explicit field, it cannot override. */
  if (
    !explicitField &&
    matches.length > 0 &&
    !hasExact &&
    holdersIn(table.records, false).length > 0
  ) {
    matches = [];
  }
  if (spans?.size) {
    matches.sort((a, b) => {
      const left = spans.get(a);
      const right = spans.get(b);
      if (left === undefined) return right === undefined ? 0 : 1;
      if (right === undefined || left < right) return -1;
      return left === right ? 0 : 1;
    });
  } else {
    matches = sortedByContains(matches);
  }

  const holders = matches.length === 0 ? holdersIn(table.records, true) : [];
  const tokenHolders =
    matches.length === 0 && holders.length === 0 && !query && firstPage
      ? tokenHoldersOf(table.records, value)
      : [];
  return {
    matches,
    holders,
    keylessHolders: matches.length > 0 && keyless.length > 0 ? holdersIn(keyless, true) : [],
    tokenHolders,
    addressLookup: address !== undefined && isKnownAddressColumn(table.id, column, registryId),
  };
}

/** Token recovery requires a single field to contain every token. */
function tokenHoldersOf(records: readonly RegistryRecord[], value: string): Holder[] {
  if (!retrySearch.safeParse(value).success) return [];
  const query = compileQuery(value);
  const counts = new Map<string, number>();
  for (const row of records) {
    // A retry must reach the row. Its cached whole-row search text also rules out
    // most rows before we normalize each individual cell.
    if (!matchesQuery(row.searchText, query)) continue;
    for (const [name, text] of Object.entries(row.fields)) {
      if (matchesQuery(toSearchText(text), query)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([name, rows]) => ({ name, rows })).sort((a, b) => b.rows - a.rows);
}
