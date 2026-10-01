/**
 * @fileoverview A protocol-index page for the search tool tests: a handful of
 * hand-written entries (invented titles, categories, ids) over filler rows that
 * clear the parse floor (500 ids, 2,000 entries). Filler titles never contain a
 * word a test queries.
 * @module tests/fixtures/search-index
 */

import { categoryRow, entryRow, type IndexRowSpec, indexPage } from './protocol-index.js';

/** The hand-written entries tests search for, in index order. */
export const SEARCH_ENTRIES: readonly IndexRowSpec[] = [
  {
    href: '/assignments/example-tls',
    title: 'Example Transport Parameters',
    docs: [
      { id: 'RFC9999', href: '/go/rfc9999', title: 'Example Transport Spec' },
      { id: 'RFC8888' },
    ],
    procedure: 'IETF Review',
  },
  {
    href: '/assignments/example-tls#example-tls-4',
    title: 'Example Cipher Suites',
    procedure: 'Specification Required<br/><span class="reg-expert">Example Reviewer</span>',
  },
  { href: '/assignments/example-tls#example-tls-5', title: 'Example Cipher Extensions' },
  { href: '/assignments/example-dns', title: 'Example Resource Record Types' },
  { href: '/assignments/Example-Mixed', title: 'Mixed Case Example Registry' },
  { href: '/assignments/rank-first', title: 'Alpha Notes' },
  { href: '/assignments/alpha', title: 'Unrelated Heading' },
  {
    href: '/assignments/example-hostile',
    title:
      'Hostile [link](https://evil.example/) &lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x&gt;',
    docs: [
      {
        id: 'RFC1',
        href: '/go/a b)&gt;[c](d)',
        title: 'Doc [x](https://evil.example/) &lt;b&gt;bold&lt;/b&gt;',
      },
    ],
    procedure: 'Reach maintainers at maintainers@example.org',
  },
];

/**
 * An index page of the entries over filler: `ids` filler ids x `entriesPerId`
 * entries under one filler category row, then the entries under their own
 * category.
 */
export function searchIndexHtml(
  entries: readonly IndexRowSpec[] = SEARCH_ENTRIES,
  ids = 520,
  entriesPerId = 4,
): string {
  const rows: string[] = [categoryRow('Filler Category')];
  for (let id = 0; id < ids; id++) {
    for (let entry = 0; entry < entriesPerId; entry++) {
      rows.push(
        entryRow({
          href: `/assignments/filler-${id}${entry === 0 ? '' : `#part-${entry}`}`,
          title: `Filler ${id} part ${entry}`,
        }),
      );
    }
  }
  rows.push(categoryRow('Example Protocols'), ...entries.map(entryRow));
  return indexPage(...rows);
}
