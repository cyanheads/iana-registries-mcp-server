/**
 * @fileoverview Tests for `iana_lookup_media_type`: exact type lookups (parameter
 * stripping, case folding, registry casing, aliases, duplicates), status
 * annotations and `replaced_by`, keyword search with ranking and the
 * `top_level` filter (and its ignored-in-type-mode notice), the registration
 * template statements and `template.fetched: false` for every way a template
 * can fail, input validation (blank strings read as unset), the declared error
 * rows, the list-enrichment contract, and `format()` parity and sanitizing.
 * Upstream I/O is a `createFetchMock` fake behind the injected `UpstreamClient`;
 * the template reader is built over the same client.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupMediaType } from '@/mcp-server/tools/definitions/lookup-media-type.tool.js';
import {
  initMediaTemplateReader,
  TEMPLATE_MAX_BYTES,
} from '@/services/media-template/media-template-reader.js';
import { registryXmlUrl } from '@/services/registry/registry-store.js';
import {
  APPLICATION_RECORDS,
  MEDIA_XML,
  mediaRecord,
  mediaXml,
  TEMPLATE_BARE,
  TEMPLATE_HOSTILE,
  TEMPLATE_LABELLED,
  TEMPLATE_NO_LABELS,
  TEMPLATE_NUMBERED,
  TEMPLATE_PERSON_MARKERS,
} from '../fixtures/media-registry.js';
import { DOCTYPE_XML, EMPTY_XML, WRONG_ROOT_XML } from '../fixtures/registry-xml.js';
import { describeFailureContract } from '../shared/failure-contract.js';
import { missingFromText } from '../shared/format-parity.js';
import { callTool, setupTools } from '../shared/tool-harness.js';
import {
  hang,
  htmlResponse,
  makeBudget,
  statusResponse,
  textResponse,
  xmlResponse,
} from '../shared/upstream-harness.js';

const MEDIA_URL = registryXmlUrl('media-types');
const BASE = 'https://www.iana.org/assignments/media-types/';
const tmpl = (path: string) => `${BASE}${path}`;

interface Template {
  deprecated_aliases?: string;
  fetched: boolean;
  file_extensions?: string;
  intended_usage?: string;
}

interface Row {
  references: { id: string; section?: string; type: string; url?: string }[];
  registered?: string;
  replaced_by?: string;
  status: string;
  status_note?: string;
  subtype: string;
  template?: Template;
  template_url: string;
  top_level: string;
  type: string;
  updated?: string;
}

type Out = { structured: Record<string, unknown>; text: string };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Template paths the default fixture's records point at; each answers a template with no labels unless overridden. */
const TEMPLATE_PATHS = [
  'application/vnd.api+json',
  'application/geo+json',
  'application/vnd.geo+json',
  'application/javascript',
  'application/vnd.afpc.afplinedata',
  'application/vnd.gmx',
  'application/remote-printing',
  'application/vnd.example.favour',
  'application/vnd.example.note',
  'application/vnd.ms-excel.addin.macroEnabled.12',
  'application/vnd.example.dup',
  'application/vnd.example.a%20b%5Bc%5D',
  'application/vnd.example.nofile',
  'application/vnd.example.contact',
  'image/png',
  'text/plain',
  'text/javascript',
  'haptics/ivs',
];

function boot(xml = MEDIA_XML, options: Parameters<typeof setupTools>[0] = {}) {
  const s = setupTools(options);
  initMediaTemplateReader({ client: s.client });
  s.serve({
    [MEDIA_URL]: () => xmlResponse(xml),
    [tmpl('application/json')]: () => textResponse(TEMPLATE_LABELLED),
    [tmpl('image/emf')]: () => textResponse(TEMPLATE_NUMBERED),
    ...Object.fromEntries(
      TEMPLATE_PATHS.map((path) => [tmpl(path), () => textResponse(TEMPLATE_NO_LABELS)]),
    ),
  });
  return s;
}

const call = (input: Record<string, unknown>) => callTool(lookupMediaType, input);
const rows = (out: Out) => out.structured.media_types as Row[];
const types = (out: Out) => rows(out).map((row) => row.type);
const templateFetches = (s: ReturnType<typeof boot>) =>
  s.fetched().filter((url) => url !== MEDIA_URL);

