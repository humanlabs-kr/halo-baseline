import { CoverSheet } from '@/components/ledger/CoverSheet';
import { TopBar } from '@/components/ledger/TopBar';

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
    </div>
  );
}
