/**
 * @fileoverview Hand-written `media-types` registry excerpt (one sub-registry per
 * top-level type, `<name>` mixing subtype and status annotation, `<file
 * type="template">` per record, one `<file name>` alias) and registration
 * template bodies in the three layouts the design names: labelled, numbered
 * vendor form, and bare `Name :`/`Email :` lines, plus the placeholder page IANA
 * serves for a type with no template and a registry excerpt for file-extension
 * keywords. Every person and address is invented (`Example Person`, `example.org`).
 * @module tests/fixtures/media-registry
 */

const XML_DECLARATION = "<?xml version='1.0' encoding='UTF-8'?>";
const NS = 'xmlns="http://www.iana.org/assignments"';

/** Invented person data the templates carry; tests assert none of it reaches a result. */
export const TEMPLATE_PERSON_MARKERS = [
  'Example Person',
  'person@example.org',
  'contact@example.org',
  'person&example.org',
  'contact&example.org',
] as const;

/** One media-type record. `file` is the `<file type="template">` text; `alias` its `name` attribute. */
export interface MediaRow {
  alias?: string;
  attrs?: string;
  extra?: string;
  file?: string;
  /** Inner XML of `<name>`. */
  name: string;
}

/** Builds one `<record>`. */
export function mediaRecord(row: MediaRow): string {
  const file =
    row.file === undefined
      ? ''
      : `<file type="template"${row.alias ? ` name="${row.alias}"` : ''}>${row.file}</file>`;
  return `<record${row.attrs ? ` ${row.attrs}` : ''}><name>${row.name}</name>${file}${row.extra ?? ''}</record>`;
}

/** Wraps `tables` (top-level id → record XML) in the `media-types` root registry. */
export function mediaXml(tables: Readonly<Record<string, string>>, updated = '2026-09-30'): string {
  const subs = Object.entries(tables)
    .map(
      ([id, records]) =>
        `<registry id="${id}"><title>${id}</title><registration_rule>Expert Review</registration_rule>${records}</registry>`,
    )
    .join('\n  ');
  return `${XML_DECLARATION}
<registry ${NS} id="media-types">
  <title>Media Types</title>
  <updated>${updated}</updated>
  ${subs}
  <people>
    <person id="Example_Person"><name>Example Person</name><uri>mailto:person@example.org</uri></person>
  </people>
</registry>
`;
}

const rfc = (data: string) => `<xref type="rfc" data="${data}"/>`;
const person = '<xref type="person" data="Example_Person"/>';

/** Application records: current, obsoleted (bare and qualified replacements), deprecated, mixed case, duplicates. */
export const APPLICATION_RECORDS = [
  mediaRecord({
    name: 'vnd.api+json',
    file: 'application/vnd.api+json',
    extra: rfc('rfc6838'),
  }),
  mediaRecord({
    name: 'json',
    file: 'application/json',
    attrs: 'date="2013-06-10" updated="2022-03-04"',
    extra: `${rfc('rfc8259')}${person}`,
  }),
  mediaRecord({ name: 'geo+json', file: 'application/geo+json', extra: rfc('rfc7946') }),
  mediaRecord({
    name: `vnd.geo+json (OBSOLETED by ${rfc('rfc7946')} in favor of application/geo+json)`,
    file: 'application/vnd.geo+json',
  }),
  mediaRecord({
    name: 'javascript (OBSOLETED in favor of text/javascript.)',
    file: 'application/javascript',
  }),
  mediaRecord({
    name: 'vnd.afpc.afplinedata (OBSOLETED in favor of vnd.afpc.modca)',
    file: 'application/vnd.afpc.afplinedata',
  }),
  mediaRecord({ name: 'vnd.gmx - DEPRECATED', file: 'application/vnd.gmx' }),
  mediaRecord({ name: 'remote-printing (OBSOLETE)', file: 'application/remote-printing' }),
  mediaRecord({
    name: 'vnd.example.favour (OBSOLETED in favour of vnd.example.new)',
    file: 'application/vnd.example.favour',
  }),
  mediaRecord({
    name: 'vnd.example.note (see the registration notes)',
    file: 'application/vnd.example.note',
  }),
  mediaRecord({
    name: 'vnd.ms-excel.addin.macroEnabled.12',
    file: 'application/vnd.ms-excel.addin.macroEnabled.12',
  }),
  mediaRecord({
    name: 'vnd.example.dup',
    file: 'application/vnd.example.dup',
    attrs: 'date="2020-01-01"',
  }),
  mediaRecord({
    name: 'vnd.example.dup',
    file: 'application/vnd.example.dup',
    attrs: 'date="2021-01-01"',
  }),
  mediaRecord({ name: 'vnd.example.spaced', file: 'application/vnd.example.a b[c]' }),
  mediaRecord({ name: 'vnd.example.nofile' }),
  mediaRecord({
    name: 'vnd.example.contact',
    file: 'application/vnd.example.contact',
    extra: `<contact>${person} person@example.org</contact><assignee>Example Person</assignee>`,
  }),
].join('\n    ');

