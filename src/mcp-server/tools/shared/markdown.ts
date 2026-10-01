/**
 * @fileoverview `format()` sanitizers for upstream-authored text, shared by every
 * tool. `inline()` makes a value safe for one markdown line (headings, bold
 * names, list items, notice fragments), `quote()` renders free text as a
 * blockquote, `url()` makes a URL safe to print. Both text helpers strip control
 * and bidi characters and leave link, image, and HTML syntax inert.
 * `joinLines()` assembles a `format()` text so every blockquote ends before the
 * next server line. `structuredContent` keeps every upstream field exactly as
 * the service model holds it; a notice, which both surfaces carry, interpolates
 * upstream values through `inline()`.
 * @module mcp-server/tools/shared/markdown
 */

/** A reference as `format()` receives it (Zod output: optional keys may hold `undefined`). */
interface ReferenceView {
  id: string;
  label?: string | undefined;
  section?: string | undefined;
  type: string;
  url?: string | undefined;
}

/** A `source` block as `format()` receives it. */
interface SourceView {
  fetched_at: string;
  registry_id: string;
  registry_updated?: string | undefined;
  stale: boolean;
  url: string;
}

/** C0/C1 controls (U+0000–U+001F, U+007F–U+009F) and bidi override/isolate/mark characters (U+061C included). */
const CONTROL_OR_BIDI = /[\p{Cc}\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/** CR, LF, CRLF, VT, FF, NEL, and the Unicode line and paragraph separators. */
const LINE_BREAK = /\r\n?|[\n\v\f\u0085\p{Zl}\p{Zp}]/gu;

/**
 * Characters that open link, image, or HTML syntax, escaped with a backslash in
 * every rendered slot. The backslash is escaped too, so an upstream `\[` cannot
 * cancel the escape.
 */
const MARKDOWN_SPECIAL = /[\\[\]<>]/g;

/** Characters a printed URL must not carry raw: whitespace, quotes, backticks, parentheses, brackets, angle brackets, backslash. */
const URL_UNSAFE = /[\s"'`()[\]<>\\]/gu;

/**
 * One markdown line: line breaks and tabs become spaces, control and bidi
 * characters are stripped, and `\` `[` `]` `<` `>` are backslash-escaped.
 */
export function inline(text: string): string {
  return text
    .replace(LINE_BREAK, ' ')
    .replace(/\t/g, ' ')
    .replace(CONTROL_OR_BIDI, '')
    .replace(MARKDOWN_SPECIAL, '\\$&');
}

/**
 * Free text as a blockquote: `> ` on every line (each line break starts a new
 * quoted line), tabs become spaces, control and bidi characters are stripped,
 * and `\` `[` `]` `<` `>` are backslash-escaped. `(`, `)`, `!`, and backticks
 * stay as written: with the brackets escaped they form no link or image.
 */
export function quote(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) =>
      `> ${line.replace(/\t/g, ' ').replace(CONTROL_OR_BIDI, '').replace(MARKDOWN_SPECIAL, '\\$&')}`.trimEnd(),
    )
    .join('\n');
}

/**
 * Joins `format()` lines into one text, inserting a blank line wherever a quoted
 * (`>`) line is followed by a non-blank line that is not quoted. Without it, a
 * server line after a blockquote continues the quote (CommonMark §5.1 laziness)
 * and renders inside the third-party text.
 */
export function joinLines(lines: readonly string[]): string {
  const joined: string[] = [];
  for (const line of lines.join('\n').split('\n')) {
    if (joined.at(-1)?.startsWith('>') && line !== '' && !line.startsWith('>')) joined.push('');
    joined.push(line);
  }
  return joined.join('\n');
}

/** A URL safe to print bare or inside `<…>`: unsafe characters percent-encoded, controls stripped. */
export function url(href: string): string {
  return href.replace(CONTROL_OR_BIDI, '').replace(URL_UNSAFE, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x80
      ? `%${code.toString(16).toUpperCase().padStart(2, '0')}`
      : encodeURIComponent(char);
  });
}

/** One list item per reference: id, type, section, label, and URL (when it differs from the id). */
export function referenceLines(references: readonly ReferenceView[], indent = ''): string[] {
  return references.map((ref) => {
    const section = ref.section ? ` §${inline(ref.section)}` : '';
    const label = ref.label ? ` — ${inline(ref.label)}` : '';
    const link = ref.url && ref.url !== ref.id ? ` <${url(ref.url)}>` : '';
    return `${indent}- ${inline(ref.id)} (${ref.type})${section}${label}${link}`;
  });
}

/** The provenance line, plus the stale-copy disclosure when a refresh failed. */
export function sourceLines(source: SourceView): string[] {
  const updated = source.registry_updated
    ? ` · registry updated ${inline(source.registry_updated)}`
    : '';
  const lines = [
    `**Source:** \`${source.registry_id}\`${updated} · fetched ${source.fetched_at} · <${url(source.url)}>`,
  ];
  if (source.stale) {
    lines.push(
      `**Served from a stale copy** fetched ${source.fetched_at}; the latest refresh failed.`,
    );
  }
  return lines;
}

/** `**Registered:** … · **Updated:** …` for a record carrying either date; `undefined` when neither. */
export function datesLine(dates: {
  registered?: string | undefined;
  updated?: string | undefined;
}): string | undefined {
  const parts = [
    dates.registered ? `**Registered:** ${inline(dates.registered)}` : undefined,
    dates.updated ? `**Updated:** ${inline(dates.updated)}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
