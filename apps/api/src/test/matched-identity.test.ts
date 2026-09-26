import { describe, expect, it } from 'vitest';

import {
  itemKeyOf,
  itemKeyString,
  normaliseItem,
  normaliseOutlet,
} from '../lib/matched-index/identity';

/**
 * These tests are the index's foundation, not a formatting check.
 *
 * Every pair that fails to collide here is a price relative that never forms,
 * and a series with no relatives publishes nothing. Every pair that collides
 * when it should not is mix drift walking back in through the front door.
 */
describe('normaliseItem', () => {
  it('folds full-width and half-width, which is one till versus another', () => {
    // The same bag of rice, printed by two different registers.
    expect(normaliseItem('コシヒカリ ５ｋｇ')).toBe(normaliseItem('コシヒカリ 5kg'));
  });

  it('folds half-width katakana, which older thermal printers still emit', () => {
    expect(normaliseItem('ｻﾗﾀﾞ油 1000g')).toBe(normaliseItem('サラダ油 1000g'));
  });

  it('drops the reduced-tax mark, which is a lane setting and not a product', () => {
    expect(normaliseItem('食パン 6枚切 *')).toBe(normaliseItem('食パン 6枚切'));
    expect(normaliseItem('食パン 6枚切 軽')).toBe(normaliseItem('食パン 6枚切'));
  });

  it('drops a leading line number or till code', () => {
    expect(normaliseItem('01. たまご Lサイズ10個')).toBe(normaliseItem('たまご Lサイズ10個'));
    expect(normaliseItem('4901234567890 たまご Lサイズ10個')).toBe(
      normaliseItem('たまご Lサイズ10個'),
    );
  });

  it('keeps the size token, because pack size is the product', () => {
    // Folding these together is exactly the mix drift the matched model removes.
    expect(normaliseItem('食パン 6枚切')).not.toBe(normaliseItem('食パン 8枚切'));
    expect(normaliseItem('コシヒカリ 5kg')).not.toBe(normaliseItem('コシヒカリ 10kg'));
  });

  it('is insensitive to case and to punctuation drift', () => {
    expect(normaliseItem('SUPREME COOKING OIL 5L')).toBe(normaliseItem('Supreme Cooking-Oil 5L'));
  });

  it('collapses whitespace runs', () => {
    expect(normaliseItem('洗濯洗剤   詰替  810g')).toBe(normaliseItem('洗濯洗剤 詰替 810g'));
  });

  it('returns empty for input with nothing left in it', () => {
    expect(normaliseItem('***')).toBe('');
    expect(normaliseItem('   ')).toBe('');
  });
});

describe('normaliseOutlet', () => {
  it('folds legal forms so one shop is not three outlets', () => {
    expect(normaliseOutlet('まいばすけっと株式会社')).toBe(normaliseOutlet('まいばすけっと'));
    expect(normaliseOutlet('Shoprite Co., Ltd.')).toBe(normaliseOutlet('Shoprite'));
  });

  it('keeps the branch, because two branches price differently', () => {
    expect(normaliseOutlet('まいばすけっと 神南店')).not.toBe(
      normaliseOutlet('まいばすけっと 渋谷店'),
    );
  });

  it('is empty for a receipt with no merchant', () => {
    expect(normaliseOutlet(null)).toBe('');
    expect(normaliseOutlet('')).toBe('');
  });
});

describe('itemKeyOf', () => {
  it('matches the same product at the same shop across receipts', () => {
    const a = itemKeyOf('まいばすけっと 神南店', 'コシヒカリ ５ｋｇ *');
    const b = itemKeyOf('まいばすけっと　神南店', 'コシヒカリ 5kg');
    expect(a).not.toBeNull();
    expect(itemKeyString(a!)).toBe(itemKeyString(b!));
  });

  it('does not match the same product at a different shop', () => {
    const a = itemKeyOf('まいばすけっと 神南店', 'コシヒカリ 5kg');
    const b = itemKeyOf('まいばすけっと 渋谷店', 'コシヒカリ 5kg');
    expect(itemKeyString(a!)).not.toBe(itemKeyString(b!));
  });

  it('is null when either half is missing, so it never enters the index', () => {
    expect(itemKeyOf(null, 'コシヒカリ 5kg')).toBeNull();
    expect(itemKeyOf('まいばすけっと', '***')).toBeNull();
  });
});
