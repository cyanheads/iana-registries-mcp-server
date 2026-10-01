/**
 * @fileoverview Tests for `RegistryStore`: first load and source provenance,
 * the 24 h cache with conditional revalidation, the stale serve and the 2-minute
 * hold after a failed refresh, shared loads on the server-scoped signal, the
 * 15-minute memory of a generic id IANA answered 404 for, the
 * generic-registry eviction rule, and the PEN, language-registry and
 * protocol-index sources. Upstream I/O is a `createFetchMock` fake; the store
 * clock is manual, retry timers run on fake timers.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURATED_REGISTRY_IDS,
  FRESH_MS,
  GENERIC_MAX_BYTES,
  GENERIC_MAX_ENTRIES,
  HOLD_MS,
  isCuratedRegistryId,
  LANGUAGE_REGISTRY_URL,
  LOAD_DEADLINE_MS,
  MISSING_MS,
  PEN_URL,
  PROTOCOL_INDEX_URL,
  RegistryStore,
  registryXmlUrl,
  STALE_MAX_MS,
} from '@/services/registry/registry-store.js';
import { LANGUAGE_REGISTRY_TEXT } from '../../fixtures/language-registry.js';
import { PEN_TEXT } from '../../fixtures/pen.js';
import { bigIndexHtml, indexHtmlWith } from '../../fixtures/protocol-index.js';
import {
  curatedXml,
  EMPTY_XML,
  HTTP_STATUS_XML,
  LEGACY_STUB_XML,
  NESTED_XML,
  PORTS_XML,
  sizedXml,
} from '../../fixtures/registry-xml.js';
import {
  asMcpError,
  createHarness,
  hang,
  htmlResponse,
  makeBudget,
  notModified,
  settle as settleWith,
  statusResponse,
  textResponse,
  thrown,
  xmlResponse,
} from '../../shared/upstream-harness.js';

const MiB = 1024 * 1024;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const LAST_MODIFIED = 'Wed, 30 Sep 2026 08:00:00 GMT';
const STATUS_URL = registryXmlUrl('http-status-codes');

type Answer = (request: Request) => Response | Promise<Response>;

/** A store over a scripted upstream with a manual clock. */
function setup(
  storeOptions: { freshMs?: number; staleMaxMs?: number } = {},
  pacing?: Parameters<typeof createHarness>[1],
) {
  let clock = T0;
  const state: { answer: Answer } = {
    answer: () => {
      throw new Error('No upstream answer scripted for this call.');
    },
  };
  const h = createHarness([{ match: /./, respond: (request) => state.answer(request) }], pacing);
  const store = new RegistryStore({ client: h.client, now: () => clock, ...storeOptions });
  return {
    ...h,
    store,
    state,
    advance: (ms: number) => {
      clock += ms;
    },
    clockMs: () => clock,
    /** Number of upstream requests so far. */
    fetches: () => h.http.calls.length,
    /** Request headers of call `index`. */
    header: (index: number, name: string) => h.http.calls[index]?.request.headers.get(name),
  };
}

type Setup = ReturnType<typeof setup>;

const settle = <T>(call: () => Promise<T>, ms?: number) =>
  settleWith(call, (step) => vi.advanceTimersByTimeAsync(step), ms);

const loadStatus = (s: Setup, budget = s.budget()) =>
  s.store.getRegistry('http-status-codes', budget);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('constants and helpers', () => {
  it('pins the five curated registries and recognises them exactly', () => {
    expect([...CURATED_REGISTRY_IDS]).toEqual([
      'service-names-port-numbers',
      'media-types',
      'http-status-codes',
      'http-fields',
      'uri-schemes',
    ]);
    expect(isCuratedRegistryId('media-types')).toBe(true);
    expect(isCuratedRegistryId('Media-Types')).toBe(false);
    expect(isCuratedRegistryId('tls-parameters')).toBe(false);
  });

  it('carries the documented cache constants', () => {
    expect(FRESH_MS).toBe(24 * 3_600_000);
    expect(STALE_MAX_MS).toBe(7 * 24 * 3_600_000);
    expect(HOLD_MS).toBe(120_000);
    expect(LOAD_DEADLINE_MS).toBe(40_000);
    expect(MISSING_MS).toBe(15 * 60_000);
    expect(GENERIC_MAX_ENTRIES).toBe(24);
    expect(GENERIC_MAX_BYTES).toBe(8 * MiB);
  });

  it('builds the XML URL from the path-encoded id', () => {
    expect(registryXmlUrl('tls-parameters')).toBe(
      'https://www.iana.org/assignments/tls-parameters/tls-parameters.xml',
    );
    expect(registryXmlUrl('a b/c?d')).toBe(
      'https://www.iana.org/assignments/a%20b%2Fc%3Fd/a%20b%2Fc%3Fd.xml',
    );
  });
});

