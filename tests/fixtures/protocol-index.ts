/**
 * @fileoverview Synthetic protocol-index pages in the shape of
 * `https://www.iana.org/protocols`: `tr.dtable__group` category rows and entry
 * rows with `div.reg-title > a`, `span.defining-doc a[data-doc-name]`,
 * `span.iana-protocol-comment`, and nested `span.reg-expert` elements. All
 * names are invented.
 * @module tests/fixtures/protocol-index
 */

/** One entry row. `procedure` is raw HTML placed inside `span.iana-protocol-comment`. */
export interface IndexRowSpec {
  docs?: readonly { href?: string; id: string; title?: string }[];
  href: string;
  procedure?: string;
  title: string;
}

/** A category row. */
export const categoryRow = (name: string) =>
  `<tr class="dtable__group"><td colspan="3">${name}</td></tr>`;

/** An entry row. */
export function entryRow({ href, title, docs = [], procedure }: IndexRowSpec): string {
  const documents = docs
    .map(
      (doc) =>
        `<span class="defining-doc"><a data-doc-name="${doc.id}"${doc.href ? ` href="${doc.href}"` : ''}${doc.title ? ` title="${doc.title}"` : ''}>[${doc.id}]</a></span>`,
    )
    .join(' ');
  const comment =
    procedure === undefined ? '' : `<span class="iana-protocol-comment">${procedure}</span>`;
  return `<tr><td><div class="reg-title"><a href="${href}">${title}</a></div></td><td class="reg-doc">${documents} ${comment}</td></tr>`;
}

/** Wraps rows in a page shell. */
export const indexPage = (...rows: string[]) =>
  `<!DOCTYPE html><html><head><title>Protocol Registries</title></head><body><table class="dtable">${rows.join('\n')}</table></body></html>`;

/** A small hand-written page exercising the row shapes; far under the parse floor. */
export const SMALL_INDEX_HTML = indexPage(
  categoryRow('Example &amp; Category'),
  entryRow({
    href: '/assignments/example-params',
    title: 'Example Parameters',
    docs: [
      { id: 'RFC9999', href: '/go/rfc9999', title: 'The Example &amp; Spec' },
      { id: 'RFC8888' },
    ],
    procedure:
      'Expert Review<br/>Standards Action;<br>Reviewer: <span class="reg-expert">Example Reviewer</span>',
  }),
  entryRow({
    href: '/assignments/example-params#alpha',
    title: 'Alpha &lt;values&gt;',
    procedure: 'Specification Required',
  }),
  categoryRow('Second Category'),
  entryRow({
    href: '/assignments/Mixed-Case.Id_1/Mixed-Case.Id_1.xhtml',
    title: 'Mixed Case Registry',
  }),
  entryRow({ href: '/assignments/_6tisch#sub-1', title: 'Underscore Id' }),
  entryRow({ href: '/somewhere-else/not-a-registry', title: 'Elsewhere' }),
  entryRow({ href: '/assignments/bad id', title: 'Bad Id' }),
  entryRow({ href: '/assignments/', title: 'No Id' }),
  entryRow({
    href: '/assignments/with-email',
    title: 'Mail person@example.org',
    procedure: 'Contact person@example.org',
  }),
  '<tr><td>Not an entry row</td></tr>',
);

/**
 * A page that clears the parse floor: `ids` distinct registry ids with
 * `entriesPerId` entries each (the first is the registry, the rest `#sub-N`),
 * spread over `categories` category rows.
 */
export function bigIndexHtml(ids = 520, entriesPerId = 4, categories = 12): string {
  const rows: string[] = [];
  for (let id = 0; id < ids; id++) {
    if (id % Math.ceil(ids / categories) === 0) rows.push(categoryRow(`Category ${rows.length}`));
    for (let entry = 0; entry < entriesPerId; entry++) {
      rows.push(
        entryRow({
          href: `/assignments/registry-${id}${entry === 0 ? '' : `#sub-${entry}`}`,
          title: `Registry ${id}${entry === 0 ? '' : ` Sub ${entry}`}`,
          procedure: 'IETF Review',
        }),
      );
    }
  }
  return indexPage(...rows);
}

/** A big page with exactly `ids` ids and `entries` entries (for floor-edge tests). */
export function indexHtmlWith(ids: number, entries: number): string {
  const rows: string[] = [categoryRow('Category')];
  for (let index = 0; index < entries; index++) {
    rows.push(
      entryRow({ href: `/assignments/registry-${index % ids}#e${index}`, title: `R ${index}` }),
    );
  }
  return indexPage(...rows);
}
