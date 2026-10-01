/**
 * @fileoverview Tests for the generic XML registry model: records, sub-registries,
 * notes, ranges, references, mixed-content flattening, sparse and port-less
 * rows, the structural drop of person data, email replacement, and the
 * unreadable-file cases. Fixtures are invented excerpts.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { parseReference, parseXmlRegistry } from '@/services/registry/xml-registry-parser.js';
import {
  DOCTYPE_XML,
  EMPTY_SUBREGISTRY_XML,
  EMPTY_XML,
  HTTP_STATUS_XML,
  LEGACY_STUB_XML,
  MALFORMED_XML,
  NESTED_XML,
  PERSON_MARKERS,
  PORTS_XML,
  WRONG_ROOT_XML,
} from '../../fixtures/registry-xml.js';
import { asMcpError } from '../../shared/upstream-harness.js';

const URL_ = 'https://www.iana.org/assignments/example/example.xml';
const parse = (xml: string) => parseXmlRegistry(xml, URL_);

/** A one-record registry around raw record markup. */
const withRecord = (record: string, extra = '') =>
  `<registry id="x"><title>t</title>${extra}<record>${record}</record></registry>`;

const only = (xml: string) => {
  const record = parse(xml).root.records[0];
  if (!record) throw new Error('fixture has no root record');
  return record;
};

describe('registry shell', () => {
  it('reads id, title, category, updated and the root rule and references', () => {
    const model = parse(NESTED_XML);
    expect(model).toMatchObject({
      id: 'example-parameters',
      title: 'Example Parameters',
      category: 'Example Protocol',
      updated: '2026-08-30',
    });
    expect(model.root).toMatchObject({
      id: 'example-parameters',
      registrationRule: 'Specification Required',
      updated: '2026-08-30',
    });
    expect(model.root.references).toEqual([
      { type: 'rfc', id: 'RFC 9999', url: 'https://www.rfc-editor.org/rfc/rfc9999.html' },
    ]);
  });

  it('omits category, updated and legacyFile when the file has none', () => {
    const model = parse(withRecord('<value>1</value>'));
    expect(model).not.toHaveProperty('category');
    expect(model).not.toHaveProperty('updated');
    expect(model).not.toHaveProperty('legacyFile');
    expect(model.title).toBe('t');
  });

  it('gives a missing title as an empty string', () => {
    expect(parse('<registry id="x"><record><value>1</value></record></registry>').title).toBe('');
  });

  it('ignores the XML declaration and the default namespace declaration', () => {
    expect(parse(HTTP_STATUS_XML).id).toBe('http-status-codes');
  });

  it('counts records across the root and every sub-registry', () => {
    expect(parse(NESTED_XML).recordCount).toBe(9);
    expect(parse(HTTP_STATUS_XML).recordCount).toBe(4);
    expect(parse(PORTS_XML).recordCount).toBe(5);
  });
});

describe('sub-registries', () => {
  const model = parse(NESTED_XML);

  it('lists sub-registries depth-first in document order', () => {
    expect(model.subregistries.map((table) => table.id)).toEqual([
      'alpha',
      'alpha-deep',
      'alpha-deeper',
      'beta',
    ]);
  });

  it('sets parentId only below the first nesting level', () => {
    const parents = Object.fromEntries(model.subregistries.map((t) => [t.id, t.parentId]));
    expect(parents).toEqual({
      alpha: undefined,
      'alpha-deep': 'alpha',
      'alpha-deeper': 'alpha-deep',
      beta: undefined,
    });
    expect(model.subregistries[0]).not.toHaveProperty('parentId');
  });

  it('keeps each table own title, rule, updated and records', () => {
    const alpha = model.subregistries[0];
    expect(alpha).toMatchObject({
      title: 'Alpha Values',
      registrationRule: 'Expert Review',
      updated: '2026-08-01',
    });
    expect(alpha?.records).toHaveLength(6);
    expect(model.subregistries[3]?.records).toHaveLength(1);
  });

  it('reads category from the root only', () => {
    const xml = `<registry id="x"><title>t</title><registry id="s"><title>s</title><category>Inner</category><record><value>1</value></record></registry></registry>`;
    expect(parse(xml)).not.toHaveProperty('category');
  });

  it('collects first-seen record element names as columns per table', () => {
    expect(model.subregistries[0]?.columns).toEqual(['value', 'name', 'description', 'file']);
    expect(model.subregistries[2]?.columns).toEqual(['value']);
    expect(model.root.columns).toEqual([]);
  });

  it('puts a sub-registry that only carries sub-registries in the list with no records', () => {
    const hollow = parse(EMPTY_SUBREGISTRY_XML);
    expect(hollow.recordCount).toBe(0);
    expect(hollow.subregistries.map((t) => t.id)).toEqual(['hollow-1']);
  });
});

