/**
 * @fileoverview Tests for the registry search over the protocol index: the
 * singular/plural fold, the four-key order (exact id, title distance, missing
 * query words, index position), and, over an excerpt of the live index, that
 * every entry the strict whole-token matcher finds is still found, once.
 */

import { describe, expect, it } from 'vitest';
import { foldToken, searchIndex } from '@/services/registry/index-search.js';
import { parseProtocolIndex } from '@/services/registry/protocol-index-parser.js';
import { compileQuery, matchesQuery, toSearchText } from '@/services/registry/search-text.js';
import type { IndexEntry } from '@/services/registry/types.js';
import { LIVE_INDEX_GROUPS, liveIndexHtml } from '../../fixtures/live-index-excerpt.js';
import {
  categoryRow,
  entryRow,
  type IndexRowSpec,
  indexPage,
} from '../../fixtures/protocol-index.js';

const pairOf = (entry: Pick<IndexEntry, 'registryId' | 'subregistryId'>) =>
  entry.subregistryId ? `${entry.registryId}#${entry.subregistryId}` : entry.registryId;

/** An index of `rows` under one category, in order. */
const indexOf = (...rows: IndexRowSpec[]) =>
  parseProtocolIndex(indexPage(categoryRow('Example Protocols'), ...rows.map(entryRow)));

const search = (index: ReturnType<typeof indexOf>, query: string) =>
  searchIndex(index, query).map(pairOf);

describe('foldToken', () => {
  it.each([
    ['registries', 'registry'],
    ['policies', 'policy'],
    ['addresses', 'address'],
    ['classes', 'class'],
    ['prefixes', 'prefix'],
    ['matches', 'match'],
    ['hashes', 'hash'],
    ['statuses', 'status'],
    ['types', 'type'],
    ['numbers', 'number'],
    ['options', 'option'],
    ['ethertypes', 'ethertype'],
    ['causes', 'cause'],
    ['uses', 'use'],
    ['ids', 'id'],
  ])('folds %s to %s', (token, folded) => {
    expect(foldToken(token)).toBe(folded);
  });

  it.each(['class', 'address', 'status', 'campus', 'analysis', 'axis', 'type', 'registry'])(
    'leaves %s as written: a singular, or a word ending ss, us, sis, or xis',
    (token) => {
      expect(foldToken(token)).toBe(token);
    },
  );

  it.each(['dns', 'tls', 'aes', 'ips', 'qos', 'as', 's'])(
    'never folds a token under four characters (%s)',
    (token) => {
      expect(foldToken(token)).toBe(token);
    },
  );

  it.each(['ipv4s', 'http2s', '1000s'])('never folds a token holding a digit (%s)', (token) => {
    expect(foldToken(token)).toBe(token);
  });

  it('folds a singular and its plural to one key', () => {
    for (const [singular, plural] of [
      ['registry', 'registries'],
      ['address', 'addresses'],
      ['status', 'statuses'],
      ['ethertype', 'ethertypes'],
      ['id', 'ids'],
    ]) {
      expect(foldToken(plural as string)).toBe(foldToken(singular as string));
    }
  });
});

describe('searchIndex: matching', () => {
  const index = indexOf(
    { href: '/assignments/example-tls#example-tls-4', title: 'Example Cipher Suites' },
    { href: '/assignments/example-widgets', title: 'Example Registry' },
    { href: '/assignments/example-dns', title: 'Example Resource Record Types' },
  );

  it('matches singular and plural in titles, categories, and ids alike', () => {
    expect(search(index, 'cipher suite')).toEqual(['example-tls#example-tls-4']);
    expect(search(index, 'resource record type')).toEqual(['example-dns']);
    expect(search(index, 'example widget')).toEqual(['example-widgets']);
    expect(search(index, 'example protocol')).toHaveLength(3);
  });

  it('still requires every query word, as a whole token', () => {
    expect(search(index, 'cipher suite extension')).toEqual([]);
    expect(search(index, 'ciph')).toEqual([]);
  });

  it('returns nothing for a query with no letter or digit', () => {
    expect(search(index, '--')).toEqual([]);
  });
});

