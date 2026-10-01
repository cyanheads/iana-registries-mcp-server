/**
 * @fileoverview Tests for email-shaped token handling: the scrub and the
 * PEN withhold check.
 */

import { describe, expect, it } from 'vitest';
import {
  EMAIL_PLACEHOLDER,
  hasEmailToken,
  scrubEmails,
} from '@/services/registry/personal-data.js';

describe('scrubEmails', () => {
  it('replaces an @-form address', () => {
    expect(scrubEmails('write to person@example.org today')).toBe(
      `write to ${EMAIL_PLACEHOLDER} today`,
    );
  });

  it('replaces every address in a string', () => {
    expect(scrubEmails('a@example.org, b.c+tag@mail.example.org')).toBe(
      `${EMAIL_PLACEHOLDER}, ${EMAIL_PLACEHOLDER}`,
    );
  });

  it('replaces a mailto: URI up to the next delimiter', () => {
    expect(scrubEmails('see mailto:person@example.org?subject=x for more')).toBe(
      `see ${EMAIL_PLACEHOLDER} for more`,
    );
    expect(scrubEmails('(mailto:person@example.org)')).toBe(`(${EMAIL_PLACEHOLDER})`);
  });

  it('matches case-insensitively', () => {
    expect(scrubEmails('MAILTO:X@EXAMPLE.ORG')).toBe(EMAIL_PLACEHOLDER);
    expect(scrubEmails('Person@Example.ORG')).toBe(EMAIL_PLACEHOLDER);
  });

  it('leaves text without an address untouched', () => {
    expect(scrubEmails('plain text, 3 @ 5, @handle, user@localhost')).toBe(
      'plain text, 3 @ 5, @handle, user@localhost',
    );
    expect(scrubEmails('')).toBe('');
  });

  it('is idempotent', () => {
    const once = scrubEmails('x person@example.org y');
    expect(scrubEmails(once)).toBe(once);
  });

  it('keeps a YANG module file name (<module>@YYYY-MM-DD.yang)', () => {
    const link =
      'https://www.iana.org/assignments/yang-parameters/example-yang-algs@2026-09-01.yang';
    expect(scrubEmails(`Module file: ${link}.`)).toBe(`Module file: ${link}.`);
    expect(scrubEmails('example-module@2026-01-01.yang')).toBe('example-module@2026-01-01.yang');
  });

  it('still scrubs an address beside a YANG file name, and one whose domain only starts like one', () => {
    expect(scrubEmails('example-module@2026-01-01.yang or person@example.org')).toBe(
      `example-module@2026-01-01.yang or ${EMAIL_PLACEHOLDER}`,
    );
    expect(scrubEmails('a@2026-01-01.yang.example.org')).toBe(EMAIL_PLACEHOLDER);
    expect(scrubEmails('a@26-01-01.yang')).toBe(EMAIL_PLACEHOLDER);
    expect(scrubEmails('mailto:a@2026-01-01.yang')).toBe(EMAIL_PLACEHOLDER);
  });
});

describe('hasEmailToken', () => {
  it.each([
    ['Example Org, Example Person person@example.org', true],
    ['Example Org, Example Person person&example.org', true],
    ['person&mail.example.org', true],
    ['Example Org & Partners', false],
    ['AT&T', false],
    ['Example Org (example.org)', false],
    ['Reserved', false],
    ['', false],
  ])('%j → %s', (text, expected) => {
    expect(hasEmailToken(text)).toBe(expected);
  });
});