describe('notes, footnotes and ranges', () => {
  const nested = parse(NESTED_XML);
  const alpha = nested.subregistries[0];

  it('reads a note with its anchor and title, mixed content flattened', () => {
    expect(alpha?.notes).toEqual([
      {
        anchor: 'alpha-1',
        title: 'NOTE',
        text: 'First line\nsecond line\nA paragraph\nAnother paragraph',
      },
    ]);
  });

  it('reads footnotes like notes', () => {
    expect(nested.subregistries[3]?.notes).toEqual([{ anchor: 'beta-fn', text: 'Beta footnote.' }]);
    expect(parse(HTTP_STATUS_XML).subregistries[0]?.notes).toEqual([
      { anchor: 'note1', text: 'Footnote text.' },
    ]);
  });

  it('renders inline xrefs inside notes as label (target)', () => {
    expect(nested.root.notes[0]?.text).toBe(
      'Root note with the spec (https://example.org/spec) and Other Registry (example-other).',
    );
    expect(parse(HTTP_STATUS_XML).root.notes[0]).toEqual({
      title: 'WARNING',
      text: 'Status codes are RFC9110, Section 15 defined.',
    });
  });

  it('drops an empty note', () => {
    const model = parse(withRecord('<value>1</value>', '<note anchor="a">   </note><note/>'));
    expect(model.root.notes).toEqual([]);
  });

  it('reads registration_ranges: range, procedure and optional note', () => {
    expect(alpha?.ranges).toEqual([
      { range: '0-223', procedure: 'Standards Action', note: 'Assigned by the working group.' },
      { range: '224-255', procedure: 'Private Use' },
    ]);
  });

  it('skips a range with no value and keeps one with no rule', () => {
    const model = parse(
      withRecord(
        '<value>1</value>',
        '<range><registration_rule>Orphan</registration_rule></range><range><value>1-5</value></range>',
      ),
    );
    expect(model.root.ranges).toEqual([{ range: '1-5' }]);
  });

  it('scrubs an email in a note title', () => {
    const model = parse(
      withRecord('<value>1</value>', '<note title="Mail person@example.org">x</note>'),
    );
    expect(model.root.notes[0]?.title).toBe('Mail [email removed]');
  });
});

describe('records', () => {
  it('flattens child elements to fields keyed by element name, in record order', () => {
    const record = parse(HTTP_STATUS_XML).subregistries[0]?.records[0];
    expect(record?.fields).toEqual({ value: '200', description: 'OK' });
    expect(Object.keys(record?.fields ?? {})).toEqual(['value', 'description']);
  });

  it('takes the key column from value, else number, else the first field', () => {
    expect(only(withRecord('<number>5</number><value>v</value><name>n</name>'))).toMatchObject({
      value: 'v',
      valueField: 'value',
    });
    expect(only(withRecord('<name>n</name><number>5</number>'))).toMatchObject({
      value: '5',
      valueField: 'number',
    });
    expect(only(withRecord('<name>n</name><description>d</description>'))).toMatchObject({
      value: 'n',
      valueField: 'name',
    });
  });

  it('reads the date and updated attributes as registered and updated', () => {
    const [first] = parse(PORTS_XML).root.records;
    expect(first).toMatchObject({ registered: '2001-02', updated: '2020-05-05' });
  });

  it('omits registered and updated for a record with neither', () => {
    const second = parse(PORTS_XML).root.records[1];
    expect(second).not.toHaveProperty('registered');
    expect(second).not.toHaveProperty('updated');
  });

  it('joins repeated elements with a newline and keeps first-occurrence attributes', () => {
    const record = parse(NESTED_XML).subregistries[0]?.records[5];
    expect(record?.fields.name).toBe('first\nsecond');
    expect(record?.fieldAttributes).toEqual({
      file: { type: 'template', name: 'alpha/two' },
    });
    expect(record?.fields.file).toBe('alpha/two');
  });

  it('omits an empty element from fields and columns', () => {
    const [first, , , , last] = parse(PORTS_XML).root.records;
    expect(last?.fields).not.toHaveProperty('name');
    expect(first?.fields.name).toBe('example-web');
  });

  it('omits fieldAttributes when no field element carried an attribute', () => {
    expect(only(withRecord('<value>1</value>'))).not.toHaveProperty('fieldAttributes');
  });

  it('builds padded whole-token search text over every field and reference id', () => {
    const record = parse(HTTP_STATUS_XML).subregistries[0]?.records[0];
    expect(record?.searchText).toBe(' 200 ok rfc 9110 ');
  });

  it('keeps the whole value of a long field (callers apply the caps)', () => {
    const long = 'word '.repeat(1_000).trim();
    expect(
      only(withRecord(`<value>1</value><description>${long}</description>`)).fields.description,
    ).toBe(long);
  });

  it('collapses inner whitespace and drops blank lines', () => {
    const xml = `<registry id="x"><title>  A
   B  </title><record><value> 1 </value><description>line1
      line2

   line3</description></record></registry>`;
    const model = parse(xml);
    expect(model.title).toBe('A\nB');
    expect(model.root.records[0]?.fields).toEqual({
      value: '1',
      description: 'line1\nline2\nline3',
    });
  });
});

