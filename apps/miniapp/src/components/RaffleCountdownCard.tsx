import { useTranslation } from 'react-i18next';

/**
 * Time left in the current raffle round. Rounds close at UTC midnight; the
 * caller owns the ticking clock so this stays a pure display component.
 *
 * The heading says what the digits below are counting. It used to read
 * "Coming Soon" — a leftover from the Kaia build, which shipped this card
 * before its raffle existed — over a live, ticking clock.
 *
 * Reversed out in the product's near-black, like the points balance on the
 * rewards tab: an inversion marks the one thing on the screen that is live
 * without spending a colour, and colour here means saved or overpaid.
 */
export default function RaffleCountdownCard({
  hours,
  minutes,
  seconds,
}: {
  hours: string;
  minutes: string;
  seconds: string;
}) {
  const { t } = useTranslation();

  return (
    <section className="rounded-[18px] bg-[#191F28] px-5 py-[22px] text-white">
      <div className="flex flex-col items-center gap-3">
        <p className="text-[13.5px] font-semibold tracking-[-.02em] text-[#8B95A1]">
          {t('L-Rt7cQm4X')}
        </p>
        <div className="mx-auto flex w-full max-w-[280px] items-start justify-between gap-2">
          <CountdownBlock label={t('Hours')} value={hours} />
          <Colon />
          <CountdownBlock label={t('Minutes')} value={minutes} />
          <Colon />
          <CountdownBlock label={t('Seconds')} value={seconds} />
        </div>
      </div>
    </section>
  );
}

function CountdownBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center">
      <b className="text-[34px] leading-[1.1] font-extrabold tabular-nums tracking-[-.045em]">
        {value}
      </b>
      <p className="mt-0.5 text-[12px] font-medium text-[#8B95A1]">{label}</p>
    </div>
  );
}

/**
 * Dimmer than the digits it separates, and set on the digits' line rather than
 * the block's, so it does not drift down beside the labels.
 */
function Colon() {
  return <span className="text-[26px] leading-[1.45] font-extrabold text-[#4E5968]">:</span>;
}