describe('iana_lookup_media_type: exact type', () => {
  it('returns the registry fields and the template statements, with counters', async () => {
    const s = boot();
    const out = await call({ type: 'application/json' });
    expect(out.isError).toBe(false);
    expect(out.structured).toEqual({
      mode: 'type',
      found: true,
      normalized_type: 'application/json',
      media_types: [
        {
          type: 'application/json',
          top_level: 'application',
          subtype: 'json',
          status: 'current',
          template_url: tmpl('application/json'),
          references: [
            { type: 'rfc', id: 'RFC 8259', url: 'https://www.rfc-editor.org/rfc/rfc8259.html' },
          ],
          registered: '2013-06-10',
          updated: '2022-03-04',
          template: {
            fetched: true,
            file_extensions: '.json',
            intended_usage: 'COMMON',
            deprecated_aliases: 'n/a',
          },
        },
      ],
      source: expect.objectContaining({
        registry_id: 'media-types',
        url: MEDIA_URL,
        registry_updated: '2026-09-30',
        stale: false,
      }),
      totalCount: 1,
      shown: 1,
      cap: 25,
      truncated: false,
    });
    expect(s.fetched()).toEqual([MEDIA_URL, tmpl('application/json')]);
  });

  it.each([
    'APPLICATION/JSON',
    'Application/Json',
    'application/json; charset=utf-8',
    'application/json;charset=utf-8;q=1',
    'application/json ;',
    '  application/json  ',
    ' Application/JSON ; x=y',
  ])('folds case and drops parameters: %j', async (type) => {
    boot();
    const out = await call({ type });
    expect(types(out)).toEqual(['application/json']);
    expect(out.structured.normalized_type).toBe('application/json');
  });

  it('returns registry casing for a mixed-case registered name, whatever the input casing', async () => {
    boot();
    for (const type of [
      'application/vnd.ms-excel.addin.macroenabled.12',
      'APPLICATION/VND.MS-EXCEL.ADDIN.MACROENABLED.12',
    ]) {
      const out = await call({ type });
      expect(rows(out)[0]).toMatchObject({
        type: 'application/vnd.ms-excel.addin.macroEnabled.12',
        subtype: 'vnd.ms-excel.addin.macroEnabled.12',
        template_url: tmpl('application/vnd.ms-excel.addin.macroEnabled.12'),
      });
      expect(out.structured.normalized_type).toBe('application/vnd.ms-excel.addin.macroenabled.12');
    }
  });

  it('does not match a type that only contains the requested name', async () => {
    boot();
    expect((await call({ type: 'application/vnd.api' })).structured.found).toBe(false);
    expect((await call({ type: 'json/json' })).structured.found).toBe(false);
  });

  it('answers a registered alias with its own name and the target template', async () => {
    const s = boot();
    const out = await call({ type: 'image/x-emf' });
    expect(rows(out)).toEqual([
      expect.objectContaining({
        type: 'image/x-emf',
        subtype: 'x-emf',
        top_level: 'image',
        template_url: tmpl('image/emf'),
        template: {
          fetched: true,
          file_extensions: 'kml\nand sometimes kmz',
          intended_usage: 'COMMON',
          deprecated_aliases: 'none',
        },
      }),
    ]);
    expect(templateFetches(s)).toEqual([tmpl('image/emf')]);
  });

  it('builds the type and template URL from the name when a record has no <file>', async () => {
    boot();
    const out = await call({ type: 'application/vnd.example.nofile' });
    expect(rows(out)[0]).toMatchObject({
      type: 'application/vnd.example.nofile',
      template_url: tmpl('application/vnd.example.nofile'),
    });
  });

  it('returns every record registered under one name, reading a template for each', async () => {
    boot();
    const out = await call({ type: 'application/vnd.example.dup' });
    expect(rows(out).map((row) => row.registered)).toEqual(['2020-01-01', '2021-01-01']);
    expect(rows(out).every((row) => row.template?.fetched)).toBe(true);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 2, truncated: false });
  });

  it('cuts duplicates at limit, reads only the shown templates, and counts the full match set', async () => {
    const s = boot();
    const out = await call({ type: 'application/vnd.example.dup', limit: 1 });
    expect(rows(out)).toHaveLength(1);
    expect(templateFetches(s)).toHaveLength(1);
    expect(out.structured).toMatchObject({ totalCount: 2, shown: 1, cap: 1, truncated: true });
    expect(typeof out.structured.notice).toBe('string');
  });

  it('never carries the contact or assignee person data of a record', async () => {
    boot();
    const out = await call({ type: 'application/vnd.example.contact' });
    expect(out.isError).toBe(false);
    for (const marker of TEMPLATE_PERSON_MARKERS) {
      expect(JSON.stringify(out.structured)).not.toContain(marker);
      expect(out.text).not.toContain(marker);
    }
  });

  it('explains a miss, reads no template, and echoes the normalized type', async () => {
    const s = boot();
    const out = await call({ type: 'Application/X-NoSuch; q=1' });
    expect(out.structured).toMatchObject({
      mode: 'type',
      found: false,
      normalized_type: 'application/x-nosuch',
      media_types: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      notice:
        "application/x-nosuch is not a registered media type. Unregistered x- types and vendor types never submitted to IANA are absent. Call iana_lookup_media_type with keyword set to the subtype's words to find registered neighbours.",
    });
    expect(s.fetched()).toEqual([MEDIA_URL]);
  });

  it('reads blank optional inputs as unset in type mode: no top_level notice, default limit', async () => {
    boot();
    const out = await call({ type: 'application/json', keyword: '', top_level: ' ', limit: '' });
    expect(out.structured).toMatchObject({ mode: 'type', found: true, cap: 25 });
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_lookup_media_type: status annotations and replacements', () => {
  it.each([
    [
      'application/vnd.geo+json',
      'obsoleted',
      'application/geo+json',
      /^OBSOLETED by .* in favor of application\/geo\+json$/,
    ],
    [
      'application/javascript',
      'obsoleted',
      'text/javascript',
      /^OBSOLETED in favor of text\/javascript\.$/,
    ],
    [
      'application/vnd.afpc.afplinedata',
      'obsoleted',
      'application/vnd.afpc.modca',
      /^OBSOLETED in favor of vnd\.afpc\.modca$/,
    ],
    [
      'application/vnd.example.favour',
      'obsoleted',
      'application/vnd.example.new',
      /^OBSOLETED in favour of vnd\.example\.new$/,
    ],
    ['application/remote-printing', 'obsoleted', undefined, /^OBSOLETE$/],
    ['application/vnd.gmx', 'deprecated', undefined, /^DEPRECATED$/],
    ['application/vnd.example.note', 'current', undefined, /^see the registration notes$/],
    ['application/json', 'current', undefined, undefined],
  ])('%s: status %s, replaced_by %s', async (type, status, replacedBy, note) => {
    boot();
    const [row] = rows(await call({ type }));
    expect(row?.status).toBe(status);
    if (replacedBy === undefined) expect(row).not.toHaveProperty('replaced_by');
    else expect(row?.replaced_by).toBe(replacedBy);
    if (note === undefined) expect(row).not.toHaveProperty('status_note');
    else expect(row?.status_note).toMatch(note);
  });

  it('keeps the registry type name without the annotation', async () => {
    boot();
    const [row] = rows(await call({ type: 'application/vnd.gmx' }));
    expect(row).toMatchObject({ type: 'application/vnd.gmx', subtype: 'vnd.gmx' });
  });

  it('takes the top-level type for a bare replacement from the record, not from the lookup', async () => {
    boot(
      mediaXml({
        image: mediaRecord({
          name: 'old (OBSOLETED in favor of new)',
          file: 'image/old',
        }),
      }),
    );
    expect(rows(await call({ type: 'image/old' }))[0]?.replaced_by).toBe('image/new');
  });

  it('omits replaced_by when the text after "in favor of" is prose, not a type', async () => {
    boot(
      mediaXml({
        application: mediaRecord({
          name: 'vnd.example.prose (OBSOLETED in favor of the vnd.example.new type)',
          file: 'application/vnd.example.prose',
        }),
      }),
    );
    const [row] = rows(await call({ type: 'application/vnd.example.prose' }));
    expect(row).toMatchObject({ status: 'obsoleted' });
    expect(row).not.toHaveProperty('replaced_by');
  });

  it.each([
    ['a spaced RFC reference', 'old (OBSOLETED in favor of RFC 9999)'],
    ['an unspaced RFC reference', 'old (OBSOLETED in favor of RFC9999)'],
    ['an unparenthesized RFC reference', 'old in favor of RFC9999'],
  ])('omits replaced_by when the text after "in favor of" is %s', async (_label, name) => {
    boot(mediaXml({ text: mediaRecord({ name, file: 'text/old' }) }));
    const [row] = rows(await call({ type: 'text/old' }));
    expect(row).not.toHaveProperty('replaced_by');
  });

  it('omits replaced_by when the named replacement is not a well-formed type', async () => {
    boot(
      mediaXml({
        text: mediaRecord({ name: 'old (OBSOLETED in favor of text/)', file: 'text/old' }),
      }),
    );
    const [row] = rows(await call({ type: 'text/old' }));
    expect(row).toMatchObject({ status: 'obsoleted' });
    expect(row).not.toHaveProperty('replaced_by');
  });
});