describe('sparse, port-less and range rows', () => {
  it('keeps a record with no <value>, keyed by its first field, with no date', () => {
    const sparse = parse(NESTED_XML).subregistries[0]?.records[1];
    expect(sparse).toMatchObject({
      fields: { name: 'no-value-column', description: 'Sparse record: no value element, no date' },
      value: 'no-value-column',
      valueField: 'name',
    });
    expect(sparse).not.toHaveProperty('registered');
  });

  it('keeps a record that holds only an xref: no fields, no key, searchable by the reference', () => {
    const refOnly = parse(NESTED_XML).subregistries[0]?.records[2];
    expect(refOnly?.fields).toEqual({});
    expect(refOnly).not.toHaveProperty('value');
    expect(refOnly).not.toHaveProperty('valueField');
    expect(refOnly?.references).toHaveLength(1);
    expect(refOnly?.searchText).toBe(' rfc 9999 ');
  });

  it('keeps an empty <record/> with empty search text', () => {
    const empty = parse(NESTED_XML).subregistries[0]?.records[3];
    expect(empty).toEqual({ fields: {}, references: [], searchText: '' });
  });

  it('keeps a port-less row, keyed by its name', () => {
    const portless = parse(PORTS_XML).root.records[3];
    expect(portless?.fields).not.toHaveProperty('number');
    expect(portless).toMatchObject({ value: 'example-portless', valueField: 'name' });
  });

  it('keeps a range row verbatim in its key column and splits its tokens for search', () => {
    const range = parse(PORTS_XML).root.records[2];
    expect(range).toMatchObject({ value: '5000-5010', valueField: 'number' });
    expect(range?.searchText).toContain(' 5000 5010 ');
    const status = parse(HTTP_STATUS_XML).subregistries[0]?.records[2];
    expect(status?.value).toBe('105-199');
  });

  it('keeps parenthesised markers in the description', () => {
    expect(parse(HTTP_STATUS_XML).subregistries[0]?.records[3]?.fields.description).toBe(
      '(Unused)',
    );
  });
});

describe('mixed content', () => {
  const description = (inner: string) =>
    only(withRecord(`<value>1</value><description>${inner}</description>`)).fields.description;

  it('renders an inline xref as its label, else its id', () => {
    const record = parse(NESTED_XML).subregistries[0]?.records[0];
    expect(record?.fields.description).toBe('Mixed RFC8446, Section 4.2 content\nafter the break');
    expect(description('see <xref type="rfc" data="rfc9110"/>.')).toBe('see RFC 9110.');
    expect(description('see <xref type="draft" data="draft-x-01"/>.')).toBe('see draft-x-01.');
  });

  it('appends the URL to a labelled uri xref and the id to a labelled registry xref', () => {
    expect(description('<xref type="uri" data="https://example.org/a">label</xref>')).toBe(
      'label (https://example.org/a)',
    );
    expect(description('<xref type="registry" data="foo">Bar</xref>')).toBe('Bar (foo)');
    expect(description('<xref type="registry" data="foo">foo table</xref>')).toBe('foo table');
  });

  it('turns <br/> into a newline and block elements into their own lines', () => {
    expect(description('one<br/>two')).toBe('one\ntwo');
    expect(
      description(
        '<paragraph>p1</paragraph><list><li>a</li><li>b</li></list><artwork>art</artwork>',
      ),
    ).toBe('p1\na\nb\nart');
  });

  it('decodes numeric character references once, leaving an escaped ampersand reference as text', () => {
    expect(description('&#233; &#x2014; &amp;#233;')).toBe('é — &#233;');
  });

  it('decodes named entities and CDATA', () => {
    expect(description('a &amp; b &lt;c&gt; &quot;q&quot; <![CDATA[<raw>]]>')).toBe(
      'a & b <c> "q" <raw>',
    );
  });
});

