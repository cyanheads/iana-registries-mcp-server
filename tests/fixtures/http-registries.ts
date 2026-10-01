/**
 * @fileoverview Hand-written excerpts shaped like the three curated registries
 * the HTTP and URI tools read: `http-status-codes` (sub-registry
 * `http-status-codes-1`), `http-fields` (`field-names`), and `uri-schemes`
 * (`uri-schemes-1`, plus an allocator sub-registry the tools must ignore). Names
 * and addresses are invented (`example.org`).
 * @module tests/fixtures/http-registries
 */

const XML_DECLARATION = "<?xml version='1.0' encoding='UTF-8'?>";
const NS = 'xmlns="http://www.iana.org/assignments"';

/** Escapes text for an XML body. */
export const xmlEscape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Wraps `records` in one sub-registry of a curated-shaped file. */
export function singleTableXml(
  registryId: string,
  tableId: string,
  records: string,
  updated = '2025-09-15',
): string {
  return `${XML_DECLARATION}
<registry ${NS} id="${registryId}">
  <title>${registryId} registry</title>
  <updated>${updated}</updated>
  <registry id="${tableId}">
    <title>${tableId} table</title>
    ${records}
  </registry>
</registry>
`;
}

/** `http-status-codes`: assigned, unused, obsoleted, temporary, range, and unassigned rows. */
export const STATUS_XML = `${XML_DECLARATION}
<registry ${NS} id="http-status-codes">
  <title>Hypertext Transfer Protocol (HTTP) Status Code Registry</title>
  <updated>2025-09-15</updated>
  <registration_rule>IETF Review</registration_rule>
  <registry id="http-status-codes-1">
    <title>HTTP Status Codes</title>
    <record date="2020-01-02" updated="2022-06-06">
      <value>100</value>
      <description>Continue</description>
      <xref type="rfc" data="rfc9110" section="15.2.1"/>
    </record>
    <record>
      <value>104</value>
      <description>Upload Resumption Supported (TEMPORARY - registered 2024-11-13, expires 2025-11-13)</description>
      <xref type="draft" data="draft-example-resumable-upload"/>
    </record>
    <record>
      <value>105-199</value>
      <description>Unassigned</description>
    </record>
    <record>
      <value>200</value>
      <description>OK</description>
      <xref type="rfc" data="rfc9110">RFC9110, Section 15.3.1</xref>
    </record>
    <record>
      <value>305</value>
      <description>Use Proxy (OBSOLETED)</description>
      <xref type="rfc" data="rfc9110"/>
    </record>
    <record>
      <value>306</value>
      <description>(Unused)</description>
      <xref type="rfc" data="rfc9110"/>
    </record>
    <record>
      <value>404</value>
      <description>Not Found</description>
      <xref type="rfc" data="rfc9110" section="15.5.5"/>
    </record>
    <record>
      <value>418</value>
      <description>(Unused)</description>
      <xref type="rfc" data="rfc9110"/>
    </record>
    <record>
      <value>429</value>
      <description>Too Many Requests</description>
      <xref type="rfc" data="rfc6585" section="4"/>
    </record>
    <record>
      <value>432-450</value>
      <description>Unassigned</description>
    </record>
    <record>
      <value>502</value>
      <description>Bad Gateway</description>
      <xref type="rfc" data="rfc9110" section="15.6.3"/>
    </record>
    <record>
      <value>504</value>
      <description>Gateway Timeout</description>
      <xref type="rfc" data="rfc9110" section="15.6.5"/>
    </record>
    <record>
      <value>512-599</value>
      <description>Unassigned</description>
    </record>
  </registry>
</registry>
`;

/** `http-fields`: mixed-case status values, structured types, comments, a duplicate name. */
export const FIELDS_XML = `${XML_DECLARATION}
<registry ${NS} id="http-fields">
  <title>Hypertext Transfer Protocol (HTTP) Field Name Registry</title>
  <updated>2026-03-10</updated>
  <registry id="field-names">
    <title>Field Names</title>
    <record date="2022-06-01">
      <value>Accept</value>
      <status>permanent</status>
      <structured>List</structured>
      <xref type="rfc" data="rfc9110" section="12.5.1"/>
    </record>
    <record>
      <value>Cache-Status</value>
      <status>permanent</status>
      <structured>List</structured>
      <comments>Describes cache handling of the response.</comments>
      <xref type="rfc" data="rfc9211"/>
    </record>
    <record>
      <value>Content-Type</value>
      <status>Permanent</status>
      <xref type="rfc" data="rfc9110" section="8.3"/>
    </record>
    <record updated="2024-02-02">
      <value>Example-Provisional</value>
      <status>Provisional</status>
      <comments>Questions to maintainers@example.org about <xref type="uri" data="https://example.org/spec/provisional">the spec</xref>.</comments>
    </record>
    <record>
      <value>Example-Deprecated</value>
      <status>deprecated</status>
      <comments>Use a newer field instead.</comments>
    </record>
    <record>
      <value>Example-Obsolete</value>
      <status>obsoleted</status>
      <comments>Line one
        <br/>Line two</comments>
    </record>
    <record>
      <value>Example-Dual</value>
      <status>permanent</status>
    </record>
    <record>
      <value>Example-Dual</value>
      <status>deprecated</status>
    </record>
    <record>
      <value>Example-Unrecorded</value>
      <comments>No status element on this row.</comments>
    </record>
  </registry>
</registry>
`;

/** `uri-schemes`: `uri-schemes-1` rows plus an allocator sub-registry the tool never reads. */
export const SCHEMES_XML = `${XML_DECLARATION}
<registry ${NS} id="uri-schemes">
  <title>Uniform Resource Identifier (URI) Schemes</title>
  <updated>2026-01-15</updated>
  <registry id="uri-schemes-1">
    <title>URI Schemes</title>
    <record date="2011-12-01">
      <value>https</value>
      <description>Hypertext Transfer Protocol Secure</description>
      <status>Permanent</status>
      <well-known>-</well-known>
      <file type="template" name="https">https</file>
      <xref type="rfc" data="rfc9110" section="4.2.2"/>
      <notes/>
    </record>
    <record>
      <value>mailto</value>
      <description>Electronic mail address</description>
      <status>permanent</status>
      <well-known>-</well-known>
      <xref type="rfc" data="rfc6068"/>
    </record>
    <record>
      <value>shttp (OBSOLETE)</value>
      <description>Secure Hypertext Transfer Protocol</description>
      <status>Historical</status>
      <xref type="rfc" data="rfc2660"/>
    </record>
    <record>
      <value>ws</value>
      <description>WebSocket connections</description>
      <status>permanent</status>
      <well-known><xref type="rfc" data="rfc8615"/></well-known>
      <file type="template" name="ws/a b">ws/a b</file>
    </record>
    <record>
      <value>wss</value>
      <description>Encrypted WebSocket connections</description>
      <status>permanent</status>
    </record>
    <record>
      <value>example-prov</value>
      <description>Example provisional scheme, contact support@example.org</description>
      <status>Provisional</status>
      <notes>Some registry notes.</notes>
    </record>
    <record>
      <value>example-bare</value>
      <description>No status recorded</description>
    </record>
  </registry>
  <registry id="example-allocators">
    <title>Example Allocator Numbers</title>
    <record>
      <value>0-99</value>
      <description>Allocator range, never a scheme</description>
    </record>
  </registry>
</registry>
`;