describe('iana_lookup_media_type: registration template', () => {
  it('reads each of the three layouts', async () => {
    boot();
    const labelled = rows(await call({ type: 'application/json' }))[0]?.template;
    expect(labelled).toEqual({
      fetched: true,
      file_extensions: '.json',
      intended_usage: 'COMMON',
      deprecated_aliases: 'n/a',
    });
    const numbered = rows(await call({ type: 'image/emf' }))[0]?.template;
    expect(numbered).toEqual({
      fetched: true,
      file_extensions: 'kml\nand sometimes kmz',
      intended_usage: 'COMMON',
      deprecated_aliases: 'none',
    });
    const s = boot();
    s.serve({ [tmpl('application/json')]: () => textResponse(TEMPLATE_BARE) });
    const bare = rows(await call({ type: 'application/json' }))[0]?.template;
    expect(bare).toEqual({ fetched: true, file_extensions: 'ex1', intended_usage: 'LIMITED USE' });
  });

  it('is fetched: true with no statement keys when the template lacks the labels', async () => {
    boot();
    const out = await call({ type: 'text/plain' });
    expect(rows(out)[0]?.template).toEqual({ fetched: true });
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('serves a repeat call from the template cache', async () => {
    const s = boot();
    await call({ type: 'application/json' });
    await call({ type: 'application/json' });
    expect(templateFetches(s)).toEqual([tmpl('application/json')]);
  });

  it.each([
    ['a 404', () => statusResponse(404, {}, 'Page not found')],
    ['a 503', () => statusResponse(503)],
    ['a 429', () => statusResponse(429, { 'retry-after': '1' })],
    ['an unexpected status', () => statusResponse(403)],
    ['an HTML page served as 200', () => htmlResponse('<html>Moved</html>')],
    [
      'an oversized body',
      () => textResponse(`File extension(s): .a\n${'x'.repeat(TEMPLATE_MAX_BYTES)}`),
    ],
    [
      'a network failure',
      () => {
        throw new TypeError('connection reset');
      },
    ],
    ['an upstream that never answers', hang],
  ])('%s gives template.fetched false and the notice, never an error', async (_label, response) => {
    const s = boot();
    s.serve({ [tmpl('application/json')]: response });
    const out = await call({ type: 'application/json' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      found: true,
      notice:
        'The registration template could not be read; registry fields are complete, template statements are missing.',
    });
    const [row] = rows(out);
    expect(row?.template).toEqual({ fetched: false });
    expect(row).toMatchObject({
      type: 'application/json',
      status: 'current',
      registered: '2013-06-10',
    });
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('a failed template is not cached: the next call reads it again', async () => {
    const s = boot();
    s.serve({ [tmpl('application/json')]: () => statusResponse(404) });
    expect(rows(await call({ type: 'application/json' }))[0]?.template).toEqual({ fetched: false });
    s.serve({ [tmpl('application/json')]: () => textResponse(TEMPLATE_LABELLED) });
    expect(rows(await call({ type: 'application/json' }))[0]?.template).toMatchObject({
      fetched: true,
      file_extensions: '.json',
    });
  });

  it('notes a failed template once, however many matches share it', async () => {
    const s = boot();
    s.serve({ [tmpl('application/vnd.example.dup')]: () => statusResponse(404) });
    const out = await call({ type: 'application/vnd.example.dup' });
    expect(rows(out).map((row) => row.template?.fetched)).toEqual([false, false]);
    expect(String(out.structured.notice).match(/could not be read/g)).toHaveLength(1);
  });

  it('a shed iana queue still answers: the registry fields stand and the template reads fetched: false', async () => {
    const s = boot(MEDIA_XML, {
      pacing: { iana: { name: 'iana', maxConcurrent: 1, maxQueueDepth: 0 } },
    });
    expect((await call({ keyword: 'png' })).isError).toBe(false);

    const occupant = new AbortController();
    s.serve({ 'https://www.iana.org/assignments/occupant': hang });
    s.client
      .request('https://www.iana.org/assignments/occupant', {
        budget: makeBudget(45_000, occupant.signal),
        profile: 'small',
        operation: 'occupy',
        accept: [200],
        expect: 'text',
        maxBytes: 100,
        parse: (response) => response.body,
      })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const out = await call({ type: 'application/json' });
    expect(out.isError).toBe(false);
    expect(rows(out)[0]?.template).toEqual({ fetched: false });
    expect(out.structured.notice).toContain('The registration template could not be read');
    occupant.abort(new Error('test done'));
  });

  it('a caller cancellation during the template read rejects as RequestCancelled', async () => {
    const s = boot();
    s.serve({ [tmpl('application/json')]: hang });
    const controller = new AbortController();
    const pending = callTool(
      lookupMediaType,
      { type: 'application/json' },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('client went away'));
    const out = await pending;
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'client went away',
    });
  });

  it('a registry the cache serves stale still reads the template and discloses the stale source', async () => {
    const s = boot();
    expect((await call({ keyword: 'png' })).isError).toBe(false);
    s.advance(25 * 3_600_000);
    s.serve({ [MEDIA_URL]: () => statusResponse(503) });
    const out = await call({ type: 'application/json' });
    expect(out.isError).toBe(false);
    expect(out.structured.source).toMatchObject({ stale: true });
    expect(rows(out)[0]?.template).toMatchObject({ fetched: true });
    expect(out.text).toContain('**Served from a stale copy**');
  });
});

describe('iana_lookup_media_type: top_level', () => {
  it('is ignored in type mode, with a notice, even when the registry has no such sub-registry', async () => {
    boot();
    const hit = await call({ type: 'application/json', top_level: 'image' });
    expect(types(hit)).toEqual(['application/json']);
    expect(hit.structured.notice).toBe(
      'top_level applies to keyword mode only; it was ignored for this exact lookup.',
    );
    const absent = await call({ type: 'application/json', top_level: 'video' });
    expect(absent.isError).toBe(false);
    expect(absent.structured.notice).toBe(hit.structured.notice);
  });

  it('adds the ignored notice after the miss text', async () => {
    boot();
    const out = await call({ type: 'application/x-nosuch', top_level: 'text' });
    expect(out.structured.notice).toMatch(
      /^application\/x-nosuch is not a registered media type\..* top_level applies to keyword mode only; it was ignored for this exact lookup\.$/,
    );
  });

  it('adds the ignored notice after the template-failure text', async () => {
    const s = boot();
    s.serve({ [tmpl('application/json')]: () => statusResponse(404) });
    const out = await call({ type: 'application/json', top_level: 'text' });
    expect(out.structured.notice).toBe(
      'The registration template could not be read; registry fields are complete, template statements are missing. top_level applies to keyword mode only; it was ignored for this exact lookup.',
    );
  });

  it('filters keyword results to the sub-registry', async () => {
    boot();
    expect(types(await call({ keyword: 'javascript' }))).toEqual([
      'application/javascript',
      'text/javascript',
    ]);
    expect(types(await call({ keyword: 'javascript', top_level: 'text' }))).toEqual([
      'text/javascript',
    ]);
    expect(types(await call({ keyword: 'emf', top_level: 'image' }))).toEqual([
      'image/emf',
      'image/x-emf',
    ]);
  });

  it('normalizes top_level: case and whitespace', async () => {
    boot();
    expect(types(await call({ keyword: 'emf', top_level: ' IMAGE ' }))).toEqual([
      'image/emf',
      'image/x-emf',
    ]);
  });

  it('names top_level in a keyword miss', async () => {
    boot();
    const out = await call({ keyword: 'png', top_level: 'application' });
    expect(out.structured).toMatchObject({
      found: false,
      media_types: [],
      notice:
        'No registered media type matched "png" in application. Try fewer words or drop top_level.',
    });
  });

  it('names top_level only when one was given', async () => {
    boot();
    expect((await call({ keyword: 'zzzz' })).structured.notice).toBe(
      'No registered media type matched "zzzz". Try fewer words.',
    );
  });

  it('a top_level the registry has no sub-registry for is unreadable, not an empty answer', async () => {
    const s = boot();
    const out = await call({ keyword: 'mp4', top_level: 'video' });
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unreadable',
        subregistry: 'video',
        recovery: {
          hint: 'The IANA media type registry could not be read; retry iana_lookup_media_type in a minute.',
        },
      },
    });
    expect(s.fetches()).toBe(1);
  });

  it.each(['bogus', 'applications', 'x-image'])(
    'rejects the unknown top_level %j',
    async (top_level) => {
      const s = boot();
      const out = await call({ keyword: 'json', top_level });
      expect(out.structured.error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(s.fetches()).toBe(0);
    },
  );

  it.each([
    'application',
    'audio',
    'example',
    'font',
    'haptics',
    'image',
    'message',
    'model',
    'multipart',
    'text',
    'video',
  ])('accepts the top-level type %s as input', async (top_level) => {
    boot(mediaXml({ [top_level]: mediaRecord({ name: 'probe', file: `${top_level}/probe` }) }));
    expect(types(await call({ keyword: 'probe', top_level }))).toEqual([`${top_level}/probe`]);
  });
});