describe('references', () => {
  it('collects a record direct-child xrefs, person xrefs dropped', () => {
    const record = parse(NESTED_XML).subregistries[0]?.records[0];
    expect(record?.references).toEqual([
      { type: 'rfc-errata', id: '1234', url: 'https://www.rfc-editor.org/errata/eid1234' },
      { type: 'note', id: 'alpha-1' },
      { type: 'text', id: 'Informal reference' },
    ]);
  });

  it('reads the section from the attribute, or from the label when there is no attribute', () => {
    const [ok, notFound] = parse(HTTP_STATUS_XML).subregistries[0]?.records ?? [];
    expect(ok?.references[0]).toMatchObject({ id: 'RFC 9110', section: '15.3.1' });
    expect(notFound?.references[0]).toMatchObject({ id: 'RFC 9110', section: '15.5.5' });
    expect(notFound?.references[0]).not.toHaveProperty('label');
  });

  it('normalizes rfc and draft references on a table', () => {
    const alpha = parse(NESTED_XML).subregistries[0];
    expect(alpha?.references).toEqual([
      {
        type: 'draft',
        id: 'draft-example-alpha-04',
        url: 'https://datatracker.ietf.org/doc/draft-example-alpha-04/',
      },
      {
        type: 'draft',
        id: 'draft-ietf-example-beta-12',
        url: 'https://datatracker.ietf.org/doc/draft-ietf-example-beta-12/',
      },
    ]);
  });

  describe('parseReference', () => {
    it.each([
      [
        { type: 'rfc', data: 'rfc 0793' },
        '',
        { type: 'rfc', id: 'RFC 793', url: 'https://www.rfc-editor.org/rfc/rfc793.html' },
      ],
      [
        { type: 'RFC', data: 'RFC1234', section: '3' },
        '',
        {
          type: 'rfc',
          id: 'RFC 1234',
          url: 'https://www.rfc-editor.org/rfc/rfc1234.html',
          section: '3',
        },
      ],
      [{ type: 'rfc', data: 'bcp14' }, '', { type: 'rfc', id: 'bcp14' }],
      [
        { type: 'rfc', data: 'rfc9110' },
        'RFC9110, §3.2',
        {
          type: 'rfc',
          id: 'RFC 9110',
          url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
          section: '3.2',
        },
      ],
      [
        { type: 'rfc', data: 'rfc9110' },
        'Section A.1 of RFC 9110',
        {
          type: 'rfc',
          id: 'RFC 9110',
          url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
          section: 'A.1',
          label: 'Section A.1 of RFC 9110',
        },
      ],
      [
        { type: 'rfc', data: 'rfc9110' },
        'the foo field',
        {
          type: 'rfc',
          id: 'RFC 9110',
          url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
          label: 'the foo field',
        },
      ],
      [
        { type: 'draft', data: 'RFC-ietf-x-01' },
        '',
        {
          type: 'draft',
          id: 'draft-ietf-x-01',
          url: 'https://datatracker.ietf.org/doc/draft-ietf-x-01/',
        },
      ],
      [
        { type: 'uri', data: 'ftp://example.org/x' },
        '',
        { type: 'uri', id: 'ftp://example.org/x' },
      ],
      [
        { type: 'uri', data: 'https://example.org/x' },
        '',
        { type: 'uri', id: 'https://example.org/x', url: 'https://example.org/x' },
      ],
      [
        { type: 'registry', data: 'a b/c' },
        '',
        { type: 'registry', id: 'a b/c', url: 'https://www.iana.org/assignments/a%20b%2Fc' },
      ],
      [{ type: 'rfc-errata', data: 'abc' }, '', { type: 'rfc-errata', id: 'abc' }],
      [{ type: 'note', data: '3' }, '', { type: 'note', id: '3' }],
      [{ type: 'weird', data: 'zzz' }, '', { type: 'text', id: 'zzz' }],
      [{}, 'only a label', { type: 'text', id: 'only a label' }],
    ])('normalizes %j with label %j', (attrs, label, expected) => {
      expect(parseReference(attrs as Record<string, string>, label)).toEqual(expected);
    });

    it.each([
      [{ type: 'person', data: 'Example_Person' }, 'Example Person'],
      [{ type: 'PERSON', data: 'x' }, ''],
      [{ type: 'uri', data: 'mailto:person@example.org' }, ''],
      [{ type: 'uri', data: 'MAILTO:person@example.org' }, ''],
      [{ type: 'rfc', data: '' }, ''],
      [{ type: 'draft', data: '' }, ''],
      [{ type: 'registry', data: '' }, ''],
      [{ type: 'note', data: '' }, ''],
      [{}, ''],
    ])('returns nothing for %j', (attrs, label) => {
      expect(parseReference(attrs as Record<string, string>, label)).toBeUndefined();
    });

    it('scrubs an email-shaped id on a uri or text reference', () => {
      expect(
        parseReference({ type: 'uri', data: 'https://example.org/?to=person@example.org' }, '')?.id,
      ).toBe('https://example.org/?to=[email removed]');
      expect(parseReference({ type: 'text', data: 'see person@example.org' }, '')?.id).toBe(
        'see [email removed]',
      );
    });

    it('does not keep an email-shaped token in the url of a uri reference', () => {
      const ref = parseReference(
        { type: 'uri', data: 'https://example.org/?to=person@example.org' },
        '',
      );
      expect(ref?.url ?? '').not.toContain('person@example.org');
    });
  });
});

