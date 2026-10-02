/**
 * @fileoverview Hand-written excerpts shaped like the RFC Editor `rfcN.json`,
 * the Datatracker `doc.json`, and the Datatracker `relateddocument` page. Titles
 * and group names are invented; every author and address is `Example …` or at
 * `example.org`, so the email-scrubbing tests prove the drop without carrying
 * real data. `doc.json` carries authors, shepherd, and AD with addresses the
 * service must never read. The series edges and the two `contains` pages are
 * real Datatracker data, which names documents only.
 * @module tests/fixtures/ietf
 */

/** A bare address the scrubbing tests plant in text; it must never reach a result. */
export const FIXTURE_EMAIL = 'author@example.org';

/** Markers of the personal data `doc.json` carries (authors, shepherd, AD). */
export const DOC_PERSON_MARKERS = [
  'author@example.org',
  'shepherd@example.org',
  'director@example.org',
  'Example Shepherd',
  'Example Director',
  'Example Org',
] as const;

/** An RFC Editor `rfcN.json` body; `overrides` replace keys (a `null` value is kept). */
export function rfcJson(number: number, overrides: Record<string, unknown> = {}) {
  return {
    draft: 'draft-example-wg-topic-12',
    doc_id: `RFC${number}`,
    title: 'Example Protocol Specification',
    authors: ['Example Author, Ed.', 'Another Example'],
    format: ['HTML', 'TEXT'],
    page_count: '42',
    pub_status: 'PROPOSED STANDARD',
    status: 'INTERNET STANDARD',
    source: 'Example Working Group',
    abstract: 'An invented abstract.',
    pub_date: 'June 2022',
    keywords: ['example'],
    obsoletes: ['RFC7230', 'RFC0791'],
    obsoleted_by: [],
    updates: ['RFC5234'],
    updated_by: ['RFC8002'],
    see_also: ['STD0097', 'BCP0047'],
    doi: `10.17487/RFC${number}`,
    errata_url: `https://www.rfc-editor.org/errata/rfc${number}`,
    ...overrides,
  };
}

/** A Datatracker `doc.json` body for an Internet-Draft; `overrides` replace keys. */
export function draftDocJson(
  name = 'draft-example-wg-topic',
  overrides: Record<string, unknown> = {},
) {
  return {
    name,
    rev: '03',
    pages: 12,
    time: '2026-08-01 10:20:30',
    group: { name: 'Example Working Group', type: 'WG', acronym: 'exwg' },
    expires: '2027-02-01 10:20:30',
    title: 'Example Draft Topic',
    abstract: 'An invented abstract.',
    state: 'Active',
    intended_std_level: 'Proposed Standard',
    std_level: null,
    authors: [{ name: 'Example Author', email: 'author@example.org', affiliation: 'Example Org' }],
    shepherd: 'Example Shepherd <shepherd@example.org>',
    ad: 'Example Director <director@example.org>',
    rev_history: [],
    iesg_state: 'I-D Exists',
    rfceditor_state: null,
    iana_review_state: null,
    consensus: null,
    stream: 'IETF',
    ...overrides,
  };
}

/** A Datatracker `doc.json` body for a published RFC (`rfcN`). */
export function rfcDocJson(number: number, overrides: Record<string, unknown> = {}) {
  return {
    ...draftDocJson(`rfc${number}`),
    rev: '',
    state: 'Published',
    std_level: 'Internet Standard',
    expires: null,
    iesg_state: null,
    ...overrides,
  };
}

/** One `relateddocument` edge with the API's URI-form relationship, source, and target. */
export function edge(relationship: string, source: string, target: string) {
  return {
    id: 1,
    originaltargetaliasname: target,
    relationship: `/api/v1/name/docrelationshipname/${relationship}/`,
    source: `/api/v1/doc/document/${source}/`,
    target: `/api/v1/doc/document/${target}/`,
  };
}

/** A `relateddocument` page of `edges`. */
export function related(...edges: readonly ReturnType<typeof edge>[]) {
  return {
    meta: { limit: 100, next: null, offset: 0, previous: null, total_count: edges.length },
    objects: edges,
  };
}

