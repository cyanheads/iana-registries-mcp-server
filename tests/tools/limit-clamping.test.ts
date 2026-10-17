/**
 * @fileoverview Clamped limit disclosure, caps and pagination across the nine limit-bearing tools.
 * @module tests/tools/limit-clamping
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistryRecords } from '@/mcp-server/tools/definitions/get-registry-records.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { lookupHttpStatus } from '@/mcp-server/tools/definitions/lookup-http-status.tool.js';
import { searchRegistries } from '@/mcp-server/tools/definitions/search-registries.tool.js';
import {
  LANGUAGE_EXTENSIONS_URL,
  LANGUAGE_REGISTRY_URL,
  PEN_URL,
  PROTOCOL_INDEX_URL,
  registryXmlUrl,
} from '@/services/registry/registry-store.js';
import { FIELDS_XML, SCHEMES_XML, STATUS_XML } from '../fixtures/http-registries.js';
import { LANGUAGE_EXTENSIONS_TEXT } from '../fixtures/language-registry.js';
import { LANGUAGE_TAGS_TEXT } from '../fixtures/language-tags.js';
import { MEDIA_XML } from '../fixtures/media-registry.js';
import { PEN_TEXT } from '../fixtures/pen.js';
import { recordXml, registryXml } from '../fixtures/records-xml.js';
import { PORTS_XML } from '../fixtures/registry-xml.js';
import { searchIndexHtml } from '../fixtures/search-index.js';
import { callTool, setupTools } from '../shared/tool-harness.js';
import { htmlResponse, textResponse, xmlResponse } from '../shared/upstream-harness.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function recordsRegistry(values: string[]) {
  const s = setupTools();
  s.serve({
    [registryXmlUrl('decimal')]: () =>
      xmlResponse(
        registryXml({
          id: 'decimal',
          body: values.map((value) => recordXml({ value, description: 'Unassigned' })).join(''),
        }),
      ),
  });
  return s;
}

describe('clamped limit disclosure on every tool', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['iana_lookup_port', { port: 443 }],
    ['iana_lookup_media_type', { keyword: 'json' }],
    ['iana_lookup_http_status', { code: 200 }],
    ['iana_lookup_http_field', { name: 'Accept' }],
    ['iana_lookup_uri_scheme', { scheme: 'https' }],
    ['iana_lookup_pen', { pen: '32473' }],
    ['iana_lookup_language_tag', { tag: 'en-u-ca-gregory' }],
    ['iana_search_registries', { query: 'cipher' }],
    ['iana_get_registry_records', { registry: 'decimal' }],
  ];
  it.each(cases)('%s discloses the effective cap on both surfaces', async (name, input) => {
    const s = recordsRegistry(['1']);
    s.serve({
      [registryXmlUrl('service-names-port-numbers')]: () => xmlResponse(PORTS_XML),
      [registryXmlUrl('media-types')]: () => xmlResponse(MEDIA_XML),
      [registryXmlUrl('http-status-codes')]: () => xmlResponse(STATUS_XML),
      [registryXmlUrl('http-fields')]: () => xmlResponse(FIELDS_XML),
      [registryXmlUrl('uri-schemes')]: () => xmlResponse(SCHEMES_XML),
      [PEN_URL]: () => textResponse(PEN_TEXT),
      [LANGUAGE_REGISTRY_URL]: () => textResponse(LANGUAGE_TAGS_TEXT),
      [LANGUAGE_EXTENSIONS_URL]: () => textResponse(LANGUAGE_EXTENSIONS_TEXT),
      [PROTOCOL_INDEX_URL]: () => htmlResponse(searchIndexHtml()),
    });
    const definition = allToolDefinitions.find((tool) => tool.name === name);
    if (!definition) throw new Error(`Missing definition ${name}`);
    const out = await callTool(definition, { ...input, limit: 1_000_000 });
    expect(out.isError).toBe(false);
    const cap = name === 'iana_search_registries' ? 50 : 100;
    expect(out.structured).toMatchObject({ cap, requested_limit: 1_000_000, effective_limit: cap });
    expect(out.text).toContain('1000000');
    expect(out.text).toContain(String(cap));
    if (name === 'iana_lookup_language_tag') {
      expect(out.structured).toMatchObject({
        valid: true,
        canonical_tag: 'en-u-ca-gregory',
        subtags: [{ subtag: 'en' }, { extension: { allocation: 'allocated' } }],
        extension_source: { url: LANGUAGE_EXTENSIONS_URL },
      });
      expect(out.text).toContain('allocated');
      expect(out.text).toContain(LANGUAGE_EXTENSIONS_URL);
    }
  });

  it('clamps record pages and continues the same cursor at the effective cap', async () => {
    recordsRegistry(Array.from({ length: 101 }, (_, index) => String(index)));
    const first = await callTool(getRegistryRecords, { registry: 'decimal', limit: 1_000_000 });
    expect(first.structured).toMatchObject({
      totalCount: 101,
      shown: 100,
      cap: 100,
      truncated: true,
    });
    expect(first.structured.records).toHaveLength(100);
    expect(first.structured.next_cursor).toEqual(expect.any(String));
    const last = await callTool(getRegistryRecords, {
      registry: 'decimal',
      limit: 101,
      cursor: first.structured.next_cursor,
    });
    expect(last.structured).toMatchObject({
      totalCount: 101,
      shown: 1,
      cap: 100,
      truncated: false,
      records: [{ value: '100' }],
    });
    expect(last.structured).not.toHaveProperty('next_cursor');
  });

  it('clamps search pages to fifty and preserves offsets through the last and past-end pages', async () => {
    const s = setupTools();
    s.serve({
      [PROTOCOL_INDEX_URL]: () =>
        htmlResponse(
          searchIndexHtml(
            Array.from({ length: 51 }, (_, i) => ({
              href: `/assignments/clamped-${i}`,
              title: `Clamped ${i}`,
            })),
          ),
        ),
    });
    const first = await callTool(searchRegistries, { query: 'clamped', limit: 101 });
    expect(first.structured).toMatchObject({
      totalCount: 51,
      shown: 50,
      cap: 50,
      next_offset: 50,
      requested_limit: 101,
      effective_limit: 50,
      truncated: true,
    });
    expect(first.structured.registries).toHaveLength(50);
    expect(first.text).not.toContain('raise limit');
    const last = await callTool(searchRegistries, { query: 'clamped', limit: 101, offset: 50 });
    expect(last.structured).toMatchObject({ totalCount: 51, shown: 1, cap: 50, truncated: false });
    const beyond = await callTool(searchRegistries, { query: 'clamped', limit: 101, offset: 51 });
    expect(beyond.structured).toMatchObject({
      totalCount: 51,
      shown: 0,
      cap: 50,
      truncated: false,
    });
    expect(beyond.structured).not.toHaveProperty('next_offset');
    expect(beyond.text).toContain('51 matching registries');
  });

  it.each([{ keyword: 'nonexistent' }, { code: 299 }, { keyword: 'request', offset: 1000 }])(
    'keeps truthful empty/exact counters for %j',
    async (input) => {
      const s = setupTools();
      s.serve({ [registryXmlUrl('http-status-codes')]: () => xmlResponse(STATUS_XML) });
      const out = await callTool(lookupHttpStatus, { ...input, limit: 101 });
      expect(out.isError).toBe(false);
      expect(out.structured).toMatchObject({
        cap: 100,
        requested_limit: 101,
        effective_limit: 100,
        shown: 0,
        truncated: false,
      });
      expect(out.text).toContain('101');
    },
  );
});