describe('person data never reaches the model', () => {
  const sweep = (value: unknown) => JSON.stringify(value);

  it.each([
    ['ports file (assignee, contact, controller xref, inline xref, people)', PORTS_XML],
    ['http status file (expert at two levels)', HTTP_STATUS_XML],
    ['nested file', NESTED_XML],
  ])('%s', (_name, xml) => {
    const text = sweep(parse(xml));
    for (const marker of PERSON_MARKERS) expect(text).not.toContain(marker);
  });

  it('drops <assignee> and <contact> from a record, leaving no field for them', () => {
    const [first] = parse(PORTS_XML).root.records;
    expect(Object.keys(first?.fields ?? {})).toEqual(['name', 'protocol', 'number', 'description']);
    expect(first?.references.map((ref) => ref.id)).toEqual(['RFC 7230']);
  });

  it('drops <expert>, <people>, <assignee> and <contact> nested inside mixed content', () => {
    const model = parse(
      `<registry id="x"><title>t</title>
        <note>Reviewed by <expert>Example Expert</expert> then <contact>Example Contact</contact> done</note>
        <record><value>1</value><description>a <expert>Example Expert</expert> b <people><person>Example Person</person></people> c <assignee>Example Assignee</assignee> d</description></record>
      </registry>`,
    );
    expect(model.root.notes[0]?.text).toBe('Reviewed by then done');
    expect(model.root.records[0]?.fields.description).toBe('a b c d');
  });

  it('drops a person xref wherever it nests: record child, field text, sub-registry, note, range', () => {
    const model = parse(
      `<registry id="x"><title>t</title>
        <xref type="person" data="Example_Person"/>
        <note>by <xref type="person" data="Example_Person">Example Person</xref></note>
        <registry id="s"><title>s</title>
          <xref type="person" data="Example_Person"/>
          <range><value>1-2</value><note><xref type="person" data="Example_Person">Example Person</xref></note></range>
          <record><value>1</value><xref type="person" data="Example_Person"/><description>d <xref type="person" data="Example_Person">Example Person</xref></description></record>
        </registry>
      </registry>`,
    );
    expect(model.root.references).toEqual([]);
    expect(model.subregistries[0]?.references).toEqual([]);
    expect(model.subregistries[0]?.records[0]?.references).toEqual([]);
    const text = sweep(model);
    expect(text).not.toContain('Example Person');
    expect(text).not.toContain('Example_Person');
  });

  it('skips a <people> block inside a sub-registry without disturbing its records', () => {
    const model = parse(
      `<registry id="x"><title>t</title><registry id="s"><title>s</title><people><person id="P"><name>Example Person</name></person></people><record><value>1</value></record></registry></registry>`,
    );
    expect(model.subregistries[0]?.records).toHaveLength(1);
    expect(sweep(model)).not.toContain('Example Person');
  });
});

