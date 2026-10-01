/**
 * @fileoverview Parses one IANA registry XML file into the generic model:
 * registry and sub-registry tables, records keyed by element name, notes,
 * registration ranges, descriptions, file pointers, and normalized references.
 * Mixed content is flattened; person data (`<people>`, `<expert>`, `<assignee>`,
 * `<contact>`, person xrefs at any depth) is dropped by structure and never
 * parsed into the model.
 * @module services/registry/xml-registry-parser
 */

import { XMLParser } from 'fast-xml-parser';
import { upstreamUnreadable } from '../upstream/upstream-client.js';
import { scrubEmails } from './personal-data.js';
import { normalizeForSearch, toSearchText } from './search-text.js';
import type {
  Reference,
  RegistrationRange,
  RegistryFile,
  RegistryNote,
  RegistryRecord,
  RegistryTable,
  XmlRegistry,
} from './types.js';

/** A `preserveOrder` node: `{ tag: children, ':@': attributes }` or `{ '#text': text }`. */
type XNode = Record<string, unknown>;

const ATTRS = ':@';
const TEXT = '#text';

const ASSIGNMENTS = 'https://www.iana.org/assignments/';

/** Elements that hold person data; skipped wherever they appear. */
const DROPPED = new Set(['people', 'expert', 'assignee', 'contact']);

/** Block-level mixed-content elements, rendered on their own lines. */
const BLOCKS = new Set(['paragraph', 't', 'artwork', 'list', 'li']);

/**
 * `htmlEntities` turns on numeric character references (`&#233;` → `é`); the five
 * XML entities decode either way, and `&amp;#233;` still reads as the literal
 * `&#233;`. A DOCTYPE is rejected before parsing, so no declared entity expands.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  processEntities: true,
  htmlEntities: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

function tagOf(node: XNode): string | undefined {
  for (const key of Object.keys(node)) if (key !== ATTRS) return key;
  return;
}

function childrenOf(node: XNode, tag: string): XNode[] {
  const children = node[tag];
  return Array.isArray(children) ? (children as XNode[]) : [];
}

function attrsOf(node: XNode): Record<string, string> {
  const attrs = node[ATTRS];
  if (!attrs || typeof attrs !== 'object') return {};
  return Object.fromEntries(
    Object.entries(attrs as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

/** Trims every line, collapses inner whitespace, drops blank lines. */
function cleanText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function collect(nodes: readonly XNode[], out: string[]): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || DROPPED.has(tag)) continue;
    if (tag === TEXT) {
      out.push(String(node[TEXT]));
      continue;
    }
    if (tag === 'xref') {
      const label = flatten(childrenOf(node, tag));
      const ref = parseReference(attrsOf(node), label);
      if (ref) out.push(inlineXref(ref, label));
      continue;
    }
    if (tag === 'br') {
      out.push('\n');
      continue;
    }
    const block = BLOCKS.has(tag);
    if (block) out.push('\n');
    collect(childrenOf(node, tag), out);
    if (block) out.push('\n');
  }
}

/**
 * Flattens mixed content to text (inline xref → its label or id, `<br/>` →
 * newline) with email-shaped tokens replaced.
 */
function flatten(nodes: readonly XNode[]): string {
  return scrubEmails(flattenRaw(nodes));
}

/** {@link flatten} without the email scrub — only for a record's key column. */
function flattenRaw(nodes: readonly XNode[]): string {
  const out: string[] = [];
  collect(nodes, out);
  return cleanText(out.join(''));
}

/** Inline xref text: the label (plus the target when the label hides it), else the id. */
function inlineXref(ref: Reference, label: string): string {
  if (!label) return ref.id;
  if (ref.type === 'uri' && ref.url) return `${label} (${ref.url})`;
  if (ref.type === 'registry' && !label.includes(ref.id)) return `${label} (${ref.id})`;
  return label;
}

const SECTION_IN_LABEL = /(?:\bSection\s+|§\s*)((?:\d+|[A-Z](?=\.))(?:\.[0-9A-Za-z]+)*)/i;

