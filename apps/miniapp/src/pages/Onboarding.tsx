import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { BASE_POINT_PER_RECEIPT } from '@halo/contracts';
import { Amount, useMoneyText } from '@/components/ledger/Amount';
import { Slip, SlipLine, SlipTotal } from '@/components/ui/Slip';
import { DownIcon, GiftIcon } from '@/components/ui/icons';
import { setOnboardingCompleted } from '@/lib/onboarding-storage';
import { sampleBasket, unitPriceText, type SampleBasket } from '@/lib/sample-basket';
import { useFormatters } from '@/lib/format';
import { sendLightImpactHaptic } from '@/lib/haptic';

/**
 * Three steps: photograph it, every item gets a price, and every scan pays.
 *
 * The deck this replaces advanced itself every four seconds and wrapped around
 * past the last slide, which took the only button on the screen with it — so
 * the way to finish onboarding was to stop reading and tap fast. Nothing here
 * moves on its own.
 *
 * It is drawn out of the same pieces as the login screen and the scan result —
 * the app's slip, the app's verdict card, the app's reward row. The previous
 * version was a sage-green screen of monospaced thermal paper, left behind when
 * the rest of the app stopped being a document; a user met it on their first
 * tap and then never saw that app again.
 *
 * The order is the product's own argument. Rewards land last because they are
 * the answer to "why would you have a million receipts", not the reason to keep
 * a ledger.
 */
const STEPS = 3;

function Onboarding({ onClose }: { onClose?: () => void } = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormatters();
  const [step, setStep] = useState(0);
  const basket = sampleBasket(fmt.lang, t);

  const finish = () => {
    sendLightImpactHaptic();
    if (onClose) {
      onClose();
      return;
    }
    setOnboardingCompleted();
    navigate('/ledger', { replace: true });
  };

  const next = () => {
    sendLightImpactHaptic();
    if (step === STEPS - 1) finish();
    else setStep(step + 1);
  };

  const copy = [
    {
      title: t('Photograph the receipt'),
      body: t('Any shop, any layout.'),
    },
    {
      title: t('Every item gets a price'),
      body: t('A 5 kg sack and a 1 kg bag stop being two prices and become one — what a kilo costs you.'),
    },
    {
      title: t('Points for every scan'),
      body: t('Those receipts are where the prices come from, and how you find out where yours stand.'),
    },
  ][step]!;

  return (
    <div
      className={`flex flex-col bg-white px-5 text-[#191F28] ${onClose ? 'min-h-full' : 'min-h-screen'}`}
    >
      <div className="flex items-center gap-3.5 pt-[max(16px,env(safe-area-inset-top))]">
        <div className="flex flex-1 gap-1.5">
          {Array.from({ length: STEPS }).map((_, index) => (
            <span
              key={index}
              className={`h-[3px] flex-1 rounded-full transition-colors ${index <= step ? 'bg-[#191F28]' : 'bg-[#E5E8EB]'}`}
            />
          ))}
        </div>
        {/* Gone on the last step, where the only button left is the one that
            finishes — offering "skip" and "get started" side by side asks the
            user to tell two identical outcomes apart. */}
        {step < STEPS - 1 && (
          <button
            type="button"
            onClick={finish}
            className="-my-2 py-2 text-[14px] font-medium text-[#8B95A1]"
          >
            {t('Skip')}
          </button>
        )}
      </div>

      {/* The art takes whatever is left and the words sit just above the
          button, so the headline lands at the same height on all three steps
          however tall the illustration is. A fixed band for the art did the
          opposite: the receipt on step two is taller than the frame on step
          one, so it overflowed and covered its own title. */}
      <div key={step} className="animate-rise flex min-h-0 flex-1 items-center justify-center overflow-hidden py-6">
        {step === 0 ? (
          <Framed />
        ) : step === 1 ? (
          <PriceSlip basket={basket} />
        ) : (
          <RewardCard basket={basket} />
        )}
      </div>

      <div className="shrink-0 pt-2">
        <h2 className="break-keep text-[27px] font-extrabold leading-[1.22] tracking-[-.045em] text-balance">
          {copy.title}
        </h2>
        <p className="mt-2.5 break-keep text-[15px] leading-[1.55] font-medium text-[#8B95A1] text-pretty">
          {copy.body}
        </p>
      </div>

      <div className="shrink-0 pt-5 pb-[max(24px,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={next}
          className="pressed w-full rounded-[14px] bg-[#191F28] py-[15px] text-[16px] font-bold tracking-[-.03em] text-white"
        >
          {step === STEPS - 1 ? t('L-qSFBPpIq') : t('Next')}
        </button>
      </div>
    </div>
  );
}

/**
 * Step one: a receipt lying inside the camera's corner guides, with the line
 * that reads it passing over the paper.
 *
 * The guides and the line are the ones the scan screen actually draws, so the
 * first time the user opens the camera nothing on it is new.
 */
