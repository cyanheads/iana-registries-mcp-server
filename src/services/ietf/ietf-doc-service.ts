/**
 * @fileoverview IETF document status from two keyless sources: the RFC Editor's
 * per-RFC JSON (current and as-published status, relations, errata, authors)
 * and the IETF Datatracker — `doc.json` for stream, group, and draft state, and
 * the REST API's `relateddocument` table for replaces, replaced-by, and
 * became-RFC edges. Every read is one `small`-profile request inside the
 * caller's budget, with no cache. Datatracker answers an unrecognized query
 * parameter with the unfiltered table, so its query strings are built only
 * from {@link DATATRACKER_QUERY_KEYS}. Author emails and affiliations, the
 * responsible AD, and the shepherd are never parsed.
 * @module services/ietf/ietf-doc-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import { scrubEmails } from '../registry/personal-data.js';
import type { CallBudget } from '../upstream/call-budget.js';
import { type UpstreamClient, upstreamUnreadable } from '../upstream/upstream-client.js';
import type {
  DatatrackerGroup,
  DraftLookup,
  DraftRecord,
  DraftRelations,
  RfcRecord,
  RfcTracking,
} from './types.js';

export const RFC_EDITOR_ORIGIN = 'https://www.rfc-editor.org';
export const DATATRACKER_ORIGIN = 'https://datatracker.ietf.org';

/** Decoded-body ceiling for one RFC Editor JSON record. */
export const RFC_JSON_MAX_BYTES = 256 * 1024;
/** Decoded-body ceiling for one Datatracker `doc.json` or `relateddocument` page. */
export const DATATRACKER_MAX_BYTES = 1024 * 1024;

/**
 * The only query keys sent to the Datatracker REST API, each verified to narrow
 * the result. An unknown key is ignored upstream, which returns the whole table.
 */
export const DATATRACKER_QUERY_KEYS = [
  'format',
  'limit',
  'source__name',
  'target__name',
  'relationship',
  'relationship__in',
] as const;

/** A `relateddocument` query: allow-listed keys only. */
export type DatatrackerQuery = Partial<Record<(typeof DATATRACKER_QUERY_KEYS)[number], string>>;

/** The RFC Editor JSON record of RFC `number` (no zero padding; a padded number answers 302). */
export function rfcJsonUrl(number: number): string {
  return `${RFC_EDITOR_ORIGIN}/rfc/rfc${number}.json`;
}

/** The RFC Editor HTML page of RFC `number`. */
export function rfcPageUrl(number: number): string {
  return `${RFC_EDITOR_ORIGIN}/rfc/rfc${number}.html`;
}

/**
 * The two-digit revision suffix of a draft name (`-07` → "07"), or `undefined`.
 * Datatracker answers a suffixed name 404, so {@link IetfDocService.findDraft}
 * reads the name again without it.
 */
export function revisionSuffix(name: string): string | undefined {
  return /-(\d{2})$/.exec(name)?.[1];
}

/** The Datatracker page of a document (`rfcN` or a draft name without revision). */
export function datatrackerPageUrl(name: string): string {
  return `${DATATRACKER_ORIGIN}/doc/${encodeURIComponent(name)}/`;
}

/** The `relateddocument` URL for `filters`, plus `format=json` and `limit=100`, allow-listed keys only. */
export function relatedDocumentsUrl(filters: DatatrackerQuery): string {
  const params: DatatrackerQuery = { format: 'json', limit: '100', ...filters };
  const query = new URLSearchParams();
  for (const key of DATATRACKER_QUERY_KEYS) {
    const value = params[key];
    if (value !== undefined) query.set(key, value);
  }
  return `${DATATRACKER_ORIGIN}/api/v1/doc/relateddocument/?${query}`;
}

const RfcJsonSchema = z.object({
  doc_id: z.string(),
  title: z.string().nullish(),
  authors: z.array(z.string()).nullish(),
  page_count: z.union([z.string(), z.number()]).nullish(),
  pub_status: z.string(),
  status: z.string(),
  pub_date: z.string(),
  obsoletes: z.array(z.string()).nullish(),
  obsoleted_by: z.array(z.string()).nullish(),
  updates: z.array(z.string()).nullish(),
  updated_by: z.array(z.string()).nullish(),
  see_also: z.array(z.string()).nullish(),
  doi: z.string(),
  errata_url: z.string().nullish(),
  draft: z.string().nullish(),
});

const GroupJsonSchema = z.object({ acronym: z.string(), name: z.string(), type: z.string() });

