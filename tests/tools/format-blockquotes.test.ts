/**
 * @fileoverview Every tool's `format()` ends each blockquote before the next
 * server line. Under CommonMark's laziness rule (§5.1) a paragraph line right
 * after a `>` line continues the quote, so a field printed there would render
 * inside the quoted third-party text. One hand-built output per registered
 * tool, every upstream text field multi-line, validated against the tool's
 * output schema before rendering.
 */

import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** Upstream free text spanning two lines, so a quote of it is a two-line block. */
const TEXT = 'First upstream line\nsecond upstream line';

const SOURCE = {
  registry_id: 'example',
  url: 'https://www.iana.org/assignments/example/example.xml',
  registry_updated: '2026-09-24',
  fetched_at: '2026-10-01T00:00:00.000Z',
  stale: false,
};

const REFERENCES = [
  { type: 'rfc', id: 'RFC 9999', url: 'https://www.rfc-editor.org/rfc/rfc9999.html' },
];

/** A full output per tool name: every optional upstream text field present and multi-line. */
const OUTPUTS: Record<string, unknown> = {
  iana_lookup_port: {
    mode: 'keyword',
    found: true,
    assignments: [
      {
        service_name: 'example',
        port: 1234,
        transport: 'tcp',
        state: 'assigned',
        description: TEXT,
        notes: TEXT,
        unauthorized_use: TEXT,
        references: REFERENCES,
        registered: '2001-01-01',
        updated: '2026-09-01',
      },
      {
        service_name: 'example-two',
        port: 1235,
        transport: 'udp',
        state: 'assigned',
        description: TEXT,
        references: REFERENCES,
      },
    ],
    source: SOURCE,
  },
  iana_lookup_media_type: {
    mode: 'type',
    found: true,
    normalized_type: 'application/example',
    media_types: [
      {
        type: 'application/example',
        top_level: 'application',
        subtype: 'example',
        status: 'current',
        status_note: TEXT,
        template_url: 'https://www.iana.org/assignments/media-types/application/example',
        references: REFERENCES,
        updated: '2026-09-01',
        template: {
          fetched: true,
          file_extensions: TEXT,
          intended_usage: TEXT,
          deprecated_aliases: TEXT,
        },
      },
    ],
    source: SOURCE,
  },
  iana_lookup_http_status: {
    mode: 'code',
    found: true,
    statuses: [
      {
        code: 299,
        phrase: TEXT,
        class: 'success',
        state: 'assigned',
        references: REFERENCES,
        updated: '2026-09-01',
      },
    ],
    source: SOURCE,
  },
  iana_lookup_http_field: {
    mode: 'name',
    found: true,
    fields: [
      {
        name: 'Example-Field',
        status: 'permanent',
        structured_type: 'Item',
        comments: TEXT,
        references: REFERENCES,
        updated: '2026-09-01',
      },
    ],
    source: SOURCE,
  },
  iana_lookup_uri_scheme: {
    mode: 'scheme',
    found: true,
    schemes: [
      {
        scheme: 'example',
        status: 'Permanent',
        status_note: TEXT,
        description: TEXT,
        well_known_uri_support: 'RFC 8615',
        notes: TEXT,
        template_url: 'https://www.iana.org/assignments/uri-schemes/prov/example',
        references: REFERENCES,
        updated: '2021-10-01',
      },
    ],
    source: SOURCE,
  },
  iana_lookup_pen: {
    mode: 'pen',
    found: true,
    enterprises: [
      { number: 32473, organization: TEXT, oid: '1.3.6.1.4.1.32473', state: 'assigned' },
    ],
    source: SOURCE,
  },
  iana_lookup_language_tag: {
    mode: 'tag',
    tag_input: 'xx-YY',
    well_formed: true,
    valid: true,
    canonical_tag: 'xx-YY',
    subtags: [
      {
        subtag: 'xx',
        position: 'language',
        registered: true,
        descriptions: [TEXT],
        added: '2009-07-29',
        comments: [TEXT, TEXT],
      },
      {
        subtag: 'YY',
        position: 'region',
        registered: true,
        descriptions: [TEXT],
        comments: [TEXT],
      },
    ],
    issues: [],
    also_registered_as: [
      { type: 'variant', subtag: 'yy', descriptions: [TEXT], prefixes: ['xx'], comments: [TEXT] },
    ],
    source: SOURCE,
  },
  iana_get_rfc_status: {
    documents: [
      {
        id: 'RFC 9999',
        kind: 'rfc',
        found: true,
        title: TEXT,
        rfc: {
          status: 'PROPOSED STANDARD',
          published_status: 'PROPOSED STANDARD',
          published: '2026-01',
          authors: ['Example Person'],
          obsoletes: [],
          obsoleted_by: [],
          updates: [],
          updated_by: [],
          see_also: [],
          doi: '10.17487/RFC9999',
          url: 'https://www.rfc-editor.org/rfc/rfc9999.html',
          datatracker_url: 'https://datatracker.ietf.org/doc/rfc9999/',
        },
      },
    ],
    failed: [],
  },
  iana_search_registries: {
    registries: [
      {
        registry_id: 'example',
        title: TEXT,
        category: TEXT,
        registration_procedure: TEXT,
        defining_documents: [{ id: 'RFC 9999', title: TEXT }],
        page_url: 'https://www.iana.org/assignments/example/',
        xml_url: 'https://www.iana.org/assignments/example/example.xml',
      },
    ],
    source: SOURCE,
  },
  iana_get_registry_records: {
    registry_id: 'example',
    registry_title: 'Example Registry',
    subregistry_id: 'example-1',
    subregistry_title: 'Example One',
    registration_procedure: TEXT,
    description: TEXT,
    references: REFERENCES,
    registration_ranges: [{ range: '0-10', procedure: TEXT, note: TEXT }],
    notes: [{ title: 'WARNING', text: TEXT }, { text: TEXT }],
    notes_truncated: true,
    columns: ['value', 'description', 'notes'],
    value_field: 'value',
    records: [
      {
        value: '1',
        fields: { value: '1', description: TEXT, notes: TEXT },
        references: REFERENCES,
        updated: '2026-09-01',
        cut_fields: ['notes'],
      },
      { value: '2', fields: { value: '2', description: TEXT }, references: [] },
    ],
    next_cursor: 'example-cursor',
    source: SOURCE,
  },
};

