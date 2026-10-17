/**
 * @fileoverview Parses the Language Tag Extensions record-jar using an explicit
 * field allowlist. Contacts, mailing lists, URLs and comments never enter the model.
 * @module services/registry/language-extensions-parser
 */

import { upstreamUnreadable } from '../upstream/upstream-client.js';
import { EMAIL_PLACEHOLDER, hasEmailToken, scrubEmails } from './personal-data.js';
import type { LanguageExtension, LanguageExtensionsRegistry, Reference } from './types.js';

/** Parses a complete registry; an incomplete or malformed copy cannot establish nonallocation. */
export function parseLanguageExtensions(text: string, url: string): LanguageExtensionsRegistry {
  const bySingleton = new Map<string, LanguageExtension>();
  const fields = new Map<string, string[]>();
  let fileDate = '';
  let lastKey = '';
  const fail = () =>
    upstreamUnreadable(`${url} is not a complete language tag extensions registry.`, { url });
  const finish = () => {
    if (fields.size === 0) return;
    const singleton = fields.get('Identifier')?.[0]?.toLowerCase() ?? '';
    const descriptions = (fields.get('Description') ?? []).map((description) =>
      hasEmailToken(description) ? EMAIL_PLACEHOLDER : scrubEmails(description),
    );
    const references: Reference[] = [];
    for (const value of fields.get('RFC') ?? []) {
      if (!(value.startsWith('[RFC') && value.endsWith(']'))) throw fail();
      const number = value.slice(4, -1);
      if (
        !number ||
        number.length > 5 ||
        ![...number].every((char) => char >= '0' && char <= '9') ||
        Number(number) === 0
      )
        throw fail();
      references.push({
        type: 'rfc',
        id: `RFC ${Number(number)}`,
        url: `https://www.rfc-editor.org/rfc/rfc${Number(number)}.html`,
      });
    }
    if (
      singleton.length !== 1 ||
      !'0123456789abcdefghijklmnopqrstuvwyz'.includes(singleton) ||
      !descriptions.length ||
      !references.length ||
      bySingleton.has(singleton)
    )
      throw fail();
    const authority = fields.get('Authority')?.[0];
    bySingleton.set(singleton, {
      singleton,
      descriptions,
      references,
      ...(authority && !hasEmailToken(authority) ? { authority } : {}),
    });
    fields.clear();
  };
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '%%') {
      finish();
      lastKey = '';
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      const values = fields.get(lastKey);
      if (values?.length) values[values.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    lastKey = colon > 0 ? line.slice(0, colon) : '';
    const value = line.slice(colon + 1).trim();
    if (lastKey === 'File-Date') {
      fileDate = value;
      continue;
    }
    if (!['Identifier', 'Description', 'RFC', 'Authority'].includes(lastKey)) continue;
    const values = fields.get(lastKey);
    if (values) values.push(value);
    else fields.set(lastKey, [value]);
  }
  finish();
  /** The established RFC 6497/6067 allocations are a floor, so a partial copy cannot revoke them. */
  if (!fileDate || !bySingleton.has('t') || !bySingleton.has('u')) throw fail();
  return { fileDate, bySingleton };
}