describe('first load and provenance', () => {
  it('fetches the curated file once and returns the model with its source', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML, { 'last-modified': LAST_MODIFIED });
    const loaded = await loadStatus(s);
    expect(s.urls()).toEqual([STATUS_URL]);
    expect(loaded.model.id).toBe('http-status-codes');
    expect(loaded.model.recordCount).toBe(4);
    expect(loaded.source).toEqual({
      registry_id: 'http-status-codes',
      url: STATUS_URL,
      registry_updated: '2025-09-15',
      fetched_at: new Date(T0).toISOString(),
      stale: false,
    });
  });

  it('sends a user agent and no conditional header on the first fetch', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML);
    await loadStatus(s);
    expect(s.header(0, 'user-agent')).toContain('iana-registries-mcp-server');
    expect(s.header(0, 'if-modified-since')).toBeNull();
  });

  it('omits registry_updated when the registry carries no date', async () => {
    const s = setup();
    s.state.answer = () =>
      xmlResponse(
        `<registry id="uri-schemes"><title>t</title><record><value>x</value></record></registry>`,
      );
    const { source } = await s.store.getRegistry('uri-schemes', s.budget());
    expect(source).not.toHaveProperty('registry_updated');
  });

  it('serves a second call inside the fresh window from memory', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML);
    const first = await loadStatus(s);
    s.advance(FRESH_MS - 1);
    const second = await loadStatus(s);
    expect(s.fetches()).toBe(1);
    expect(second.model).toBe(first.model);
    expect(second.source.fetched_at).toBe(first.source.fetched_at);
  });

  it('reads each curated id from its own URL and keeps the models apart', async () => {
    const s = setup();
    s.state.answer = (request) =>
      xmlResponse(curatedXml(new URL(request.url).pathname.split('/')[2] ?? 'x'));
    for (const id of CURATED_REGISTRY_IDS) {
      expect((await s.store.getRegistry(id, s.budget())).model.id).toBe(id);
    }
    expect(s.urls()).toEqual(CURATED_REGISTRY_IDS.map((id) => registryXmlUrl(id)));
  });

  it('honors freshMs', async () => {
    const s = setup({ freshMs: 1_000 });
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML);
    await loadStatus(s);
    s.advance(999);
    await loadStatus(s);
    expect(s.fetches()).toBe(1);
    s.advance(1);
    await loadStatus(s);
    expect(s.fetches()).toBe(2);
  });
});

describe('conditional revalidation', () => {
  it('sends If-Modified-Since with the stored Last-Modified once the copy is past its fresh window', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML, { 'last-modified': LAST_MODIFIED });
    await loadStatus(s);
    s.advance(FRESH_MS);
    s.state.answer = () => notModified();
    await loadStatus(s);
    expect(s.header(1, 'if-modified-since')).toBe(LAST_MODIFIED);
  });

  it('on 304 re-stamps fetched_at, keeps the same model, and is not stale', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML, { 'last-modified': LAST_MODIFIED });
    const first = await loadStatus(s);
    s.advance(FRESH_MS + 5_000);
    s.state.answer = () => notModified();
    const second = await loadStatus(s);
    expect(second.model).toBe(first.model);
    expect(second.source.stale).toBe(false);
    expect(second.source.fetched_at).toBe(new Date(T0 + FRESH_MS + 5_000).toISOString());
    s.advance(FRESH_MS - 1);
    await loadStatus(s);
    expect(s.fetches()).toBe(2);
  });

  it('keeps the stored Last-Modified across a 304 for the next revalidation', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML, { 'last-modified': LAST_MODIFIED });
    await loadStatus(s);
    s.state.answer = () => notModified();
    s.advance(FRESH_MS);
    await loadStatus(s);
    s.advance(FRESH_MS);
    await loadStatus(s);
    expect(s.header(2, 'if-modified-since')).toBe(LAST_MODIFIED);
  });

  it('re-fetches unconditionally when the cached copy came without Last-Modified', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML);
    await loadStatus(s);
    s.advance(FRESH_MS);
    await loadStatus(s);
    expect(s.header(1, 'if-modified-since')).toBeNull();
  });

  it('replaces the model when the revalidation returns a new 200', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML, { 'last-modified': LAST_MODIFIED });
    const first = await loadStatus(s);
    s.advance(FRESH_MS);
    s.state.answer = () =>
      xmlResponse(curatedXml('http-status-codes', '2026-09-30'), {
        'last-modified': 'Thu, 01 Oct 2026 00:00:00 GMT',
      });
    const second = await loadStatus(s);
    expect(second.model).not.toBe(first.model);
    expect(second.source.registry_updated).toBe('2026-09-30');
    s.advance(FRESH_MS);
    s.state.answer = () => notModified();
    await loadStatus(s);
    expect(s.header(2, 'if-modified-since')).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
  });

  it('treats a 304 to a request with no cached copy as unreadable', async () => {
    const s = setup();
    s.state.answer = () => notModified();
    const { error } = await settle(() => loadStatus(s));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(failure.message).toContain('304');
  });
});