describe('email-shaped tokens', () => {
  it('replaces them in notes, field text and titles', () => {
    const model = parse(PORTS_XML);
    expect(model.root.notes[0]?.text).toBe(
      'Questions go to [email removed]. See RFC6335, Section 8.1.',
    );
    const nested = parse(NESTED_XML);
    expect(nested.subregistries[0]?.records[4]?.fields.description).toBe(
      'Reach the maintainers at [email removed]',
    );
    expect(
      parse(
        `<registry id="x"><title>Mail person@example.org</title><record><value>1</value></record></registry>`,
      ).title,
    ).toBe('Mail [email removed]');
  });

  it('keeps an email-shaped key column verbatim while scrubbing every other field', () => {
    const record = parse(NESTED_XML).subregistries[0]?.records[4];
    expect(record).toMatchObject({ value: 'bindkey@example.org', valueField: 'value' });
    expect(record?.fields.value).toBe('bindkey@example.org');
    expect(record?.fields.description).not.toContain('@');
  });

  it('keeps the key verbatim when the key column is number or the first field', () => {
    expect(
      only(withRecord('<number>a@example.org</number><name>b@example.org</name>')).fields,
    ).toEqual({
      number: 'a@example.org',
      name: '[email removed]',
    });
    expect(
      only(withRecord('<name>a@example.org</name><description>c@example.org</description>')).fields,
    ).toEqual({ name: 'a@example.org', description: '[email removed]' });
  });

  it('drops a mailto: xref instead of keeping it as a reference or inline text', () => {
    const record = only(
      withRecord(
        '<value>1</value><description>mail <xref type="uri" data="mailto:person@example.org">them</xref> now</description><xref type="uri" data="mailto:person@example.org"/>',
      ),
    );
    expect(record.references).toEqual([]);
    expect(record.fields.description).toBe('mail now');
  });
});

describe('unreadable files', () => {
  const failure = (xml: string) => asMcpError(catching(() => parse(xml)));

  function catching(fn: () => unknown): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    throw new Error('Expected a throw.');
  }

  it.each([
    ['a DOCTYPE', DOCTYPE_XML, /DOCTYPE/],
    ['a document that is not a registry', WRONG_ROOT_XML, /no <registry> root/],
    ['a registry with no records, sub-registries or legacy pointer', EMPTY_XML, /zero records/],
    ['unbalanced markup that leaves no records', MALFORMED_XML, /zero records|well-formed/],
    ['an empty body', '', /no <registry> root/],
    [
      'an HTML error page',
      '<html><head><title>Page not found</title></head><body>404</body></html>',
      /no <registry> root/,
    ],
  ])('rejects %s as upstream_unreadable (ServiceUnavailable)', (_name, xml, message) => {
    const error = failure(xml);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', url: URL_ });
    expect(error.message).toMatch(message);
  });

  it('rejects a truncated file as not well-formed, with the parser error as cause', () => {
    const error = failure(
      `<registry id="x"><title>t</title><record><value>1</value></record><record><value>2</val`,
    );
    expect(error.message).toContain('not well-formed');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('does not expand a DOCTYPE entity even when the DOCTYPE is the only problem', () => {
    const error = failure(DOCTYPE_XML);
    expect(error.message).not.toContain('expanded');
  });

  it('accepts a legacy stub: no records, the file pointer on the model and the root table', () => {
    const model = parse(LEGACY_STUB_XML);
    expect(model.recordCount).toBe(0);
    expect(model.legacyFile).toBe('example-legacy.txt');
    expect(model.root.legacyFile).toBe('example-legacy.txt');
    expect(model.updated).toBe('2026-09-17');
  });

  it('ignores a non-legacy <file> on a table', () => {
    const model = parse(
      `<registry id="x"><title>t</title><file type="template">a/b</file><record><value>1</value></record></registry>`,
    );
    expect(model).not.toHaveProperty('legacyFile');
  });

  it('accepts a DOCTYPE-looking string inside text after the root begins', () => {
    const model = parse(
      `<registry id="x"><title>t</title><record><value>1</value><description>mentions &lt;!DOCTYPE html&gt; literally</description></record></registry>`,
    );
    expect(model.root.records[0]?.fields.description).toBe('mentions <!DOCTYPE html> literally');
  });
});
