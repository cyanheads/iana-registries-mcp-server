/**
 * @fileoverview Table lookup inside a parsed XML registry. The curated tools read
 * one known sub-registry; when IANA renames or drops it, the registry's layout
 * has changed and the answer is unreadable, not empty.
 * @module services/registry/registry-tables
 */

import { upstreamUnreadable } from '../upstream/upstream-client.js';
import type { Loaded, RegistryTable, XmlRegistry } from './types.js';

/** Every table of a registry, root first, then sub-registries depth-first. */
export function tablesOf(registry: XmlRegistry): RegistryTable[] {
  return [registry.root, ...registry.subregistries];
}

/** The table with exactly this id; throws `upstream_unreadable` when the registry has none. */
export function requireTable(loaded: Loaded<XmlRegistry>, tableId: string): RegistryTable {
  const table = tablesOf(loaded.model).find((candidate) => candidate.id === tableId);
  if (!table) {
    throw upstreamUnreadable(
      `${loaded.source.url} has no "${tableId}" sub-registry; the registry layout has changed.`,
      { url: loaded.source.url, subregistry: tableId },
    );
  }
  return table;
}
