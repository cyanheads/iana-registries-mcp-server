/** @fileoverview Generic registry filters, note routes, and template pointers through the XML and tool contracts. */

import { decodeCursor, encodeCursor, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRegistryRecords } from '@/mcp-server/tools/definitions/get-registry-records.tool.js';
import { LANGUAGE_EXTENSIONS_URL, registryXmlUrl } from '@/services/registry/registry-store.js';
import { recordXml, registryXml, subregistryXml } from '../fixtures/records-xml.js';
import { callTool, setupTools, type ToolOutcome } from '../shared/tool-harness.js';
import { xmlResponse } from '../shared/upstream-harness.js';

const call = (registry: string, filters: Record<string, unknown>) =>
  callTool(getRegistryRecords, { registry, ...filters });
const values = (out: ToolOutcome) =>
  (out.structured.records as { value?: string }[]).map(({ value }) => value);

function serve(id: string, body: string) {
  const harness = setupTools();
  harness.serve({ [registryXmlUrl(id)]: () => xmlResponse(registryXml({ id, body })) });
  return harness;
}

function notice(out: ToolOutcome, fragment: string) {
  expect(out.structured.notice).toContain(fragment);
  expect(out.text).toContain(fragment);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('preserves literal keys, alternate exact precedence, and cursor binding', async () => {
  const id = 'ldap-parameters';
  serve(
    id,
    subregistryXml(
      'ldap-parameters-3',
      [
        recordXml({ value: '2.5.23.3', name: 'LDAP' }),
        recordXml({ value: '2.5.23.3', name: 'LDAP duplicate' }),
        recordXml({ value: '10-20', name: 'range' }),
        recordXml({ value: '30', name: '15' }),
      ].join(''),
    ),
  );
  const first = await call(id, { value: '2.5.23.3', limit: 1 });
  // Emitted by v0.3.0 for this registry, selector, and filter.
  const cursor = 'eyJvZmZzZXQiOjEsImxpbWl0IjoxLCJxIjoidW5pdDcwIiwidSI6IjIwMjYtMDgtMzAifQ';
  expect(first.structured.next_cursor).toBe(cursor);
  expect(values(first)).toEqual(['2.5.23.3']);
  expect(first.text).toContain('#### 2.5.23.3');
  expect(values(await call(id, { value: '2.5.23.3', cursor }))).toEqual(['2.5.23.3']);
  const mismatch = await call(id, { value: '2.5.23.4', cursor });
  expect(mismatch.structured.error).toMatchObject({ data: { reason: 'cursor_mismatch' } });
  expect(mismatch.text).toContain('without cursor');
  notice(await call(id, { value: '15' }), 'Column name (1 row) holds');
  expect(values(await call(id, { value: '15', field: 'value' }))).toEqual(['10-20']);
});

it.each([
  ['192.0.0.1', '192.0.0.0/29'],
  ['192.0.0.170', '192.0.0.170/32, 192.0.0.171/32'],
])('ranks covering IPv4 blocks for %s before paging', async (value, best) => {
  const id = 'iana-ipv4-special-registry';
  serve(
    id,
    [
      '<footnote anchor="2">Parent footnote.</footnote>',
      subregistryXml(
        'iana-ipv4-special-registry-1',
        [
          recordXml({ address: '192.0.0.0/24 <xref type="note" data="2"/>', name: 'Parent' }),
          recordXml({ address: '192.0.0.0/29', name: 'Child' }),
          recordXml({ address: '192.0.0.170/32, 192.0.0.171/32', name: 'Pair' }),
          recordXml({ address: '192.168.0.0/16', name: 'Private' }),
        ].join(''),
      ),
    ].join(''),
  );
  const first = await call(id, { value, limit: 1 });
  expect(values(first)).toEqual([best]);
  expect(first.text).toContain(best);
  expect(first.structured.totalCount).toBe(2);
  const cursor = first.structured.next_cursor as string;
  const second = await call(id, { value, limit: 1, cursor });
  expect(values(second)).toEqual(['192.0.0.0/24 [2]']);
  expect(second.text).toContain(String.raw`192.0.0.0/24 \[2\]`);
  expect(second.structured.next_cursor).toBeUndefined();
  const past = encodeCursor({
    ...decodeCursor(cursor, requestContextService.createRequestContext({ operation: 'test' })),
    offset: 3,
  });
  notice(await call(id, { value, cursor: past }), 'offset 3 is past the 2 matching records');
  const miss = await call(id, { value: '192.0.0.0/23' });
  expect(values(miss)).toEqual([]);
  notice(miss, 'covering block');
  expect(
    values(await call(id, { value: '192.168.1.1', field: 'address', contains: 'private' })),
  ).toEqual(['192.168.0.0/16']);
  for (const spelling of ['192.0.0.0/24', '192.0.0.0/24 2', '192.0.0.0/24 [2]']) {
    const hit = await call(id, { value: spelling });
    expect(values(hit)).toEqual(['192.0.0.0/24 [2]']);
    expect(hit.structured.registry_notes).toEqual([{ anchor: '2', text: 'Parent footnote.' }]);
    expect(hit.text).toContain('[anchor 2]');
  }
});

it.each([
  ['ipv4-address-space', undefined, 'prefix', '010/8', ['10', '10/8', '010/8', '10.1.2.3']],
  [
    'iana-ipv6-special-registry',
    'iana-ipv6-special-registry-1',
    'address',
    '2001:db8::/32',
    ['2001:db8::1', '2001:0db8::/32'],
  ],
  [
    'iana-ipv6-special-registry',
    'iana-ipv6-special-registry-1',
    'address',
    '2002::/16 <xref type="note" data="3"/>',
    ['2002::/16'],
  ],
  [
    'multicast-addresses',
    'multicast-addresses-1',
    'addr',
    '224.0.0.153-224.0.0.250',
    ['224.0.0.153', '224.0.0.200', '224.0.0.250'],
  ],
  ['ipv6-multicast-addresses', 'link-local', 'addr', 'FF02:0:0:0:0:0:0:1', ['ff02::1']],
] as const)(
  'matches address spellings in %s / %s (%s %s)',
  async (id, subregistry, field, cell, queries) => {
    serve(
      id,
      subregistry
        ? subregistryXml(subregistry, recordXml({ [field]: cell }))
        : recordXml({ [field]: cell }),
    );
    const expected = cell.replace(' <xref type="note" data="3"/>', ' [3]');
    for (const value of queries) {
      const result = await call(id, { subregistry, value });
      expect(values(result)).toEqual([expected]);
      expect(result.text).toContain(expected.replace('[3]', String.raw`\[3\]`));
    }
  },
);

it('keeps an exact alternate value authoritative for implicit address containment', async () => {
  const id = 'iana-ipv4-special-registry';
  serve(
    id,
    subregistryXml(
      'iana-ipv4-special-registry-1',
      [
        recordXml({ address: '192.0.0.0/24', name: 'block' }),
        recordXml({ address: '192.0.0.0/29', name: 'first tie' }),
        recordXml({ address: '192.0.0.0-192.0.0.7', name: 'second tie' }),
        recordXml({ address: '192.0.1.0/24', name: '192.0.0.1' }),
      ].join(''),
    ),
  );
  const implicit = await call(id, { value: '192.0.0.1' });
  expect(values(implicit)).toEqual([]);
  notice(implicit, 'Column name (1 row) holds');
  const explicit = await call(id, { value: '192.0.0.1', field: 'address' });
  expect(values(explicit)).toEqual(['192.0.0.0/29', '192.0.0.0-192.0.0.7', '192.0.0.0/24']);
  expect(explicit.text.indexOf('#### 192.0.0.0/29')).toBeLessThan(
    explicit.text.indexOf('#### 192.0.0.0-192.0.0.7'),
  );
});

it('preserves literal wildcard and invalid spellings and leaves two-column ranges separate', async () => {
  const id = 'multicast-addresses';
  serve(
    id,
    subregistryXml(
      'multicast-addresses-1',
      [recordXml({ addr: '224.0.0.*' }), recordXml({ addr: '224.0.0.999' })].join(''),
    ),
  );
  for (const value of ['224.0.0.*', '224.0.0.999']) {
    const hit = await call(id, { value });
    expect(values(hit)).toEqual([value]);
    expect(hit.text).toContain(`#### ${value}`);
  }
  expect(values(await call(id, { value: '224.0.0.2' }))).toEqual([]);
  serve('ipv4-recovered-address-space', recordXml({ start: '192.0.0.0', end: '192.0.0.255' }));
  expect(values(await call('ipv4-recovered-address-space', { value: '192.0.0.1' }))).toEqual([]);
  const equality = await call('ipv4-recovered-address-space', { value: '192.0.0.0' });
  expect(values(equality)).toEqual(['192.0.0.0']);
  expect(equality.text).toContain('192.0.0.255');
});

it('matches repeated aliases and keeps the original joined display', async () => {
  const id = 'character-sets';
  serve(
    id,
    '<record><value>4</value><alias>latin1</alias><alias>csISOLatin1</alias><alias>LATIN1</alias><name>one<br/>two</name></record>',
  );
  for (const value of ['latin1', 'csISOLatin1', 'latin1\ncsISOLatin1\nLATIN1']) {
    const hit = await call(id, { field: 'alias', value });
    expect(hit.structured.records).toMatchObject([
      { value: '4', fields: { alias: 'latin1\ncsISOLatin1\nLATIN1' } },
    ]);
    expect(hit.text).toContain('latin1\ncsISOLatin1\nLATIN1');
  }
  notice(await call(id, { value: 'latin1' }), 'Column alias (1 row) holds');
  expect(values(await call(id, { value: 'two', field: 'name' }))).toEqual([]);
});

it.each([
  ['rtsp-parameters', 'name', 'PLAY', 'PLAY [2]', String.raw`PLAY \[2\]`],
  ['sip-parameters', 'value', 'foo', 'foo [2]', String.raw`foo \[2\]`],
  ['ppp-numbers', 'name', 'Example', 'Example [2]', String.raw`Example \[2\]`],
  ['ldap-parameters', 'name', 'lang- (See 1)', 'lang- (See [1])', String.raw`lang- (See \[1\])`],
] as const)('matches note spellings in %s', async (id, field, value, display, markdown) => {
  serve(id, recordXml({ [field]: display.replace(/\[(\d)\]/, '<xref type="note" data="$1"/>') }));
  const hit = await call(id, { value, field });
  expect(values(hit)).toEqual([display]);
  expect(hit.text).toContain(markdown);
});

it('routes empty pointer tables using only the selected notes and skips their own IDs', async () => {
  const id = 'language-subtags-tags-extensions';
  const ref = (target: string) => `<xref type="registry" data="${target}"/>`;
  serve(
    id,
    `<note>Root ${ref('root-only')}</note>
    ${subregistryXml('language-subtags', `<note>${ref('language-subtag-registry')} ${ref('lang-subtags-templates')} ${ref('language-subtag-registry')} ${ref('language-subtags')}</note>`)}
    ${subregistryXml('language-tag-extensions', `<note>${ref('language-tag-extensions-registry')}</note>`)}
    ${subregistryXml('language-tags', `<note>${ref('language-tags')} ${ref('lang-tag-apps')}</note>`)}
    ${subregistryXml('populated', `<note>${ref('lang-tag-apps')}</note>${recordXml({ value: '1' })}`)}`,
  );
  const subtags = await call(id, { subregistry: 'language-subtags' });
  notice(subtags, 'Its notes point to');
  notice(subtags, 'iana_lookup_language_tag');
  notice(subtags, 'lang-subtags-templates');
  expect(String(subtags.structured.notice).match(/language-subtag-registry/g)).toHaveLength(1);
  expect(subtags.structured.notice).not.toContain('root-only');
  expect(subtags.text).toContain('root-only');
  const extensions = await call(id, { subregistry: 'language-tag-extensions' });
  notice(extensions, 'en-u-ca-gregory');
  const tags = await call(id, { subregistry: 'language-tags' });
  notice(tags, 'lang-tag-apps');
  expect(String(tags.structured.notice).match(/language-tags/g)).toHaveLength(1);
  expect(
    (await call(id, { subregistry: 'populated', value: 'wrong' })).structured.notice,
  ).not.toContain('Its notes point');
  serve(
    'smi-numbers',
    subregistryXml('smi-numbers-25', `<note>${ref('enterprise-numbers')}</note>`),
  );
  notice(await call('smi-numbers', { subregistry: 'smi-numbers-25' }), 'iana_lookup_pen');
  const upstream = setupTools();
  const direct = await call('language-tag-extensions-registry', {});
  expect(upstream.fetches()).toBe(0);
  expect(direct.structured.error).toMatchObject({
    data: {
      file: LANGUAGE_EXTENSIONS_URL,
      reason: 'non_xml_registry',
      recovery: { hint: expect.stringContaining('en-u-ca-gregory') },
    },
  });
  expect(direct.text).toContain('en-u-ca-gregory');
  expect(direct.text).toContain(LANGUAGE_EXTENSIONS_URL);
});

it.each([
  ['cbor-tags', 'tags', '32768', 'template/32768', ''],
  [
    'dns-parameters',
    'dns-parameters-4',
    '65',
    'HTTPS/https-completed-template',
    '<xref type="rfc" data="rfc9460"/>',
  ],
  ['media-types', 'image', 'x-emf', 'image/emf', ''],
  ['media-types', 'application', 'atom+xml', 'application/atom+xml', ''],
  ['uri-schemes', 'uri-schemes-1', 'acd', 'prov/acd', ''],
] as const)('links %s template for %s / %s', async (id, subregistry, value, file, extra) => {
  const harness = serve(
    id,
    subregistryXml(
      subregistry,
      recordXml({ value }, `<file type="template" name="${value}">${file}</file>${extra}`),
    ),
  );
  const hit = await call(id, { subregistry, value });
  const url = `https://www.iana.org/assignments/${id}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const reference = { type: 'uri', label: 'template', id: url, url };
  expect(hit.structured.records).toMatchObject([
    {
      fields: { file },
      references: extra ? [expect.objectContaining({ id: 'RFC 9460' }), reference] : [reference],
    },
  ]);
  expect(hit.text).toContain(`<${url}> (uri) — template`);
  expect(harness.fetches()).toBe(1);
});

it('offers ALPN contains retries only when one column has all tokens and no holder takes precedence', async () => {
  const id = 'tls-extensiontype-values';
  const subregistry = 'alpn-protocol-ids';
  serve(
    id,
    subregistryXml(
      subregistry,
      [
        recordXml({ value: 'one', description: 'HTTP/2 ("h2", 0x68 0x32)' }),
        recordXml({ value: 'two', description: 'HTTP/2 over TCP ("h2c", 0x68 0x32 0x63)' }),
        recordXml({ value: 'three', description: 'HTTP/3 ("h3", 0x68 0x33)' }),
        recordXml({ value: 'four', description: 'extra 0x68', name: 'other 0x32' }),
        recordXml({ value: 'five', description: 'extra xx h2', name: 'xx' }),
      ].join(''),
    ),
  );
  for (const [value, rows] of [
    ['h2', 2],
    ['h3', 1],
    ['0x68 0x32', 2],
  ] as const) {
    const miss = await call(id, { subregistry, value });
    expect(values(miss)).toEqual([]);
    notice(miss, `description (${rows} ${rows === 1 ? 'row' : 'rows'})`);
    notice(miss, 'omit field and cursor');
    expect(values(await call(id, { subregistry, contains: value }))).toContain(
      value === 'h3' ? 'three' : 'one',
    );
  }
  notice(await call(id, { subregistry, value: 'xx' }), 'Column name (1 row) holds');
  for (const filters of [{ value: 'h' }, { value: '!!' }, { value: 'h2', contains: 'other' }]) {
    expect((await call(id, { subregistry, ...filters })).structured.notice).not.toContain(
      'omit field and cursor',
    );
  }
  const invalid = await call(id, { subregistry, contains: '!' });
  expect(invalid.isError).toBe(true);
  expect(invalid.text).toContain('contains');
});
