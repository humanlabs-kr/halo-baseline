import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Amount, countryName } from '@/components/ledger/Amount';
import { Chip } from '@/components/ui/Chip';
import { Row, RowRule, GroupHead } from '@/components/ui/Row';
import { Button } from '@/components/ui/Button';
import { categoryName, unitEach } from '@/lib/basket';
import { useMarketBoard } from '@/lib/api/queries';
import { useFormatters } from '@/lib/format';
import { categoryIcon, categoryTone } from '@/components/ledger/category-icon';
import type { MarketItem } from '@/lib/api/ledger';

/**
 * What groceries cost around here, whether or not this person has scanned one.
 *
 * The home screen used to be 55% empty grey for anybody who had not uploaded a
 * receipt — a logo, one sentence and a button. That emptiness was never
 * necessary: the app is sitting on a price index built from more than a
 * million receipts and was showing none of it. This is the part of the screen
 * that is useful on day zero, and it is also the argument for scanning, since
 * one photograph is all it takes to be placed against these numbers.
 *
 * Where a country has no corpus yet the same rows show the distance to one.
 * A progress bar toward twenty receipts is a fact about the data rather than
 * an apology for it, and it is the only honest version of "not yet".
 */
export function MarketBoard({ hasReceipts, currency }: { hasReceipts: boolean; currency: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormatters();
  const { data } = useMarketBoard();

  if (!data || data.country === null || data.items.length === 0) return null;

  const priced = data.items.filter((item) => item.unitPrice !== null);
  const collecting = data.items.filter((item) => item.unitPrice === null);
  const showing = priced.length > 0 ? priced : collecting;
  const money = data.currency ?? currency;
  const country = countryName(data.country, fmt.lang);

  return (
    <section>
      <GroupHead
        title={priced.length > 0 ? t('Prices in {{country}}', { country }) : t('Collecting prices in {{country}}', { country })}
        trailing={
          priced.length > 0 ? t('{{count}} receipts', { count: fmt.compact(data.receipts) }) : undefined
        }
      />
      <p className="px-5 pb-2 text-[13px] font-medium leading-[1.5] text-[#8B95A1]">
        {priced.length > 0
          ? t('Read from receipts photographed in {{country}} over the last six months', { country })
          : t('A price appears once twenty receipts carry the item')}
      </p>

      {showing.slice(0, 5).map((item, index) => (
        <div key={item.category}>
          {index > 0 && <RowRule />}
          {item.unitPrice === null ? (
            <Collecting item={item} t={t} />
          ) : (
            <Row
              icon={categoryIcon(item.category)}
              tone={categoryTone(item.category)}
              title={categoryName(item.category, t)}
              caption={unitEach(item.unit, t)}
              right={
                <>
                  <b className="block text-[16px] font-bold tracking-[-.03em]">
                    <Amount value={item.unitPrice} currency={money} />
                  </b>
                  {item.change !== null && (
                    <div className="mt-[5px]">
                      <Chip size="sm" tone={item.change > 0 ? 'over' : item.change < 0 ? 'saved' : 'neutral'}>
                        {item.change === 0
                          ? t('unchanged')
                          : `${Math.abs(item.change * 100).toFixed(1)}% ${item.change > 0 ? '↑' : '↓'}`}
                      </Chip>
                    </div>
                  )}
                </>
              }
              onClick={hasReceipts ? () => navigate(`/ledger/item/${item.category}`) : undefined}
            />
          )}
        </div>
      ))}

      {showing.length > 5 && (
        <div className="px-5 pt-3.5">
          <Button variant="ghost" onClick={() => navigate('/ledger/market')}>
            {t('See all {{count}} items', { count: showing.length })}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * A category that cannot be priced yet, shown as the distance to twenty.
 *
 * The bar is the content. "No data" is a shrug; "14 of 20" is a number that
 * moves when somebody scans, including the person reading it.
 */
function Collecting({ item, t }: { item: MarketItem; t: ReturnType<typeof useTranslation>['t'] }) {
  const target = item.observations + item.needed;
  const share = target === 0 ? 0 : Math.min(100, (item.observations / target) * 100);

  return (
    <div className="flex items-center gap-3.5 bg-white px-5 py-[15px]">
      <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[14px] bg-[#F2F4F6] text-[#8B95A1]">
        {categoryIcon(item.category)}
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[16px] font-bold tracking-[-.03em]">{categoryName(item.category, t)}</b>
        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-[#F2F4F6]">
          <i className="block h-full rounded-full bg-[#B0B8C1]" style={{ width: `${share}%` }} />
        </span>
      </span>
      <span className="shrink-0 text-[14px] font-bold tabular-nums text-[#8B95A1]">
        {item.observations}
        <span className="text-[#C4CBD3]">/{target}</span>
      </span>
    </div>
  );
}