/** `doc.json` fields this server reads; `authors`, `ad`, and `shepherd` are not among them. */
const DocJsonSchema = z.object({
  name: z.string(),
  title: z.string().nullish(),
  rev: z.string().nullish(),
  time: z.string().nullish(),
  state: z.string().nullish(),
  iesg_state: z.string().nullish(),
  rfceditor_state: z.string().nullish(),
  stream: z.string().nullish(),
  group: GroupJsonSchema.nullish(),
  intended_std_level: z.string().nullish(),
  expires: z.string().nullish(),
});
type DocJson = z.infer<typeof DocJsonSchema>;

const RelatedJsonSchema = z.object({
  objects: z.array(z.object({ relationship: z.string(), source: z.string(), target: z.string() })),
});

/** Parses a JSON body against `schema`; malformed or mis-shaped JSON is unreadable (and retried). */
function parseJson<T>(body: string, schema: z.ZodType<T>, url: string): T {
  const host = new URL(url).hostname;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw upstreamUnreadable(
      `${host} sent malformed JSON for ${url}.`,
      { host, url },
      { cause: error },
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'the root';
    throw upstreamUnreadable(
      `${host} sent JSON of an unexpected shape for ${url} (${where}: ${issue?.message ?? 'invalid'}).`,
      { host, url },
    );
  }
  return parsed.data;
}