describe('iana_lookup_media_type: keyword', () => {
  it('matches whole tokens of the full type name, across every top-level type', async () => {
    const s = boot();
    expect(types(await call({ keyword: 'png' }))).toEqual(['image/png']);
    expect(types(await call({ keyword: 'plain' }))).toEqual(['text/plain']);
    expect(types(await call({ keyword: 'ivs' }))).toEqual(['haptics/ivs']);
    expect(types(await call({ keyword: 'pn' }))).toEqual([]);
    expect(templateFetches(s)).toEqual([]);
  });

  it('matches the status annotation text as well as the name', async () => {
    boot();
    expect(types(await call({ keyword: 'obsoleted' }))).toEqual([
      'application/vnd.geo+json',
      'application/javascript',
      'application/vnd.afpc.afplinedata',
      'application/vnd.example.favour',
    ]);
    expect(types(await call({ keyword: 'deprecated' }))).toEqual(['application/vnd.gmx']);
  });

  it('ranks an exact subtype hit first, then registry order', async () => {
    boot();
    expect(types(await call({ keyword: 'json' }))).toEqual([
      'application/json',
      'application/vnd.api+json',
      'application/geo+json',
      'application/vnd.geo+json',
    ]);
  });

  it('ranks an exact subtype with a symbol in it first, and an exact full-type hit first', async () => {
    boot();
    expect(types(await call({ keyword: 'geo json' }))).toEqual([
      'application/geo+json',
      'application/vnd.geo+json',
    ]);
    expect(types(await call({ keyword: 'application/json' }))[0]).toBe('application/json');
    expect(types(await call({ keyword: 'APPLICATION/JSON' }))[0]).toBe('application/json');
  });

  it('keeps every exact hit ahead of the non-exact rows when several types share the subtype', async () => {
    boot();
    expect(types(await call({ keyword: 'javascript' }))).toEqual([
      'application/javascript',
      'text/javascript',
    ]);
  });

  it('carries no template and no normalized_type, and reads no template', async () => {
    const s = boot();
    const out = await call({ keyword: 'json' });
    expect(out.structured).toMatchObject({ mode: 'keyword', found: true });
    expect(out.structured).not.toHaveProperty('normalized_type');
    for (const row of rows(out)) expect(row).not.toHaveProperty('template');
    expect(s.fetched()).toEqual([MEDIA_URL]);
  });

  it('percent-encodes template URL path characters except RFC 3986 path-safe ones', async () => {
    boot();
    expect(rows(await call({ keyword: 'example a b c' }))[0]?.template_url).toBe(
      tmpl('application/vnd.example.a%20b%5Bc%5D'),
    );
    expect(rows(await call({ keyword: 'vnd geo json' }))[0]?.template_url).toBe(
      tmpl('application/vnd.geo+json'),
    );
  });

  it('cuts at limit, counts the full match set, and says how to see the rest', async () => {
    boot();
    const out = await call({ keyword: 'json', limit: 2 });
    expect(types(out)).toEqual(['application/json', 'application/vnd.api+json']);
    expect(out.structured).toMatchObject({
      totalCount: 4,
      shown: 2,
      cap: 2,
      truncated: true,
      notice:
        'Showing 2 of 4 matching media types; raise limit (max 100) or add words to keyword to narrow.',
    });
  });

  it('explains a miss, echoing the keyword on one line', async () => {
    boot();
    const out = await call({ keyword: 'zzzz\n   yyyy' });
    expect(out.structured).toMatchObject({
      found: false,
      media_types: [],
      totalCount: 0,
      notice: 'No registered media type matched "zzzz yyyy". Try fewer words.',
    });
  });

  it('rejects a symbol-only keyword as invalid arguments, before any fetch', async () => {
    const s = boot();
    const out = await call({ keyword: '++' });
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(out.text).toContain('Must contain at least one letter or digit');
    expect(s.fetches()).toBe(0);
  });

  it('reads blank optional inputs as unset: keyword mode, no top_level, default limit', async () => {
    boot();
    const out = await call({ type: '', keyword: 'json', top_level: '', limit: ' ' });
    expect(out.structured).toMatchObject({ mode: 'keyword', cap: 25, totalCount: 4 });
  });

  it('applies a digit-string limit', async () => {
    boot();
    expect((await call({ keyword: 'json', limit: '1' })).structured).toMatchObject({
      cap: 1,
      shown: 1,
    });
  });
});

