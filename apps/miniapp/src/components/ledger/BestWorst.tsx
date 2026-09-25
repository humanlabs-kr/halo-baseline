import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Amount, useMoneyText } from '@/components/ledger/Amount';
import { Chip } from '@/components/ui/Chip';
import { GroupHead } from '@/components/ui/Row';
import { categoryName, unitEach } from '@/lib/basket';
import type { ComparedLine, MonthSummary } from '@/lib/api/ledger';

/**
 * The one thing bought well this month and the one bought badly.
 *
 * A month that nets to nothing is not a month where nothing happened: it is
 * usually one item well bought and one badly, and those two are the only part
 * of a comparison a shopper can do anything with next time. The netted figure
 * is already at the top of the screen; this says what it was made of.
 *
 * The line is printed as it was printed on the paper — "햇반 백미 5KG", not
 * "rice" — because recognising your own receipt is what makes the number
 * believable.
 */
export function BestWorst({
  comparison,
  currency,
}: {
  comparison: NonNullable<MonthSummary['comparison']>;
  currency: string;
}) {
  const { t } = useTranslation();

  return (
    <section>
      <GroupHead title={t('Against everyone else')} />
      <div className="flex gap-2.5 px-5">
        {comparison.best && <Tile line={comparison.best} currency={currency} kind="best" />}
        {comparison.worst && <Tile line={comparison.worst} currency={currency} kind="worst" />}
      </div>
      {/* What the two tiles are drawn from. Without it the pair reads as a
          claim about the whole basket, and most of a basket is still lines we
          have no price for. */}
      <p className="px-5 pt-3 text-[12.5px] font-medium text-[#8B95A1]">
        {comparison.unmatched === 0
          ? t('Compared {{matched}} items', { matched: comparison.matched })
          : t('Compared {{matched}} items · {{unmatched}} not yet', {
              matched: comparison.matched,
              unmatched: comparison.unmatched,
            })}
      </p>
    </section>
  );
}

function Tile({
  line,
  currency,
  kind,
}: {
  line: ComparedLine;
  currency: string;
  kind: 'best' | 'worst';
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const money = useMoneyText();
  const saved = kind === 'best';

  return (
    <button
      type="button"
      onClick={() => navigate(`/ledger/item/${line.category}`)}
      className={`pressed min-w-0 flex-1 rounded-[18px] px-4 py-[15px] text-left ${
        saved ? 'bg-[#F0FAF6]' : 'bg-[#FFF4F5]'
      }`}
    >
      <b
        className={`block text-[12.5px] font-bold tracking-[-.02em] ${
          saved ? 'text-[#00A06A]' : 'text-[#F04452]'
        }`}
      >
        {saved ? t('Best buy') : t('Worst buy')}
      </b>
      <b className="mt-1.5 block break-keep text-[15px] leading-[1.3] font-bold tracking-[-.03em]">
        {line.rawText}
      </b>
      <span className="mt-1 block text-[12.5px] font-medium tabular-nums text-[#8B95A1]">
        {unitEach(line.unit, t)} <Amount value={line.unitPrice} currency={currency} />
      </span>
      <span className="mt-2.5 block">
        <Chip size="sm" tone={saved ? 'saved' : 'over'}>
          {saved
            ? t('{{amount}} cheaper', { amount: money(Math.abs(line.gap), currency) })
            : t('{{amount}} dearer', { amount: money(Math.abs(line.gap), currency) })}
        </Chip>
      </span>
      <span className="sr-only">{categoryName(line.category, t)}</span>
    </button>
  );
}
