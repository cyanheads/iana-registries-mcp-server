/**
 * @fileoverview Hand-written IANA registry XML excerpts shaped like the API
 * Reference (`<registry>`, nested `<registry>`, `<record>`, `<xref>`, `<note>`,
 * `<range>`, `<expert>`, `<people>`). Every person is invented
 * (`Example Person`, `example.org`); nothing is copied from a real registry.
 * @module tests/fixtures/registry-xml
 */

const XML_DECLARATION = "<?xml version='1.0' encoding='UTF-8'?>";
const NS = 'xmlns="http://www.iana.org/assignments"';

/** The invented people and addresses the fixtures carry; tests assert none of them survive. */
export const PERSON_MARKERS = [
  'Example Person',
  'Example_Person',
  'Example Expert',
  'Example Assignee',
  'Example Contact',
  'Example Reviewer',
  'person@example.org',
  'expert@example.org',
  'contact@example.org',
] as const;

/**
 * A port-registry shaped file: port-less rows, range rows, an `<assignee>` and
 * `<contact>` carrying person data, a person xref inside a record, a `<controller>`
 * holding a person xref beside org text, a `<people>` block, and dates.
 */
export const PORTS_XML = `${XML_DECLARATION}
<registry ${NS} id="service-names-port-numbers">
  <title>Service Name and Transport Protocol Port Number Registry</title>
  <category>Example Category</category>
  <created>2000-01-01</created>
  <updated>2026-09-01</updated>
  <xref type="rfc" data="rfc6335"/>
  <registration_rule>See [RFC6335]</registration_rule>
  <expert>Example Expert</expert>
  <note>Questions go to registrar@example.org. See <xref type="rfc" data="rfc6335">RFC6335, Section 8.1</xref>.</note>
  <record date="2001-02" updated="2020-05-05">
    <name>example-web</name>
    <protocol>tcp</protocol>
    <number>8080</number>
    <description>Example HTTP alternate port</description>
    <xref type="rfc" data="rfc7230"/>
    <assignee>Example Assignee <xref type="person" data="Example_Person"/></assignee>
    <contact><xref type="person" data="Example_Person"/> person@example.org</contact>
  </record>
  <record>
    <name>example-web</name>
    <protocol>udp</protocol>
    <number>8080</number>
    <description>Reserved for future use</description>
  </record>
  <record>
    <name>example-range</name>
    <protocol>tcp</protocol>
    <number>5000-5010</number>
    <description>Example range row</description>
  </record>
  <record>
    <name>example-portless</name>
    <protocol>none</protocol>
    <description>Service name reserved without a port; see <xref type="person" data="Example_Person">Example Person</xref> for details</description>
    <controller>Example Org <xref type="person" data="Example_Person"/></controller>
  </record>
  <record>
    <name/>
    <protocol>tcp</protocol>
    <number>9</number>
    <description>Empty name element is omitted</description>
  </record>
  <people>
    <person id="Example_Person">
      <name>Example Person</name>
      <org>Example Org</org>
      <uri>mailto:person@example.org</uri>
      <updated>2020-01-01</updated>
    </person>
  </people>
</registry>
`;

/**
 * An HTTP-status-shaped file: one sub-registry, `<value>`-keyed records, a range
 * row, parenthesised markers, xrefs with a `section` attribute and with the
 * section only in the label, a registry-level `<expert>`, and a `<footnote>`.
 */
export const HTTP_STATUS_XML = `${XML_DECLARATION}
<registry ${NS} id="http-status-codes">
  <title>Hypertext Transfer Protocol (HTTP) Status Code Registry</title>
  <created>2000-01-01</created>
  <updated>2025-09-15</updated>
  <registration_rule>IETF Review</registration_rule>
  <expert>Example Expert</expert>
  <note title="WARNING">Status codes are <xref type="rfc" data="rfc9110">RFC9110, Section 15</xref> defined.</note>
  <registry id="http-status-codes-1">
    <title>HTTP Status Codes</title>
    <registration_rule>IETF Review</registration_rule>
    <expert>Example Expert</expert>
    <record>
      <value>200</value>
      <description>OK</description>
      <xref type="rfc" data="rfc9110" section="15.3.1"/>
    </record>
    <record>
      <value>404</value>
      <description>Not Found</description>
      <xref type="rfc" data="rfc9110">RFC9110, Section 15.5.5</xref>
    </record>
    <record>
      <value>105-199</value>
      <description>Unassigned</description>
    </record>
    <record>
      <value>306</value>
      <description>(Unused)</description>
      <xref type="rfc" data="rfc9110"/>
    </record>
    <footnote anchor="note1">Footnote text.</footnote>
  </registry>
</registry>
`;

/**
 * A nested file: root records, two sub-registries (one with a nested
 * sub-registry), notes with anchors, `<range>` blocks, mixed content, a sparse
 * record with no `<value>`/`<number>`, a record with only xrefs, an empty
 * `<record/>`, and a record whose key column is email-shaped.
 */
