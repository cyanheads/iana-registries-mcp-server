/**
 * @fileoverview Reads media type registration templates
 * (`https://www.iana.org/assignments/media-types/<type>/<subtype>`, plain text)
 * and keeps only the three statements `template-statements.ts` extracts. A
 * template is best-effort context for a registry answer that is already
 * complete, so every failure but the caller's cancellation (404, a wrong content
 * type, a body over 256 KiB, an upstream failure, a spent budget, a full pacer
 * queue) returns `fetched: false` instead of failing the call. Successful reads
 * are cached in an LRU of 256 entries for 24 h, without revalidation.
 * @module services/media-template/media-template-reader
 */

import { logger, withExtra } from '@cyanheads/mcp-ts-core/utils';
import type { CallBudget } from '../upstream/call-budget.js';
import type { UpstreamClient } from '../upstream/upstream-client.js';
import { extractTemplateStatements, type TemplateStatements } from './template-statements.js';

/** Templates held at once. */
export const TEMPLATE_CACHE_MAX_ENTRIES = 256;
/** How long a read template is served from cache. */
export const TEMPLATE_TTL_MS = 24 * 3_600_000;
/** Decoded-body ceiling for one template. */
export const TEMPLATE_MAX_BYTES = 256 * 1024;

/** A template read: its statements, or `fetched: false` when it could not be read. */
export interface MediaTemplate extends TemplateStatements {
  fetched: boolean;
}

/** Constructor options. Every seam a test needs is here, never in env vars. */
export interface MediaTemplateReaderOptions {
  client: UpstreamClient;
  /** LRU size. Default {@link TEMPLATE_CACHE_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Clock driving the TTL. Default `Date.now`. */
  now?: () => number;
  /** Cache lifetime. Default {@link TEMPLATE_TTL_MS}. */
  ttlMs?: number;
}

interface CachedTemplate {
  /** Reader-clock time of the read. */
  readAt: number;
  statements: TemplateStatements;
}

/** Cached, best-effort reads of media type registration templates. */
export class MediaTemplateReader {
  readonly #client: UpstreamClient;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #ttlMs: number;
  /** Insertion order is recency order: the last entry is the most recently used. */
  readonly #cache = new Map<string, CachedTemplate>();

  constructor(options: MediaTemplateReaderOptions) {
    this.#client = options.client;
    this.#maxEntries = options.maxEntries ?? TEMPLATE_CACHE_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? TEMPLATE_TTL_MS;
  }

  /**
   * The statements of the template at `url`, inside the caller's budget.
   * Rejects only when the caller's signal aborted; every other failure resolves
   * as `{ fetched: false }` with a warning log.
   */
  async read(url: string, budget: CallBudget): Promise<MediaTemplate> {
    const cached = this.#cache.get(url);
    if (cached) {
      this.#cache.delete(url);
      if (this.#now() - cached.readAt < this.#ttlMs) {
        this.#cache.set(url, cached);
        return { fetched: true, ...cached.statements };
      }
    }

    let statements: TemplateStatements | undefined;
    try {
      statements = await this.#client.request(url, {
        budget,
        profile: 'small',
        operation: 'MediaTemplateReader.read',
        accept: [200, 404],
        expect: 'text',
        maxBytes: TEMPLATE_MAX_BYTES,
        parse: (response) =>
          response.status === 200 ? extractTemplateStatements(response.body) : undefined,
      });
    } catch (error) {
      if (budget.signal.aborted) throw error;
      logger.warning(
        'Media type template could not be read',
        withExtra(budget.context, {
          url,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return { fetched: false };
    }
    if (!statements) {
      logger.warning('Media type template answered 404', withExtra(budget.context, { url }));
      return { fetched: false };
    }

    this.#cache.set(url, { readAt: this.#now(), statements });
    for (const key of this.#cache.keys()) {
      if (this.#cache.size <= this.#maxEntries) break;
      this.#cache.delete(key);
    }
    return { fetched: true, ...statements };
  }
}

let _reader: MediaTemplateReader | undefined;

/** Constructs the process-wide reader. Called from `createApp({ setup })`. */
export function initMediaTemplateReader(options: MediaTemplateReaderOptions): MediaTemplateReader {
  _reader = new MediaTemplateReader(options);
  return _reader;
}

/** The process-wide reader. */
export function getMediaTemplateReader(): MediaTemplateReader {
  if (!_reader)
    throw new Error(
      'MediaTemplateReader not initialized — call initMediaTemplateReader() in setup()',
    );
  return _reader;
}
