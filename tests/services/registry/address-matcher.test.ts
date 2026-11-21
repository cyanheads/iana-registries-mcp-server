/**
 * @fileoverview Address matching against IANA registry cells.
 * @module tests/services/registry/address-matcher.test
 */

import { describe, expect, it } from 'vitest';
import { addressMatcher, isKnownAddressColumn } from '@/services/registry/address-matcher.js';
import { valueMatcher } from '@/services/registry/value-matcher.js';

describe('literal registry matching', () => {
  it('retains dotted OIDs, complete ranges and wildcard text as literals', () => {
    expect(valueMatcher('2.5.23.3')('2.5.23.3')).toBe(true);
    expect(valueMatcher('2.5.23.3')('2.5.23.4')).toBe(false);
    expect(valueMatcher('224.0.0.153-224.0.0.250')('224.0.0.153 - 224.0.0.250')).toBe(true);
    expect(valueMatcher('FF0X:0:0:0:0:0:0:1')('ff0x:0:0:0:0:0:0:1')).toBe(true);
  });
});

describe('address matching', () => {
  it.each(['10', '10/8', '010/8', '10.0.0.0/8'])('recognizes %s as the 010/8 block', (query) => {
    const match = addressMatcher('ipv4-address-space', 'prefix', query);
    expect(match?.('010/8')).toEqual({ span: 16_777_216n, exact: true });
    expect(match?.('011/8')).toBeUndefined();
  });

  it('limits an octet shorthand query to actual /8 cells', () => {
    const match = addressMatcher('ipv4-address-space', 'prefix', '010');
    expect(match?.('010/8')).toEqual({ span: 16_777_216n, exact: true });
    expect(match?.('10.0.0.0/8')).toEqual({ span: 16_777_216n, exact: true });
    expect(match?.('010')).toBeUndefined();
    expect(match?.('0.0.0.0/0')).toBeUndefined();
    expect(match?.('10.0.0.0-10.255.255.255')).toBeUndefined();
    expect(addressMatcher('new-table', 'prefix', '010/8')).toBeUndefined();
  });

  it('finds the /8 allocation for a point without treating every point as exact', () => {
    const match = addressMatcher('ipv4-address-space', 'prefix', '10.1.2.3');
    expect(match?.('010/8')).toEqual({ span: 16_777_216n, exact: false });
  });

  it('orders overlapping prefix sizes and chooses the matching member of a list', () => {
    const match = addressMatcher('iana-ipv4-special-registry-1', 'address', '192.0.0.1');
    expect(match?.('192.0.0.0/24')).toEqual({ span: 256n, exact: false });
    expect(match?.('192.0.0.0/29')).toEqual({ span: 8n, exact: false });
    expect(match?.('192.0.0.0/24, 192.0.0.1/32')).toEqual({ span: 1n, exact: true });
    expect(match?.('192.0.0.170/32, 192.0.0.171/32')).toBeUndefined();
    const discovery = addressMatcher('iana-ipv4-special-registry-1', 'address', '192.0.0.170');
    expect(discovery?.('192.0.0.170/32, 192.0.0.171/32')).toEqual({ span: 1n, exact: true });
  });

  it('requires full prefix containment and masks host bits on both sides', () => {
    const match = addressMatcher('iana-ipv4-special-registry-1', 'address', '192.168.1.7/23');
    expect(match?.('192.168.0.0/24')).toBeUndefined();
    expect(match?.('192.168.0.0/24, 192.168.1.0/24')).toBeUndefined();
    expect(match?.('192.168.1.23/23')).toEqual({ span: 512n, exact: true });
    expect(match?.('192.168.0.0/16')).toEqual({ span: 65_536n, exact: false });
    expect(match?.('0.0.0.0/0')).toEqual({ span: 4_294_967_296n, exact: false });
  });

  it.each([
    ['224.0.0.152', undefined],
    ['224.0.0.153', 98n],
    ['224.0.0.200', 98n],
    ['224.0.0.250', 98n],
    ['224.0.0.251', undefined],
  ])('checks inclusive multicast bounds for %s', (query, span) => {
    const match = addressMatcher('multicast-addresses-1', 'addr', query);
    expect(match?.('224.0.0.153 - 224.0.0.250')?.span).toBe(span);
    expect(match?.('224.0.0.250-224.0.0.153')).toBeUndefined();
  });

  it('normalizes IPv6 spelling and compares the full 128-bit interval', () => {
    const prefix = addressMatcher('iana-ipv6-special-registry-1', 'address', '2001:0db8::/32');
    expect(prefix?.('2001:db8::/32')).toEqual({ span: 1n << 96n, exact: true });
    const point = addressMatcher('iana-ipv6-special-registry-1', 'address', '2001:db8::1');
    expect(point?.('2001:db8::/32')).toEqual({ span: 1n << 96n, exact: false });
    expect(point?.('::/0')).toEqual({ span: 1n << 128n, exact: false });
    expect(point?.('2001:db8::2')).toBeUndefined();
    expect(point?.('192.0.0.0/24')).toBeUndefined();
  });

  it('compares IPv6 singleton, embedded IPv4 and explicit multicast range forms', () => {
    const match = addressMatcher('link-local', 'addr', 'ff02::1', 'ipv6-multicast-addresses');
    expect(match?.('FF02:0:0:0:0:0:0:1')).toEqual({ span: 1n, exact: true });
    expect(match?.('FF0X:0:0:0:0:0:0:1')).toBeUndefined();
    const range = addressMatcher('link-local', 'addr', 'ff02::101', 'ipv6-multicast-addresses');
    expect(range?.('FF02:0:0:0:0:0:0:100-FF02:0:0:0:0:0:0:179')).toEqual({
      span: 122n,
      exact: false,
    });
    expect(range?.('FF02:0:0:0:0:0:100-FF02:0:0:0:0:0:179')).toBeUndefined();
    const mapped = addressMatcher('iana-ipv6-special-registry-1', 'address', '::ffff:192.0.2.1');
    expect(mapped?.('::FFFF:C000:201/128')).toEqual({ span: 1n, exact: true });
  });

  it('scopes address semantics to the correct table, field and family', () => {
    expect(addressMatcher('ldap-parameters-3', 'value', '2.5.23.3')).toBeUndefined();
    expect(
      addressMatcher('ipv4-recovered-address-space-1', 'start', '160.20.241.0'),
    ).toBeUndefined();
    expect(addressMatcher('iana-ipv4-special-registry-1', 'name', '10.1.2.3')).toBeUndefined();
    expect(addressMatcher('iana-ipv4-special-registry-1', 'address', '::1')).toBeUndefined();
    expect(isKnownAddressColumn('link-local', 'addr', 'unrelated')).toBe(false);
    expect(isKnownAddressColumn('link-local', 'addr', 'ipv6-multicast-addresses')).toBe(true);
    const global = addressMatcher('ipv6-unicast-address-assignments', 'prefix', '2001::1');
    expect(global?.('2001::/23')?.span).toBe(1n << 105n);
  });

  it('matches full IP blocks in address-bearing fields of unfamiliar tables', () => {
    const match = addressMatcher('new-table', 'prefix', '198.51.100.1');
    expect(match?.('198.51.100.0/24')).toEqual({ span: 256n, exact: false });
    expect(match?.('198.51.100.0/24, wildcard')).toBeUndefined();
    expect(match?.('2001:db8::/32')).toBeUndefined();
    expect(match?.('iana-bfd-types')).toBeUndefined();
    expect(isKnownAddressColumn('new-table', 'prefix')).toBe(false);
  });

  it.each(['999.1.1.1', '1.2.3', '010.0.0.1', '10.0.0.0/33', '10.0.0.0/', '10', ''])(
    'leaves invalid nonlegacy IPv4 input %s to the literal matcher',
    (value) => {
      expect(addressMatcher('iana-ipv4-special-registry-1', 'address', value)).toBeUndefined();
    },
  );

  it.each([':::', '1::2::3', '::zzzz', '::/129', 'ff02::1%eth0', '::ffff:999.0.2.1'])(
    'leaves invalid IPv6 input %s to the literal matcher',
    (value) => {
      expect(addressMatcher('iana-ipv6-special-registry-1', 'address', value)).toBeUndefined();
    },
  );
});
