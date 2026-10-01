/**
 * @fileoverview Tests for the protocol-index page parser and its failure floor.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  INDEX_MIN_ENTRIES,
  INDEX_MIN_REGISTRY_IDS,
  indexFloorError,
  parseProtocolIndex,
} from '@/services/registry/protocol-index-parser.js';
import {
  bigIndexHtml,
  categoryRow,
  entryRow,
  indexHtmlWith,
  indexPage,
  SMALL_INDEX_HTML,
} from '../../fixtures/protocol-index.js';

const URL_ = 'https://www.iana.org/protocols';

describe('parseProtocolIndex', () => {
  const index = parseProtocolIndex(SMALL_INDEX_HTML);
  const byTitle = (title: string) => index.entries.find((entry) => entry.title === title);

  it('reads one entry per registry or sub-registry row and counts category rows', () => {
    expect(index.entries).toHaveLength(5);
    expect(index.categoryCount).toBe(2);
  });

  it('carries the category the row sits under, entity-decoded', () => {
    expect(byTitle('Example Parameters')?.category).toBe('Example & Category');
    expect(byTitle('Underscore Id')?.category).toBe('Second Category');
  });

  it('derives registry id, page URL and XML URL from the href', () => {
    expect(byTitle('Example Parameters')).toMatchObject({
      registryId: 'example-params',
      pageUrl: 'https://www.iana.org/assignments/example-params',
      xmlUrl: 'https://www.iana.org/assignments/example-params/example-params.xml',
    });
    expect(byTitle('Example Parameters')).not.toHaveProperty('subregistryId');
  });

  it('reads the fragment as the sub-registry id and keeps it on the page URL only', () => {
    expect(byTitle('Alpha <values>')).toMatchObject({
      registryId: 'example-params',
      subregistryId: 'alpha',
      pageUrl: 'https://www.iana.org/assignments/example-params#alpha',
      xmlUrl: 'https://www.iana.org/assignments/example-params/example-params.xml',
    });
  });

  it('takes the first path segment as the id when the href carries a file path', () => {
    expect(byTitle('Mixed Case Registry')).toMatchObject({
      registryId: 'Mixed-Case.Id_1',
      xmlUrl: 'https://www.iana.org/assignments/Mixed-Case.Id_1/Mixed-Case.Id_1.xml',
    });
  });

  it('accepts ids that start with an underscore', () => {
    expect(byTitle('Underscore Id')).toMatchObject({
      registryId: '_6tisch',
      subregistryId: 'sub-1',
      xmlUrl: 'https://www.iana.org/assignments/_6tisch/_6tisch.xml',
    });
  });

  it('skips rows whose href is outside /assignments/, has an invalid id, or has no id', () => {
    const titles = index.entries.map((entry) => entry.title);
    expect(titles).not.toContain('Elsewhere');
    expect(titles).not.toContain('Bad Id');
    expect(titles).not.toContain('No Id');
  });

  it('drops an invalid fragment but keeps the entry', () => {
    const page = indexPage(entryRow({ href: '/assignments/ok#bad frag', title: 'T' }));
    expect(parseProtocolIndex(page).entries[0]).toMatchObject({ registryId: 'ok' });
    expect(parseProtocolIndex(page).entries[0]).not.toHaveProperty('subregistryId');
  });

  it('decodes entities and strips markup in titles', () => {
    expect(byTitle('Alpha <values>')).toBeDefined();
    const page = indexPage(
      entryRow({ href: '/assignments/a', title: '<b>Bold</b> &amp; &#169; &nbsp;x' }),
    );
    expect(parseProtocolIndex(page).entries[0]?.title).toBe('Bold & © x');
  });

  it('reads defining documents with id, entity-decoded title and an iana.org URL for site-relative links', () => {
    expect(byTitle('Example Parameters')?.definingDocuments).toEqual([
      { id: 'RFC9999', title: 'The Example & Spec', url: 'https://www.iana.org/go/rfc9999' },
      { id: 'RFC8888' },
    ]);
    expect(byTitle('Alpha <values>')?.definingDocuments).toEqual([]);
  });

  it('does not follow an absolute defining-document href', () => {
    const page = indexPage(
      entryRow({
        href: '/assignments/a',
        title: 'T',
        docs: [{ id: 'RFC1', href: 'https://elsewhere.example/doc' }],
      }),
    );
    expect(parseProtocolIndex(page).entries[0]?.definingDocuments).toEqual([{ id: 'RFC1' }]);
  });

  it('joins comment lines with "; " and removes designated-expert spans before reading any text', () => {
    const procedure = byTitle('Example Parameters')?.registrationProcedure;
    expect(procedure).toBe('Expert Review; Standards Action; Reviewer:');
    expect(procedure).not.toContain('Example Reviewer');
    expect(byTitle('Alpha <values>')?.registrationProcedure).toBe('Specification Required');
    expect(byTitle('Mixed Case Registry')).not.toHaveProperty('registrationProcedure');
  });

  it.each([
    ['an extra class on the span', 'class="reg-expert extra"'],
    ['the class listed second', 'class="extra reg-expert"'],
    ['single-quoted markup', "class='reg-expert'"],
  ])(
    'withholds the whole procedure when an expert span survives removal (%s)',
    (_name, attributes) => {
      const page = indexPage(
        entryRow({
          href: '/assignments/a',
          title: 'T',
          procedure: `Review <span ${attributes}>Example Reviewer</span> done`,
        }),
      );
      const entry = parseProtocolIndex(page).entries[0];
      expect(entry).not.toHaveProperty('registrationProcedure');
      expect(JSON.stringify(entry)).not.toContain('Example Reviewer');
    },
  );

  it('never leaks an expert name from nested expert spans', () => {
    const page = indexPage(
      entryRow({
        href: '/assignments/a',
        title: 'T',
        procedure:
          'Review <span class="reg-expert"><span class="reg-expert">Example Reviewer</span></span> done',
      }),
    );
    expect(JSON.stringify(parseProtocolIndex(page).entries[0])).not.toContain('Example Reviewer');
  });

  it('removes every expert span, not just the first', () => {
    const page = indexPage(
      entryRow({
        href: '/assignments/a',
        title: 'T',
        procedure:
          'Expert Review<br/>Experts: <span class="reg-expert">Example Reviewer</span>, <span class="reg-expert">Example Expert</span>',
      }),
    );
    const procedure = parseProtocolIndex(page).entries[0]?.registrationProcedure;
    expect(procedure).not.toContain('Example');
    expect(procedure).toBe('Expert Review; Experts: ,');
  });

  it('replaces email-shaped tokens in titles, categories and procedures', () => {
    const entry = byTitle('Mail [email removed]');
    expect(entry?.registrationProcedure).toBe('Contact [email removed]');
    const page = indexPage(
      categoryRow('Mail person@example.org'),
      entryRow({ href: '/assignments/a', title: 'T' }),
    );
    expect(parseProtocolIndex(page).entries[0]?.category).toBe('Mail [email removed]');
  });

  it('builds padded search text over title, category, registry id and sub-registry id', () => {
    expect(byTitle('Alpha <values>')?.searchText).toBe(
      ' alpha values example category example params alpha ',
    );
  });

  it('maps lowercase ids to the canonical spelling', () => {
    expect(index.registryIds.get('mixed-case.id_1')).toBe('Mixed-Case.Id_1');
    expect(index.registryIds.get('_6tisch')).toBe('_6tisch');
    expect(index.registryIds.has('Mixed-Case.Id_1')).toBe(false);
    expect([...index.registryIds.keys()].sort()).toEqual([
      '_6tisch',
      'example-params',
      'mixed-case.id_1',
      'with-email',
    ]);
  });

  it('reads an empty page as an empty index', () => {
    expect(parseProtocolIndex('<html></html>')).toEqual({
      entries: [],
      registryIds: new Map(),
      categoryCount: 0,
    });
  });

  it('reads rows with an empty category before the first category row', () => {
    const page = indexPage(entryRow({ href: '/assignments/a', title: 'T' }));
    expect(parseProtocolIndex(page).entries[0]?.category).toBe('');
  });
});

describe('indexFloorError', () => {
  it('accepts a page at the floor: 500 ids and 2,000 entries', () => {
    const index = parseProtocolIndex(indexHtmlWith(INDEX_MIN_REGISTRY_IDS, INDEX_MIN_ENTRIES));
    expect(index.registryIds.size).toBe(500);
    expect(index.entries).toHaveLength(2_000);
    expect(indexFloorError(index, URL_)).toBeUndefined();
  });

  it('accepts a full-size synthetic page', () => {
    expect(indexFloorError(parseProtocolIndex(bigIndexHtml()), URL_)).toBeUndefined();
  });

  it.each([
    ['one id short', 499, 2_000],
    ['one entry short', 500, 1_999],
    ['a short page', 20, 100],
  ])('rejects %s', (_name, ids, entries) => {
    const index = parseProtocolIndex(indexHtmlWith(ids, entries));
    const error = indexFloorError(index, URL_);
    expect(error).toBeDefined();
    expect(error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error?.data).toMatchObject({
      reason: 'index_unreadable',
      retryable: false,
      url: URL_,
      registryIds: ids,
      entries,
    });
    expect(error?.message).toContain(`${ids} registry ids and ${entries} entries`);
  });

  it('rejects an empty index and a page of the wrong shape', () => {
    expect(
      indexFloorError(parseProtocolIndex('<html><body>Maintenance</body></html>'), URL_)?.data,
    ).toMatchObject({ reason: 'index_unreadable', registryIds: 0, entries: 0 });
  });

  it('exposes the floor constants the design names', () => {
    expect(INDEX_MIN_REGISTRY_IDS).toBe(500);
    expect(INDEX_MIN_ENTRIES).toBe(2_000);
  });
});