describe('unreadable curated answers', () => {
  it.each([
    ['an HTML page served 200', () => htmlResponse('<html><title>Page not found</title></html>')],
    ['a 404', () => statusResponse(404, {}, 'Page not found')],
    ['a legacy stub with no records', () => xmlResponse(LEGACY_STUB_XML)],
    ['a well-formed file with no records', () => xmlResponse(EMPTY_XML)],
    ['a body that is not XML', () => xmlResponse('this is not xml at all')],
  ])('throws upstream_unreadable for %s', async (_name, answer) => {
    const s = setup();
    s.state.answer = answer;
    const { error } = await settle(() => loadStatus(s));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('retries the load inside the ladder: three fetches for one failed read', async () => {
    const s = setup();
    s.state.answer = () => htmlResponse('<html/>');
    await settle(() => loadStatus(s));
    expect(s.fetches()).toBe(3);
  });

  it('enforces the 4 MiB ceiling on media-types', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(sizedXml('media-types', 4 * MiB + 1_024));
    const { error } = await settle(() => s.store.getRegistry('media-types', s.budget()));
    expect(asMcpError(error).data).toMatchObject({
      reason: 'upstream_unreadable',
      maxBytes: 4 * MiB,
    });
  });

  it('accepts a media-types file just under its ceiling', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(sizedXml('media-types', 3 * MiB));
    const loaded = await s.store.getRegistry('media-types', s.budget());
    expect(loaded.model.recordCount).toBe(1);
  });
});

describe('findRegistry (generic registries)', () => {
  it('returns a generic registry by exact id', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(NESTED_XML);
    const loaded = await s.store.findRegistry('example-parameters', s.budget());
    expect(s.urls()).toEqual([registryXmlUrl('example-parameters')]);
    expect(loaded?.model.subregistries).toHaveLength(4);
    expect(loaded?.source).toMatchObject({
      registry_id: 'example-parameters',
      url: registryXmlUrl('example-parameters'),
      registry_updated: '2026-08-30',
      stale: false,
    });
  });

  it('returns undefined for a 404 and remembers it for 15 minutes: two calls make one fetch', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(404, {}, 'Page not found');
    expect(await s.store.findRegistry('no-such-registry', s.budget())).toBeUndefined();
    expect(await s.store.findRegistry('no-such-registry', s.budget())).toBeUndefined();
    expect(s.fetches()).toBe(1);
    s.advance(MISSING_MS - 1);
    expect(await s.store.findRegistry('no-such-registry', s.budget())).toBeUndefined();
    expect(s.fetches()).toBe(1);
    s.advance(1);
    expect(await s.store.findRegistry('no-such-registry', s.budget())).toBeUndefined();
    expect(s.fetches()).toBe(2);
  });

  it('remembers each 404 under its own id', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(404);
    await s.store.findRegistry('missing-a', s.budget());
    await s.store.findRegistry('missing-b', s.budget());
    await s.store.findRegistry('missing-a', s.budget());
    expect(s.urls()).toEqual([registryXmlUrl('missing-a'), registryXmlUrl('missing-b')]);
  });

  it('a 404 starts no hold, and an id IANA adds later reads once the 404 window has passed', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(404);
    await s.store.findRegistry('later-added', s.budget());
    s.state.answer = () => xmlResponse(curatedXml('later-added'));
    expect(await s.store.findRegistry('later-added', s.budget())).toBeUndefined();
    s.advance(MISSING_MS);
    expect((await s.store.findRegistry('later-added', s.budget()))?.model.id).toBe('later-added');
    expect(s.fetches()).toBe(2);
  });

  it('remembers a cached registry that a revalidation finds removed', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(NESTED_XML);
    expect(await s.store.findRegistry('example-parameters', s.budget())).toBeDefined();
    s.advance(FRESH_MS);
    s.state.answer = () => statusResponse(404);
    expect(await s.store.findRegistry('example-parameters', s.budget())).toBeUndefined();
    expect(await s.store.findRegistry('example-parameters', s.budget())).toBeUndefined();
    expect(s.fetches()).toBe(2);
  });

  it('is case-sensitive: the id goes to IANA exactly as given', async () => {
    const s = setup();
    s.state.answer = (request) =>
      request.url.includes('/Example-Parameters/') ? statusResponse(404) : xmlResponse(NESTED_XML);
    expect(await s.store.findRegistry('Example-Parameters', s.budget())).toBeUndefined();
    expect(await s.store.findRegistry('example-parameters', s.budget())).toBeDefined();
  });

  it('reads a curated id through the pinned model without a second fetch', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML);
    const viaGet = await loadStatus(s);
    const viaFind = await s.store.findRegistry('http-status-codes', s.budget());
    expect(viaFind?.model).toBe(viaGet.model);
    expect(s.fetches()).toBe(1);
  });

  it('serves a generic registry from memory inside the fresh window and revalidates after it', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(NESTED_XML, { 'last-modified': LAST_MODIFIED });
    const first = await s.store.findRegistry('example-parameters', s.budget());
    s.advance(FRESH_MS - 1);
    const second = await s.store.findRegistry('example-parameters', s.budget());
    expect(second?.model).toBe(first?.model);
    expect(s.fetches()).toBe(1);
    s.advance(1);
    s.state.answer = () => notModified();
    const third = await s.store.findRegistry('example-parameters', s.budget());
    expect(s.header(1, 'if-modified-since')).toBe(LAST_MODIFIED);
    expect(third?.model).toBe(first?.model);
  });

  it('returns a legacy stub to the caller, where a curated read would reject it', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(LEGACY_STUB_XML);
    const loaded = await s.store.findRegistry('example-legacy', s.budget());
    expect(loaded?.model).toMatchObject({ recordCount: 0 });
    expect(loaded?.model.root.files).toEqual([
      {
        type: 'legacy',
        url: 'https://www.iana.org/assignments/example-legacy/example-legacy.txt',
      },
    ]);
  });

  it('returns a titled, well-formed generic file with no records after one fetch', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(EMPTY_XML);
    const loaded = await s.store.findRegistry('example-empty', s.budget());
    expect(loaded?.model).toMatchObject({ id: 'example-empty', recordCount: 0 });
    expect(s.fetches()).toBe(1);
  });

  it('a generic 304 with no cached copy is unreadable, not missing', async () => {
    const s = setup();
    s.state.answer = () => notModified();
    const { error } = await settle(() => s.store.findRegistry('example-parameters', s.budget()));
    expect(asMcpError(error).data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('accepts the 16 MiB generic ceiling and rejects one byte past it', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(sizedXml('big-registry', 16 * MiB + 1_024));
    const { error } = await settle(() => s.store.findRegistry('big-registry', s.budget()));
    expect(asMcpError(error).data).toMatchObject({ maxBytes: 16 * MiB });
  });
});