describe('searchIndex: order', () => {
  it('ranks an exact registry or sub-registry id first, case-insensitively', () => {
    const index = indexOf(
      { href: '/assignments/beta#gamma', title: 'Alpha Gamma Notes' },
      { href: '/assignments/Alpha', title: 'Unrelated Heading' },
      { href: '/assignments/beta#alpha-codes', title: 'Codes' },
    );
    expect(search(index, 'ALPHA')).toEqual(['Alpha', 'beta#gamma', 'beta#alpha-codes']);
    expect(search(index, 'alpha-codes')).toEqual(['beta#alpha-codes']);
  });

  it('ranks a registry whose id is the folded query first: "widget numbers" finds widget-numbers', () => {
    const index = indexOf(
      { href: '/assignments/widget-misc#legacy', title: 'Legacy Widget Numbers for Gadgets' },
      { href: '/assignments/widget-numbers#widget-numbers-1', title: 'Assigned Widget Numbers' },
    );
    expect(search(index, 'widget numbers')).toEqual([
      'widget-numbers#widget-numbers-1',
      'widget-misc#legacy',
    ]);
    expect(search(index, 'Widget Number')).toEqual([
      'widget-numbers#widget-numbers-1',
      'widget-misc#legacy',
    ]);
  });

  it('keeps a sub-registry id out of the exact tier: the closest title ranks above it', () => {
    const index = indexOf(
      { href: '/assignments/gizmo#command-codes', title: 'Gizmo Command Codes' },
      { href: '/assignments/gizmo-params#gizmo-params-3', title: 'Command Codes' },
    );
    expect(search(index, 'command codes')).toEqual([
      'gizmo-params#gizmo-params-3',
      'gizmo#command-codes',
    ]);
    expect(search(index, 'command-codes')).toEqual([
      'gizmo#command-codes',
      'gizmo-params#gizmo-params-3',
    ]);
  });

  it('ranks by title distance: query words missing from the title plus title words missing from the query', () => {
    const index = indexOf(
      { href: '/assignments/widget-params#codes', title: 'Widget Option Codes' },
      {
        href: '/assignments/widget-params#bulk',
        title: 'Widget Options Registry for Bulk Gadgets',
      },
      { href: '/assignments/widget-params#options', title: 'Options for Widgets' },
    );
    expect(search(index, 'widget options')).toEqual([
      'widget-params#options',
      'widget-params#codes',
      'widget-params#bulk',
    ]);
  });

  it('does not count a, an, and, by, for, in, of, on, or, the, to, or with as title words', () => {
    const index = indexOf(
      { href: '/assignments/widget-params#codes', title: 'Widget Option Codes' },
      { href: '/assignments/widget-params#options', title: 'The Options of a Widget' },
    );
    expect(search(index, 'widget options')).toEqual([
      'widget-params#options',
      'widget-params#codes',
    ]);
  });

  it('counts the parts of a camelCase title word as title words', () => {
    const index = indexOf(
      { href: '/assignments/foo-params#long', title: 'Foo Bar Baz Qux Codes' },
      { href: '/assignments/foo-params#camel', title: 'FooBar Codes' },
    );
    expect(search(index, 'foo bar codes')).toEqual(['foo-params#camel', 'foo-params#long']);
  });

  it('breaks a title-distance tie by fewer query words missing from the title', () => {
    const index = indexOf(
      { href: '/assignments/beta-reg#one', title: 'Alpha Gamma' },
      { href: '/assignments/other-reg#two', title: 'Alpha Beta Gamma Delta' },
    );
    expect(search(index, 'alpha beta')).toEqual(['other-reg#two', 'beta-reg#one']);
  });

  it('keeps index order for entries the first three keys tie', () => {
    const index = indexOf(
      { href: '/assignments/tie#b', title: 'Widget Beta Codes' },
      { href: '/assignments/tie#a', title: 'Widget Alpha Codes' },
    );
    expect(search(index, 'widget codes')).toEqual(['tie#b', 'tie#a']);
  });

  it('lists a pair indexed under two categories once, found through either category', () => {
    const index = parseProtocolIndex(
      indexPage(
        categoryRow('Interface Parameters'),
        entryRow({ href: '/assignments/smi-example#smi-example-5', title: 'ifType Definitions' }),
        entryRow({ href: '/assignments/other#types', title: 'Other Interface Types' }),
        categoryRow('Management Information'),
        entryRow({ href: '/assignments/smi-example#smi-example-5', title: 'ifType Definitions' }),
      ),
    );
    expect(search(index, 'interface')).toEqual(['other#types', 'smi-example#smi-example-5']);
    expect(search(index, 'management information')).toEqual(['smi-example#smi-example-5']);
    expect(search(index, 'interface management')).toEqual(['smi-example#smi-example-5']);
  });

  it("finds a pair through a later listing's title, ranked by the title it shows", () => {
    const index = parseProtocolIndex(
      indexPage(
        categoryRow('Interface Parameters'),
        entryRow({ href: '/assignments/smi-example#smi-example-5', title: 'ifType Definitions' }),
        entryRow({ href: '/assignments/other#kinds', title: 'Interface Kinds' }),
        categoryRow('Management Information'),
        entryRow({ href: '/assignments/smi-example#smi-example-5', title: 'Interface Kinds' }),
      ),
    );
    expect(index.entries.map((entry) => entry.title)).toEqual([
      'ifType Definitions',
      'Interface Kinds',
    ]);
    expect(search(index, 'interface kinds')).toEqual(['other#kinds', 'smi-example#smi-example-5']);
    expect(search(index, 'kind management')).toEqual(['smi-example#smi-example-5']);
  });
});

describe('searchIndex over the live index excerpt', () => {
  const index = parseProtocolIndex(liveIndexHtml(0));

  /** Each excerpt row as its own entry, matched by the strict shared matcher. */
  const rows = LIVE_INDEX_GROUPS.flatMap(([category, entries]) =>
    entries.map(([href, title]) => {
      const [registryId = '', subregistryId] = href.slice('/assignments/'.length).split('#');
      return {
        pair: pairOf({ registryId, ...(subregistryId ? { subregistryId } : {}) }),
        searchText: toSearchText(title, category, registryId, subregistryId),
        title,
      };
    }),
  );

  const queries = [
    ...new Set([
      ...rows.map((row) => row.title),
      ...rows
        .flatMap((row) => row.searchText.trim().split(' '))
        .filter((token) => token.length > 1),
    ]),
  ];

  it('finds every entry the strict whole-token matcher finds, for every title and title word', () => {
    expect(queries.length).toBeGreaterThan(400);
    const lost: string[] = [];
    for (const query of queries) {
      const strict = compileQuery(query);
      const found = new Set(searchIndex(index, query).map(pairOf));
      for (const row of rows) {
        if (matchesQuery(row.searchText, strict) && !found.has(row.pair)) {
          lost.push(`${query} → ${row.pair}`);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  it('never lists a pair twice', () => {
    for (const query of queries) {
      const pairs = searchIndex(index, query).map(pairOf);
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  });

  it('answers the same order on every call', () => {
    expect(searchIndex(index, 'protocol numbers')).toEqual(searchIndex(index, 'protocol numbers'));
  });
});
