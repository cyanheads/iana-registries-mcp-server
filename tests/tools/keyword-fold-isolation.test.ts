/**
 * @fileoverview Characterization of the eight keyword surfaces outside
 * `iana_search_registries`: each keeps strict whole-token matching, so a
 * singular and a plural query (`http`/`https`, `request`/`requests`) answer
 * from different records. The singular/plural fold belongs to the registry
 * search alone; in these corpora a trailing "s" usually names a different
 * protocol or a different name. Each tool reads its own fixture through the
 * scripted upstream.
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistryRecords } from '@/mcp-server/tools/definitions/get-registry-records.tool.js';
import { lookupHttpField } from '@/mcp-server/tools/definitions/lookup-http-field.tool.js';
import { lookupHttpStatus } from '@/mcp-server/tools/definitions/lookup-http-status.tool.js';
import { lookupLanguageTag } from '@/mcp-server/tools/definitions/lookup-language-tag.tool.js';
import { lookupMediaType } from '@/mcp-server/tools/definitions/lookup-media-type.tool.js';
import { lookupPen } from '@/mcp-server/tools/definitions/lookup-pen.tool.js';
import { lookupPort } from '@/mcp-server/tools/definitions/lookup-port.tool.js';
import { lookupUriScheme } from '@/mcp-server/tools/definitions/lookup-uri-scheme.tool.js';
import {
  LANGUAGE_REGISTRY_URL,
  PEN_URL,
  registryXmlUrl,
} from '@/services/registry/registry-store.js';
import { FIELDS_XML, SCHEMES_XML, singleTableXml } from '../fixtures/http-registries.js';
import { jar, jarRecord } from '../fixtures/language-tags.js';
import { mediaRecord, mediaXml } from '../fixtures/media-registry.js';
import { PEN_TEXT } from '../fixtures/pen.js';
import { PORTS_XML } from '../fixtures/port-registry.js';
import { recordXml, registryXml } from '../fixtures/records-xml.js';
import { callTool, setupTools } from '../shared/tool-harness.js';
import { textResponse, xmlResponse } from '../shared/upstream-harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Row = Record<string, unknown>;

interface Surface {
  body: () => Response;
  definition: AnyToolDefinition;
  /** Inputs besides the keyword. */
  extra?: Record<string, unknown>;
  /** The row's identity in the expectations. */
  id: (row: Row) => unknown;
  /** The keyword input. */
  key: string;
  /** The output list. */
  list: string;
  /** Query → the rows it returns. */
  results: Readonly<Record<string, readonly unknown[]>>;
  url: string;
}

const STATUS_XML = singleTableXml(
  'http-status-codes',
  'http-status-codes-1',
  '<record><value>400</value><description>Bad Request</description></record><record><value>429</value><description>Too Many Requests</description></record>',
);
const MEDIA_XML = mediaXml({
  application:
    mediaRecord({ name: 'vnd.example.ipf', file: 'application/vnd.example.ipf' }) +
    mediaRecord({ name: 'vnd.example.ipfs', file: 'application/vnd.example.ipfs' }),
});
const LANGUAGE_TEXT = jar([
  jarRecord({ Type: 'region', Subtag: '019', Description: 'Americas', Added: '2005-10-16' }),
  jarRecord({
    Type: 'region',
    Subtag: '021',
    Description: 'Northern America',
    Added: '2005-10-16',
  }),
]);
const RECORDS_XML = registryXml({
  id: 'example-fold',
  body:
    recordXml({ value: '1', description: 'HTTP' }) +
    recordXml({ value: '2', description: 'HTTPS' }),
});

const SURFACES: Readonly<Record<string, Surface>> = {
  iana_lookup_port: {
    definition: lookupPort,
    url: registryXmlUrl('service-names-port-numbers'),
    body: () => xmlResponse(PORTS_XML),
    key: 'keyword',
    list: 'assignments',
    id: (row) => `${row.service_name}/${row.transport ?? '-'}`,
    results: {
      http: ['https/sctp', 'https/udp', 'https/tcp'],
      https: ['https/sctp', 'https/udp', 'https/tcp', 'example-alt/dccp'],
      name: ['example-reserved-name/tcp', 'example-dnssd/tcp'],
      names: ['example-multi/-', 'example-clock/-'],
    },
  },
  iana_lookup_media_type: {
    definition: lookupMediaType,
    url: registryXmlUrl('media-types'),
    body: () => xmlResponse(MEDIA_XML),
    key: 'keyword',
    list: 'media_types',
    id: (row) => row.type,
    results: {
      ipf: ['application/vnd.example.ipf'],
      ipfs: ['application/vnd.example.ipfs'],
    },
  },
  iana_lookup_http_status: {
    definition: lookupHttpStatus,
    url: registryXmlUrl('http-status-codes'),
    body: () => xmlResponse(STATUS_XML),
    key: 'keyword',
    list: 'statuses',
    id: (row) => row.code,
    results: { request: [400], requests: [429] },
  },
  iana_lookup_http_field: {
    definition: lookupHttpField,
    url: registryXmlUrl('http-fields'),
    body: () => xmlResponse(FIELDS_XML),
    key: 'keyword',
    list: 'fields',
    id: (row) => row.name,
    results: {
      http: [],
      https: ['Example-Provisional'],
      field: ['Example-Deprecated'],
      fields: [],
    },
  },
  iana_lookup_uri_scheme: {
    definition: lookupUriScheme,
    url: registryXmlUrl('uri-schemes'),
    body: () => xmlResponse(SCHEMES_XML),
    key: 'keyword',
    list: 'schemes',
    id: (row) => row.scheme,
    results: { http: [], https: ['https'], scheme: ['example-prov'], schemes: [] },
  },
  iana_lookup_pen: {
    definition: lookupPen,
    url: PEN_URL,
    body: () => textResponse(PEN_TEXT),
    key: 'organization',
    list: 'enterprises',
    id: (row) => row.number,
    results: { network: [], networks: [1] },
  },
  iana_lookup_language_tag: {
    definition: lookupLanguageTag,
    url: LANGUAGE_REGISTRY_URL,
    body: () => textResponse(LANGUAGE_TEXT),
    key: 'description',
    list: 'matches',
    id: (row) => `${row.type}:${row.subtag}`,
    results: { america: ['region:021'], americas: ['region:019'] },
  },
  iana_get_registry_records: {
    definition: getRegistryRecords,
    url: registryXmlUrl('example-fold'),
    body: () => xmlResponse(RECORDS_XML),
    key: 'contains',
    extra: { registry: 'example-fold' },
    list: 'records',
    id: (row) => row.value,
    results: { http: ['1'], https: ['2'] },
  },
};

describe('keyword matching outside iana_search_registries keeps singular and plural apart', () => {
  const cases = Object.entries(SURFACES).flatMap(([tool, surface]) =>
    Object.entries(surface.results).map(([query, expected]) => ({
      tool,
      surface,
      query,
      expected,
    })),
  );

  it.each(cases)('$tool: "$query" → $expected', async ({ surface, query, expected }) => {
    const s = setupTools();
    s.serve({ [surface.url]: surface.body });
    const out = await callTool(surface.definition, {
      ...surface.extra,
      [surface.key]: query,
      limit: 100,
    });
    expect(out.isError).toBe(false);
    const rows = out.structured[surface.list] as Row[];
    expect(rows.map(surface.id)).toEqual(expected);
    expect(out.structured).toMatchObject({ totalCount: expected.length });
  });
});
