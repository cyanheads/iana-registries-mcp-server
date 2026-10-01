/**
 * @fileoverview Builders for the generic-registry XML the records tool tests
 * need beyond the shared excerpts: many-record registries sized against the
 * output budget, wide records, long fields, long notes, a root with records and
 * sub-registries, and hostile text. Names are invented; nothing is copied from a
 * real registry.
 * @module tests/fixtures/records-xml
 */

const XML_DECLARATION = "<?xml version='1.0' encoding='UTF-8'?>";
const NS = 'xmlns="http://www.iana.org/assignments"';

/** Options for {@link registryXml}. */
export interface RegistryShell {
  /** Raw XML placed after the title: records, notes, ranges, sub-registries. */
  body: string;
  id: string;
  rule?: string;
  title?: string;
  /** Pass `null` for a registry with no `<updated>`. */
  updated?: string | null;
}

/** A whole registry file around `body`. */
export function registryXml({ id, body, updated = '2026-08-30', title, rule }: RegistryShell) {
  return `${XML_DECLARATION}
<registry ${NS} id="${id}">
  <title>${title ?? `${id} title`}</title>
  ${updated === null ? '' : `<updated>${updated}</updated>`}
  ${rule ? `<registration_rule>${rule}</registration_rule>` : ''}
  ${body}
</registry>
`;
}

/** One sub-registry element. */
export const subregistryXml = (id: string, body: string, title = `${id} title`) =>
  `<registry id="${id}"><title>${title}</title>${body}</registry>`;

/** One record from element name → raw XML text, in order, plus raw extras (xrefs). */
export function recordXml(fields: Readonly<Record<string, string>>, extras = ''): string {
  const elements = Object.entries(fields)
    .map(([name, text]) => `<${name}>${text}</${name}>`)
    .join('');
  return `<record>${elements}${extras}</record>`;
}

/** `count` records keyed by `value` = `first + index`, each with the fields `describe` returns. */
export function numberedRecords(
  count: number,
  describe: (index: number) => Readonly<Record<string, string>> = () => ({}),
  first = 0,
): string {
  return Array.from({ length: count }, (_, index) =>
    recordXml({ value: String(first + index), ...describe(index) }),
  ).join('\n');
}

/** The JSON of one output record exactly as the records tool builds it for `value` + `description`. */
export const outputRecordJson = (value: string, description: string) =>
  JSON.stringify({ value, fields: { value, description }, references: [] });

/**
 * A registry whose records, serialized as the tool's `records` array, total
 * exactly `arrayLength` characters: `count` two-digit-valued records with
 * `description` text of a fixed length except the last, which absorbs the
 * remainder.
 */
export function exactBudgetRegistry(id: string, count: number, arrayLength: number) {
  const overhead = outputRecordJson('10', '').length;
  const fixed = 1_780;
  const last = arrayLength - 2 - (count - 1) - overhead * count - fixed * (count - 1);
  const body = Array.from({ length: count }, (_, index) =>
    recordXml({
      value: String(10 + index),
      description: 'x'.repeat(index === count - 1 ? last : fixed),
    }),
  ).join('\n');
  return { xml: registryXml({ id, body }), lastLength: last };
}

/** One record with `fieldCount` fields `f01…`, each `valueLength` characters (or `values[name]`). */
export function wideRecordXml(fieldCount: number, valueLength = 5) {
  const fields: Record<string, string> = {};
  for (let index = 1; index <= fieldCount; index++) {
    fields[`f${String(index).padStart(2, '0')}`] = 'v'.repeat(valueLength);
  }
  return recordXml(fields);
}