/** Each `>` line followed directly by a non-blank line that is not quoted, as `n: line`. */
function lazyContinuations(text: string): string[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    const next = lines[index + 1];
    return line.startsWith('>') && next && !next.startsWith('>') ? [`${index + 2}: ${next}`] : [];
  });
}

function render(name: string): string {
  const tool = allToolDefinitions.find((candidate) => candidate.name === name);
  if (!tool?.format) throw new Error(`${name} has no format()`);
  return tool
    .format(tool.output.parse(OUTPUTS[name]))
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

describe('format(): blockquotes end before the next server line', () => {
  it('has a hand-built output for every registered tool', () => {
    expect(Object.keys(OUTPUTS).sort()).toEqual(allToolDefinitions.map((tool) => tool.name).sort());
  });

  it.each(allToolDefinitions.map((tool) => tool.name))(
    '%s puts a blank line after every quoted block',
    (name) => {
      expect(lazyContinuations(render(name))).toEqual([]);
    },
  );

  it('separates a quoted URI scheme description from the field after it', () => {
    expect(render('iana_lookup_uri_scheme')).toContain(
      '**Description:**\n> First upstream line\n> second upstream line\n\n**Well-known URI support:** RFC 8615',
    );
  });

  it('separates the last quoted record field from the record dates', () => {
    expect(render('iana_get_registry_records')).toContain(
      '> **notes:** First upstream line\n> second upstream line\n\n**Updated:** 2026-09-01',
    );
  });
});
