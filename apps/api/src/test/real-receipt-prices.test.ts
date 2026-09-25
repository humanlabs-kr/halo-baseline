import { describe, expect, it } from 'vitest';
import { toCanonicalQuantity, unitPrice } from '../lib/receipt-processor/categories';

/**
 * Unit prices computed from values the vision model actually returned.
 *
 * The numbers below were read by the deployed model off rendered receipts in
 * three layouts — a Korean restaurant slip, a Korean supermarket table, and a
 * Nigerian column receipt — and pasted here unchanged. They are the output of
 * the step this file tests the input of, so if the prompt regresses on pack
 * sizes the fixture stops matching what the model produces and the mismatch is
 * caught upstream, in the extraction suite.
 *
 * What they guard: a pack size printed inside the product name multiplies by
 * the count column. `햇반 백미 5KG` bought once is five kilos, not one. The
 * model read it as one until the prompt said so, which made rice five times
 * too expensive — and that figure is pooled into the median every other
 * shopper is compared against.
 */
const REAL = [
  { name: '햇반 백미 5KG ×1 = ₩18,900', cat: 'rice', qty: 5, unit: 'kg', total: 18900, want: 3780 },
  { name: '식용유 1.8L ×2 = ₩18,800', cat: 'cooking_oil', qty: 3.6, unit: 'l', total: 18800, want: 18800 / 3.6 },
  { name: '계란 한판 30구 = ₩7,900', cat: 'eggs', qty: 1, unit: 'crate', total: 7900, want: 7900 },
  { name: 'MAMA GOLD RICE 5KG = ₦4,200', cat: 'rice', qty: 5, unit: 'kg', total: 4200, want: 840 },
  { name: 'KINGS OIL 1L = ₦3,900', cat: 'cooking_oil', qty: 1, unit: 'l', total: 3900, want: 3900 },
  { name: 'CRATE OF EGGS = ₦4,500', cat: 'eggs', qty: 1, unit: 'crate', total: 4500, want: 4500 },
] as const;

describe('추출값 → 단가', () => {
  for (const r of REAL) {
    it(r.name, () => {
      const p = unitPrice(r.cat as never, r.total, r.qty, r.unit as never);
      expect(p).not.toBeNull();
      expect(p!).toBeCloseTo(r.want, 2);
    });
  }

  it('수량을 잘못 읽었을 때 얼마나 틀리는가 (고치기 전 동작)', () => {
    const wrong = unitPrice('rice', 18900, 1, 'kg');   // 이전: 5KG 를 1kg 으로
    const right = unitPrice('rice', 18900, 5, 'kg');
    expect(wrong! / right!).toBe(5);
  });

  it('계란 piece 는 여전히 값을 못 매긴다', () => {
    // «6 EGGS» 같은 낱개 표기는 판 단위로 환산할 방법이 없다 — null 이 정답
    expect(toCanonicalQuantity('eggs', 6, 'piece')).toBeNull();
    expect(unitPrice('eggs', 1800, 6, 'piece')).toBeNull();
  });
});
