import { CoverSheet } from '@/components/ledger/CoverSheet';
import { Positions, type Position } from '@/components/ledger/Positions';
import { TopBar } from '@/components/ledger/TopBar';

/**
 * Every state the positions list has, side by side.
 *
 * Rendering only the happy one is how `frozen` ships as a dead button with no
 * explanation beside it — the state nobody builds a fixture for is the state
 * nobody looks at.
 */
const POSITIONS: Position[] = [
  {
    marketId: '0x1', itemName: 'Rice', currency: 'JPY', cover: 4000,
    strikeBps: 500, capBps: 1500, settledBps: null, payout: null, status: 'open',
  },
  {
    marketId: '0x2', itemName: 'Bread', currency: 'JPY', cover: 2000,
    strikeBps: 300, capBps: 1200, settledBps: null, payout: null,
    status: 'frozen', opensAt: '1 Oct',
  },
  {
    marketId: '0x3', itemName: 'Eggs', currency: 'JPY', cover: 8000,
    strikeBps: 500, capBps: 1500, settledBps: 1100, payout: 4800, status: 'settled',
  },
  {
    marketId: '0x4', itemName: 'Cooking oil', currency: 'JPY', cover: 4000,
    strikeBps: 500, capBps: 1500, settledBps: 200, payout: 0, status: 'redeemed',
  },
];

/**
 * A harness for looking at CoverSheet without a wallet, a market or a session.
 *
 * Every screen in this app is supposed to be seen before it is called done,
 * and the cover flow is the one screen that cannot be reached without an
 * on-chain position — so without this it would be the one screen nobody ever
 * looks at. The terms below are the ones from the design: ¥4,000 of cover on
 * rice, +5% to +15%, priced at 0.30.
 *
 * Mounted only under `import.meta.env.DEV`, so it does not ship.
 */
export default function CoverPreview() {
  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar title="Cover" back fallback="/ledger" />
      <CoverSheet
        terms={{ cover: 4000, strikeBps: 500, capBps: 1500, priceHigh: 0.3 }}
        currency="JPY"
        itemName="rice"
        months={3}
        onConfirm={(cover) => console.info('confirm', cover)}
      />

      <div className="mt-6 border-t border-[#F2F4F6] pt-4">
        <p className="px-5 pb-2 text-[14px] font-medium text-[#8B95A1]">Positions — all states</p>
        <Positions positions={POSITIONS} onRedeem={(id) => console.info('redeem', id)} />
      </div>
    </div>
  );
}