/** The first `relateddocument` page of a 449-edge result: `edges`, with `meta.next` naming the page after it. */
export function pagedRelated(...edges: readonly ReturnType<typeof edge>[]) {
  return {
    meta: {
      limit: 100,
      next: '/api/v1/doc/relateddocument/?format=json&limit=100&offset=100',
      offset: 0,
      previous: null,
      total_count: 449,
    },
    objects: edges,
  };
}

/**
 * Real `contains` edges (series → member RFC) from Datatracker's 449-edge
 * table, captured 2026-10-01; the table matches the RFC Editor index's
 * `is-also` pairs exactly. BCP 9 has eight members, as many as any series.
 */
export const CONTAINS_EDGES: readonly (readonly [series: string, rfc: string])[] = [
  ['bcp9', 'rfc2026'],
  ['bcp9', 'rfc5657'],
  ['bcp9', 'rfc6410'],
  ['bcp9', 'rfc7100'],
  ['bcp9', 'rfc7127'],
  ['bcp9', 'rfc7475'],
  ['bcp9', 'rfc8789'],
  ['bcp9', 'rfc9282'],
  ['bcp14', 'rfc2119'],
  ['bcp14', 'rfc8174'],
  ['bcp47', 'rfc4647'],
  ['bcp47', 'rfc5646'],
  ['std5', 'rfc1112'],
  ['std5', 'rfc791'],
  ['std5', 'rfc792'],
  ['std5', 'rfc919'],
  ['std5', 'rfc922'],
  ['std5', 'rfc950'],
  ['std7', 'rfc9293'],
  ['std97', 'rfc9110'],
  ['fyi36', 'rfc4949'],
];

/** `relateddocument/?format=json&limit=100&source__name=bcp14&relationship=contains`, verbatim as captured 2026-10-01. */
export const BCP14_CONTAINS_PAGE = {
  meta: { limit: 100, next: null, offset: 0, previous: null, total_count: 2 },
  objects: [
    {
      id: 1297039,
      originaltargetaliasname: null,
      relationship: '/api/v1/name/docrelationshipname/contains/',
      resource_uri: '/api/v1/doc/relateddocument/1297039/',
      source: '/api/v1/doc/document/bcp14/',
      target: '/api/v1/doc/document/rfc2119/',
    },
    {
      id: 1297312,
      originaltargetaliasname: null,
      relationship: '/api/v1/name/docrelationshipname/contains/',
      resource_uri: '/api/v1/doc/relateddocument/1297312/',
      source: '/api/v1/doc/document/bcp14/',
      target: '/api/v1/doc/document/rfc8174/',
    },
  ],
};

/** `relateddocument/?format=json&limit=100&target__name__in=rfc2119,rfc9293,rfc4949&relationship=contains`, verbatim as captured 2026-10-01. */
export const MEMBERSHIP_PAGE = {
  meta: { limit: 100, next: null, offset: 0, previous: null, total_count: 3 },
  objects: [
    {
      id: 1297039,
      originaltargetaliasname: null,
      relationship: '/api/v1/name/docrelationshipname/contains/',
      resource_uri: '/api/v1/doc/relateddocument/1297039/',
      source: '/api/v1/doc/document/bcp14/',
      target: '/api/v1/doc/document/rfc2119/',
    },
    {
      id: 1297178,
      originaltargetaliasname: null,
      relationship: '/api/v1/name/docrelationshipname/contains/',
      resource_uri: '/api/v1/doc/relateddocument/1297178/',
      source: '/api/v1/doc/document/fyi36/',
      target: '/api/v1/doc/document/rfc4949/',
    },
    {
      id: 1297373,
      originaltargetaliasname: null,
      relationship: '/api/v1/name/docrelationshipname/contains/',
      resource_uri: '/api/v1/doc/relateddocument/1297373/',
      source: '/api/v1/doc/document/std7/',
      target: '/api/v1/doc/document/rfc9293/',
    },
  ],
};