/** A value worth keeping: a non-empty string. */
function present(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

/** "RFC7230" → "RFC 7230"; any other id verbatim. */
function relationId(id: string): string {
  const match = /^rfc0*(\d+)$/i.exec(id.trim());
  return match ? `RFC ${match[1]}` : id;
}

/** The last path segment of a Datatracker API URI: a document name or a relationship slug. */
function lastSegment(uri: string): string {
  return uri.split('/').filter(Boolean).at(-1) ?? '';
}

function toGroup(group: DocJson['group']): DatatrackerGroup | undefined {
  return group ? { ...group, name: scrubEmails(group.name) } : undefined;
}

function toRfcRecord(json: z.infer<typeof RfcJsonSchema>, number: number): RfcRecord {
  const pageCount = Number(json.page_count);
  const title = present(json.title);
  const errataUrl = present(json.errata_url);
  const draftName = present(json.draft);
  return {
    number,
    ...(title ? { title: scrubEmails(title) } : {}),
    authors: (json.authors ?? []).map(scrubEmails),
    ...(Number.isInteger(pageCount) && pageCount > 0 ? { pageCount } : {}),
    status: json.status,
    publishedStatus: json.pub_status,
    published: json.pub_date,
    obsoletes: (json.obsoletes ?? []).map(relationId),
    obsoletedBy: (json.obsoleted_by ?? []).map(relationId),
    updates: (json.updates ?? []).map(relationId),
    updatedBy: (json.updated_by ?? []).map(relationId),
    seeAlso: (json.see_also ?? []).map(relationId),
    doi: json.doi,
    ...(errataUrl ? { errataUrl } : {}),
    ...(draftName ? { draftName } : {}),
  };
}

function toDraftRecord(doc: DocJson, url: string): DraftRecord {
  const { rev, state, time } = doc;
  if (!rev || !state || !time) {
    throw upstreamUnreadable(
      `Datatracker's record for ${doc.name} lacks its revision, state, or time.`,
      {
        host: new URL(url).hostname,
        url,
      },
    );
  }
  const title = present(doc.title);
  const group = toGroup(doc.group);
  const iesgState = present(doc.iesg_state);
  const rfceditorState = present(doc.rfceditor_state);
  const stream = present(doc.stream);
  const intendedStdLevel = present(doc.intended_std_level);
  const expires = present(doc.expires);
  return {
    name: doc.name,
    rev,
    state,
    lastUpdated: time,
    ...(title ? { title: scrubEmails(title) } : {}),
    ...(group ? { group } : {}),
    ...(iesgState ? { iesgState } : {}),
    ...(rfceditorState ? { rfceditorState } : {}),
    ...(stream ? { stream } : {}),
    ...(intendedStdLevel ? { intendedStdLevel } : {}),
    ...(expires ? { expires } : {}),
  };
}

/** Constructor options. Every seam a test needs is here, never in env vars. */
export interface IetfDocServiceOptions {
  client: UpstreamClient;
}

/** RFC and Internet-Draft status reads against the RFC Editor and Datatracker. */
export class IetfDocService {
  readonly #client: UpstreamClient;

  constructor(options: IetfDocServiceOptions) {
    this.#client = options.client;
  }

  /** The RFC Editor record of RFC `number`; `undefined` when it answers 404 (never issued or not yet published). */
  getRfc(number: number, budget: CallBudget): Promise<RfcRecord | undefined> {
    const url = rfcJsonUrl(number);
    return this.#client.request(url, {
      budget,
      profile: 'small',
      operation: 'IetfDocService.getRfc',
      accept: [200, 404],
      expect: 'json',
      maxBytes: RFC_JSON_MAX_BYTES,
      parse: (response) =>
        response.status === 200
          ? toRfcRecord(parseJson(response.body, RfcJsonSchema, url), number)
          : undefined,
    });
  }

  /** Datatracker's stream and group for RFC `number`; `undefined` when Datatracker answers 404. */
  async getRfcTracking(number: number, budget: CallBudget): Promise<RfcTracking | undefined> {
    const doc = await this.#getDoc(`rfc${number}`, budget, 'IetfDocService.getRfcTracking');
    if (!doc) return;
    const stream = present(doc.json.stream);
    const group = toGroup(doc.json.group);
    return { ...(stream ? { stream } : {}), ...(group ? { group } : {}) };
  }

  /**
   * The draft named `name`. Datatracker does not resolve a name with a revision
   * suffix, so a 404 on a name ending in `-NN` is retried once without it.
   * `undefined` when neither form exists.
   */
  async findDraft(name: string, budget: CallBudget): Promise<DraftLookup | undefined> {
    const doc = await this.#getDoc(name, budget, 'IetfDocService.findDraft');
    if (doc) return { draft: toDraftRecord(doc.json, doc.url) };
    const revision = revisionSuffix(name);
    if (!revision) return;
    const base = await this.#getDoc(name.slice(0, -3), budget, 'IetfDocService.findDraft');
    return base && { draft: toDraftRecord(base.json, base.url), requestedRevision: revision };
  }

  /** The `replaces` / `became_rfc` edges out of `name` and the `replaces` edges into it. */
  async getDraftRelations(name: string, budget: CallBudget): Promise<DraftRelations> {
    const [outgoing, incoming] = await Promise.all([
      this.#related({ source__name: name, relationship__in: 'replaces,became_rfc' }, budget),
      this.#related({ target__name: name, relationship: 'replaces' }, budget),
    ]);
    const from = outgoing.filter((edge) => edge.source === name);
    const becameRfc = from.find((edge) => edge.relationship === 'became_rfc')?.target;
    return {
      replaces: from.filter((edge) => edge.relationship === 'replaces').map((edge) => edge.target),
      replacedBy: incoming
        .filter((edge) => edge.target === name && edge.relationship === 'replaces')
        .map((edge) => edge.source),
      ...(becameRfc ? { becameRfc: relationId(becameRfc) } : {}),
    };
  }

  #getDoc(
    name: string,
    budget: CallBudget,
    operation: string,
  ): Promise<{ json: DocJson; url: string } | undefined> {
    const url = `${DATATRACKER_ORIGIN}/doc/${encodeURIComponent(name)}/doc.json`;
    return this.#client.request(url, {
      budget,
      profile: 'small',
      operation,
      accept: [200, 404],
      expect: 'json',
      maxBytes: DATATRACKER_MAX_BYTES,
      parse: (response) =>
        response.status === 200
          ? { json: parseJson(response.body, DocJsonSchema, url), url }
          : undefined,
    });
  }

  /** One `relateddocument` page as `{ relationship, source, target }` names. */
  #related(
    filters: DatatrackerQuery,
    budget: CallBudget,
  ): Promise<{ relationship: string; source: string; target: string }[]> {
    const url = relatedDocumentsUrl(filters);
    return this.#client.request(url, {
      budget,
      profile: 'small',
      operation: 'IetfDocService.getDraftRelations',
      accept: [200],
      expect: 'json',
      maxBytes: DATATRACKER_MAX_BYTES,
      parse: (response) =>
        parseJson(response.body, RelatedJsonSchema, url).objects.map((edge) => ({
          relationship: lastSegment(edge.relationship),
          source: lastSegment(edge.source),
          target: lastSegment(edge.target),
        })),
    });
  }
}

let _service: IetfDocService | undefined;

/** Constructs the process-wide service. Called from `createApp({ setup })`. */
export function initIetfDocService(options: IetfDocServiceOptions): IetfDocService {
  _service = new IetfDocService(options);
  return _service;
}

/** The process-wide service. */
export function getIetfDocService(): IetfDocService {
  if (!_service)
    throw new Error('IetfDocService not initialized — call initIetfDocService() in setup()');
  return _service;
}