function Framed() {
  return (
    <div className="relative h-[244px] w-[152px]">
      <div className="absolute inset-0 -rotate-[2.5deg] rounded-[14px] bg-white p-[7px] shadow-[0_1px_2px_rgba(25,31,40,.08),0_10px_24px_rgba(25,31,40,.10)]">
        <div
          className="relative h-full rounded-[8px] bg-[#F7F8FA]"
          style={{
            backgroundImage:
              'repeating-linear-gradient(180deg,rgba(78,89,104,.22) 0 2px,transparent 2px 10px)',
            backgroundPosition: '0 34px',
            backgroundRepeat: 'repeat-x',
            backgroundSize: '100% 172px',
          }}
        >
          <span className="absolute top-[9px] right-[18%] left-[18%] h-[5px] rounded-full bg-[rgba(78,89,104,.45)]" />
          <span className="absolute inset-x-0 bottom-3 h-[5px] bg-[rgba(78,89,104,.45)] shadow-[0_-9px_0_-7px_rgba(78,89,104,.35)]" />
          {/* One crisp line with a glow above it. Drawn as a band, it read as a
              crease in the paper rather than as something scanning it. */}
          <span className="animate-scanline absolute inset-x-0 top-[44%] h-0.5 bg-[#00A06A] shadow-[0_0_12px_2px_rgba(0,160,106,.40)]">
            <span className="absolute inset-x-0 bottom-0.5 h-[30px] bg-gradient-to-b from-transparent to-[rgba(0,160,106,.14)]" />
          </span>
        </div>
      </div>
      {(
        [
          '-top-2 -left-3 border-r-0 border-b-0 rounded-tl-[6px]',
          '-top-2 -right-3 border-l-0 border-b-0 rounded-tr-[6px]',
          '-bottom-2 -left-3 border-r-0 border-t-0 rounded-bl-[6px]',
          '-bottom-2 -right-3 border-l-0 border-t-0 rounded-br-[6px]',
        ] as const
      ).map((position) => (
        <span
          key={position}
          className={`absolute h-[26px] w-[26px] border-[2.5px] border-[#191F28] ${position}`}
        />
      ))}
    </div>
  );
}

/** Step two: the same shopping, with the price per unit divided out. */
function PriceSlip({ basket }: { basket: SampleBasket }) {
  const { t } = useTranslation();
  const money = useMoneyText();
  const lines = basket.lines.filter((line) => line.unit !== null).slice(0, 3);
  const total = lines.reduce((sum, line) => sum + line.total, 0);

  return (
    <div className="w-full">
      <Slip>
        <div className="mb-[2px] flex items-baseline justify-between border-b border-[#F2F4F6] pb-[10px]">
          <b className="text-[14.5px] font-bold tracking-[-.025em]">{basket.shop}</b>
        </div>
        {lines.map((line) => (
          <SlipLine
            key={line.name}
            name={line.name}
            price={<Amount value={line.total} currency={basket.currency} />}
            unit={`${line.category} · ${unitPriceText(line.unit!, money(line.unitPrice!, basket.currency), t)}`}
          />
        ))}
        <SlipTotal label={t('TOTAL')} amount={<Amount value={total} currency={basket.currency} />} />
      </Slip>
    </div>
  );
}

/**
 * Step three: what a scan pays, and what the scans are for.
 *
 * The points card is on top because the step is about them. The verdict sits
 * under it as the consequence — this is the one place in the app where the
 * comparison is an argument rather than a result, and it is shown small.
 */
function RewardCard({ basket }: { basket: SampleBasket }) {
  const { t } = useTranslation();
  const money = useMoneyText();

  return (
    <div className="w-full">
      <div className="flex items-center gap-3.5 rounded-[18px] bg-[#F2F4F6] px-[18px] py-[17px]">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-[#FFF1E6] text-[#E8833A]">
          <GiftIcon />
        </span>
        <b className="text-[17px] font-bold tracking-[-.03em]">
          {t('This receipt earned {{points}}P', { points: BASE_POINT_PER_RECEIPT })}
        </b>
      </div>

      <div className="mt-2.5 flex items-center gap-3.5 rounded-[18px] bg-[#F0FAF6] px-[18px] py-[17px]">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-[#E7F8F1] text-[#00A06A]">
          <DownIcon />
        </span>
        <p className="min-w-0 flex-1 break-keep text-[16px] font-semibold leading-[1.4] tracking-[-.03em]">
          {basket.country
            ? t('{{amount}} less than most people in {{country}}', {
                amount: money(basket.saved, basket.currency),
                country: basket.country,
              })
            : t('{{amount}} less than most people', {
                amount: money(basket.saved, basket.currency),
              })}
        </p>
      </div>
    </div>
  );
}

export default Onboarding;
