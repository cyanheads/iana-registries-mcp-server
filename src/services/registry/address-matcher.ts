/**
 * @fileoverview Address containment for IANA columns with IP address semantics.
 * @module services/registry/address-matcher
 */

import { isIPv4, isIPv6 } from 'node:net';

type AddressBits = 32 | 128;

const addressPrefixes = new Map<string, AddressBits>([
  ['ipv4-address-space', 32],
  ['ipv6-address-space-1', 128],
  ['ipv6-unicast-address-assignments', 128],
]);

const specialAddresses = new Map<string, AddressBits>([
  ['iana-ipv4-special-registry-1', 32],
  ['iana-ipv6-special-registry-1', 128],
]);

interface Interval {
  first: bigint;
  last: bigint;
}

interface AddressMatch {
  /** That block has the same endpoints as the query. */
  exact: boolean;
  /** Number of addresses in the narrowest matching block. */
  span: bigint;
}

function knownAddressBits(
  tableId: string,
  column: string | undefined,
  registryId: string | undefined,
): AddressBits | undefined {
  if (column === 'prefix') return addressPrefixes.get(tableId);
  if (column === 'address') return specialAddresses.get(tableId);
  if (column !== 'addr') return;
  if (registryId === 'ipv6-multicast-addresses') return 128;
  return registryId === 'multicast-addresses' || /^multicast-addresses-\d+$/.test(tableId)
    ? 32
    : undefined;
}

/** Whether IANA uses this column for IP blocks, even when a query has no match. */
export function isKnownAddressColumn(
  tableId: string,
  column: string | undefined,
  registryId?: string,
): boolean {
  return knownAddressBits(tableId, column, registryId) !== undefined;
}

function ipv4Number(text: string): number {
  return text.split('.').reduce((number, octet) => number * 256 + Number(octet), 0);
}

function groupsNumber(groups: readonly string[]): bigint {
  return groups.reduce((number, group) => (number << 16n) | BigInt(`0x${group}`), 0n);
}

function addressNumber(text: string, bits: AddressBits): bigint | undefined {
  if (bits === 32) return isIPv4(text) ? BigInt(ipv4Number(text)) : undefined;
  // Scoped interface addresses are not registry identifiers.
  if (text.includes('%') || !isIPv6(text)) return;

  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    const ipv4 = ipv4Number(text.slice(lastColon + 1));
    text = `${text.slice(0, lastColon + 1)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const compressedAt = text.indexOf('::');
  if (compressedAt === -1) return groupsNumber(text.split(':'));
  const left = text.slice(0, compressedAt);
  const right = text.slice(compressedAt + 2);
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  return (
    (groupsNumber(leftGroups) << BigInt((8 - leftGroups.length) * 16)) | groupsNumber(rightGroups)
  );
}

function prefixInterval(address: bigint, hostBits: number): Interval {
  const width = BigInt(hostBits);
  const first = (address >> width) << width;
  return { first, last: first + (1n << width) - 1n };
}

function legacyPrefix(text: string, allowBare: boolean): Interval | undefined {
  const match = /^(\d{1,3})(\/8)?$/.exec(text);
  if (match?.[1] !== undefined && (allowBare || match[2]) && Number(match[1]) <= 255)
    return prefixInterval(BigInt(match[1]) << 24n, 24);
  return undefined;
}

function parseBlock(text: string, bits: AddressBits, allowRange: boolean): Interval | undefined {
  const slash = text.indexOf('/');
  if (slash !== -1) {
    const prefix = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > bits) return;
    const address = addressNumber(text.slice(0, slash), bits);
    return address === undefined ? undefined : prefixInterval(address, bits - Number(prefix));
  }

  const hyphen = allowRange ? text.indexOf('-') : -1;
  if (hyphen !== -1) {
    const first = addressNumber(text.slice(0, hyphen).trimEnd(), bits);
    const last = addressNumber(text.slice(hyphen + 1).trimStart(), bits);
    if (first !== undefined && last !== undefined && first <= last) return { first, last };
    return;
  }

  const address = addressNumber(text, bits);
  return address === undefined ? undefined : { first: address, last: address };
}

/**
 * Compiles a point or prefix for address-bearing XML fields. A cell must parse
 * as a same-family block. Pass the registry id for multicast tables whose ids
 * are not globally unique, and compare cells using note-free text.
 */
export function addressMatcher(
  tableId: string,
  column: string | undefined,
  value: string,
  registryId?: string,
): ((cell: string) => AddressMatch | undefined) | undefined {
  if (column !== 'prefix' && column !== 'address' && column !== 'addr') return;
  const text = value.trim();
  const bits = knownAddressBits(tableId, column, registryId) ?? (text.includes(':') ? 128 : 32);
  const legacyOctet = tableId === 'ipv4-address-space' && column === 'prefix';
  const shorthand = legacyOctet ? legacyPrefix(text, true) : undefined;
  const query = shorthand ?? parseBlock(text, bits, false);
  if (!query) return;

  const querySpan = query.last - query.first + 1n;
  return (cell) => {
    let narrowest: bigint | undefined;
    let start = 0;
    for (;;) {
      const comma = cell.indexOf(',', start);
      const member = (comma === -1 ? cell.slice(start) : cell.slice(start, comma)).trim();
      const block =
        (legacyOctet ? legacyPrefix(member, false) : undefined) ??
        parseBlock(member, bits, shorthand === undefined);
      if (!block) return;
      if (block.first <= query.first && query.last <= block.last) {
        const span = block.last - block.first + 1n;
        if ((!shorthand || span === querySpan) && (narrowest === undefined || span < narrowest))
          narrowest = span;
      }
      if (comma === -1) break;
      start = comma + 1;
    }
    return narrowest === undefined
      ? undefined
      : { exact: narrowest === querySpan, span: narrowest };
  };
}
