import { describe, expect, it } from 'vitest';

import { decodeDnsName, epochToNumber, parseName } from '../lib/matched-index/ens-name';

/** Encode labels the way ENSIP-10 hands them to a resolver. */
function encode(name: string): Uint8Array {
  const labels = name.split('.');
  const parts: number[] = [];
  for (const label of labels) {
    const bytes = new TextEncoder().encode(label);
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0);
  return new Uint8Array(parts);
}

describe('decodeDnsName', () => {
  it('round-trips a name', () => {
    expect(decodeDnsName(encode('rice.jp.halo.eth'))).toEqual(['rice', 'jp', 'halo', 'eth']);
  });

  it('refuses a truncated name rather than guessing', () => {
    // A gateway that guesses at a broken name answers for a different one.
    expect(() => decodeDnsName(new Uint8Array([5, 0x72, 0x69]))).toThrow();
  });

  it('refuses an unterminated name', () => {
    expect(() => decodeDnsName(new Uint8Array([2, 0x6a, 0x70]))).toThrow();
  });

  it('refuses a label longer than DNS allows', () => {
    expect(() => decodeDnsName(new Uint8Array([64, ...new Array(64).fill(0x61), 0]))).toThrow();
  });
});

describe('parseName', () => {
  it('reads a country roll-up', () => {
    const p = parseName(decodeDnsName(encode('jp.halo.eth')));
    expect(p.country).toBe('JP');
    expect(p.item).toBeNull();
  });

  it('reads a series', () => {
    const p = parseName(decodeDnsName(encode('rice.jp.halo.eth')));
    expect(p.country).toBe('JP');
    expect(p.item).toBe('rice');
    expect(p.epoch).toBeNull();
  });

  it('reads an epoch', () => {
    const p = parseName(decodeDnsName(encode('2026q4.rice.jp.halo.eth')));
    expect(p.epoch).toBe('2026Q4');
    expect(p.item).toBe('rice');
    expect(p.country).toBe('JP');
  });

  it('reads a market, strike and all', () => {
    const p = parseName(decodeDnsName(encode('500bp.2026q4.rice.jp.halo.eth')));
    expect(p.strikeBps).toBe(500);
    expect(p.epoch).toBe('2026Q4');
    expect(p.item).toBe('rice');
    expect(p.country).toBe('JP');
  });

  /**
   * The index groups by country. A city label names a series that does not
   * exist, and putting one on a slide is how a judge finds out the naming was
   * invented rather than derived from the data.
   */
  it('does not accept a city where a country belongs', () => {
    const p = parseName(decodeDnsName(encode('rice.tokyo.halo.eth')));
    expect(p.country).toBeNull();
  });

  it('is case-insensitive, because names arrive normalised in either case', () => {
    const p = parseName(['RICE', 'JP', 'halo', 'eth']);
    expect(p.country).toBe('JP');
    expect(p.item).toBe('rice');
  });
});

describe('epochToNumber', () => {
  it('maps a quarter to the month that closes it', () => {
    expect(epochToNumber('2026Q4')).toBe(202612);
    expect(epochToNumber('2026Q1')).toBe(202603);
  });

  it('is null for anything else', () => {
    expect(epochToNumber(null)).toBeNull();
    expect(epochToNumber('2026Q5')).toBeNull();
  });
});
