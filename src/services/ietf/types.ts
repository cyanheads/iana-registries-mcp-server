/**
 * @fileoverview Normalized models for IETF document status: an RFC as the RFC
 * Editor publishes it, the stream and group Datatracker adds, an Internet-Draft
 * as Datatracker reports it, and a draft's replacement and became-RFC edges.
 * Absent upstream values stay absent; nothing is defaulted.
 * @module services/ietf/types
 */

/** A Datatracker group (working group, research group, area, or the individual-submission bucket). */
export interface DatatrackerGroup {
  acronym: string;
  name: string;
  type: string;
}

/** One RFC from `https://www.rfc-editor.org/rfc/rfcN.json`. */
export interface RfcRecord {
  /** Author strings as published, e.g. "R. Fielding, Ed.". */
  authors: string[];
  doi: string;
  /** The Internet-Draft the RFC was published from, as the RFC Editor names it (usually with its revision). */
  draftName?: string;
  errataUrl?: string;
  number: number;
  /** Relation ids, normalized to "RFC N" (other ids verbatim). */
  obsoletedBy: string[];
  obsoletes: string[];
  pageCount?: number;
  /** Publication month and year, free text, e.g. "June 2022". */
  published: string;
  /** Status as published. */
  publishedStatus: string;
  /** Current status, e.g. "INTERNET STANDARD" or "HISTORIC". */
  status: string;
  title?: string;
  updatedBy: string[];
  updates: string[];
}

/** What Datatracker adds for a published RFC. */
export interface RfcTracking {
  group?: DatatrackerGroup;
  /** Publication stream, e.g. "IETF", "IRTF", "IAB", "ISE". */
  stream?: string;
}

/** One Internet-Draft from `https://datatracker.ietf.org/doc/<name>/doc.json`. */
export interface DraftRecord {
  expires?: string;
  group?: DatatrackerGroup;
  iesgState?: string;
  intendedStdLevel?: string;
  /** Datatracker's last-updated time, "YYYY-MM-DD HH:MM:SS". */
  lastUpdated: string;
  /** The draft name without a revision. */
  name: string;
  /** Latest revision, e.g. "19". */
  rev: string;
  rfceditorState?: string;
  /** Datatracker state, e.g. "Active", "Expired", "Replaced", "RFC". */
  state: string;
  stream?: string;
  title?: string;
}

/** A draft found by name; `requestedRevision` is set when a `-NN` suffix was stripped to find it. */
export interface DraftLookup {
  draft: DraftRecord;
  requestedRevision?: string;
}

/** A draft's edges in Datatracker's `relateddocument` table. */
export interface DraftRelations {
  /** "RFC N" the draft was published as. */
  becameRfc?: string;
  /** Documents that replaced this draft. */
  replacedBy: string[];
  /** Documents this draft replaced. */
  replaces: string[];
}
