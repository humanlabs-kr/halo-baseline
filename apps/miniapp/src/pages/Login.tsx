import { Link, useNavigate } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { Amount } from '@/components/ledger/Amount';
import { Slip, SlipLine, SlipTotal } from '@/components/ui/Slip';
import { hasCompletedOnboarding } from '@/lib/onboarding-storage';
import { sampleBasket, unitPriceText } from '@/lib/sample-basket';
import { useReceiptTotalCount } from '@/lib/api/queries';
import { useMoneyText } from '@/components/ledger/Amount';
import { useFormatters } from '@/lib/format';
import { sendLightImpactHaptic } from '@/lib/haptic';
import { useAuthStore } from '@/stores/auth';
import { BASE_POINT_PER_RECEIPT } from '@halo/contracts';
import { GiftIcon } from '@/components/ui/icons';

/**
 * The first screen states the bargain: one photograph, and the book writes
 * itself — with points for having taken it.
 *
 * It used to lead with "have you been paying too much?", which put the price
 * comparison first and left the two things the product actually does — keeping
 * the ledger and paying for scans — off the screen entirely. Somebody deciding
 * whether to install this needs to know what they have to do and what they
 * get, in that order.
 *
 * The evidence is a real slip rather than a promise: one receipt, already
 * sorted into items, with the reward it earned underneath. The per-unit price
 * stays on each line, quietly. The comparison is no longer the headline but it
 * has not been hidden — it is simply shown as a result instead of claimed as a
 * feature.
 */
function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormatters();
  const money = useMoneyText();
  const signIn = useAuthStore((s) => s.signIn);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const { data: corpus } = useReceiptTotalCount();

  const basket = sampleBasket(fmt.lang, t);
  const lines = basket.lines.filter((line) => line.unit !== null).slice(0, 4);
  const total = lines.reduce((sum, line) => sum + line.total, 0);

  const handleSignIn = async () => {
    sendLightImpactHaptic();
    const signedIn = await signIn();
    // The failure reason is already in the store and rendered below.
    if (!signedIn) return;
    navigate(hasCompletedOnboarding() ? '/ledger' : '/onboarding');
  };

  return (
    <div className="flex min-h-screen flex-col overflow-hidden bg-white px-5 text-[#191F28]">
      <header className="flex items-center gap-2 pt-[max(6px,env(safe-area-inset-top))]">
        <b className="text-[16px] font-extrabold tracking-[-.03em]">Halo</b>
        {/* The count is the argument for scanning today rather than later: the
            prices this compares against already exist. */}
        <span className="ml-auto text-[12.5px] font-medium text-[#8B95A1]">
          {corpus === undefined
            ? ' '
            : t('{{count}} receipts read', { count: fmt.compact(corpus.totalCount) })}
        </span>
      </header>

      <h1 className="mt-6 break-keep text-[31px] font-extrabold leading-[1.22] tracking-[-.045em]">
        <Trans i18nKey="Photograph a receipt<0/>and the book writes itself" components={[<br key="0" />]} />
      </h1>
      <p className="mt-[11px] break-keep text-[15px] font-medium leading-[1.55] text-[#8B95A1]">
        <Trans
          i18nKey="Sorted into items for you.<0/>Every scan earns points too"
          components={[<br key="0" />]}
        />
      </p>

      <div className="mt-[22px]">
        <Slip>
          <div className="mb-[2px] flex items-baseline justify-between border-b border-[#F2F4F6] pb-[10px]">
            <b className="text-[14.5px] font-bold tracking-[-.025em]">{basket.shop}</b>
            <span className="text-[12px] font-medium text-[#8B95A1]">{fmt.receiptDay(new Date())}</span>
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

        {/* Below the paper, not on it. The points are ours to give; they are
            not printed on the shop's receipt. */}
        <div className="mt-[11px] flex items-center gap-[10px] rounded-2xl bg-[#F2F4F6] px-[15px] py-[13px]">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FFF1E6] text-[#E8833A]">
            <GiftIcon />
          </span>
          <b className="text-[15px] font-bold tracking-[-.025em]">
            {t('This receipt earned {{points}}P', { points: BASE_POINT_PER_RECEIPT })}
          </b>
        </div>
      </div>

      <div className="relative z-10 mt-auto bg-white pt-[18px] pb-[max(20px,env(safe-area-inset-bottom))]">
        {error && <p className="pb-2.5 text-center text-sm text-[#F04452]">{t(error)}</p>}
        <button
          type="button"
          onClick={handleSignIn}
          disabled={isLoading}
          className={`pressed w-full rounded-[14px] bg-[#191F28] py-[15px] text-[16px] font-bold tracking-[-.03em] text-white ${isLoading ? 'opacity-50' : ''}`}
        >
          {isLoading ? t('L-IXArjCtB') : t('L-4wGUcm56')}
        </button>
        <p className="mt-3 text-center text-[11.5px] font-medium leading-[1.6] text-[#8B95A1]">
          <Trans
            i18nKey="By continuing you agree to the <0>Terms</0> and <1>Privacy Policy</1>."
            components={[
              <Link key="0" to="/terms" className="underline" />,
              <Link key="1" to="/privacy" className="underline" />,
            ]}
          />
          <br />
          {t('Operated by Human Labs')}
        </p>
      </div>
    </div>
  );
}


export default Login;
