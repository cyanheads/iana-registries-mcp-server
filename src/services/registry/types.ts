/**
 * @fileoverview Parsed models for the IANA sources: the generic XML registry
 * model, the Private Enterprise Number list, the Language Subtag Registry, and
 * the protocol registry index. Person data never enters any of them; text values
 * are upstream text after the personal-data rules (email-shaped tokens replaced).
 * @module services/registry/types
 */

/** Reference kinds, one shape for every xref. `person` xrefs are dropped before this. */
export type ReferenceType = 'rfc' | 'draft' | 'uri' | 'registry' | 'rfc-errata' | 'note' | 'text';

/** A normalized `<xref>` (or a defining document). */
export interface Reference {
  /** Display id: `RFC 9110`, a draft name, a registry id, a URL, a note anchor. */
  id: string;
  /** The label text, kept only when it says more than `id` and `section`. */
  label?: string;
  /** The xref's `section` attribute, else the `Section N` / `§N` number in its label. */
  section?: string;
  type: ReferenceType;
  /** Resolvable URL: RFC Editor, Datatracker, iana.org, an http(s) URI, or an errata page. */
  url?: string;
}

/** A registry or sub-registry `<note>` / `<footnote>`, flattened to text. */
export interface RegistryNote {
  /** `anchor` attribute (footnotes and notes that xrefs of type `note` point at). */
  anchor?: string;
  text: string;
  /** `title` attribute, e.g. `WARNING`. */
  title?: string;
}

/** One `<range>` block: an allocation range and its registration procedure. */
export interface RegistrationRange {
  note?: string;
  procedure?: string;
  /** The range's `<value>` text, e.g. `0-223` or a prose qualifier. */
  range: string;
}

/** One `<record>`, its children flattened to text by element name. */
export interface RegistryRecord {
  /**
   * Attributes of field elements that carried any (first occurrence), e.g.
   * `{ file: { type: 'template', name: 'image/x-emf' } }`. Absent when none did.
   */
  fieldAttributes?: Record<string, Record<string, string>>;
  /**
   * Field text keyed by XML element name, in record order. Mixed content is
   * flattened (inline xref → its label or id, `<br/>` → newline); repeated
   * elements are joined with a newline; elements left empty are omitted.
   * Full values — callers apply their own length caps.
   */
  fields: Record<string, string>;
  /** Direct-child xrefs of the record, person xrefs dropped. */
  references: Reference[];
  /** The record's `date` attribute. */
  registered?: string;
  /**
   * Normalized search text over every field value and reference id, padded with
   * one space on each side for whole-token matching (see `search-text.ts`).
   */
  searchText: string;
  /** The record's `updated` attribute. */
  updated?: string;
  /** Key column value: `<value>`, else `<number>`, else the first field. */
  value?: string;
  /** Element name `value` came from. */
  valueField?: string;
}

/** A registry's root level or one nested `<registry>`: the unit records live in. */
export interface RegistryTable {
  /** Element names seen across the table's records, first-seen order (xref excluded). */
  columns: string[];
  id: string;
  /** `<file type="legacy">` text when this table is a stub pointing at a plain-text file. */
  legacyFile?: string;
  notes: RegistryNote[];
  /** Id of the enclosing nested registry, for tables nested more than one level deep. */
  parentId?: string;
  ranges: RegistrationRange[];
  records: RegistryRecord[];
  references: Reference[];
  /** `<registration_rule>`. */
  registrationRule?: string;
  title: string;
  /** The table's own `<updated>`, when it carries one. */
  updated?: string;
}

/** One IANA XML registry file. */
export interface XmlRegistry {
  category?: string;
  id: string;
  /** `<file type="legacy">` at the root: the registry is published only as plain text. */
  legacyFile?: string;
  /** Records in the whole file, root and every sub-registry. */
  recordCount: number;
  /** Root-level rule, references, notes, ranges, and records (`id` = registry id). */
  root: RegistryTable;
  /** Nested `<registry>` elements, depth-first in document order. */
  subregistries: RegistryTable[];
  title: string;
  /** Root `<updated>`: the registry's own last-updated date. */
  updated?: string;
}

/** PEN record state derived from the organization line. */
export type PenState = 'assigned' | 'reserved' | 'unassigned';