describe('stale serve and the failed-refresh hold', () => {
  /** Loads status codes, ages the copy past freshness, and makes the upstream fail. */
  async function loadedThenFailing(s: Setup, ageMs = FRESH_MS) {
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML, { 'last-modified': LAST_MODIFIED });
    const first = await loadStatus(s);
    s.advance(ageMs);
    s.state.answer = () => statusResponse(503, {}, 'busy');
    return first;
  }

  it('serves the old copy marked stale when the refresh fails, with the old fetched_at', async () => {
    const s = setup();
    const first = await loadedThenFailing(s);
    const { value } = await settle(() => loadStatus(s));
    expect(value?.model).toBe(first.model);
    expect(value?.source).toMatchObject({ stale: true, fetched_at: new Date(T0).toISOString() });
    expect(s.fetches()).toBe(1 + 3);
  });

  it('holds for 2 minutes: callers get the stale copy with no fetch, then a refetch is allowed', async () => {
    const s = setup();
    const first = await loadedThenFailing(s);
    await settle(() => loadStatus(s));
    const afterFailure = s.fetches();

    s.advance(HOLD_MS - 1);
    const held = await loadStatus(s);
    expect(held.model).toBe(first.model);
    expect(held.source.stale).toBe(true);
    expect(s.fetches()).toBe(afterFailure);

    s.advance(1);
    s.state.answer = () => notModified();
    const recovered = await loadStatus(s);
    expect(s.fetches()).toBe(afterFailure + 1);
    expect(recovered.source.stale).toBe(false);
    expect(recovered.model).toBe(first.model);
  });

  it('a recovered load ends the hold: the next failure starts a new one', async () => {
    const s = setup();
    await loadedThenFailing(s);
    await settle(() => loadStatus(s));
    s.advance(HOLD_MS);
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML, { 'last-modified': LAST_MODIFIED });
    await loadStatus(s);
    const afterRecovery = s.fetches();
    s.advance(FRESH_MS);
    s.state.answer = () => statusResponse(500);
    await settle(() => loadStatus(s));
    const failed = s.fetches();
    expect(failed).toBe(afterRecovery + 3);
    await loadStatus(s);
    expect(s.fetches()).toBe(failed);
  });

  it('serves up to 7 days old and no further; beyond that the failure is thrown', async () => {
    const s = setup();
    await loadedThenFailing(s, STALE_MAX_MS);
    const { value } = await settle(() => loadStatus(s));
    expect(value?.source.stale).toBe(true);

    const old = setup();
    await loadedThenFailing(old, STALE_MAX_MS + 1);
    const { error } = await settle(() => loadStatus(old));
    expect(asMcpError(error).data).toMatchObject({ status: 503 });
  });

  it('honors staleMaxMs', async () => {
    const s = setup({ staleMaxMs: 10_000 });
    await loadedThenFailing(s, FRESH_MS + 10_001);
    const { error } = await settle(() => loadStatus(s));
    expect(asMcpError(error).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('with no copy at all, throws the failure, and the hold replays that same error without fetching', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(502, {}, 'bad gateway');
    const first = await settle(() => loadStatus(s));
    const failure = asMcpError(first.error);
    expect(failure.data).toMatchObject({ status: 502, retryAttempts: 3 });
    expect(s.fetches()).toBe(3);

    s.advance(HOLD_MS - 1);
    const held = await thrown(() => loadStatus(s));
    expect(held).toBe(first.error);
    expect(s.fetches()).toBe(3);

    s.advance(1);
    s.state.answer = () => xmlResponse(HTTP_STATUS_XML);
    const loaded = await loadStatus(s);
    expect(loaded.source.stale).toBe(false);
    expect(s.fetches()).toBe(4);
  });

  it('a stale copy beyond the stale limit during the hold throws the remembered error', async () => {
    const s = setup({ staleMaxMs: 1_000 });
    await loadedThenFailing(s, 2_000 + FRESH_MS);
    const first = await settle(() => loadStatus(s));
    s.advance(10_000);
    expect(await thrown(() => loadStatus(s))).toBe(first.error);
  });

  it('keeps holds per source: a failing registry does not hold another', async () => {
    const s = setup();
    s.state.answer = (request) =>
      request.url.includes('/http-status-codes/')
        ? statusResponse(500)
        : xmlResponse(curatedXml('uri-schemes'));
    await settle(() => loadStatus(s));
    const loaded = await s.store.getRegistry('uri-schemes', s.budget());
    expect(loaded.model.id).toBe('uri-schemes');
  });

  it('does not start a hold for a pacer shed, so the next call fetches again', async () => {
    const s = setup({}, { pacing: { iana: { name: 'iana', maxConcurrent: 1, maxQueueDepth: 0 } } });
    // Occupy the only IANA slot with a request that never answers.
    s.state.answer = hang;
    const occupant = s.client
      .request(PEN_URL, {
        budget: s.budget(),
        profile: 'small',
        operation: 'occupy',
        accept: [200],
        expect: 'text',
        maxBytes: 100,
        parse: (r) => r.body,
      })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const shed = await settle(() => loadStatus(s));
    const failure = asMcpError(shed.error);
    expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(failure.data).toMatchObject({ reason: 'pacer_shed' });
    expect(s.fetches()).toBe(1);

    // Free the slot; with no hold in force the very next call goes to the upstream.
    s.state.answer = (request) =>
      request.url === STATUS_URL ? xmlResponse(HTTP_STATUS_XML) : hang(request);
    await vi.advanceTimersByTimeAsync(30_000);
    await occupant;
    const loaded = await settle(() => loadStatus(s));
    expect(loaded.value?.source.stale).toBe(false);
    expect(s.urls()).toContain(STATUS_URL);
  });
});

