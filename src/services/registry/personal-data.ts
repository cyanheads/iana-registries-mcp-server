/**
 * @fileoverview Email-shaped token handling. Text that reaches a model has
 * `@`-form addresses and `mailto:` URIs replaced; a PEN organization line holding
 * an address in either the `@` form or IANA's `&` substitution is withheld whole.
 * @module services/registry/personal-data
 */

/** What an email-shaped token is replaced with. */
export const EMAIL_PLACEHOLDER = '[email removed]';

const DOMAIN = String.raw`[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`;
const LOCAL = '[A-Za-z0-9._%+-]+';

const EMAIL_OR_MAILTO = new RegExp(String.raw`mailto:[^\s<>"'()\[\]]+|${LOCAL}@${DOMAIN}`, 'gi');
const AT_FORM = new RegExp(`${LOCAL}@${DOMAIN}`);
const AMP_FORM = new RegExp(`${LOCAL}&${DOMAIN}`);

/** Replaces `@`-form addresses and `mailto:` URIs with {@link EMAIL_PLACEHOLDER}. */
export function scrubEmails(text: string): string {
  if (!text.includes('@') && !/mailto:/i.test(text)) return text;
  return text.replace(EMAIL_OR_MAILTO, EMAIL_PLACEHOLDER);
}

/** True when the text holds an address in the `@` form or IANA's `local&domain.tld` form. */
export function hasEmailToken(text: string): boolean {
  return AT_FORM.test(text) || AMP_FORM.test(text);
}