describe('iana_lookup_media_type: input validation', () => {
  it.each([
    ['a type without a slash', { type: 'json' }],
    ['a type with an empty subtype', { type: 'application/' }],
    ['a type with an empty top level', { type: '/json' }],
    ['a type with two slashes', { type: 'application/json/extra' }],
    ['a type with a space', { type: 'application/ json' }],
    ['a type that is only parameters', { type: '; charset=utf-8' }],
    ['a type with a disallowed character', { type: 'application/js*n' }],
    ['a type starting with a symbol', { type: '+application/json' }],
    ['a top level over 127 characters', { type: `${'a'.repeat(128)}/json` }],
    ['a subtype over 127 characters', { type: `application/${'a'.repeat(128)}` }],
    ['a one-character keyword', { keyword: 'a' }],
    ['a keyword over 100 characters', { keyword: 'a'.repeat(101) }],
    ['limit 0', { keyword: 'json', limit: 0 }],
    ['limit above 100', { keyword: 'json', limit: 101 }],
    ['a non-numeric limit', { keyword: 'json', limit: 'many' }],
  ])('rejects %s as invalid arguments, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.isError).toBe(true);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(s.fetches()).toBe(0);
  });

  it('accepts a 127-character top level and subtype, and the full RFC 6838 character set', async () => {
    boot();
    const long = `${'a'.repeat(127)}/${'b'.repeat(127)}`;
    expect((await call({ type: long })).structured).toMatchObject({ found: false });
    expect((await call({ type: 'a1!#$&^_.+-/b1!#$&^_.+-' })).isError).toBe(false);
  });
});