describe('shared loads', () => {
  it('concurrent callers of one source share a single fetch and one model', async () => {
    const s = setup();
    s.state.answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return xmlResponse(HTTP_STATUS_XML);
    };
    const calls = [loadStatus(s), loadStatus(s), loadStatus(s)];
    await vi.advanceTimersByTimeAsync(300);
    const [a, b, c] = await Promise.all(calls);
    expect(s.fetches()).toBe(1);
    expect(a?.model).toBe(b?.model);
    expect(b?.model).toBe(c?.model);
  });

  it('different sources load independently and in parallel', async () => {
    const s = setup();
    s.state.answer = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return request.url.includes('http-status-codes')
        ? xmlResponse(HTTP_STATUS_XML)
        : xmlResponse(curatedXml('uri-schemes'));
    };
    const calls = [loadStatus(s), s.store.getRegistry('uri-schemes', s.budget())];
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(calls);
    expect(s.fetches()).toBe(2);
  });

  it('one caller aborting does not fail the others, even the caller that started the load', async () => {
    const s = setup();
    s.state.answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return xmlResponse(HTTP_STATUS_XML);
    };
    const starter = new AbortController();
    const reason = new Error('the first caller went away');
    const first = thrown(() => loadStatus(s, makeBudget(45_000, starter.signal)));
    const second = loadStatus(s);
    await vi.advanceTimersByTimeAsync(100);
    starter.abort(reason);
    expect(await first).toBe(reason);

    await vi.advanceTimersByTimeAsync(400);
    const loaded = await second;
    expect(loaded.model.recordCount).toBe(4);
    expect(loaded.source.stale).toBe(false);
    expect(s.fetches()).toBe(1);

    // The abandoned load still filled the cache.
    await loadStatus(s);
    expect(s.fetches()).toBe(1);
  });

  it('a caller whose own budget runs out gets retry_deadline_exceeded while the load completes for the others', async () => {
    const s = setup();
    s.state.answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return xmlResponse(HTTP_STATUS_XML);
    };
    const impatient = thrown(() => loadStatus(s, makeBudget(100)));
    const patient = loadStatus(s);
    await vi.advanceTimersByTimeAsync(100);
    const error = asMcpError(await impatient);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 100 });

    await vi.advanceTimersByTimeAsync(400);
    expect((await patient).model.recordCount).toBe(4);
    expect(s.fetches()).toBe(1);
  });

  it('runs a load on its own 40 s deadline, not on a caller budget', async () => {
    const s = setup();
    s.state.answer = hang;
    const started = Date.now();
    const { error } = await settle(() => loadStatus(s));
    const failure = asMcpError(error);
    expect(failure.code).toBe(JsonRpcErrorCode.Timeout);
    expect(failure.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      deadlineMs: LOAD_DEADLINE_MS,
    });
    expect(Date.now() - started).toBeLessThanOrEqual(LOAD_DEADLINE_MS + 500);
  });

  it('every waiter on a failed shared load sees the same failure', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(500);
    const results = await Promise.all([settle(() => loadStatus(s)), settle(() => loadStatus(s))]);
    expect(s.fetches()).toBe(3);
    expect(results[0]?.error).toBe(results[1]?.error);
  });

  it('dispose() aborts a load in flight: the caller rejects, nothing is retried and no hold starts', async () => {
    const s = setup();
    s.state.answer = hang;
    const pending = thrown(() => loadStatus(s));
    await vi.advanceTimersByTimeAsync(100);
    s.store.dispose();
    const error = await pending;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.fetches()).toBe(1);
  });

  it('is disposable with `using` semantics', () => {
    const s = setup();
    expect(() => s.store[Symbol.dispose]()).not.toThrow();
  });
});

