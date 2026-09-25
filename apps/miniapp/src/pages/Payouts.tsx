import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TopBar } from "@/components/ledger/TopBar";
import { Row, RowRule } from "@/components/ui/Row";
import { Stepper } from "@/components/ui/Stepper";
import { GiftIcon } from "@/components/ui/icons";
import { useFormatters } from "@/lib/format";
import { useRafflePayouts } from "@/lib/api/queries";
import type { HaloRaffleChain, HaloRafflePayout } from "@/lib/api/raffle";
import { EXPLORER_TX_URL, REWARD_CURRENCY } from "@/lib/constants";
import { useAuthStore } from "@/stores/auth";

function Payouts() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const platform = useAuthStore((s) => s.platform);
  const [page, setPage] = useState(1);
  const limit = 20;

  // Payout records only exist for the chains we settle ourselves. On World the
  // winner claims the prize directly, so there is no payout ledger to show.
  const chain: HaloRaffleChain | null =
    platform === "celo" || platform === "kaia" ? platform : null;
  const currency = platform ? REWARD_CURRENCY[platform] : "";

  const {
    data: apiData,
    isLoading,
    error,
    isFetching,
  } = useRafflePayouts(chain, { limit, offset: (page - 1) * limit });

  const totalPages = apiData ? Math.ceil(apiData.total / limit) : 0;

  const handlePrevious = () => {
    if (page > 1) {
      setPage((prev) => prev - 1);
      window.scrollTo(0, 0);
    }
  };

  const handleNext = () => {
    if (page < totalPages) {
      setPage((prev) => prev + 1);
      window.scrollTo(0, 0);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      {/* This screen is reachable signed out — a winner's shared link — so back
          goes to the draw rather than out of the mini app. */}
      <TopBar title={t("Payouts")} back fallback="/raffle" />

      {apiData && apiData.summary.totalPaidCount > 0 && (
        <section className="px-5 pt-1">
          <div className="rounded-[18px] bg-[#F0FAF6] px-5 py-[18px]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium tracking-[-.02em] text-[#4E5968]">
                  {t("Total Paid Out")}
                </p>
                <p className="mt-1 text-[24px] font-extrabold tabular-nums tracking-[-.04em] text-[#00A06A]">
                  ${fmt.number(apiData.summary.totalPaid, { maximumFractionDigits: 2 })}
                </p>
              </div>
              <div className="min-w-0 text-right">
                <p className="text-[13px] font-medium tracking-[-.02em] text-[#4E5968]">
                  {t("Winners")}
                </p>
                <p className="mt-1 text-[24px] font-extrabold tabular-nums tracking-[-.04em] text-[#00A06A]">
                  {fmt.number(apiData.summary.totalPaidCount)}
                </p>
              </div>
            </div>
            <p className="mt-3 break-keep text-center text-[12.5px] font-medium text-[#8B95A1]">
              {t("All payouts verified on-chain")}
            </p>
          </div>
        </section>
      )}

      {isLoading || isFetching ? (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">
          {t("L-W9Q0CklX")}
        </p>
      ) : error ? (
        <div className="px-10 pt-14 text-center">
          <p className="text-[19px] font-bold tracking-[-.03em]">
            {t("Error loading payouts")}
          </p>
          <p className="mt-2 break-keep text-[15px] font-medium text-[#8B95A1]">
            {t("Please try again later")}
          </p>
        </div>
      ) : !apiData || apiData.payouts.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="pt-1">
            {apiData.payouts.map((payout, index) => (
              <div key={`${payout.txHash}-${index}`}>
                {index > 0 && <RowRule inset={false} />}
                <PayoutRow
                  payout={payout}
                  currency={currency}
                  explorerTxUrl={platform ? EXPLORER_TX_URL[platform] : ""}
                />
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="pt-4">
              <Stepper
                label={t("Page {{current}} of {{total}}", {
                  current: page,
                  total: totalPages,
                })}
                previousLabel={t("Previous page")}
                nextLabel={t("Next page")}
                onPrevious={handlePrevious}
                onNext={handleNext}
                canPrevious={page > 1}
                canNext={page < totalPages}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PayoutRow({
  payout,
  currency,
  explorerTxUrl,
}: {
  payout: HaloRafflePayout;
  currency: string;
  explorerTxUrl: string;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const displayName = payout.winner.username
    ? `@${payout.winner.username}`
    : `${payout.winner.address.slice(0, 8)}...${payout.winner.address.slice(-4)}`;
  // Date first, name second. A winner picks their own name and a long one
  // pushed the date off the end of the line.
  const caption = `${fmt.day(payout.utcDate)} · ${displayName}`;

  return (
    <Row
      title={
        <span className="tabular-nums">
          {fmt.amount(payout.amountInUSDT)} {currency}
        </span>
      }
      caption={<span className="block truncate">{caption}</span>}
      action={
        <a
          href={`${explorerTxUrl}${payout.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="pressed shrink-0 rounded-[12px] bg-[#F2F4F6] px-3 py-1.5 text-[12.5px] font-bold tracking-[-.02em] text-[#4E5968]"
        >
          {t("View TX")}
        </a>
      }
    />
  );
}

function EmptyState() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center px-10 pt-24 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-[#F2F4F6] text-[#B0B8C1]">
        <GiftIcon />
      </span>
      <p className="mt-5 text-[19px] font-bold tracking-[-.03em]">
        {t("No payouts yet")}
      </p>
      <p className="mt-2 break-keep text-[15px] font-medium text-[#8B95A1]">
        {t("Verified on-chain payouts will appear here")}
      </p>
    </div>
  );
}

export default Payouts;