/** One Private Enterprise Number. Contact and email lines are never parsed. */
export interface PenEntry {
  number: number;
  /** Verbatim organization line; absent when withheld or missing upstream. */
  organization?: string;
  /** The organization line held an email-shaped token and is withheld. */
  organizationWithheld?: true;
  /** Padded normalized organization text; `''` when withheld or absent. */
  searchText: string;
  state: PenState;
}

/** The parsed `enterprise-numbers.txt`. */
export interface PenRegistry {
  byNumber: ReadonlyMap<number, PenEntry>;
  /** Every entry, ascending by number (registry order). */
  entries: PenEntry[];
  /** Highest number listed. */
  maxNumber: number;
  /** `(last updated YYYY-MM-DD)` header value. */
  updated?: string;
  withheldCount: number;
}

/** Language Subtag Registry `Type` values. */
export type LanguageSubtagType =
  | 'language'
  | 'extlang'
  | 'script'
  | 'region'
  | 'variant'
  | 'grandfathered'
  | 'redundant';

/** One record-jar record of the Language Subtag Registry. */
export interface LanguageRecord {
  added?: string;
  /** `Comments` values (repeatable). */
  comments: string[];
  deprecated?: string;
  /** `Description` values (repeatable), verbatim. */
  descriptions: string[];
  macrolanguage?: string;
  preferredValue?: string;
  /** `Prefix` values (repeatable). */
  prefixes: string[];
  scope?: string;
  /** Padded normalized text over the descriptions. */
  searchText: string;
  /** `Subtag` (every type except grandfathered/redundant), registry casing. */
  subtag?: string;
  suppressScript?: string;
  /** `Tag` (grandfathered/redundant whole-tag records), registry casing. */
  tag?: string;
  type: LanguageSubtagType;
}

/** A private-use range record such as `qaa..qtz`, matched by range rather than by key. */
export interface LanguageRange {
  /** Range end, lowercase. */
  end: string;
  record: LanguageRecord;
  /** Range start, lowercase. */
  start: string;
}

/** The parsed Language Subtag Registry. */
export interface LanguageRegistry {
  /** Lowercase subtag → every record registered under it (a subtag can have several types). */
  bySubtag: ReadonlyMap<string, LanguageRecord[]>;
  /** Lowercase whole tag → grandfathered/redundant record. */
  byTag: ReadonlyMap<string, LanguageRecord>;
  /** `File-Date` header value. */
  fileDate?: string;
  ranges: LanguageRange[];
  /** Every record, registry order. */
  records: LanguageRecord[];
}

/** A defining document link from the protocol index. */
export interface DefiningDocument {
  /** `data-doc-name`, e.g. `RFC6320`. */
  id: string;
  /** The link's `title` attribute (the document title). */
  title?: string;
  /** `https://www.iana.org` + the link's `/go/…` path. */
  url?: string;
}

/** One registry or sub-registry row of the protocol index page. */
export interface IndexEntry {
  /** Category row the entry sits under. */
  category: string;
  definingDocuments: DefiningDocument[];
  /** `https://www.iana.org/assignments/<id>` plus `#<sub>` when present. */
  pageUrl: string;
  /** Comment spans with designated-expert spans removed, `<br/>` → `; `. */
  registrationProcedure?: string;
  registryId: string;
  /** Padded normalized text over title, category, and ids. */
  searchText: string;
  /** The href fragment; equals the nested XML `<registry id>`. */
  subregistryId?: string;
  title: string;
  /** `https://www.iana.org/assignments/<id>/<id>.xml`. */
  xmlUrl: string;
}

/** The parsed protocol registry index. */
export interface ProtocolIndex {
  categoryCount: number;
  entries: IndexEntry[];
  /** Lowercase registry id → canonical id, for case-insensitive resolution. */
  registryIds: ReadonlyMap<string, string>;
}

/**
 * Provenance every registry-backed output carries (wire shape, snake_case).
 * `registry_updated` is the registry's own date; `fetched_at` the last 200 or
 * 304; `stale` true only when a refresh failed and a copy ≤ 7 days old answered.
 */
export interface SourceInfo {
  fetched_at: string;
  registry_id: string;
  registry_updated?: string;
  stale: boolean;
  url: string;
}

/** A parsed model plus its provenance. */
export interface Loaded<T> {
  readonly model: T;
  readonly source: SourceInfo;
}