describe('eviction of generic registries', () => {
  /** Reads generic registry `id`; each id answers its own small file. */
  const read = (s: Setup, id: string) => s.store.findRegistry(id, s.budget());
  const small = (request: Request) => xmlResponse(curatedXml(request.url.split('/').at(-2) ?? 'x'));

  it('holds up to 24 generic registries, then evicts the least recently used', async () => {
    const s = setup();
    s.state.answer = small;
    for (let index = 0; index < GENERIC_MAX_ENTRIES; index++) await read(s, `generic-${index}`);
    expect(s.fetches()).toBe(24);
    for (let index = 0; index < GENERIC_MAX_ENTRIES; index++) await read(s, `generic-${index}`);
    expect(s.fetches()).toBe(24);

    await read(s, 'generic-24');
    expect(s.fetches()).toBe(25);
    await read(s, 'generic-0');
    expect(s.fetches()).toBe(26);
  });

  it('recency, not load order, decides: a read refreshes an entry', async () => {
    const s = setup();
    s.state.answer = small;
    for (let index = 0; index < GENERIC_MAX_ENTRIES; index++) await read(s, `generic-${index}`);
    await read(s, 'generic-0');
    await read(s, 'generic-24');
    const before = s.fetches();
    await read(s, 'generic-0');
    expect(s.fetches()).toBe(before);
    await read(s, 'generic-1');
    expect(s.fetches()).toBe(before + 1);
  });

  it('evicts by combined source bytes past 8 MiB, oldest first', async () => {
    const s = setup();
    s.state.answer = (request) =>
      xmlResponse(sizedXml(request.url.split('/').at(-2) ?? 'x', 3 * MiB));
    await read(s, 'heavy-a');
    await read(s, 'heavy-b');
    expect(s.fetches()).toBe(2);
    await read(s, 'heavy-a');
    await read(s, 'heavy-b');
    expect(s.fetches()).toBe(2);

    await read(s, 'heavy-c');
    expect(s.fetches()).toBe(3);
    await read(s, 'heavy-b');
    await read(s, 'heavy-c');
    expect(s.fetches()).toBe(3);
    await read(s, 'heavy-a');
    expect(s.fetches()).toBe(4);
  });

  it('always keeps the newest entry, even one over the byte cap on its own', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(sizedXml('whale', GENERIC_MAX_BYTES + MiB));
    await read(s, 'whale');
    await read(s, 'whale');
    expect(s.fetches()).toBe(1);
  });

  it('never evicts the curated registries however many generic ones load', async () => {
    const s = setup();
    s.state.answer = (request) =>
      request.url.includes('/http-status-codes/') ? xmlResponse(HTTP_STATUS_XML) : small(request);
    const first = await loadStatus(s);
    for (let index = 0; index < 30; index++) await read(s, `generic-${index}`);
    const again = await loadStatus(s);
    expect(again.model).toBe(first.model);
    expect(s.fetches()).toBe(31);
  });

  it('does not count a 404 id against the cap', async () => {
    const s = setup();
    s.state.answer = (request) =>
      request.url.includes('/missing/') ? statusResponse(404) : small(request);
    for (let index = 0; index < GENERIC_MAX_ENTRIES - 1; index++) await read(s, `generic-${index}`);
    await read(s, 'missing');
    await read(s, 'generic-23');
    const before = s.fetches();
    for (let index = 0; index < GENERIC_MAX_ENTRIES; index++) await read(s, `generic-${index}`);
    expect(s.fetches()).toBe(before);
  });

  it('a 404 probe at full capacity does not evict a cached registry', async () => {
    const s = setup();
    s.state.answer = (request) =>
      request.url.includes('/missing/') ? statusResponse(404) : small(request);
    for (let index = 0; index < GENERIC_MAX_ENTRIES; index++) await read(s, `generic-${index}`);
    await read(s, 'missing');
    const before = s.fetches();
    await read(s, 'generic-0');
    expect(s.fetches()).toBe(before);
  });

  it('a failed load of a never-loaded id leaves nothing behind', async () => {
    const s = setup();
    s.state.answer = (request) =>
      request.url.includes('/broken/') ? statusResponse(500) : small(request);
    await settle(() => read(s, 'broken'));
    for (let index = 0; index < GENERIC_MAX_ENTRIES; index++) await read(s, `generic-${index}`);
    const before = s.fetches();
    for (let index = 0; index < GENERIC_MAX_ENTRIES; index++) await read(s, `generic-${index}`);
    expect(s.fetches()).toBe(before);
  });
});

