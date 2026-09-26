import { describe, expect, it } from 'vitest';

import { itemKeyOf } from '../lib/matched-index/identity';
import type { Observation } from '../lib/matched-index/relatives';
import {
  buildSnapshot,
  CURRENT_RULES,
  merkleRoot,
  rulesHash,
  serialiseLeaf,
  toLeaves,
} from '../lib/matched-index/snapshot';

function obs(shop: string, item: string, person: string, price: number, ms = 1_760_000_000_000): Observation {
  const key = itemKeyOf(shop, item)!;
  return { key, person, price, expenditure: price, at: new Date(ms) };
}

describe('rulesHash', () => {
  it('is stable across key ordering, so the same rules hash the same', () => {
    const reordered = { ...CURRENT_RULES };
    expect(rulesHash(reordered)).toBe(rulesHash(CURRENT_RULES));
  });

  it('changes when any parameter changes, which is what makes it a commitment', () => {
    expect(rulesHash({ ...CURRENT_RULES, trim: 0.1 })).not.toBe(rulesHash(CURRENT_RULES));
    expect(rulesHash({ ...CURRENT_RULES, minPeople: 31 })).not.toBe(rulesHash(CURRENT_RULES));
  });

  /**
   * The window is cut on upload time, not the printed date.
   *
   * The archive holds receipts bought recently and uploaded long after, and
   * the printed date cannot tell those apart — so cutting on it lets anyone
   * move a closed period by uploading old paper into it. No forgery, no sybil,
   * just a shoebox.
   */
  it('commits to cutting the window on upload time', () => {
    expect(CURRENT_RULES.windowField).toBe('uploadedAt');
  });
});

describe('toLeaves', () => {
  it('sorts, so the root does not depend on map iteration order', () => {
    const a = toLeaves([obs('Shop B', 'Rice', 'p1', 100), obs('Shop A', 'Rice', 'p2', 200)], 'JPY');
    const b = toLeaves([obs('Shop A', 'Rice', 'p2', 200), obs('Shop B', 'Rice', 'p1', 100)], 'JPY');
    expect(a.map(serialiseLeaf)).toEqual(b.map(serialiseLeaf));
  });

  it('carries no identity, because the set is published', () => {
    const [leaf] = toLeaves([obs('Shop', 'Rice', 'alice', 100)], 'JPY');
    expect(Object.keys(leaf!)).not.toContain('person');
    expect(JSON.stringify(leaf)).not.toContain('alice');
  });

  it('stores minor units, so nothing crosses the wire as a float', () => {
    const [leaf] = toLeaves([obs('Shop', 'Rice', 'p1', 123.45)], 'JPY');
    expect(leaf!.priceMinor).toBe(12_345);
  });
});

describe('merkleRoot', () => {
  it('is reproducible from the same leaves', () => {
    const leaves = toLeaves([obs('S', 'A', 'p1', 1), obs('S', 'B', 'p2', 2)], 'JPY');
    expect(merkleRoot(leaves)).toBe(merkleRoot(leaves));
  });

  it('changes when any leaf changes, which is the point of committing to it', () => {
    const one = toLeaves([obs('S', 'A', 'p1', 100), obs('S', 'B', 'p2', 200)], 'JPY');
    const two = toLeaves([obs('S', 'A', 'p1', 101), obs('S', 'B', 'p2', 200)], 'JPY');
    expect(merkleRoot(one)).not.toBe(merkleRoot(two));
  });

  /**
   * An omitted leaf changes the root, which is what makes censorship visible.
   *
   * It is the published leaf *set* that proves this, not the root alone — but
   * the root has to move, or dropping an observation would be free.
   */
  it('changes when a leaf is dropped', () => {
    const full = toLeaves(
      [obs('S', 'A', 'p1', 100), obs('S', 'B', 'p2', 200), obs('S', 'C', 'p3', 300)],
      'JPY',
    );
    expect(merkleRoot(full)).not.toBe(merkleRoot(full.slice(0, 2)));
  });

  it('carries an odd node up rather than duplicating it', () => {
    // Duplicating the last leaf is the classic second-preimage foothold: two
    // different sets collapsing to one root. Three leaves and four where the
    // fourth is a copy of the third must not agree.
    const three = toLeaves(
      [obs('S', 'A', 'p1', 100), obs('S', 'B', 'p2', 200), obs('S', 'C', 'p3', 300)],
      'JPY',
    );
    const fourWithDupe = [...three, three[2]!];
    expect(merkleRoot(three)).not.toBe(merkleRoot(fourWithDupe));
  });
});

describe('buildSnapshot', () => {
  it('counts people without listing them', () => {
    const snap = buildSnapshot(
      [
        obs('S', 'A', 'alice', 100),
        obs('S', 'A', 'bob', 110),
        obs('S', 'B', 'alice', 200),
      ],
      'JPY',
    );
    expect(snap.people).toBe(2);
    expect(snap.outlets).toBe(1);
    expect(JSON.stringify(snap.leaves)).not.toContain('alice');
  });

  it('ships the rules hash alongside, so the two cannot drift apart', () => {
    const snap = buildSnapshot([obs('S', 'A', 'p1', 100)], 'JPY');
    expect(snap.rules).toBe(rulesHash());
  });
});