describe('iana_lookup_media_type: mode_required', () => {
  it.each([
    ['neither', {}],
    ['both', { type: 'application/json', keyword: 'json' }],
    ['blank strings only', { type: '', keyword: ' ' }],
    ['top_level alone', { top_level: 'image' }],
  ])('fails %s as mode_required with the recovery, before any fetch', async (_label, input) => {
    const s = boot();
    const out = await call(input);
    expect(out.structured.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Pass exactly one of type or keyword.',
      data: {
        reason: 'mode_required',
        recovery: { hint: 'Pass exactly one of type or keyword to iana_lookup_media_type.' },
      },
    });
    expect(out.text).toContain(
      'Recovery: Pass exactly one of type or keyword to iana_lookup_media_type.',
    );
    expect(s.fetches()).toBe(0);
  });
});

describe('iana_lookup_media_type: list-enrichment contract', () => {
  it('zero-result page (keyword miss): counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ keyword: 'zzzz' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({
      found: false,
      media_types: [],
      totalCount: 0,
      shown: 0,
      cap: 25,
      truncated: false,
    });
    expect(out.text).toContain('0 total');
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('zero-result page (type miss): counters parse and the notice reaches both surfaces', async () => {
    boot();
    const out = await call({ type: 'text/x-nosuch' });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 0, shown: 0, truncated: false });
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('under-cap page (keyword): shown equals the match count and nothing is truncated', async () => {
    boot();
    const out = await call({ keyword: 'obsoleted', limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 4, shown: 4, cap: 10, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });

  it('under-cap page (type): one match, one shown, no notice', async () => {
    boot();
    const out = await call({ type: 'application/json', limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.structured).toMatchObject({ totalCount: 1, shown: 1, cap: 10, truncated: false });
    expect(out.structured).not.toHaveProperty('notice');
  });
});

describe('iana_lookup_media_type: format()', () => {
  it('prints every structuredContent field of an exact lookup', async () => {
    boot();
    const out = await call({ type: 'application/json' });
    expect(out.text).toContain('**Mode:** type · **Found:** true');
    expect(out.text).toContain('**Looked up:** application/json');
    expect(out.text).toContain('### application/json');
    expect(out.text).toContain(
      '**Top level:** application · **Subtype:** json · **Status:** current',
    );
    expect(out.text).toContain(`**Template:** <${tmpl('application/json')}>`);
    expect(out.text).toContain('**Registered:** 2013-06-10 · **Updated:** 2022-03-04');
    expect(out.text).toContain('- RFC 8259 (rfc) <https://www.rfc-editor.org/rfc/rfc8259.html>');
    expect(out.text).toContain('**Template read:** yes');
    expect(out.text).toContain('**File extensions:**\n> .json');
    expect(out.text).toContain('**Intended usage:**\n> COMMON');
    expect(out.text).toContain('**Deprecated aliases:**\n> n/a');
    expect(out.text).toContain('**Source:** `media-types` · registry updated 2026-09-30');
  });

  it.each([
    ['an exact lookup with a template', { type: 'application/json' }],
    ['an obsoleted type with a replacement', { type: 'application/javascript' }],
    ['a type read from the numbered template layout', { type: 'image/x-emf' }],
    ['a keyword page', { keyword: 'json' }],
    ['a keyword page of annotated types', { keyword: 'obsoleted' }],
  ])('carries every string and number of structuredContent: %s', async (_label, input) => {
    const s = boot();
    s.serve({ [tmpl('application/javascript')]: () => textResponse(TEMPLATE_BARE) });
    const out = await call(input);
    expect(out.isError).toBe(false);
    expect(missingFromText(out.structured, out.text)).toEqual([]);
  });

  it('prints the status note and the replacement', async () => {
    boot();
    const text = (await call({ type: 'application/javascript' })).text;
    expect(text).toContain('**Status:** obsoleted');
    expect(text).toContain('**Status note:** OBSOLETED in favor of text/javascript.');
    expect(text).toContain('**Replaced by:** text/javascript');
  });

  it('prints a multi-line statement as one blockquote line per line', async () => {
    boot();
    expect((await call({ type: 'image/emf' })).text).toContain(
      '**File extensions:**\n> kml\n> and sometimes kmz',
    );
  });

  it('says the template could not be read, and omits the statements', async () => {
    const s = boot();
    s.serve({ [tmpl('application/json')]: () => statusResponse(404) });
    const out = await call({ type: 'application/json' });
    expect(out.text).toContain('**Template read:** no — the template could not be read');
    expect(out.text).not.toContain('**File extensions:**');
  });

  it('prints no template block in keyword mode', async () => {
    boot();
    const out = await call({ keyword: 'json' });
    expect(out.text).not.toContain('**Template read:**');
    expect(out.text).not.toContain('**Looked up:**');
    for (const row of rows(out)) {
      expect(out.text).toContain(`### ${row.type}`);
      expect(out.text).toContain(`**Template:** <${row.template_url}>`);
    }
  });

  it('prints the notice and counters the framework appends', async () => {
    boot();
    const out = await call({ keyword: 'zzzz' });
    expect(out.text).toContain(String(out.structured.notice));
  });

  it('keeps hostile upstream text verbatim in structuredContent and inert in format()', async () => {
    const hostile = mediaRecord({
      name: 'vnd.evil - DEPRECATED<br/># Pwned [x](https://evil.example/) &lt;b&gt;',
      file: 'application/vnd.evil[1]',
    });
    const s = boot(mediaXml({ application: `${APPLICATION_RECORDS}\n${hostile}` }));
    s.serve({ [tmpl('application/json')]: () => textResponse(TEMPLATE_HOSTILE) });

    const listing = await call({ keyword: 'evil' });
    const [evil] = rows(listing);
    expect(evil?.type).toBe('application/vnd.evil[1]');
    expect(evil?.status_note).toBe('DEPRECATED\n# Pwned [x](https://evil.example/) <b>');
    const lines = listing.text.split('\n');
    expect(lines.filter((line) => line.startsWith('###'))).toEqual([
      String.raw`### application/vnd.evil\[1\]`,
    ]);
    expect(lines).toContain(
      String.raw`**Status note:** DEPRECATED # Pwned \[x\](https://evil.example/) \<b\>`,
    );
    expect(lines.some((line) => /^(# |## |- )/.test(line))).toBe(false);

    const exact = await call({ type: 'application/json' });
    expect(rows(exact)[0]?.template?.file_extensions).toBe(
      '.evil\n# Forged heading\n- forged item\n[x](https://evil.example/)\n<b>bold</b>\u{202E}\u0007',
    );
    const exactLines = exact.text.split('\n');
    expect(exactLines).toContain('> # Forged heading');
    expect(exactLines).toContain('> - forged item');
    expect(exactLines).toContain(String.raw`> \[x\](https://evil.example/)`);
    expect(exactLines.some((line) => /^(# |- forged)/.test(line))).toBe(false);
    expect(exact.text).not.toMatch(/[\u{202E}\u0007]/u);
  });
});

describeFailureContract({
  definition: lookupMediaType,
  input: { keyword: 'json' },
  url: MEDIA_URL,
  ok: () => xmlResponse(MEDIA_XML),
  reason: 'upstream_unreadable',
  recovery:
    'The IANA media type registry could not be read; retry iana_lookup_media_type in a minute.',
  unreadable: [
    { label: 'an HTML page served as 200', attempts: 3, response: () => htmlResponse('<html/>') },
    {
      label: 'a body with no registry root',
      attempts: 3,
      response: () => xmlResponse(WRONG_ROOT_XML),
    },
    { label: 'a DOCTYPE', attempts: 3, response: () => xmlResponse(DOCTYPE_XML) },
    { label: 'a registry with zero records', attempts: 3, response: () => xmlResponse(EMPTY_XML) },
  ],
});
