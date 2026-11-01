/**
 * @fileoverview Cost and edge cases for registry value matching.
 * @module tests/services/registry/value-matcher.test
 */

import { describe, expect, it } from 'vitest';
import { valueMatcher } from '@/services/registry/value-matcher.js';

describe('value matcher column context', () => {
  it('retains prefixed hex cells alongside established bare hex cells', () => {
    const match = valueMatcher('0xC021', true);
    expect(match('c021')).toBe(true);
    expect(match('0xc021')).toBe(true);
    expect(match('0xc000-0xc100')).toBe(true);
  });
});

describe('value matcher scanner timing', () => {
  const shapes = [
    { name: 'digits', size: 320_000, make: (n: number) => '9'.repeat(n) },
    { name: 'openers', size: 80_000, make: (n: number) => '{'.repeat(n) },
    {
      name: 'nested openers',
      size: 80_000,
      make: (n: number) => `${'{0x'.repeat(Math.floor(n / 4))}${'}'.repeat(Math.floor(n / 4))}`,
    },
    {
      name: 'overlapping prefixes',
      size: 80_000,
      make: (n: number) => '0x0'.repeat(Math.ceil(n / 3)).slice(0, n),
    },
    {
      name: 'terminal line break',
      size: 80_000,
      make: (n: number) => `${'0x x'.repeat(n / 4)}\ny`,
    },
    { name: 'line breaks throughout', size: 80_000, make: (n: number) => '  \r\n'.repeat(n / 4) },
  ];
  it.each(shapes)('bounds $name matching CPU', ({ name, size, make }) => {
    const match = valueMatcher('-5');
    const matchHex = valueMatcher('0x0050');
    let first = 0;
    let last = 0;
    for (let n = 5_000; n <= size; n *= 2) {
      const cell = make(n);
      match(cell);
      const start = process.threadCpuUsage();
      for (let repeat = 0; repeat < 10; repeat++) {
        expect(match(cell)).toBe(false);
        expect(matchHex(cell)).toBe(false);
      }
      const cpu = process.threadCpuUsage(start);
      last = cpu.user + cpu.system;
      expect(last).toBeLessThan(500_000);
      if (n === 5_000) first = last;
    }
    if (name === 'digits') expect(last / Math.max(first, 1)).toBeLessThan(256);
  });

  it('bounds signed range and hexadecimal endpoint scans', () => {
    for (let n = 5_000; n <= 320_000; n *= 2) {
      const decimal = `-${'9'.repeat(n)} to -1`;
      const hexadecimal = `0x1-0x${'f'.repeat(n)}`;
      const matchDecimal = valueMatcher('-5');
      const matchHex = valueMatcher('0x05');
      const start = process.threadCpuUsage();
      expect(matchDecimal(decimal)).toBe(true);
      expect(matchHex(hexadecimal)).toBe(true);
      const cpu = process.threadCpuUsage(start);
      expect(cpu.user + cpu.system).toBeLessThan(100_000);
    }
  });
});
