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

describe('scrubEmails address bounds', () => {
  it('still removes an address whose local part runs past 64 characters', () => {
    const out = scrubEmails(`${'x'.repeat(100)}@example.org`);
    expect(out).not.toContain('@');
    expect(out.endsWith(EMAIL_PLACEHOLDER)).toBe(true);
  });

  it('removes an address with a seven-label domain', () => {
    expect(scrubEmails('person@a.b.c.d.e.f.example.org')).toBe(EMAIL_PLACEHOLDER);
  });
});

describe('linear-time scanning', () => {
  const N = 100_000;

  /**
   * Runs `fn` three times and returns its result with the CPU milliseconds (user
   * plus system) of the fastest run. CPU time leaves out the time the process
   * spends descheduled, so a loaded machine cannot fail a linear scan, while a
   * quadratic one still costs seconds of CPU.
   */
  function timed<T>(fn: () => T): [T, number] {
    const runs = [1, 2, 3].map(() => {
      const started = process.cpuUsage();
      const result = fn();
      const { user, system } = process.cpuUsage(started);
      return { result, ms: (user + system) / 1_000 };
    });
    const fastest = runs.reduce((best, run) => (run.ms < best.ms ? run : best));
    return [fastest.result, fastest.ms];
  }

  it.each([
    ['a run of local-part characters before a lone "@"', `${'a'.repeat(N)} @`],
    ['an address whose domain is a run of one-letter labels', `a@${'a.'.repeat(N / 2)}1`],
  ])('scrubEmails reads %s (100,000 characters) in under 250 ms of CPU', (_label, text) => {
    const [out, ms] = timed(() => scrubEmails(text));
    expect(out).toBe(text);
    expect(ms).toBeLessThan(250);
  });

  it.each([
    ['a run of local-part characters before a lone "&"', `${'a'.repeat(N)}&`],
    ['a run of local-part characters before a lone "@"', `${'a'.repeat(N)} @`],
    ['an "&" address whose domain is a run of one-letter labels', `a&${'a.'.repeat(N / 2)}1`],
  ])('hasEmailToken reads %s (100,000 characters) in under 250 ms of CPU', (_label, text) => {
    const [found, ms] = timed(() => hasEmailToken(text));
    expect(found).toBe(false);
    expect(ms).toBeLessThan(250);
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
