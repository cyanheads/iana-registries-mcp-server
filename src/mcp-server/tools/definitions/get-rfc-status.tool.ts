/**
 * @fileoverview `iana_get_rfc_status` — current status and relations of up to
 * 10 RFCs or Internet-Drafts per call, from the RFC Editor and the IETF
 * Datatracker. Each id is classified and resolved on its own, so one bad id
 * never fails the batch: a miss is `found: false` with guidance; an upstream
 * failure, an id whose planned Datatracker requests do not fit the call's
 * request limit, or one that retries cut off at that limit, lands in
 * `failed[]`; and the call fails only when every id failed.
 * @module mcp-server/tools/definitions/get-rfc-status
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  datatrackerPageUrl,
  getIetfDocService,
  revisionSuffix,
  rfcPageUrl,
} from '@/services/ietf/ietf-doc-service.js';
import { type CallBudget, startCallBudget } from '@/services/upstream/call-budget.js';
import { DATATRACKER_CALL_REQUESTS } from '@/services/upstream/upstream-client.js';
import { inline, url } from '../shared/markdown.js';

/** Most ids one call resolves. */
const MAX_IDS = 10;

/** The `failed[].error` of an id the call's Datatracker request limit left unresolved. */
const REQUEST_LIMIT_MESSAGE = `Not resolved within this call's limit of ${DATATRACKER_CALL_REQUESTS} Datatracker requests. Call iana_get_rfc_status again with this id.`;

/**
 * `ids` preprocess: one string splits on commas, semicolons, and newlines (a
 * bracketed string stays whole, so the framework's JSON-array repair reads it);
 * items are trimmed, blanks dropped, and the list cut to one past the maximum
 * so an oversized list fails with a single bounded issue.
 */
function splitIds(value: unknown): unknown {
  const items =
    typeof value === 'string' && !value.trim().startsWith('[') ? value.split(/[,;\n]/) : value;
  if (!Array.isArray(items)) return items;
  return items
    .map((item: unknown) => (typeof item === 'string' ? item.trim() : item))
    .filter((item: unknown) => item !== '')
    .slice(0, MAX_IDS + 1);
}

/** "RFC 9110", "rfc9110", "RFC-9110", "9110", zero-padded forms. */
const RFC_ID = /^(?:rfc[\s-]?)?0*([1-9]\d{0,4})$/i;

