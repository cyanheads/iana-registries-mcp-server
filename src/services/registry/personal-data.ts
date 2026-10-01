/**
 * @fileoverview Email-shaped token handling. Text that reaches a model has
 * `@`-form addresses and `mailto:` URIs replaced, except YANG module file names
 * (`<module>@YYYY-MM-DD.yang`, RFC 7950 §5.2); a PEN organization line holding
 * an address in either the `@` form or IANA's `&` substitution is withheld whole.
 * @module services/registry/personal-data
 */

/** What an email-shaped token is replaced with. */
export const EMAIL_PLACEHOLDER = '[email removed]';

/**
 * Every part of an address is length-bounded (RFC 5321 caps a local part at 64
 * characters and a label at 63), so a scan costs a constant per position. With
 * unbounded runs, each start inside a long run rescans it to the end.
 */
const DOMAIN = String.raw`(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,63}`;
const LOCAL = '[A-Za-z0-9._%+-]{1,64}';

const EMAIL_OR_MAILTO = new RegExp(String.raw`mailto:[^\s<>"'()\[\]]+|${LOCAL}@${DOMAIN}`, 'gi');

/**
 * An `@` or `&` with a local-part character right before it and a domain after
 * it: the text holds an address exactly when one does, and the scan starts only
 * at an `@` or `&`.
 */
const ADDRESS_MARK = new RegExp(`(?<=[A-Za-z0-9._%+-])[@&]${DOMAIN}`);

/** The part after `@` in a YANG module revision file name. */
const YANG_REVISION_FILE = /@\d{4}-\d{2}-\d{2}\.yang$/;

/**
 * Replaces `@`-form addresses and `mailto:` URIs with {@link EMAIL_PLACEHOLDER}.
 * A YANG module file name (`ietf-example@2026-01-01.yang`) is a file, not an
 * address, and is kept.
 */
export function scrubEmails(text: string): string {
  if (!text.includes('@') && !/mailto:/i.test(text)) return text;
  return text.replace(EMAIL_OR_MAILTO, (token) =>
    !/^mailto:/i.test(token) && YANG_REVISION_FILE.test(token) ? token : EMAIL_PLACEHOLDER,
  );
}

/** True when the text holds an address in the `@` form or IANA's `local&domain.tld` form. */
export function hasEmailToken(text: string): boolean {
  return ADDRESS_MARK.test(text);
}
