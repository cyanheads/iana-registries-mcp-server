/**
 * @fileoverview In-memory parsed cache over the IANA files: generic XML
 * registries, the PEN list, the Language Subtag Registry, and the protocol
 * index. Each source loads on first use, stays fresh for 24 h, then revalidates
 * with `If-Modified-Since` (304 re-stamps it). A failed refresh starts a 2-minute
 * hold during which the source is not re-fetched; callers get a copy up to 7 days
 * old marked `stale`, else the failure. Concurrent loads of one source share one
 * promise run under a server-scoped signal and its own 40 s deadline, so no
 * caller's cancellation fails the others; each caller waits within its own
 * budget. Curated sources are pinned; other XML registries sit in a
 * byte-weighted LRU.
 * @module services/registry/registry-store
 */

import { internalError, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import { type CallBudget, createCallBudget, raceBudget } from '../upstream/call-budget.js';
import {
  type ExpectedContent,
  type UpstreamClient,
  type UpstreamResponse,
  upstreamUnreadable,
} from '../upstream/upstream-client.js';
import { parseLanguageRegistry } from './language-registry-parser.js';
import { parsePen } from './pen-parser.js';
import { indexFloorError, parseProtocolIndex } from './protocol-index-parser.js';
import type { LanguageRegistry, Loaded, PenRegistry, ProtocolIndex, XmlRegistry } from './types.js';
import { parseXmlRegistry } from './xml-registry-parser.js';

/** XML registries the curated tools read; pinned, never evicted. */
export const CURATED_REGISTRY_IDS = [
  'service-names-port-numbers',
  'media-types',
  'http-status-codes',
  'http-fields',
  'uri-schemes',
] as const;

/** One of {@link CURATED_REGISTRY_IDS}. */
export type CuratedRegistryId = (typeof CURATED_REGISTRY_IDS)[number];

const IANA = 'https://www.iana.org';
export const PEN_URL = `${IANA}/assignments/enterprise-numbers.txt`;
export const LANGUAGE_REGISTRY_URL = `${IANA}/assignments/language-subtag-registry/language-subtag-registry`;
export const PROTOCOL_INDEX_URL = `${IANA}/protocols`;

/** `https://www.iana.org/assignments/<id>/<id>.xml`, the id path-encoded. */
export function registryXmlUrl(id: string): string {
  const segment = encodeURIComponent(id);
  return `${IANA}/assignments/${segment}/${segment}.xml`;
}

const MiB = 1024 * 1024;
const HOUR_MS = 3_600_000;

/** A source stays fresh this long before it is revalidated. */
export const FRESH_MS = 24 * HOUR_MS;
/** Oldest copy served (marked `stale`) when a refresh fails. */
export const STALE_MAX_MS = 7 * 24 * HOUR_MS;
/** After a failed refresh, the source is not re-fetched for this long. */
export const HOLD_MS = 2 * 60_000;
/** Deadline of one shared load, independent of any caller's budget. */
export const LOAD_DEADLINE_MS = 40_000;
/** A generic registry id IANA answered 404 for is not fetched again for this long. */
export const MISSING_MS = 15 * 60_000;
/** Generic (non-curated) XML registries held at once. */
export const GENERIC_MAX_ENTRIES = 24;
/** Combined decoded source bytes of the generic registries held at once. */
export const GENERIC_MAX_BYTES = 8 * MiB;

const CURATED_MAX_BYTES: Readonly<Record<CuratedRegistryId, number>> = {
  'service-names-port-numbers': 16 * MiB,
  'media-types': 4 * MiB,
  'http-status-codes': 16 * MiB,
  'http-fields': 16 * MiB,
  'uri-schemes': 16 * MiB,
};
const GENERIC_XML_MAX_BYTES = 16 * MiB;

/** How one source is fetched and parsed. */
interface SourceSpec<T> {
  accept: readonly number[];
  expect: ExpectedContent;
  /** Decoded-body ceiling. */
  maxBytes: number;
  parse: (body: string, budget: CallBudget) => T;
  /** The registry's own last-updated date. */
  registryUpdated: (model: T) => string | undefined;
  /** `data.reason` for an unreadable answer. Default `upstream_unreadable`. */
  unreadableReason?: string;
}

interface CacheEntry<T> {
  /** Decoded source size, for the generic LRU's byte cap. */
  bytes: number;
  /** Store-clock time of the last 200 or 304. */
  fetchedAt: number;
  lastModified?: string;
  model: T;
}

type LoadOutcome<T> =
  | { entry: CacheEntry<T>; kind: 'loaded' }
  | { kind: 'missing' }
  | { error: unknown; kind: 'failed' };

/** Cache state of one source. */
interface Slot<T> {
  entry?: CacheEntry<T> | undefined;
  heldError?: unknown;
  /** Store-clock time the post-failure hold ends; 0 when not holding. */
  holdUntil: number;
  /** The shared load in flight; it never rejects (a failure resolves as `failed`). */
  inflight?: Promise<LoadOutcome<T>> | undefined;
  /** `source.registry_id`. */
  readonly key: string;
  readonly spec: SourceSpec<T>;
  readonly url: string;
}

function slot<T>(key: string, url: string, spec: SourceSpec<T>): Slot<T> {
  return { key, url, spec, holdUntil: 0 };
}

/** Constructor options. Every seam a test needs is here, never in env vars. */
export interface RegistryStoreOptions {
  client: UpstreamClient;
  /** Fresh window. Default {@link FRESH_MS}. */
  freshMs?: number;
  /** Clock driving freshness, stale age, and the hold. Default `Date.now`. */
  now?: () => number;
  /** Oldest copy served when a refresh fails. Default {@link STALE_MAX_MS}. */
  staleMaxMs?: number;
}

function isPacerShed(error: unknown): boolean {
  return error instanceof McpError && error.data?.reason === 'pacer_shed';
}

function xmlSpec(
  url: string,
  maxBytes: number,
  accept: readonly number[],
  curated: boolean,
): SourceSpec<XmlRegistry> {
  return {
    accept,
    expect: 'xml',
    maxBytes,
    parse: (body) => {
      const model = parseXmlRegistry(body, url);
      if (curated && model.recordCount === 0)
        throw upstreamUnreadable(`${url} parsed to zero records.`, { url });
      return model;
    },
    registryUpdated: (model) => model.updated,
  };
}

/** Parsed, cached IANA registry sources. */
export class RegistryStore implements Disposable {
  readonly #client: UpstreamClient;
  readonly #freshMs: number;
  readonly #now: () => number;
  readonly #staleMaxMs: number;
  /** Aborted on dispose; every shared load runs under it. */
  readonly #scope = new AbortController();

  readonly #curated: Readonly<Record<CuratedRegistryId, Slot<XmlRegistry>>>;
  /** Insertion order is recency order: the last entry is the most recently used. */
  readonly #generic = new Map<string, Slot<XmlRegistry>>();
  /**
   * Generic ids IANA answered 404 for → store-clock time the memory ends. Every
   * entry lives {@link MISSING_MS}, so insertion order is expiry order.
   */
  readonly #missing = new Map<string, number>();
  readonly #pen: Slot<PenRegistry>;
  readonly #language: Slot<LanguageRegistry>;
  readonly #index: Slot<ProtocolIndex>;

  constructor(options: RegistryStoreOptions) {
    this.#client = options.client;
    this.#now = options.now ?? Date.now;
    this.#freshMs = options.freshMs ?? FRESH_MS;
    this.#staleMaxMs = options.staleMaxMs ?? STALE_MAX_MS;

    this.#curated = Object.fromEntries(
      CURATED_REGISTRY_IDS.map((id) => {
        const url = registryXmlUrl(id);
        return [id, slot(id, url, xmlSpec(url, CURATED_MAX_BYTES[id], [200, 304], true))];
      }),
    ) as Record<CuratedRegistryId, Slot<XmlRegistry>>;

    this.#pen = slot('enterprise-numbers', PEN_URL, {
      accept: [200, 304],
      expect: 'text',
      maxBytes: 16 * MiB,
      parse: (body) => parsePen(body, PEN_URL),
      registryUpdated: (model) => model.updated,
    });

    this.#language = slot('language-subtag-registry', LANGUAGE_REGISTRY_URL, {
      accept: [200, 304],
      expect: 'text',
      maxBytes: 4 * MiB,
      parse: (body) => parseLanguageRegistry(body, LANGUAGE_REGISTRY_URL),
      registryUpdated: (model) => model.fileDate,
    });

    this.#index = slot('protocols', PROTOCOL_INDEX_URL, {
      accept: [200, 304],
      expect: 'html',
      maxBytes: 8 * MiB,
      unreadableReason: 'index_unreadable',
      parse: (body, budget) => {
        const index = parseProtocolIndex(body);
        const floorError = indexFloorError(index, PROTOCOL_INDEX_URL);
        if (floorError) {
          logger.warning(
            'Protocol index parse fell under the floor; not cached',
            withExtra(budget.context, {
              registryIds: index.registryIds.size,
              entries: index.entries.length,
            }),
          );
          throw floorError;
        }
        return index;
      },
      registryUpdated: () => undefined,
    });
  }

  /** A curated XML registry (pinned). Any 404 or unreadable answer throws `upstream_unreadable`. */
  async getRegistry(id: CuratedRegistryId, budget: CallBudget): Promise<Loaded<XmlRegistry>> {
    return required(await this.#read(this.#curated[id], budget), id);
  }

  /**
   * Any XML registry by exact (case-sensitive) id. `undefined` when IANA answers
   * 404, which is remembered for {@link MISSING_MS}: the id is not fetched again
   * until then. A curated id reads the pinned model; any other id goes through
   * the LRU.
   */
  async findRegistry(id: string, budget: CallBudget): Promise<Loaded<XmlRegistry> | undefined> {
    if (isCuratedRegistryId(id)) return this.getRegistry(id, budget);
    if (this.#isMissing(id)) return;

    let generic = this.#generic.get(id);
    if (generic) this.#generic.delete(id);
    else {
      const url = registryXmlUrl(id);
      generic = slot(id, url, xmlSpec(url, GENERIC_XML_MAX_BYTES, [200, 304, 404], false));
    }
    this.#generic.set(id, generic);

    const loaded = await this.#read(generic, budget);
    if (!loaded) this.#rememberMissing(id);
    if (!(loaded || generic.entry) && this.#generic.get(id) === generic) this.#generic.delete(id);
    this.#evict();
    return loaded;
  }

  /** The Private Enterprise Number list (pinned). */
  async getPen(budget: CallBudget): Promise<Loaded<PenRegistry>> {
    return required(await this.#read(this.#pen, budget), this.#pen.key);
  }

  /** The Language Subtag Registry (pinned). */
  async getLanguageRegistry(budget: CallBudget): Promise<Loaded<LanguageRegistry>> {
    return required(await this.#read(this.#language, budget), this.#language.key);
  }

  /**
   * The protocol registry index (pinned). A failed load or a parse under the
   * 500-id / 2,000-entry floor throws `index_unreadable` unless a good copy up to
   * 7 days old is held, which answers with `source.stale: true`.
   */
  async getIndex(budget: CallBudget): Promise<Loaded<ProtocolIndex>> {
    return required(await this.#read(this.#index, budget), this.#index.key);
  }

  /** The index if a copy up to 7 days old is held, without loading anything. */
  cachedIndex(): ProtocolIndex | undefined {
    const { entry } = this.#index;
    return entry && this.#now() - entry.fetchedAt <= this.#staleMaxMs ? entry.model : undefined;
  }

  /** True while `id`'s 404 is remembered; an expired memory is dropped. */
  #isMissing(id: string): boolean {
    const until = this.#missing.get(id);
    if (until === undefined) return false;
    if (this.#now() < until) return true;
    this.#missing.delete(id);
    return false;
  }

  /** Remembers `id`'s 404 and drops expired memories (oldest first, since every entry lives the same time). */
  #rememberMissing(id: string): void {
    const now = this.#now();
    this.#missing.delete(id);
    this.#missing.set(id, now + MISSING_MS);
    for (const [key, until] of this.#missing) {
      if (until > now) break;
      this.#missing.delete(key);
    }
  }

  /** Aborts every shared load in flight. Called from `createApp({ teardown })`. */
  dispose(): void {
    this.#scope.abort();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  async #read<T>(source: Slot<T>, budget: CallBudget): Promise<Loaded<T> | undefined> {
    const { entry } = source;
    if (entry && this.#now() - entry.fetchedAt < this.#freshMs)
      return this.#loaded(source, entry, false);
    if (this.#now() < source.holdUntil) return this.#staleOrThrow(source, source.heldError, budget);

    source.inflight ??= this.#load(source).finally(() => {
      source.inflight = undefined;
    });
    const outcome = await raceBudget(source.inflight, budget, `Loading ${source.url}`);
    switch (outcome.kind) {
      case 'loaded':
        return this.#loaded(source, outcome.entry, false);
      case 'missing':
        return;
      case 'failed':
        return this.#staleOrThrow(source, outcome.error, budget);
    }
  }

  /** One shared load under the server scope and its own deadline. Never rejects. */
  async #load<T>(source: Slot<T>): Promise<LoadOutcome<T>> {
    const budget = createCallBudget({
      signal: this.#scope.signal,
      totalMs: LOAD_DEADLINE_MS,
      context: requestContextService.createRequestContext({
        operation: 'RegistryStore.load',
        additionalContext: { source: source.key },
      }),
    });
    const previous = source.entry;
    const { spec } = source;
    try {
      const outcome = await this.#client.request(source.url, {
        budget,
        profile: 'bulk',
        operation: `RegistryStore.load ${source.key}`,
        accept: spec.accept,
        expect: spec.expect,
        maxBytes: spec.maxBytes,
        ...(spec.unreadableReason ? { unreadableReason: spec.unreadableReason } : {}),
        ...(previous?.lastModified
          ? { headers: { 'If-Modified-Since': previous.lastModified } }
          : {}),
        parse: (response) => this.#outcomeOf(source, previous, response, budget),
      });
      if (outcome.kind === 'loaded') {
        source.entry = outcome.entry;
        source.holdUntil = 0;
        source.heldError = undefined;
      } else {
        source.entry = undefined;
      }
      return outcome;
    } catch (error) {
      const holds = !(this.#scope.signal.aborted || isPacerShed(error));
      if (holds) {
        source.holdUntil = this.#now() + HOLD_MS;
        source.heldError = error;
      }
      logger.warning(
        `Load of ${source.url} failed`,
        withExtra(budget.context, {
          error: error instanceof Error ? error.message : String(error),
          holdMs: holds ? HOLD_MS : 0,
        }),
      );
      return { kind: 'failed', error };
    }
  }

  #outcomeOf<T>(
    source: Slot<T>,
    previous: CacheEntry<T> | undefined,
    response: UpstreamResponse,
    budget: CallBudget,
  ): Exclude<LoadOutcome<T>, { kind: 'failed' }> {
    if (response.status === 404) return { kind: 'missing' };
    if (response.status === 304) {
      if (!previous) {
        throw upstreamUnreadable(
          `${source.url} answered 304 to an unconditional request.`,
          { url: source.url },
          source.spec.unreadableReason ? { reason: source.spec.unreadableReason } : {},
        );
      }
      return { kind: 'loaded', entry: { ...previous, fetchedAt: this.#now() } };
    }
    const lastModified = response.headers.get('last-modified');
    return {
      kind: 'loaded',
      entry: {
        model: source.spec.parse(response.body, budget),
        fetchedAt: this.#now(),
        bytes: response.bytes,
        ...(lastModified ? { lastModified } : {}),
      },
    };
  }

  /** Serves a copy up to `staleMaxMs` old marked stale (with a warning log), else throws `error`. */
  #staleOrThrow<T>(source: Slot<T>, error: unknown, budget: CallBudget): Loaded<T> {
    const { entry } = source;
    if (!entry || this.#now() - entry.fetchedAt > this.#staleMaxMs) throw error;
    logger.warning(
      `Serving a stale copy of ${source.url}; the latest refresh failed`,
      withExtra(budget.context, { fetchedAt: new Date(entry.fetchedAt).toISOString() }),
    );
    return this.#loaded(source, entry, true);
  }

  #loaded<T>(source: Slot<T>, entry: CacheEntry<T>, stale: boolean): Loaded<T> {
    const updated = source.spec.registryUpdated(entry.model);
    return {
      model: entry.model,
      source: {
        registry_id: source.key,
        url: source.url,
        fetched_at: new Date(entry.fetchedAt).toISOString(),
        stale,
        ...(updated ? { registry_updated: updated } : {}),
      },
    };
  }

  /**
   * Drops least-recently-used generic registries past the entry or byte cap; the
   * newest always stays. Only slots holding a model count, so a 404 or a failed
   * first load never evicts a cached registry. An empty slot is kept only while a
   * load is in flight or its post-failure hold runs.
   */
  #evict(): void {
    const now = this.#now();
    for (const [id, generic] of this.#generic) {
      if (!(generic.entry || generic.inflight) && now >= generic.holdUntil)
        this.#generic.delete(id);
    }
    const cached = [...this.#generic].filter(([, generic]) => generic.entry);
    let count = cached.length;
    let bytes = 0;
    for (const [, generic] of cached) bytes += generic.entry?.bytes ?? 0;
    for (const [id, generic] of cached) {
      if (count <= 1) return;
      if (count <= GENERIC_MAX_ENTRIES && bytes <= GENERIC_MAX_BYTES) return;
      this.#generic.delete(id);
      count--;
      bytes -= generic.entry?.bytes ?? 0;
    }
  }
}

/** True for one of {@link CURATED_REGISTRY_IDS}. */
export function isCuratedRegistryId(id: string): id is CuratedRegistryId {
  return (CURATED_REGISTRY_IDS as readonly string[]).includes(id);
}

/** Narrows a read whose accept-list excludes 404 (so it can never be missing). */
function required<T>(loaded: Loaded<T> | undefined, key: string): Loaded<T> {
  if (!loaded)
    throw internalError(`${key} resolved as missing although its accept-list excludes 404.`);
  return loaded;
}

let _store: RegistryStore | undefined;

/** Constructs the process-wide store. Called from `createApp({ setup })`. */
export function initRegistryStore(options: RegistryStoreOptions): RegistryStore {
  _store = new RegistryStore(options);
  return _store;
}

/** The process-wide store. */
export function getRegistryStore(): RegistryStore {
  if (!_store)
    throw new Error('RegistryStore not initialized — call initRegistryStore() in setup()');
  return _store;
}
