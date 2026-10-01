/**
 * @fileoverview Hand-written excerpts shaped like the RFC Editor `rfcN.json`,
 * the Datatracker `doc.json`, and the Datatracker `relateddocument` page. Titles
 * and group names are invented; every author and address is `Example …` or at
 * `example.org`, so the email-scrubbing tests prove the drop without carrying
 * real data. `doc.json` carries authors, shepherd, and AD with addresses the
 * service must never read.
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