/**
 * Normalizes one xref. Returns `undefined` for person xrefs, `mailto:` URIs, and
 * xrefs with nothing to identify them.
 */
export function parseReference(
  attrs: Readonly<Record<string, string>>,
  label: string,
): Reference | undefined {
  const type = attrs.type?.trim().toLowerCase();
  if (type === 'person') return;
  const data = (attrs.data ?? '').trim();

  let ref: Reference | undefined;
  switch (type) {
    case 'rfc': {
      const number = /^rfc\s*0*(\d+)$/i.exec(data)?.[1];
      if (number)
        ref = {
          type: 'rfc',
          id: `RFC ${number}`,
          url: `https://www.rfc-editor.org/rfc/rfc${number}.html`,
        };
      else if (data) ref = { type: 'rfc', id: data };
      break;
    }
    case 'draft': {
      const name = /^rfc-/i.test(data) ? `draft-${data.slice(4)}` : data;
      if (name)
        ref = {
          type: 'draft',
          id: name,
          url: `https://datatracker.ietf.org/doc/${encodeURIComponent(name)}/`,
        };
      break;
    }
    case 'registry':
      if (data)
        ref = {
          type: 'registry',
          id: data,
          url: `${ASSIGNMENTS}${encodeURIComponent(data)}`,
        };
      break;
    case 'uri':
      if (data && !/^mailto:/i.test(data)) {
        // A URL carrying an address cannot keep it and still resolve, so it loses `url`.
        const id = scrubEmails(data);
        ref = {
          type: 'uri',
          id,
          ...(id === data && /^https?:\/\//i.test(data) ? { url: data } : {}),
        };
      }
      break;
    case 'rfc-errata':
      if (data) {
        ref = {
          type: 'rfc-errata',
          id: data,
          ...(/^\d+$/.test(data) ? { url: `https://www.rfc-editor.org/errata/eid${data}` } : {}),
        };
      }
      break;
    case 'note':
      if (data) ref = { type: 'note', id: data };
      break;
    default:
      if (data || label) ref = { type: 'text', id: scrubEmails(data || label) };
  }
  if (!ref) return;

  const section = attrs.section?.trim() || SECTION_IN_LABEL.exec(label)?.[1];
  if (section) ref.section = section;
  if (label && label !== ref.id && labelAddsMore(label, [ref.id, data, 'section', section]))
    ref.label = label;
  return ref;
}

/** True when the label carries tokens beyond the id, data, and section. */
function labelAddsMore(label: string, known: readonly (string | undefined)[]): boolean {
  const covered = new Set(normalizeForSearch(known.filter(Boolean).join(' ')).split(' '));
  return normalizeForSearch(label)
    .split(' ')
    .some((token) => token && !covered.has(token));
}

function referenceFrom(node: XNode): Reference | undefined {
  return parseReference(attrsOf(node), flatten(childrenOf(node, 'xref')));
}

function parseNote(node: XNode, tag: string): RegistryNote | undefined {
  const text = flatten(childrenOf(node, tag));
  if (!text) return;
  const { anchor, title } = attrsOf(node);
  return {
    text,
    ...(anchor ? { anchor } : {}),
    ...(title ? { title: scrubEmails(cleanText(title)) } : {}),
  };
}

function parseRange(node: XNode): RegistrationRange | undefined {
  let range = '';
  let procedure: string | undefined;
  let note: string | undefined;
  for (const child of childrenOf(node, 'range')) {
    const tag = tagOf(child);
    if (tag === 'value') range = flatten(childrenOf(child, tag));
    else if (tag === 'registration_rule') procedure = flatten(childrenOf(child, tag)) || undefined;
    else if (tag === 'note') note = flatten(childrenOf(child, tag)) || undefined;
  }
  if (!range) return;
  return { range, ...(procedure ? { procedure } : {}), ...(note ? { note } : {}) };
}

/**
 * Parses one record. Field text is email-scrubbed except the key column
 * (`value`, else `number`, else the first field): a key is a registered
 * identifier, and some are email-shaped (the TLS exporter label
 * `TEAPbindkey@ietf.org`), so scrubbing it would replace the registration itself.
 */
function parseRecord(node: XNode, columns: Set<string>): RegistryRecord {
  const raw = new Map<string, string>();
  const fieldAttributes = new Map<string, Record<string, string>>();
  const references: Reference[] = [];

  for (const child of childrenOf(node, 'record')) {
    const tag = tagOf(child);
    if (tag === undefined || tag === TEXT || DROPPED.has(tag)) continue;
    if (tag === 'xref') {
      const ref = referenceFrom(child);
      if (ref) references.push(ref);
      continue;
    }
    const text = flattenRaw(childrenOf(child, tag));
    if (!text) continue;
    const previous = raw.get(tag);
    raw.set(tag, previous === undefined ? text : `${previous}\n${text}`);
    columns.add(tag);
    const attrs = attrsOf(child);
    if (Object.keys(attrs).length > 0 && !fieldAttributes.has(tag)) fieldAttributes.set(tag, attrs);
  }

  const valueField = raw.has('value')
    ? 'value'
    : raw.has('number')
      ? 'number'
      : raw.keys().next().value;
  const fields = new Map(
    [...raw].map(([tag, text]) => [tag, tag === valueField ? text : scrubEmails(text)]),
  );
  const value = valueField === undefined ? undefined : fields.get(valueField);
  const { date, updated } = attrsOf(node);
  return {
    fields: Object.fromEntries(fields),
    references,
    searchText: toSearchText(...fields.values(), ...references.map((ref) => ref.id)),
    ...(fieldAttributes.size > 0 ? { fieldAttributes: Object.fromEntries(fieldAttributes) } : {}),
    ...(value !== undefined && valueField !== undefined ? { value, valueField } : {}),
    ...(date ? { registered: date } : {}),
    ...(updated ? { updated } : {}),
  };
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Links one `<file>` the way IANA's registry stylesheet does: an absolute URL as
 * given (a protocol-relative one on https), a MIB module at
 * `/assignments/<name>`, a file naming a `registry` under that registry, and any
 * other file under the root registry.
 */
function parseFile(node: XNode, rootId: string): RegistryFile | undefined {
  const text = flatten(childrenOf(node, 'file'));
  if (!text) return;
  const { type, registry } = attrsOf(node);
  let url: string;
  if (/^https?:\/\//i.test(text)) url = text;
  else if (text.startsWith('//')) url = `https:${text}`;
  else if (type === 'mib') url = `${ASSIGNMENTS}${encodePath(text)}`;
  else url = `${ASSIGNMENTS}${encodeURIComponent(registry?.trim() || rootId)}/${encodePath(text)}`;
  return { ...(type ? { type } : {}), url };
}

interface TableWalk {
  /** Category text, read at the root only. */
  category?: string;
  /** Nested tables collected depth-first in document order. */
  nested: RegistryTable[];
  /** The root `<registry id>`, which relative file pointers resolve under. */
  rootId: string;
}

/**
 * Parses one `<registry>` element. Nested tables are pushed onto `walk.nested`
 * before their own children, so the list is depth-first in document order.
 * `<people>`, `<expert>`, `<created>`, and other unmodeled elements are skipped.
 */
function parseTable(
  node: XNode,
  walk: TableWalk,
  nesting: { isRoot: boolean; parentId?: string },
): RegistryTable {
  const id = attrsOf(node).id ?? '';
  const table: RegistryTable = {
    id,
    title: '',
    columns: [],
    files: [],
    notes: [],
    ranges: [],
    records: [],
    references: [],
    ...(nesting.parentId ? { parentId: nesting.parentId } : {}),
  };
  if (!nesting.isRoot) walk.nested.push(table);
  const columns = new Set<string>();

  for (const child of childrenOf(node, 'registry')) {
    const tag = tagOf(child);
    if (tag === undefined || tag === TEXT) continue;
    switch (tag) {
      case 'title':
        table.title = flatten(childrenOf(child, tag));
        break;
      case 'category':
        if (nesting.isRoot) {
          const category = flatten(childrenOf(child, tag));
          if (category) walk.category = category;
        }
        break;
      case 'updated': {
        const updated = flatten(childrenOf(child, tag));
        if (updated) table.updated = updated;
        break;
      }
      case 'registration_rule': {
        const rule = flatten(childrenOf(child, tag));
        if (rule) table.registrationRule = rule;
        break;
      }
      case 'description': {
        const description = flatten(childrenOf(child, tag));
        if (description) table.description = description;
        break;
      }
      case 'xref': {
        const ref = referenceFrom(child);
        if (ref) table.references.push(ref);
        break;
      }
      case 'note':
      case 'footnote': {
        const note = parseNote(child, tag);
        if (note) table.notes.push(note);
        break;
      }
      case 'range': {
        const range = parseRange(child);
        if (range) table.ranges.push(range);
        break;
      }
      case 'record':
        table.records.push(parseRecord(child, columns));
        break;
      case 'registry':
        parseTable(
          child,
          walk,
          nesting.isRoot ? { isRoot: false } : { isRoot: false, parentId: id },
        );
        break;
      case 'file':
      case 'files':
        for (const fileNode of tag === 'file' ? [child] : childrenOf(child, tag)) {
          if (tagOf(fileNode) !== 'file') continue;
          const file = parseFile(fileNode, walk.rootId);
          if (file) table.files.push(file);
        }
        break;
    }
  }
  table.columns = [...columns];
  return table;
}

function holdsRecord(node: XNode): boolean {
  const tag = tagOf(node);
  if (tag === undefined || tag === TEXT) return false;
  return tag === 'record' || childrenOf(node, tag).some(holdsRecord);
}

/** The root's closing tag, then only whitespace. */
const ROOT_CLOSED = /<\/registry\s*>\s*$/;

/**
 * Accepts a file with no records only when nothing points at a broken read. The
 * parser is lenient: it reads a cut-off body as a titled registry, and an
 * unclosed element swallows the records after it. So the body must end with
 * the root's closing tag, the root must carry a title, and no `<record>` may
 * sit anywhere in the tree.
 */
function assertRecordless(xml: string, url: string, root: RegistryTable, rootNode: XNode): void {
  if (!ROOT_CLOSED.test(xml)) {
    throw upstreamUnreadable(
      `${url} parsed to zero records and does not end with its </registry> closing tag.`,
      { url },
    );
  }
  if (!root.title) {
    throw upstreamUnreadable(`${url} parsed to zero records and has no registry title.`, { url });
  }
  if (holdsRecord(rootNode)) {
    throw upstreamUnreadable(`${url} parsed to zero records although it holds <record> elements.`, {
      url,
    });
  }
}

/**
 * Parses an IANA registry XML file. Throws `upstream_unreadable` when the body
 * declares a DOCTYPE (entity expansion stays off), fails to parse, has no
 * `<registry>` root, or holds no records and fails the record-less checks.
 */
export function parseXmlRegistry(xml: string, url: string): XmlRegistry {
  const rootStart = xml.indexOf('<registry');
  if (/<!DOCTYPE/i.test(rootStart === -1 ? xml : xml.slice(0, rootStart))) {
    throw upstreamUnreadable(`${url} declares a DOCTYPE; registry XML never does.`, { url });
  }
  let document: XNode[];
  try {
    document = parser.parse(xml) as XNode[];
  } catch (error) {
    throw upstreamUnreadable(`${url} is not well-formed XML.`, { url }, { cause: error });
  }
  const rootNode = document.find((node) => tagOf(node) === 'registry');
  if (!rootNode) throw upstreamUnreadable(`${url} has no <registry> root element.`, { url });

  const walk: TableWalk = { nested: [], rootId: attrsOf(rootNode).id ?? '' };
  const root = parseTable(rootNode, walk, { isRoot: true });
  const recordCount = walk.nested.reduce(
    (sum, table) => sum + table.records.length,
    root.records.length,
  );
  if (recordCount === 0) assertRecordless(xml, url, root, rootNode);

  return {
    id: root.id,
    title: root.title,
    root,
    subregistries: walk.nested,
    recordCount,
    ...(walk.category ? { category: walk.category } : {}),
    ...(root.updated ? { updated: root.updated } : {}),
  };
}