/** The default media-types fixture: application, image (with an alias), text, haptics; no `video` table. */
export const MEDIA_XML = mediaXml({
  application: APPLICATION_RECORDS,
  image: [
    mediaRecord({ name: 'emf', file: 'image/emf' }),
    mediaRecord({ name: 'x-emf', file: 'image/emf', alias: 'image/x-emf' }),
    mediaRecord({ name: 'png', file: 'image/png' }),
  ].join('\n    '),
  text: [
    mediaRecord({ name: 'plain', file: 'text/plain' }),
    mediaRecord({ name: 'javascript', file: 'text/javascript' }),
  ].join('\n    '),
  haptics: mediaRecord({ name: 'ivs', file: 'haptics/ivs' }),
});

/**
 * Records modeled on the live registry for file-extension keywords: `jpg` names
 * only `image/vnd.sealedmedia.softseal.jpg`, `svg` and `epub` name no subtype
 * though their type is present, three `doc` records fill a cut page at limit 2,
 * and `png`, `json`, and `mpeg` are subtype names.
 */
export const EXTENSION_XML = mediaXml({
  application: [
    mediaRecord({ name: 'json', file: 'application/json' }),
    mediaRecord({
      name: 'vnd.3gpp.seal-group-doc+xml',
      file: 'application/vnd.3gpp.seal-group-doc+xml',
    }),
    mediaRecord({ name: 'vnd.collection.doc+json', file: 'application/vnd.collection.doc+json' }),
    mediaRecord({ name: 'vnd.sealed.doc', file: 'application/vnd.sealed.doc' }),
    mediaRecord({ name: 'epub+zip', file: 'application/epub+zip' }),
  ].join('\n    '),
  audio: mediaRecord({ name: 'mpeg', file: 'audio/mpeg' }),
  image: [
    mediaRecord({ name: 'gif', file: 'image/gif' }),
    mediaRecord({ name: 'jpeg', file: 'image/jpeg' }),
    mediaRecord({ name: 'png', file: 'image/png' }),
    mediaRecord({ name: 'svg+xml', file: 'image/svg+xml' }),
    mediaRecord({
      name: 'vnd.sealedmedia.softseal.jpg',
      file: 'image/vnd.sealedmedia.softseal.jpg',
    }),
  ].join('\n    '),
  text: mediaRecord({ name: 'plain', file: 'text/plain' }),
});

/** The 35-byte page IANA serves, as HTTP 200 `text/plain`, at the template URL of a registered type with no registration template. */
export const TEMPLATE_PLACEHOLDER = 'No registration template available.';

/** A real template whose text merely contains the placeholder sentence. */
export const TEMPLATE_QUOTING_PLACEHOLDER = `Type name: application

Subtype name: vnd.example.quoting

File extension(s): .quo

Additional information: No registration template available.
`;

/** Layout 1: the labelled template, with the three statements and a contact block. */
export const TEMPLATE_LABELLED = `Type name: application

Subtype name: json

Required parameters: n/a

Encoding considerations: binary

Additional information:

   Deprecated alias names for this type: n/a
   Magic number(s): n/a
   File extension(s): .json
   Macintosh file type code(s): TEXT

Person & email address to contact for further information:
   Example Person <person@example.org>

Intended usage: COMMON

Restrictions on usage: none

Author:
   Example Person <person@example.org>

Change controller:
   Example Org
`;

/** Layout 2: the numbered vendor form, `Name :` and `Email :` lines, labels with a space before the colon. */
export const TEMPLATE_NUMBERED = `Name : Example Person
Email : person@example.org

Media type name : application
Media subtype name : vnd.example.kml

1. Required parameters : none
2. File extension(s) : kml
   and sometimes kmz
3. Intended usage : COMMON
4. Deprecated alias names for this type : none
5. Contact : Example Person
`;

/** Layout 3: bare `Name :`/`Email :` head lines and an `Author/Change controller` line. */
export const TEMPLATE_BARE = `Name : Example Person
Email : person@example.org

MIME media type name : application
MIME subtype name : x-example

   File extension(s): ex1
   Intended usage: LIMITED USE

Author/Change controller : Example Person
`;

/** A template with no label the extractor reads. */
export const TEMPLATE_NO_LABELS = `Type name: application
Subtype name: nothing

Published specification: none
`;

/** A hostile template: line breaks and markdown inside statements, an email-shaped line, bidi and control characters. */
export const TEMPLATE_HOSTILE = [
  'File extension(s): .evil',
  '# Forged heading',
  '- forged item',
  '[x](https://evil.example/)',
  '<b>bold</b>\u202E\u0007',
  '',
  'Intended usage: COMMON',
].join('\r\n');