describe('PEN', () => {
  it('loads enterprise-numbers.txt as text and reports the list date', async () => {
    const s = setup();
    s.state.answer = () => textResponse(PEN_TEXT, { 'last-modified': LAST_MODIFIED });
    const loaded = await s.store.getPen(s.budget());
    expect(s.urls()).toEqual([PEN_URL]);
    expect(loaded.model.maxNumber).toBe(32473);
    expect(loaded.model.withheldCount).toBe(2);
    expect(loaded.source).toEqual({
      registry_id: 'enterprise-numbers',
      url: PEN_URL,
      registry_updated: '2026-09-24',
      fetched_at: new Date(T0).toISOString(),
      stale: false,
    });
  });

  it('caches for 24 h and revalidates with If-Modified-Since', async () => {
    const s = setup();
    s.state.answer = () => textResponse(PEN_TEXT, { 'last-modified': LAST_MODIFIED });
    const first = await s.store.getPen(s.budget());
    s.advance(FRESH_MS - 1);
    await s.store.getPen(s.budget());
    expect(s.fetches()).toBe(1);
    s.advance(1);
    s.state.answer = () => notModified();
    const again = await s.store.getPen(s.budget());
    expect(again.model).toBe(first.model);
    expect(s.header(1, 'if-modified-since')).toBe(LAST_MODIFIED);
  });

  it.each([
    ['an HTML page where text was expected', () => htmlResponse('<html><body>moved</body></html>')],
    ['XML where text was expected', () => xmlResponse('<a/>')],
    ['a body with no records', () => textResponse('PRIVATE ENTERPRISE NUMBERS\n| | | |\n')],
    ['an unrelated text body', () => textResponse('hello')],
  ])('throws upstream_unreadable for %s', async (_name, answer) => {
    const s = setup();
    s.state.answer = answer;
    const { error } = await settle(() => s.store.getPen(s.budget()));
    expect(asMcpError(error).data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('serves a stale list when the refresh fails', async () => {
    const s = setup();
    s.state.answer = () => textResponse(PEN_TEXT);
    const first = await s.store.getPen(s.budget());
    s.advance(FRESH_MS + 1);
    s.state.answer = () => statusResponse(503);
    const { value } = await settle(() => s.store.getPen(s.budget()));
    expect(value?.model).toBe(first.model);
    expect(value?.source.stale).toBe(true);
  });
});

describe('language registry', () => {
  it('loads the record-jar as text and reports File-Date as the registry date', async () => {
    const s = setup();
    s.state.answer = () => textResponse(LANGUAGE_REGISTRY_TEXT);
    const loaded = await s.store.getLanguageRegistry(s.budget());
    expect(s.urls()).toEqual([LANGUAGE_REGISTRY_URL]);
    expect(loaded.model.records).toHaveLength(10);
    expect(loaded.source).toMatchObject({
      registry_id: 'language-subtag-registry',
      registry_updated: '2026-09-17',
      stale: false,
    });
  });

  it('enforces the 4 MiB ceiling', async () => {
    const s = setup();
    s.state.answer = () => textResponse(`${LANGUAGE_REGISTRY_TEXT}\n${'x'.repeat(4 * MiB)}`);
    const { error } = await settle(() => s.store.getLanguageRegistry(s.budget()));
    expect(asMcpError(error).data).toMatchObject({ maxBytes: 4 * MiB });
  });

  it('throws upstream_unreadable for an HTML page and for a body with no records', async () => {
    for (const answer of [
      () => htmlResponse('<html/>'),
      () => textResponse('File-Date: 2026-01-01\n'),
    ]) {
      const s = setup();
      s.state.answer = answer;
      const { error } = await settle(() => s.store.getLanguageRegistry(s.budget()));
      expect(asMcpError(error).data).toMatchObject({ reason: 'upstream_unreadable' });
    }
  });
});

describe('protocol index', () => {
  const goodIndex = () => htmlResponse(bigIndexHtml(), { 'last-modified': LAST_MODIFIED });

  it('loads the page as HTML, with no registry_updated', async () => {
    const s = setup();
    s.state.answer = goodIndex;
    const loaded = await s.store.getIndex(s.budget());
    expect(s.urls()).toEqual([PROTOCOL_INDEX_URL]);
    expect(loaded.model.entries.length).toBeGreaterThanOrEqual(2_000);
    expect(loaded.source).toEqual({
      registry_id: 'protocols',
      url: PROTOCOL_INDEX_URL,
      fetched_at: new Date(T0).toISOString(),
      stale: false,
    });
  });

  it('cachedIndex() is undefined before a load and never fetches', async () => {
    const s = setup();
    expect(s.store.cachedIndex()).toBeUndefined();
    expect(s.fetches()).toBe(0);
    s.state.answer = goodIndex;
    const loaded = await s.store.getIndex(s.budget());
    expect(s.store.cachedIndex()).toBe(loaded.model);
    s.advance(FRESH_MS * 2);
    expect(s.store.cachedIndex()).toBe(loaded.model);
    expect(s.fetches()).toBe(1);
  });

  it('cachedIndex() stops returning a copy older than the stale limit', async () => {
    const s = setup();
    s.state.answer = goodIndex;
    await s.store.getIndex(s.budget());
    s.advance(STALE_MAX_MS);
    expect(s.store.cachedIndex()).toBeDefined();
    s.advance(1);
    expect(s.store.cachedIndex()).toBeUndefined();
  });

  it.each([
    ['one id short of the floor', 499, 2_000],
    ['one entry short of the floor', 500, 1_999],
  ])(
    'rejects a parse %s as index_unreadable, once, never retried, and never caches it',
    async (_name, ids, entries) => {
      const s = setup();
      s.state.answer = () => htmlResponse(indexHtmlWith(ids, entries));
      const first = await settle(() => s.store.getIndex(s.budget()));
      const failure = asMcpError(first.error);
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(failure.data).toMatchObject({
        reason: 'index_unreadable',
        retryable: false,
        registryIds: ids,
        entries,
      });
      expect(s.fetches()).toBe(1);
      expect(s.store.cachedIndex()).toBeUndefined();
    },
  );

  it('after an under-floor parse the 2-minute hold replays the error, then a good page loads', async () => {
    const s = setup();
    s.state.answer = () => htmlResponse('<html><body>Maintenance</body></html>');
    const first = await settle(() => s.store.getIndex(s.budget()));
    s.advance(HOLD_MS - 1);
    expect(await thrown(() => s.store.getIndex(s.budget()))).toBe(first.error);
    expect(s.fetches()).toBe(1);

    s.advance(1);
    s.state.answer = goodIndex;
    const loaded = await s.store.getIndex(s.budget());
    expect(loaded.model.entries.length).toBeGreaterThanOrEqual(2_000);
    expect(s.fetches()).toBe(2);
  });

  it('keeps serving the good copy, marked stale, when a refresh parses under the floor', async () => {
    const s = setup();
    s.state.answer = goodIndex;
    const first = await s.store.getIndex(s.budget());
    s.advance(FRESH_MS);
    s.state.answer = () => htmlResponse(indexHtmlWith(10, 10));
    const { value } = await settle(() => s.store.getIndex(s.budget()));
    expect(value?.model).toBe(first.model);
    expect(value?.source.stale).toBe(true);
    expect(s.store.cachedIndex()).toBe(first.model);
  });

  it('labels a wrong content type with index_unreadable', async () => {
    const s = setup();
    s.state.answer = () => textResponse('plain text');
    const { error } = await settle(() => s.store.getIndex(s.budget()));
    expect(asMcpError(error).data).toMatchObject({ reason: 'index_unreadable' });
  });

  it('labels an unexpected status with index_unreadable', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(403, {}, 'no');
    const { error } = await settle(() => s.store.getIndex(s.budget()));
    expect(asMcpError(error).data).toMatchObject({ reason: 'index_unreadable', status: 403 });
  });

  it('leaves an exhausted 5xx framework-classified, without the index reason', async () => {
    const s = setup();
    s.state.answer = () => statusResponse(503, {}, 'busy');
    const { error } = await settle(() => s.store.getIndex(s.budget()));
    const failure = asMcpError(error);
    expect(failure.data).toMatchObject({ status: 503, retryAttempts: 3 });
    expect(failure.data?.reason).toBeUndefined();
  });

  it('revalidates a good index with a conditional request and keeps the model on 304', async () => {
    const s = setup();
    s.state.answer = goodIndex;
    const first = await s.store.getIndex(s.budget());
    s.advance(FRESH_MS);
    s.state.answer = () => notModified();
    const again = await s.store.getIndex(s.budget());
    expect(again.model).toBe(first.model);
    expect(s.header(1, 'if-modified-since')).toBe(LAST_MODIFIED);
  });
});

describe('the curated and generic paths share one parsed model per id', () => {
  it('port registry loaded through either entry point is one model', async () => {
    const s = setup();
    s.state.answer = () => xmlResponse(PORTS_XML);
    const curated = await s.store.getRegistry('service-names-port-numbers', s.budget());
    const generic = await s.store.findRegistry('service-names-port-numbers', s.budget());
    expect(generic?.model).toBe(curated.model);
    expect(s.fetches()).toBe(1);
  });
});
