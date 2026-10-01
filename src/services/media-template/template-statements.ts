/**
 * @fileoverview Extracts the three statements `iana_lookup_media_type` returns
 * from a media type registration template: file extensions, intended usage, and
 * deprecated alias names. Templates are free-form and carry contact names and
 * addresses, so the rule is narrow by design: match one of three labels, take
 * the label's value plus continuation lines (stopping at a blank line or any
 * other label line), drop every line holding an email-shaped token or opening
 * with a contact word and every continuation line that is only a personal name
 * (a name-shaped line holding a statement word such as `Limited Use` or
 * `Not Applicable` is a value, not a name, and stays), then cut what is left to
 * 300 characters. Nothing else in the template is read.
 * @module services/media-template/template-statements
 */

/** The statements a template yields; each is verbatim text, absent when the template lacks it. */
export interface TemplateStatements {
  /** `Deprecated alias names for this type:` statement. */
  deprecatedAliases?: string;
  /** `File extension(s):` (or `File extension:`) statement. */
  fileExtensions?: string;
  /** `Intended usage:` statement. */
  intendedUsage?: string;
}

/** Longest statement kept, in characters, after the line filter runs. */
export const STATEMENT_MAX_CHARS = 300;

/** Optional leading whitespace and `2.`-style numbering in front of a label. */
const LABEL_LEAD = String.raw`^\s*(?:\d+\.\s*)?`;

/** The three labels read, each matched at the start of a line up to its colon. */
const LABELS = {
  fileExtensions: new RegExp(String.raw`${LABEL_LEAD}file extension(?:\(s\)|s)?\s*:`, 'i'),
  intendedUsage: new RegExp(String.raw`${LABEL_LEAD}intended usage\s*:`, 'i'),
  deprecatedAliases: new RegExp(
    String.raw`${LABEL_LEAD}deprecated alias names for this type\s*:`,
    'i',
  ),
} as const satisfies Record<keyof TemplateStatements, RegExp>;

/** Any label line; one ends the statement before it. */
const ANY_LABEL = new RegExp(String.raw`${LABEL_LEAD}[A-Za-z][A-Za-z0-9 ()/&,'.-]{0,80}?\s*:`);

/** An `@`, a `mailto:`, or IANA's `local&domain` substitution (an `&` between word characters). */
const EMAIL_SHAPED = /@|mailto:|[A-Za-z0-9._%+-]&[A-Za-z0-9-]/i;

/** A line opening with a contact word, matched as a whole word, after optional numbering. */
const CONTACT_OPENER =
  /^\s*(?:\d+\.\s*)?(?:persons?|contacts?|authors?|names?|e-?mails?|change controllers?)\b/i;

/** One capitalized personal-name word: `Example`, `J.`, `O'Example`, `Mary-Ann`. */
const NAME_WORD = String.raw`(?:\p{Lu}\.|\p{Lu}[\p{Ll}\p{M}]*(?:['’-]\p{Lu}?[\p{Ll}\p{M}]+)*\.?)`;

/** A line holding only two to four capitalized name words, e.g. `Example Person`. */
const BARE_NAME = new RegExp(String.raw`^\s*${NAME_WORD}(?:\s+${NAME_WORD}){1,3}\s*$`, 'u');

/** Words of a statement value (`LIMITED USE`, `Not Applicable`) that no personal name is made of. */
const STATEMENT_WORD =
  /\b(?:common|limited|use|obsolete|not|none|applicable|specified|unspecified|unknown)\b/i;

/** Extracts the three statements from a template's text. */
export function extractTemplateStatements(text: string): TemplateStatements {
  const lines = text.split(/\r\n?|\n/);
  const statements: TemplateStatements = {};
  for (const key of Object.keys(LABELS) as (keyof TemplateStatements)[]) {
    const label = LABELS[key];
    const start = lines.findIndex((line) => label.test(line));
    if (start === -1) continue;
    const statement = statementAt(lines, start, label);
    if (statement) statements[key] = statement;
  }
  return statements;
}

/** True when a line of a statement may be returned; `continuation` is false for the label's own line. */
function keepLine(line: string, continuation: boolean): boolean {
  if (EMAIL_SHAPED.test(line) || CONTACT_OPENER.test(line)) return false;
  return !(continuation && BARE_NAME.test(line) && !STATEMENT_WORD.test(line));
}

/**
 * The statement whose label sits on `lines[start]`: the value after the colon
 * plus continuation lines, line-filtered, then cut to {@link STATEMENT_MAX_CHARS}
 * code points. Filtering first means a cut never leaves part of a dropped line.
 * `undefined` when nothing survives.
 */
function statementAt(lines: readonly string[], start: number, label: RegExp): string | undefined {
  const extent = [(lines[start] ?? '').replace(label, '').trim()];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || ANY_LABEL.test(line)) break;
    extent.push(line.trim());
  }
  const kept = extent.filter((line, index) => line !== '' && keepLine(line, index > 0)).join('\n');
  return Array.from(kept).slice(0, STATEMENT_MAX_CHARS).join('').trim() || undefined;
}
