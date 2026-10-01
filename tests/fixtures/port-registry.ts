/**
 * @fileoverview Hand-written `service-names-port-numbers` excerpt shaped like
 * the API Reference: root-level records keyed by `<number>` (single ports,
 * `a-b` range rows, port-less rows), `<assignee>`/`<contact>` carrying invented
 * person data, a scrubbed address, and one record of hostile text. Every person
 * and address is invented (`Example Person`, `example.org`).
 * @module tests/fixtures/port-registry
 */

import { xmlEscape } from './http-registries.js';

const XML_DECLARATION = "<?xml version='1.0' encoding='UTF-8'?>";
const NS = 'xmlns="http://www.iana.org/assignments"';

/** The invented person data the port fixture carries; tests assert none of it survives. */
export const PORT_PERSON_MARKERS = [
  'Example Person',
  'Example_Person',
  'person@example.org',
] as const;

/** One port record. */
export interface PortRow {
  /** `date` and `updated` attributes. */
  attrs?: string;
  description?: string;
  /** Raw inner XML appended after the standard children (xrefs, notes). */
  extra?: string;
  name?: string;
  number?: string;
  protocol?: string;
}

/** Builds one `<record>`; omitted children are left out. */
export function portRecord(row: PortRow): string {
  const child = (tag: string, text: string | undefined) =>
    text === undefined ? '' : `<${tag}>${text}</${tag}>`;
  return (
    `<record${row.attrs ? ` ${row.attrs}` : ''}>` +
    child('name', row.name) +
    child('protocol', row.protocol) +
    child('number', row.number) +
    child('description', row.description) +
    (row.extra ?? '') +
    '</record>'
  );
}

/** Wraps records in the curated-shaped root registry. */
export function portsXml(records: string, updated = '2026-09-01'): string {
  return `${XML_DECLARATION}
<registry ${NS} id="service-names-port-numbers">
  <title>Service Name and Transport Protocol Port Number Registry</title>
  <updated>${updated}</updated>
  ${records}
</registry>
`;
}

const rfc = (data: string, section?: string) =>
  `<xref type="rfc" data="${data}"${section ? ` section="${section}"` : ''}/>`;

/** Rows for ports 0, 9, 22, 63, 66, 123, 443, 1000–1010, 1500–1600, 2525, 4000, 5432, 5990–6010, 7777, 31337 and port-less names. */
export const PORT_RECORDS = [
  portRecord({ protocol: 'tcp', number: '0', description: 'Reserved', extra: rfc('rfc6335') }),
  portRecord({ protocol: 'udp', number: '0', description: 'Reserved', extra: rfc('rfc6335') }),
  portRecord({ protocol: 'tcp', number: '9', description: 'De-registered' }),
  portRecord({
    name: 'ssh',
    protocol: 'tcp',
    number: '22',
    description: 'The Secure Shell (SSH) Protocol',
    attrs: 'date="2001-01" updated="2021-03-02"',
    extra:
      `${rfc('rfc4251')}<assignee>Example Person <xref type="person" data="Example_Person"/></assignee>` +
      '<contact><xref type="person" data="Example_Person"/> person@example.org</contact>',
  }),
  portRecord({ name: 'whois++', protocol: 'tcp', number: '63', description: 'whois++' }),
  portRecord({ name: 'sql*net', protocol: 'tcp', number: '66', description: 'Oracle SQL*NET' }),
  portRecord({
    name: 'ntp',
    protocol: 'udp',
    number: '123',
    description: 'Network Time Protocol',
    extra: rfc('rfc5905'),
  }),
  portRecord({
    name: 'ntp',
    protocol: 'tcp',
    number: '123',
    description: 'Network Time Protocol',
    extra: rfc('rfc5905'),
  }),
  portRecord({ name: 'example-time', protocol: 'tcp', number: '37', description: 'Time' }),
  portRecord({
    name: 'https',
    protocol: 'sctp',
    number: '443',
    description: 'http protocol over TLS/SSL',
    extra: rfc('rfc4960'),
  }),
  portRecord({
    name: 'https',
    protocol: 'udp',
    number: '443',
    description: 'http protocol over TLS/SSL',
    extra: rfc('rfc9114', '3.1'),
  }),
  portRecord({
    name: 'https',
    protocol: 'tcp',
    number: '443',
    description: 'http protocol over TLS/SSL',
    extra: rfc('rfc9110'),
  }),
  portRecord({
    name: 'example-alt',
    protocol: 'dccp',
    number: '443',
    description: 'Alternate service on the https port',
  }),
  portRecord({ protocol: 'tcp', number: '443', description: 'De-registered' }),
  portRecord({ number: '1002-1007', description: 'Unassigned' }),
  portRecord({ number: '1000-1010', description: 'Reserved' }),
  portRecord({ number: '1500', description: 'UNASSIGNED' }),
  portRecord({
    name: 'example-reserved-name',
    protocol: 'tcp',
    number: '1600',
    description: 'Reserved',
  }),
  portRecord({
    name: 'example-mail',
    protocol: 'tcp',
    number: '2525',
    description: 'Mail relay, report abuse to abuse@example.org',
  }),
  portRecord({ name: 'example-bare', protocol: 'tcp', number: '4000' }),
  portRecord({
    name: 'postgresql',
    protocol: 'tcp',
    number: '5432',
    description: 'PostgreSQL Database',
    extra: '<note>Only the first note text</note>',
  }),
  portRecord({
    name: 'postgresql',
    protocol: 'udp',
    number: '5432',
    description: 'PostgreSQL Database',
    extra: '<unauthorized>Used by example malware</unauthorized>',
  }),
  portRecord({ number: '5990-6010', description: 'Unassigned' }),
  portRecord({
    name: 'example-multi',
    protocol: 'udp',
    number: '6000',
    description: 'Multi port service',
  }),
  portRecord({
    name: 'example-multi',
    protocol: 'tcp',
    number: '6000',
    description: 'Multi port service',
  }),
  portRecord({
    name: 'example-multi',
    protocol: 'udp',
    number: '5999',
    description: 'Multi port service',
  }),
  portRecord({
    name: 'example-multi',
    description: 'Multi port service names registered without a port',
  }),
  portRecord({
    name: 'example-udp',
    protocol: 'udp',
    number: '7777',
    description: 'A service registered for udp only',
  }),
  portRecord({
    name: 'example-dnssd',
    protocol: 'tcp',
    description: 'DNS-SD service name registered without a port',
  }),
  portRecord({
    name: 'example-clock',
    description: 'Clock time synchronization names, no port',
  }),
].join('\n  ');

/** The default port fixture. */
export const PORTS_XML = portsXml(PORT_RECORDS);

/** One record of upstream-authored text a renderer must not let reach markdown structure. */
export const HOSTILE_PORT_RECORD = portRecord({
  name: `evil[1]<br/># Pwned ${xmlEscape('<b>x</b>')}`,
  protocol: `tcp<br/>## Proto`,
  number: `x[1]<br/>- item`,
  description: `${xmlEscape('![i](https://evil.example/i.png) <script>alert(1)</script>')}<br/># Heading<br/>---\u202E\u0007`,
  extra:
    `<note>note<br/># Note heading</note>` +
    `<unauthorized>unauth<br/>- listed ${xmlEscape('[l](m)')}</unauthorized>`,
});