/** RFC Editor and Datatracker URLs of an RFC. */
const RFC_URL =
  /^(?:https?:\/\/)?(?:www\.)?(?:rfc-editor\.org\/(?:rfc|info)|datatracker\.ietf\.org\/doc(?:\/html)?)\/rfc0*([1-9]\d{0,4})(?:\.(?:html|txt|json|pdf|xml))?\/?(?:[?#]\S*)?$/i;

const DRAFT_NAME = /^draft-[a-z0-9-]+$/i;

/** A Datatracker draft URL; a `/NN/` revision path segment becomes a `-NN` suffix. */
const DRAFT_URL =
  /^(?:https?:\/\/)?datatracker\.ietf\.org\/doc(?:\/html)?\/(draft-[a-z0-9-]+?)(?:\/(\d{2}))?\/?(?:[?#]\S*)?$/i;

/** BCP, STD, and FYI series numbers, which are labels for sets of RFCs. */
const SERIES = /^(?:bcp|std|fyi)[\s-]?\d+$/i;

type Requested =
  | { id: string; kind: 'rfc'; number: number }
  | { id: string; kind: 'draft'; name: string }
  | { guidance: string; id: string; kind: 'unsupported' };

function classify(raw: string): Requested {
  const rfc = RFC_ID.exec(raw) ?? RFC_URL.exec(raw);
  if (rfc) {
    const number = Number(rfc[1]);
    return { kind: 'rfc', id: `RFC ${number}`, number };
  }
  const draftUrl = DRAFT_URL.exec(raw);
  if (draftUrl || DRAFT_NAME.test(raw)) {
    const name = (
      draftUrl ? `${draftUrl[1]}${draftUrl[2] ? `-${draftUrl[2]}` : ''}` : raw
    ).toLowerCase();
    return { kind: 'draft', id: name, name };
  }
  return {
    kind: 'unsupported',
    id: raw,
    guidance: SERIES.test(raw)
      ? 'BCP, STD, and FYI numbers are series labels, not documents; pass the member RFC numbers instead.'
      : `${raw} is neither an RFC number nor a draft name.`,
  };
}

/**
 * Datatracker requests an id needs when every read answers first time: an RFC's
 * `doc.json`; a draft's `doc.json` and two `relateddocument` pages, plus the
 * second `doc.json` a revision suffix costs.
 */
function plannedRequests(requested: Requested): number {
  switch (requested.kind) {
    case 'rfc':
      return 1;
    case 'draft':
      return revisionSuffix(requested.name) ? 4 : 3;
    case 'unsupported':
      return 0;
  }
}

/**
 * The ids a call starts, chosen before any request: each id, in request order,
 * whose planned requests still fit the call's Datatracker limit. An id that
 * does not fit is passed over, not a stop, since a later RFC or plain draft may
 * still fit. The first id always fits, so calling again with the ids left out
 * always starts at least one.
 */
function admit(requests: readonly Requested[]): Set<Requested> {
  let planned = 0;
  return new Set(
    requests.filter((requested) => {
      const cost = plannedRequests(requested);
      if (planned + cost > DATATRACKER_CALL_REQUESTS) return false;
      planned += cost;
      return true;
    }),
  );
}

const GroupSchema = z
  .object({
    acronym: z.string().describe('E.g. "httpbis"; "none" for individual submissions.'),
    name: z.string().describe('Group name.'),
    type: z.string().describe('E.g. "WG", "RG", "Individual".'),
  })
  .describe('The responsible Datatracker group.');

const RfcSchema = z
  .object({
    status: z
      .string()
      .describe('Current status per the RFC Editor, e.g. "INTERNET STANDARD", "HISTORIC".'),
    published_status: z.string().describe('Status at publication, which may since have changed.'),
    stream: z.string().optional().describe('Stream, e.g. "IETF", "IRTF", "IAB", "ISE".'),
    group: GroupSchema.optional(),
    published: z.string().describe('Publication month and year, e.g. "June 2022".'),
    page_count: z.number().optional().describe('Page count.'),
    authors: z.array(z.string()).describe('Authors as published.'),
    obsoletes: z.array(z.string()).describe('RFCs this RFC obsoletes, e.g. "RFC 7230".'),
    obsoleted_by: z.array(z.string()).describe('RFCs that obsolete this RFC.'),
    updates: z.array(z.string()).describe('RFCs this RFC updates.'),
    updated_by: z.array(z.string()).describe('RFCs that update this RFC.'),
    see_also: z.array(z.string()).describe('Related documents, e.g. its BCP or STD.'),
    doi: z.string().describe('DOI, e.g. "10.17487/RFC9110".'),
    errata_url: z.string().optional().describe('Errata page, when errata exist.'),
    draft_name: z.string().optional().describe('The Internet-Draft it was published from.'),
    url: z.string().describe('The RFC on the RFC Editor site.'),
    datatracker_url: z.string().describe('The RFC on the IETF Datatracker.'),
  })
  .describe('Present when kind is rfc and found is true.');

const DraftSchema = z
  .object({
    rev: z.string().describe('Latest revision, e.g. "19".'),
    requested_revision: z
      .string()
      .optional()
      .describe('The revision suffix requested, when the draft was found without it.'),
    state: z.string().describe('E.g. "Active", "Expired", "Replaced", "RFC".'),
    iesg_state: z.string().optional().describe('IESG state, e.g. "RFC Published".'),
    rfceditor_state: z.string().optional().describe('RFC Editor queue state, when in the queue.'),
    stream: z.string().optional().describe('Stream, e.g. "IETF".'),
    group: GroupSchema.optional(),
    intended_std_level: z
      .string()
      .optional()
      .describe('Intended status, e.g. "Proposed Standard".'),
    last_updated: z.string().describe('Last-updated time, "YYYY-MM-DD HH:MM:SS".'),
    expires: z.string().optional().describe('Expiry time of the latest revision.'),
    replaced_by: z.array(z.string()).describe('Documents that replaced this draft.'),
    replaces: z.array(z.string()).describe('Documents this draft replaced.'),
    became_rfc: z.string().optional().describe('The RFC it became, e.g. "RFC 9110".'),
    datatracker_url: z.string().describe('The draft on the IETF Datatracker.'),
  })
  .describe('Present when kind is draft and found is true.');

/** One `documents[]` entry. */
interface RfcDocument {
  draft?: z.infer<typeof DraftSchema>;
  found: boolean;
  guidance?: string;
  id: string;
  kind: Requested['kind'];
  rfc?: z.infer<typeof RfcSchema>;
  title?: string;
}

/** One resolved id; `trackingUnavailable` marks an RFC whose Datatracker fields are missing. */
interface Resolved {
  document: RfcDocument;
  trackingUnavailable?: boolean;
}

async function resolveRfc(
  requested: Extract<Requested, { kind: 'rfc' }>,
  budget: CallBudget,
  ctx: Context,
): Promise<Resolved> {
  const service = getIetfDocService();
  const { id, number } = requested;
  const [editor, tracking] = await Promise.allSettled([
    service.getRfc(number, budget),
    service.getRfcTracking(number, budget),
  ]);
  if (editor.status === 'rejected') throw editor.reason;
  const record = editor.value;
  if (!record) {
    return {
      document: {
        id,
        kind: 'rfc',
        found: false,
        guidance: `RFC ${number} is not published (never issued, or not yet assigned). Check the number; drafts go by their draft- name.`,
      },
    };
  }
  if (tracking.status === 'rejected') {
    ctx.log.warning('Datatracker lookup failed for an RFC', {
      rfc: number,
      error: tracking.reason instanceof Error ? tracking.reason.message : String(tracking.reason),
    });
  }
  const trackingValue = tracking.status === 'fulfilled' ? tracking.value : undefined;
  return {
    document: {
      id,
      kind: 'rfc',
      found: true,
      ...(record.title ? { title: record.title } : {}),
      rfc: {
        status: record.status,
        published_status: record.publishedStatus,
        ...(trackingValue?.stream ? { stream: trackingValue.stream } : {}),
        ...(trackingValue?.group ? { group: trackingValue.group } : {}),
        published: record.published,
        ...(record.pageCount !== undefined ? { page_count: record.pageCount } : {}),
        authors: record.authors,
        obsoletes: record.obsoletes,
        obsoleted_by: record.obsoletedBy,
        updates: record.updates,
        updated_by: record.updatedBy,
        see_also: record.seeAlso,
        doi: record.doi,
        ...(record.errataUrl ? { errata_url: record.errataUrl } : {}),
        ...(record.draftName ? { draft_name: record.draftName } : {}),
        url: rfcPageUrl(number),
        datatracker_url: datatrackerPageUrl(`rfc${number}`),
      },
    },
    trackingUnavailable: trackingValue === undefined,
  };
}

async function resolveDraft(
  requested: Extract<Requested, { kind: 'draft' }>,
  budget: CallBudget,
): Promise<Resolved> {
  const service = getIetfDocService();
  const found = await service.findDraft(requested.name, budget);
  if (!found) {
    return {
      document: {
        id: requested.id,
        kind: 'draft',
        found: false,
        guidance: `No Internet-Draft named ${requested.name}. Draft names look like draft-<source>-<group>-<topic>; a revision suffix such as -07 is optional.`,
      },
    };
  }
  const { draft, requestedRevision } = found;
  const relations = await service.getDraftRelations(draft.name, budget);
  return {
    document: {
      id: draft.name,
      kind: 'draft',
      found: true,
      ...(draft.title ? { title: draft.title } : {}),
      draft: {
        rev: draft.rev,
        ...(requestedRevision ? { requested_revision: requestedRevision } : {}),
        state: draft.state,
        ...(draft.iesgState ? { iesg_state: draft.iesgState } : {}),
        ...(draft.rfceditorState ? { rfceditor_state: draft.rfceditorState } : {}),
        ...(draft.stream ? { stream: draft.stream } : {}),
        ...(draft.group ? { group: draft.group } : {}),
        ...(draft.intendedStdLevel ? { intended_std_level: draft.intendedStdLevel } : {}),
        last_updated: draft.lastUpdated,
        ...(draft.expires ? { expires: draft.expires } : {}),
        replaced_by: relations.replacedBy,
        replaces: relations.replaces,
        ...(relations.becameRfc ? { became_rfc: relations.becameRfc } : {}),
        datatracker_url: datatrackerPageUrl(draft.name),
      },
    },
  };
}

function resolve(requested: Requested, budget: CallBudget, ctx: Context): Promise<Resolved> {
  switch (requested.kind) {
    case 'rfc':
      return resolveRfc(requested, budget, ctx);
    case 'draft':
      return resolveDraft(requested, budget);
    case 'unsupported':
      return Promise.resolve({
        document: {
          id: requested.id,
          kind: 'unsupported',
          found: false,
          guidance: requested.guidance,
        },
      });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `data.reason` of a classified failure, when it carries one. */
function reasonOf(error: unknown): string | undefined {
  const reason = error instanceof McpError ? error.data?.reason : undefined;
  return typeof reason === 'string' ? reason : undefined;
}

/** `none`, or the items joined, each made safe for one markdown line. */
function list(items: readonly string[], separator = ', '): string {
  return items.length > 0 ? items.map(inline).join(separator) : 'none';
}

function groupText(group: z.infer<typeof GroupSchema>): string {
  return `${inline(group.acronym)} (${inline(group.name)}, ${inline(group.type)})`;
}

export const getRfcStatus = tool('iana_get_rfc_status', {
  title: 'Get RFC and Internet-Draft status',
  description: `Get the current status of up to 10 RFCs or Internet-Drafts in one call. Accepts "RFC 9110", "rfc9110", "9110", RFC Editor or Datatracker URLs, and draft names with or without a revision suffix ("draft-ietf-httpbis-semantics-19"). RFCs return current and as-published status, stream, working group, obsoletes/obsoleted-by and updates/updated-by relations, and the errata page; drafts return their state, IESG state, intended status, expiry, the document that replaced them, and the RFC they became. Unknown ids return found: false. BCP, STD, and FYI numbers are not resolved. A call makes at most ${DATATRACKER_CALL_REQUESTS} Datatracker requests, retries included (an RFC needs one, a draft three, or four with a revision suffix): each id is taken in request order if its requests still fit, and the others come back in failed with reason request_limit, to pass in another call.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ids: z
      .preprocess(
        splitIds,
        z
          .array(
            z
              .string()
              .max(200)
              .describe(
                'One RFC number ("RFC 9110", "9110"), RFC Editor or Datatracker URL, or draft name.',
              ),
          )
          .min(1)
          .max(MAX_IDS),
      )
      .describe(
        'Up to 10 RFCs or Internet-Drafts, e.g. ["RFC 9110", "draft-ietf-httpbis-semantics-19"]. One comma-, semicolon-, or newline-separated string is also accepted.',
      ),
  }),
  output: z.object({
    documents: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe(
                'As resolved: "RFC 9110", a draft name without revision, or the id as given when unsupported or not found.',
              ),
            kind: z
              .enum(['rfc', 'draft', 'unsupported'])
              .describe(
                'How the id was read; unsupported covers BCP/STD/FYI and unrecognized text.',
              ),
            found: z.boolean().describe('True when the document exists upstream.'),
            guidance: z
              .string()
              .optional()
              .describe('Why nothing was found, and what to pass instead.'),
            title: z.string().optional().describe('Document title.'),
            rfc: RfcSchema.optional(),
            draft: DraftSchema.optional(),
          })
          .describe('One requested document.'),
      )
      .describe('One entry per distinct requested id, in request order, excluding ids in failed.'),
    failed: z
      .array(
        z
          .object({
            id: z.string().describe('The document whose lookup failed.'),
            error: z.string().describe('What failed.'),
            reason: z
              .string()
              .optional()
              .describe(
                'Failure reason, when classified: "request_limit" (call again with this id now), or an upstream one such as "upstream_unreadable" (retry later).',
              ),
          })
          .describe('One failed id.'),
      )
      .describe(
        "Ids whose lookup failed upstream or was cut by the call's request limit; the rest of the batch still answered.",
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        "Set when ids were left unresolved at the call's Datatracker request limit, or when Datatracker fields (stream, group) were unavailable for some RFCs.",
      ),
  },
  errors: [
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every id failed because the RFC Editor or Datatracker sent a response that could not be read.',
      recovery:
        'The RFC Editor or Datatracker response could not be read; retry iana_get_rfc_status in a minute.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own RFC Editor or Datatracker request queue is too full for any id to start in time.",
      recovery:
        'Wait the retryAfter seconds given in this error, then call iana_get_rfc_status again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'request_limit',
      code: JsonRpcErrorCode.RateLimited,
      when: `An id did not fit within the call's limit of ${DATATRACKER_CALL_REQUESTS} Datatracker requests, a third of this server's per-minute Datatracker pacing, or retries used up the limit before it resolved. Those ids land in failed with this reason; the call itself fails with it only when no id resolved.`,
      recovery: 'Call iana_get_rfc_status again with just the ids that failed with request_limit.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const budget = startCallBudget(ctx, { datatracker: DATATRACKER_CALL_REQUESTS });
    const seen = new Set<string>();
    const requests = input.ids.map(classify).filter((requested) => {
      const key = `${requested.kind}:${requested.id.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const admitted = admit(requests);

    const outcomes = await Promise.all(
      requests.map(async (requested) => {
        if (!admitted.has(requested)) {
          return { requested, error: ctx.fail('request_limit', REQUEST_LIMIT_MESSAGE) };
        }
        try {
          return { requested, resolved: await resolve(requested, budget, ctx) };
        } catch (error) {
          return {
            requested,
            error:
              reasonOf(error) === 'request_limit'
                ? ctx.fail('request_limit', REQUEST_LIMIT_MESSAGE)
                : error,
          };
        }
      }),
    );
    ctx.signal.throwIfAborted();

    const documents: RfcDocument[] = [];
    const failed: { error: string; id: string; reason?: string }[] = [];
    const cut: string[] = [];
    const trackingUnavailable: string[] = [];
    for (const outcome of outcomes) {
      if ('resolved' in outcome) {
        documents.push(outcome.resolved.document);
        if (outcome.resolved.trackingUnavailable) trackingUnavailable.push(outcome.requested.id);
        continue;
      }
      const reason = reasonOf(outcome.error);
      const failure = {
        id: outcome.requested.id,
        error: errorMessage(outcome.error),
        ...(reason ? { reason } : {}),
      };
      ctx.log.warning('Document status lookup failed', failure);
      failed.push(failure);
      if (reason === 'request_limit') cut.push(failure.id);
    }

    const firstFailure = outcomes.find((outcome) => 'error' in outcome);
    if (documents.length === 0 && firstFailure && 'error' in firstFailure) throw firstFailure.error;
    const notice = [
      cut.length > 0 &&
        `${cut.join(', ')} ${cut.length === 1 ? 'was' : 'were'} not resolved within this call's limit of ${DATATRACKER_CALL_REQUESTS} Datatracker requests; call iana_get_rfc_status again with ${cut.length === 1 ? 'it' : 'them'}.`,
      trackingUnavailable.length > 0 &&
        `Stream and working group were unavailable for ${trackingUnavailable.join(', ')}; status and relations come from the RFC Editor.`,
    ].filter(Boolean);
    if (notice.length > 0) ctx.enrich.notice(notice.join(' '));
    return { documents, failed };
  },

  format: (result) => {
    const lines = [
      `**Documents:** ${result.documents.length} · **Failed:** ${result.failed.length}`,
    ];
    for (const doc of result.documents) {
      const title = doc.title ? ` · ${inline(doc.title)}` : '';
      lines.push(
        '',
        `### ${inline(doc.id)}${title}`,
        `**Kind:** ${doc.kind} · **Found:** ${doc.found}`,
      );
      if (doc.guidance) lines.push(inline(doc.guidance));
      const { rfc, draft } = doc;
      if (rfc) {
        const stream = rfc.stream ? ` · **Stream:** ${inline(rfc.stream)}` : '';
        const group = rfc.group ? ` · **Group:** ${groupText(rfc.group)}` : '';
        const pages = rfc.page_count !== undefined ? ` · **Pages:** ${rfc.page_count}` : '';
        lines.push(
          `**Status:** ${inline(rfc.status)} · **As published:** ${inline(rfc.published_status)}${stream}${group}`,
          `**Published:** ${inline(rfc.published)}${pages} · **DOI:** ${inline(rfc.doi)}`,
          `**Authors:** ${list(rfc.authors, '; ')}`,
          `**Obsoletes:** ${list(rfc.obsoletes)} · **Obsoleted by:** ${list(rfc.obsoleted_by)}`,
          `**Updates:** ${list(rfc.updates)} · **Updated by:** ${list(rfc.updated_by)}`,
          `**See also:** ${list(rfc.see_also)}`,
        );
        if (rfc.draft_name) lines.push(`**Draft:** ${inline(rfc.draft_name)}`);
        if (rfc.errata_url) lines.push(`**Errata:** <${url(rfc.errata_url)}>`);
        lines.push(
          `**RFC Editor:** <${url(rfc.url)}> · **Datatracker:** <${url(rfc.datatracker_url)}>`,
        );
      }
      if (draft) {
        const requested = draft.requested_revision
          ? ` (requested -${inline(draft.requested_revision)})`
          : '';
        const facts = [
          draft.iesg_state && `**IESG state:** ${inline(draft.iesg_state)}`,
          draft.rfceditor_state && `**RFC Editor state:** ${inline(draft.rfceditor_state)}`,
          draft.stream && `**Stream:** ${inline(draft.stream)}`,
          draft.group && `**Group:** ${groupText(draft.group)}`,
          draft.intended_std_level && `**Intended status:** ${inline(draft.intended_std_level)}`,
        ].filter(Boolean);
        const expires = draft.expires ? ` · **Expires:** ${inline(draft.expires)}` : '';
        lines.push(
          `**State:** ${inline(draft.state)} · **Revision:** ${inline(draft.rev)}${requested}`,
        );
        if (facts.length > 0) lines.push(facts.join(' · '));
        lines.push(`**Last updated:** ${inline(draft.last_updated)}${expires}`);
        if (draft.became_rfc) lines.push(`**Became:** ${inline(draft.became_rfc)}`);
        lines.push(
          `**Replaces:** ${list(draft.replaces)} · **Replaced by:** ${list(draft.replaced_by)}`,
          `**Datatracker:** <${url(draft.datatracker_url)}>`,
        );
      }
    }
    if (result.failed.length > 0) {
      lines.push('', '### Failed');
      for (const failure of result.failed) {
        const reason = failure.reason ? ` (${inline(failure.reason)})` : '';
        lines.push(`- ${inline(failure.id)}: ${inline(failure.error)}${reason}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
