/**
 * @fileoverview Exact registry cell equality and numeric range containment, preserving byte widths.
 * @module services/registry/value-matcher
 */

const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();
const unpadded = (digits: string) => digits.replace(/^0+(?=.)/, '');
const INTEGER = /^-?\d+$/;
const DECIMAL_RANGE = /^(-?\d+)(?:-|to)(-?\d+)$/;
const HEX_RANGE = /^0x([0-9a-f]+)-0x([0-9a-f]+)$/;
const HEX_TOKEN = /^0x[0-9a-f]+$/i;
const BARE_HEX = /^[0-9a-f]+$/;
const BARE_HEX_RANGE = /^([0-9a-f]+)-([0-9a-f]+)$/;
const BYTE_RANGE =
  /^0x([0-9a-f]{2})(?:-(?:0x)?([0-9a-f]{2}))?(?: ?, ?| )(?:\*|0x([0-9a-f]{2})(?:-(?:0x)?([0-9a-f]{2}))?)$/i;

/** Compares normalized unsigned digits in either decimal or hexadecimal radix. */
function unsignedCompare(left: string, right: string): number {
  const a = unpadded(left);
  const b = unpadded(right);
  return a.length === b.length ? (a === b ? 0 : a < b ? -1 : 1) : a.length < b.length ? -1 : 1;
}

/** Orders signed decimal integers without parsing registry-sized endpoints. */
function integerCompare(left: string, right: string): number {
  const a = left.startsWith('-') ? unpadded(left.slice(1)) : unpadded(left);
  const b = right.startsWith('-') ? unpadded(right.slice(1)) : unpadded(right);
  const negativeA = left.startsWith('-') && a !== '0';
  const negativeB = right.startsWith('-') && b !== '0';
  if (negativeA !== negativeB) return negativeA ? -1 : 1;
  return unsignedCompare(a, b) * (negativeA ? -1 : 1);
}

/** Hex tokens joined as written; a single token retains scalar numeric semantics. */
function hexForm(text: string): { digits: string; single: boolean } | undefined {
  let body = text.trim();
  if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1).trim();
  const tokens = body.split(/\s*,\s*|\s+/);
  if (!tokens.every((token) => HEX_TOKEN.test(token))) return;
  return {
    digits: tokens
      .map((token) => token.slice(2))
      .join('')
      .toLowerCase(),
    single: tokens.length === 1,
  };
}

/** Builds one query matcher; bare hexadecimal interpretation requires an established column context. */
export function valueMatcher(
  value: string,
  bareHex = false,
  ranges = true,
): (cell: string | undefined) => boolean {
  const wanted = squash(value);
  const hex = hexForm(value);
  const scalarHex = hex?.single ? hex.digits : undefined;
  const decimal = INTEGER.test(wanted)
    ? wanted
    : scalarHex === undefined || bareHex
      ? undefined
      : BigInt(`0x${scalarHex}`).toString();
  return (cell) => {
    if (cell === undefined) return false;
    const key = squash(cell);
    if (key === wanted) return true;
    if (bareHex && scalarHex !== undefined) {
      if (BARE_HEX.test(key)) return unsignedCompare(key, scalarHex) === 0;
      const range = ranges ? BARE_HEX_RANGE.exec(key) : null;
      if (range?.[1] !== undefined && range[2] !== undefined) {
        return (
          unsignedCompare(range[1], scalarHex) <= 0 && unsignedCompare(scalarHex, range[2]) <= 0
        );
      }
    }
    if (decimal !== undefined) {
      if (INTEGER.test(key)) return integerCompare(key, decimal) === 0;
      if (ranges) {
        const range = DECIMAL_RANGE.exec(key);
        if (
          range?.[1] !== undefined &&
          range[2] !== undefined &&
          integerCompare(range[1], decimal) <= 0 &&
          integerCompare(decimal, range[2]) <= 0
        )
          return true;
        for (const [prefix, direction] of [
          ['lessthan', -1],
          ['greaterthan', 1],
        ] as const) {
          if (key.startsWith(prefix)) {
            const bound = key.slice(prefix.length);
            if (INTEGER.test(bound) && integerCompare(decimal, bound) === direction) return true;
          }
        }
      }
    }
    if (!hex) return false;
    const form = hexForm(cell);
    if (form) {
      return scalarHex !== undefined && form.single
        ? unsignedCompare(form.digits, scalarHex) === 0
        : form.digits === hex.digits;
    }
    if (!ranges) return false;
    if (hex.digits.length === 4) {
      let body = cell.trim();
      if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1).trim();
      const pair = BYTE_RANGE.exec(body.replace(/\s+/g, ' '));
      if (pair?.[1] !== undefined) {
        const high = hex.digits.slice(0, 2);
        const low = hex.digits.slice(2);
        return (
          unsignedCompare(pair[1].toLowerCase(), high) <= 0 &&
          unsignedCompare(high, (pair[2] ?? pair[1]).toLowerCase()) <= 0 &&
          (pair[3] === undefined ||
            (unsignedCompare(pair[3].toLowerCase(), low) <= 0 &&
              unsignedCompare(low, (pair[4] ?? pair[3]).toLowerCase()) <= 0))
        );
      }
    }
    if (scalarHex === undefined) return false;
    const range = HEX_RANGE.exec(key);
    return (
      range?.[1] !== undefined &&
      range[2] !== undefined &&
      unsignedCompare(range[1], scalarHex) <= 0 &&
      unsignedCompare(scalarHex, range[2]) <= 0
    );
  };
}