export const NESTED_XML = `${XML_DECLARATION}
<registry ${NS} id="example-parameters">
  <title>Example Parameters</title>
  <category>Example Protocol</category>
  <updated>2026-08-30</updated>
  <xref type="rfc" data="rfc9999"/>
  <registration_rule>Specification Required</registration_rule>
  <note anchor="root-note">Root note with <xref type="uri" data="https://example.org/spec">the spec</xref> and <xref type="registry" data="example-other">Other Registry</xref>.</note>
  <registry id="alpha">
    <title>Alpha Values</title>
    <updated>2026-08-01</updated>
    <registration_rule>Expert Review</registration_rule>
    <expert>Example Expert</expert>
    <xref type="draft" data="draft-example-alpha-04"/>
    <xref type="draft" data="RFC-ietf-example-beta-12"/>
    <note anchor="alpha-1" title="NOTE">First line<br/>second line<paragraph>A paragraph</paragraph><paragraph>Another paragraph</paragraph></note>
    <range>
      <value>0-223</value>
      <registration_rule>Standards Action</registration_rule>
      <note>Assigned by the working group.</note>
    </range>
    <range>
      <value>224-255</value>
      <registration_rule>Private Use</registration_rule>
    </range>
    <record date="2019-04-01">
      <value>1</value>
      <name>alpha-one</name>
      <description>Mixed <xref type="rfc" data="rfc8446">RFC8446, Section 4.2</xref> content<br/>after the break</description>
      <xref type="rfc-errata" data="1234"/>
      <xref type="note" data="alpha-1"/>
      <xref type="text" data="Informal reference"/>
    </record>
    <record>
      <name>no-value-column</name>
      <description>Sparse record: no value element, no date</description>
    </record>
    <record>
      <xref type="rfc" data="rfc9999"/>
    </record>
    <record/>
    <record>
      <value>bindkey@example.org</value>
      <description>Reach the maintainers at maintainers@example.org</description>
    </record>
    <record>
      <value>2</value>
      <name>first</name>
      <name>second</name>
      <file type="template" name="alpha/two">alpha/two</file>
    </record>
    <registry id="alpha-deep">
      <title>Alpha Deep Values</title>
      <record>
        <value>10</value>
        <description>Deeply nested record</description>
      </record>
      <registry id="alpha-deeper">
        <title>Alpha Deeper Values</title>
        <record>
          <value>11</value>
        </record>
      </registry>
    </registry>
  </registry>
  <registry id="beta">
    <title>Beta Values</title>
    <footnote anchor="beta-fn">Beta footnote.</footnote>
    <record>
      <value>7</value>
      <description>Beta record</description>
    </record>
  </registry>
</registry>
`;

/** A legacy stub: no records, a `<file type="legacy">` pointer to a plain-text file. */
export const LEGACY_STUB_XML = `${XML_DECLARATION}
<registry ${NS} id="example-legacy">
  <title>Example Legacy Registry</title>
  <created>2001-01-01</created>
  <updated>2026-09-17</updated>
  <registration_rule>Specification Required</registration_rule>
  <file type="legacy">example-legacy.txt</file>
</registry>
`;

/** A well-formed registry with a title but no records, sub-registries, or legacy pointer. */
export const EMPTY_XML = `${XML_DECLARATION}
<registry ${NS} id="example-empty">
  <title>Example Empty Registry</title>
  <updated>2026-09-17</updated>
</registry>
`;

/** A registry holding only sub-registries that carry no records. */
export const EMPTY_SUBREGISTRY_XML = `${XML_DECLARATION}
<registry ${NS} id="example-hollow">
  <title>Example Hollow Registry</title>
  <registry id="hollow-1"><title>Hollow One</title></registry>
</registry>
`;

/** A DOCTYPE with an internal entity before the root. */
export const DOCTYPE_XML = `${XML_DECLARATION}
<!DOCTYPE registry [<!ENTITY example "expanded">]>
<registry ${NS} id="example-doctype">
  <title>&example;</title>
  <record><value>1</value></record>
</registry>
`;

/** A well-formed document whose root is not `<registry>`. */
export const WRONG_ROOT_XML = `${XML_DECLARATION}
<html><body>Page not found</body></html>
`;

/** An unterminated document. */
export const MALFORMED_XML = `${XML_DECLARATION}
<registry ${NS} id="example-broken">
  <title>Broken
  <record><value>1</value></record>
`;

/** The minimal curated-shaped file: one record under the root. */
export function curatedXml(id: string, updated = '2026-09-01', extraRecords = ''): string {
  return `${XML_DECLARATION}
<registry ${NS} id="${id}">
  <title>${id} title</title>
  <updated>${updated}</updated>
  <record><value>1</value><description>first</description></record>
  ${extraRecords}
</registry>
`;
}

/** A generic registry of `count` records, padded so its decoded size is at least `minBytes`. */
export function sizedXml(id: string, minBytes: number, count = 1): string {
  const filler = 'x'.repeat(Math.max(0, minBytes - 400));
  const records = Array.from(
    { length: count },
    (_, index) => `<record><value>${index}</value><description>${filler}</description></record>`,
  ).join('\n');
  return `${XML_DECLARATION}
<registry ${NS} id="${id}"><title>${id}</title><updated>2026-01-01</updated>${records}</registry>
`;
}
