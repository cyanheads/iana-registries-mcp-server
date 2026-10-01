/**
 * @fileoverview Tests for the `format()` sanitizers: `inline`, `quote`, and `url`
 * on hostile input (link, image, and HTML syntax, line breaks, control and bidi
 * characters, long runs), and the render helpers built on them.
 */

import { describe, expect, it } from 'vitest';
import {
  datesLine,
  inline,
  quote,
  referenceLines,
  sourceLines,
  url,
} from '@/mcp-server/tools/shared/markdown.js';

const BIDI = [
  '\u200E',
  '\u200F',
  '\u202A',
  '\u202B',
  '\u202C',
  '\u202D',
  '\u202E',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
];
const LINE_BREAKS = ['\n', '\r', '\r\n', '\v', '\f', '\u0085', '\u2028', '\u2029'];
const CONTROL = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Every C0 and C1 control character except the tab and the line breaks `inline` turns into spaces. */
const NON_BREAKING_CONTROLS = [
  ...Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)),
  '\u007F',
  ...Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(0x80 + code)),
].filter((char) => !['\n', '\r', '\t', '\v', '\f', '\u0085'].includes(char));

/** A deterministic pool-based generator: hostile fragments in random order. */
function hostileStrings(count: number): string[] {
  const pool = [
    '[x](https://evil.example/)',
    '![img](https://evil.example/x.png)',
    '<img src=x onerror=alert(1)>',
    '<https://evil.example>',
    '<script>alert(1)</script>',
    '\\',
    '\\[',
    '\n# Injected heading',
    '\r\n---\r\n',
    '\u2028- item',
    '\u2029> quote',
    '\t',
    '\u0000',
    '\u0007',
    '\u001B[31m',
    '\u0085',
    '\u202E',
    '\u2066',
    '\u200F',
    '`',
    '*',
    '😀',
    'plain text',
    '&amp;',
    ']',
    '[',
    '>',
    '<',
  ];
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + (next() % 12) }, () => pool[next() % pool.length]).join(''),
  );
}

describe('inline', () => {
  it('backslash-escapes square brackets and angle brackets, so link, image, and HTML syntax is inert', () => {
    expect(inline('[a](b)')).toBe(String.raw`\[a\](b)`);
    expect(inline('![alt](https://evil.example/x.png)')).toBe(
      String.raw`!\[alt\](https://evil.example/x.png)`,
    );
    expect(inline('<img src=x onerror=alert(1)>')).toBe(String.raw`\<img src=x onerror=alert(1)\>`);
    expect(inline('<https://evil.example>')).toBe(String.raw`\<https://evil.example\>`);
    expect(inline('<script>alert(1)</script>')).toBe(String.raw`\<script\>alert(1)\</script\>`);
  });

  it('escapes the backslash first, so a caller-supplied backslash cannot cancel an escape', () => {
    expect(inline(String.raw`\[`)).toBe(String.raw`\\\[`);
    expect(inline(String.raw`\\`)).toBe(String.raw`\\\\`);
    expect(inline('trailing\\')).toBe(String.raw`trailing\\`);
  });

  it.each(LINE_BREAKS)('turns the line break %j into one space', (breakChar) => {
    expect(inline(`a${breakChar}b`)).toBe('a b');
  });

  it('turns a tab into a space and keeps the words apart', () => {
    expect(inline('a\tb')).toBe('a b');
  });

  it('keeps an injected heading, list item, or quote on the same line as its slot', () => {
    expect(inline('Name\n# Injected\r\n- item\u2028> quote')).toBe(
      String.raw`Name # Injected - item \> quote`,
    );
  });

  it.each(BIDI)('strips the bidi character U+%s', (char) => {
    expect(inline(`a${char}b`)).toBe('ab');
  });

  it('strips every other C0 and C1 control character', () => {
    for (const char of NON_BREAKING_CONTROLS)
      expect(inline(`a${char}b`), JSON.stringify(char)).toBe('ab');
  });

  it('strips the Arabic letter mark U+061C', () => {
    expect(inline('a\u{061C}b')).toBe('ab');
  });

  it('leaves printable text, astral characters, and combining marks untouched', () => {
    expect(inline('Café 😀 é 日本語 — 100%')).toBe('Café 😀 é 日本語 — 100%');
  });

  it('does not throw on a lone surrogate', () => {
    expect(inline('a\ud800b')).toBe('a\ud800b');
  });

  it('returns an empty string for an empty or all-control input', () => {
    expect(inline('')).toBe('');
    expect(inline(NON_BREAKING_CONTROLS.join(''))).toBe('');
  });

  it('never leaves a line break, a control or bidi character, or an unescaped bracket (fuzz)', () => {
    for (const hostile of hostileStrings(500)) {
      const out = inline(hostile);
      expect(out, JSON.stringify(hostile)).not.toMatch(/[\n\r\u2028\u2029]/);
      expect(out, JSON.stringify(hostile)).not.toMatch(CONTROL);
      expect(out.replace(/\\[\\[\]<>]/g, ''), JSON.stringify(hostile)).not.toMatch(/[\\[\]<>]/);
    }
  });

  it('handles very long runs in linear time', () => {
    const started = performance.now();
    const brackets = inline('['.repeat(300_000));
    const breaks = inline('\n'.repeat(300_000));
    const long = inline('a'.repeat(2_000_000));
    expect(brackets).toHaveLength(600_000);
    expect(breaks).toBe(' '.repeat(300_000));
    expect(long).toHaveLength(2_000_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('quote', () => {
  it('prefixes every line with "> "', () => {
    expect(quote('one\ntwo\nthree')).toBe('> one\n> two\n> three');
  });

  it.each(LINE_BREAKS)('starts a new quoted line at the line break %j', (breakChar) => {
    expect(quote(`a${breakChar}b`)).toBe('> a\n> b');
  });

  it('keeps blank lines inside the blockquote as a bare ">"', () => {
    expect(quote('a\n\nb')).toBe('> a\n>\n> b');
    expect(quote('')).toBe('>');
  });

  it('keeps injected heading, rule, fence, and list syntax inside the quote', () => {
    expect(quote('text\n# Heading\n---\n```\n- item')).toBe(
      '> text\n> # Heading\n> ---\n> ```\n> - item',
    );
  });

  it('strips control and bidi characters and turns tabs into spaces', () => {
    expect(quote(`a\u202Eb\u0007c\td${BIDI.join('')}`)).toBe('> abc d');
    for (const char of NON_BREAKING_CONTROLS)
      expect(quote(`a${char}b`), JSON.stringify(char)).toBe('> ab');
  });

  it('strips the Arabic letter mark U+061C', () => {
    expect(quote('a\u{061C}b')).toBe('> ab');
  });

  it('backslash-escapes backslash, brackets, and angle brackets, so link, image, and HTML syntax is inert', () => {
    expect(quote(String.raw`![i](https://x/y.png) <b> \[a]`)).toBe(
      String.raw`> !\[i\](https://x/y.png) \<b\> \\\[a\]`,
    );
  });

  it('trims trailing spaces left by a stripped tail', () => {
    expect(quote('a \t')).toBe('> a');
  });

  it('puts every output line inside the blockquote, whatever the input (fuzz)', () => {
    for (const hostile of hostileStrings(500)) {
      const out = quote(hostile);
      for (const line of out.split('\n')) {
        expect(line, JSON.stringify(hostile)).toMatch(/^>( |$)/);
      }
      expect(out.replace(/\n/g, ''), JSON.stringify(hostile)).not.toMatch(CONTROL);
    }
  });

  it('handles very long runs in linear time', () => {
    const started = performance.now();
    const lines = quote('line\n'.repeat(200_000));
    const wide = quote('a'.repeat(2_000_000));
    expect(lines.split('\n')).toHaveLength(200_001);
    expect(wide).toHaveLength(2_000_002);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('url', () => {
  it('leaves a plain URL untouched', () => {
    const plain =
      'https://www.iana.org/assignments/tls-parameters/tls-parameters.xml#sub-1?a=1&b=2';
    expect(url(plain)).toBe(plain);
  });

  it('percent-encodes whitespace, quotes, brackets, parentheses, angle brackets, and backslash', () => {
    expect(url('https://example.org/a b"c\'d`e(f)[g]<h>\\i')).toBe(
      'https://example.org/a%20b%22c%27d%60e%28f%29%5Bg%5D%3Ch%3E%5Ci',
    );
  });

  it('breaks no autolink or link destination: a hostile URL stays one inert token', () => {
    const hostile = 'https://example.org/x)>\n[y](https://evil.example "t") <b>';
    const out = url(hostile);
    expect(out).not.toMatch(/[\s<>()[\]"']/);
    expect(`<${out}>`.indexOf('>')).toBe(`<${out}>`.length - 1);
  });

  it('encodes non-ASCII whitespace as UTF-8 percent escapes', () => {
    expect(url('https://example.org/a\u00A0b\u2003c\u2028d')).toBe(
      'https://example.org/a%C2%A0b%E2%80%83c%E2%80%A8d',
    );
  });

  it('strips control and bidi characters instead of encoding them', () => {
    expect(url('https://exa\u0000mple.org/\r\n\tpath\u202E')).toBe('https://example.org/path');
    expect(url(`https://example.org/${BIDI.join('')}`)).toBe('https://example.org/');
  });

  it('keeps existing percent escapes, so it is idempotent', () => {
    const once = url('https://example.org/a b%20c[d]');
    expect(once).toBe('https://example.org/a%20b%20c%5Bd%5D');
    expect(url(once)).toBe(once);
  });

  it('does not throw on a lone surrogate and returns "" for ""', () => {
    expect(url('https://example.org/\ud800')).toBe('https://example.org/\ud800');
    expect(url('')).toBe('');
  });

  it('never emits whitespace, a control or bidi character, or an angle bracket (fuzz)', () => {
    for (const hostile of hostileStrings(500)) {
      const out = url(`https://example.org/${hostile}`);
      expect(out, JSON.stringify(hostile)).not.toMatch(/[\s<>[\]()"'`\\]/u);
      expect(out, JSON.stringify(hostile)).not.toMatch(CONTROL);
    }
  });

  it('handles very long runs in linear time', () => {
    const started = performance.now();
    expect(url(' '.repeat(500_000))).toBe('%20'.repeat(500_000));
    expect(url('a'.repeat(2_000_000))).toHaveLength(2_000_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('referenceLines', () => {
  it('prints id, type, section, label, and a differing URL on one list item', () => {
    expect(
      referenceLines([
        {
          type: 'rfc',
          id: 'RFC 9110',
          section: '15.5.5',
          label: 'Not Found',
          url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
        },
        { type: 'text', id: 'Informal reference' },
        { type: 'uri', id: 'https://example.org/spec', url: 'https://example.org/spec' },
      ]),
    ).toEqual([
      '- RFC 9110 (rfc) §15.5.5 — Not Found <https://www.rfc-editor.org/rfc/rfc9110.html>',
      '- Informal reference (text)',
      '- https://example.org/spec (uri)',
    ]);
  });

  it('indents each item', () => {
    expect(referenceLines([{ type: 'note', id: 'n1' }], '  ')).toEqual(['  - n1 (note)']);
  });

  it('sanitizes id, section, label, and URL', () => {
    const [line = ''] = referenceLines([
      {
        type: 'text',
        id: 'evil\n## Injected [x](https://evil.example)',
        section: '1\n2',
        label: '<b>label</b>\u202E',
        url: 'https://example.org/a b)>[c]',
      },
    ]);
    expect(line).not.toMatch(/[\n\u202E]/);
    expect(line).toBe(
      String.raw`- evil ## Injected \[x\](https://evil.example) (text) §1 2 — \<b\>label\</b\> <https://example.org/a%20b%29%3E%5Bc%5D>`,
    );
  });
});

describe('sourceLines', () => {
  const source = {
    registry_id: 'http-status-codes',
    url: 'https://www.iana.org/assignments/http-status-codes/http-status-codes.xml',
    registry_updated: '2025-09-15',
    fetched_at: '2026-10-01T12:00:00.000Z',
    stale: false,
  };

  it('prints one provenance line for a fresh source', () => {
    expect(sourceLines(source)).toEqual([
      `**Source:** \`http-status-codes\` · registry updated 2025-09-15 · fetched 2026-10-01T12:00:00.000Z · <${source.url}>`,
    ]);
  });

  it('omits the updated date when the source has none', () => {
    const { registry_updated: _omitted, ...bare } = source;
    expect(sourceLines(bare)[0]).not.toContain('registry updated');
  });

  it('adds the stale-copy disclosure when a refresh failed', () => {
    expect(sourceLines({ ...source, stale: true })).toEqual([
      expect.stringContaining('**Source:**'),
      '**Served from a stale copy** fetched 2026-10-01T12:00:00.000Z; the latest refresh failed.',
    ]);
  });

  it('sanitizes the registry date and the URL', () => {
    const [line = ''] = sourceLines({
      ...source,
      registry_updated: '2025[x]\n',
      url: 'https://iana.org/a b',
    });
    expect(line).toContain(String.raw`registry updated 2025\[x\]`);
    expect(line).toContain('<https://iana.org/a%20b>');
    expect(line).not.toContain('\n');
  });
});

describe('datesLine', () => {
  it('joins the dates present and returns undefined when neither is', () => {
    expect(datesLine({ registered: '2020-01-02', updated: '2022-06-06' })).toBe(
      '**Registered:** 2020-01-02 · **Updated:** 2022-06-06',
    );
    expect(datesLine({ registered: '2020-01-02' })).toBe('**Registered:** 2020-01-02');
    expect(datesLine({ updated: '2022-06-06' })).toBe('**Updated:** 2022-06-06');
    expect(datesLine({})).toBeUndefined();
    expect(datesLine({ registered: '', updated: undefined })).toBeUndefined();
  });

  it('sanitizes a hostile date', () => {
    expect(datesLine({ registered: '[x](y)\n# h' })).toBe(String.raw`**Registered:** \[x\](y) # h`);
  });
});
