import type { Platform } from "@halo/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { TopBar } from "@/components/ledger/TopBar";
import { Chip } from "@/components/ui/Chip";
import { GroupHead, Row, RowRule } from "@/components/ui/Row";
import { Stepper } from "@/components/ui/Stepper";
import { GiftIcon } from "@/components/ui/icons";
import { useFormatters } from "@/lib/format";
import { useRaffleHistory } from "@/lib/api/queries";
import { type RaffleHistoryView } from "@/lib/api/raffle";
import { EXPLORER_TX_URL, REWARD_CURRENCY } from "@/lib/constants";
import { useAuthStore } from "@/stores/auth";

// Retained for UTC date arithmetic only — the round key below is a machine
// string and must stay "YYYY-MM-DD" in every language. Everything the user
// reads goes through `useFormatters`.
dayjs.extend(utc);

/**
 * How often to re-read the round while a claim is in flight.
 *
 * A World prize is claimed on Drop Protocol's own page, outside this app, so
 * nothing tells us when it lands — the server is simply asked again until the
 * reward comes back settled. Without this the user returns to an unchanged
 * "Claim" button and taps it a second time.
 */
const CLAIM_POLL_INTERVAL_MS = 2_000;

function RaffleHistory() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const platform = useAuthStore((s) => s.platform);
  // Start with yesterday's date in YYYY-MM-DD format (UTC)
  const [selectedDate, setSelectedDate] = useState(() =>
    dayjs().utc().subtract(1, "day").format("YYYY-MM-DD")
  );

  // Claim links the user has opened but that have not settled yet, keyed by
  // the link itself — one reward, one link.
  const [claimingUrls, setClaimingUrls] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  const {
    data: apiData,
    isLoading,
    error,
  } = useRaffleHistory(platform, selectedDate, {
    refetchInterval: claimingUrls.size > 0 ? CLAIM_POLL_INTERVAL_MS : undefined,
  });

  const startClaim = useCallback((claimUrl: string) => {
    setClaimingUrls((previous) => new Set(previous).add(claimUrl));
    // The claim page belongs to Drop Protocol, not to us; opening it in a new
    // context keeps the app mounted so the poll above can see it complete.
    window.open(claimUrl, "_blank", "noopener,noreferrer");
  }, []);

  // Stop polling for a reward once the server reports it settled.
  useEffect(() => {
    if (claimingUrls.size === 0) return;

    const settled = (apiData?.myRewards ?? [])
      .filter((reward) => reward.settledAt !== null)
      .map((reward) => reward.claimUrl)
      .filter((url): url is string => url !== undefined && claimingUrls.has(url));

    if (settled.length === 0) return;
    setClaimingUrls((previous) => {
      const next = new Set(previous);
      for (const url of settled) next.delete(url);
      return next;
    });
  }, [apiData, claimingUrls]);

  // A date change reopens a different round; anything in flight belongs to the
  // one being left behind, and keeping it would poll the wrong query forever.
  useEffect(() => {
    setClaimingUrls(new Set());
  }, [selectedDate]);

  const handlePrevious = () => {
    const previousDate = dayjs(selectedDate)
      .subtract(1, "day")
      .format("YYYY-MM-DD");
    setSelectedDate(previousDate);
  };

  const handleNext = () => {
    const nextDate = dayjs(selectedDate).add(1, "day").format("YYYY-MM-DD");
    // Don't allow going beyond yesterday (UTC)
    const yesterdayUTC = dayjs().utc().subtract(1, "day");
    if (
      dayjs(nextDate).isBefore(yesterdayUTC, "day") ||
      dayjs(nextDate).isSame(yesterdayUTC, "day")
    ) {
      setSelectedDate(nextDate);
    }
  };

  // Can go to next date if it's before or equal to yesterday (UTC)
  const nextDate = dayjs(selectedDate).add(1, "day");
  const yesterdayUTC = dayjs().utc().subtract(1, "day");
  const canGoNext =
    nextDate.isBefore(yesterdayUTC, "day") ||
    nextDate.isSame(yesterdayUTC, "day");

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar title={t("Past draws")} back fallback="/raffle" />

      <Stepper
        label={fmt.day(selectedDate)}
        previousLabel={t("Previous date")}
        nextLabel={t("Next date")}
        onPrevious={handlePrevious}
        onNext={handleNext}
        canNext={canGoNext}
      />

      {isLoading ? (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">
          {t("L-W9Q0CklX")}
        </p>
      ) : error ? (
        <div className="px-10 pt-14 text-center">
          <p className="text-[19px] font-bold tracking-[-.03em]">
            {t("Error loading raffle history")}
          </p>
          <p className="mt-2 break-keep text-[15px] font-medium text-[#8B95A1]">
            {t("Please try again later")}
          </p>
        </div>
      ) : !apiData || apiData.pools.length === 0 ? (
        <EmptyState />
      ) : (
        <RaffleRound
          key={selectedDate}
          date={selectedDate}
          data={apiData}
          platform={platform}
          claimingUrls={claimingUrls}
          onClaim={startClaim}
        />
      )}
    </div>
  );
}

function RaffleRound({
  date,
  data,
  platform,
  claimingUrls,
  onClaim,
}: {
  date: string;
  data: RaffleHistoryView;
  platform: Platform | null;
  claimingUrls: ReadonlySet<string>;
  onClaim: (claimUrl: string) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const currency = platform ? REWARD_CURRENCY[platform] : "";
  const isWon = data.myRewards.length > 0;
  const isLost = !isWon && data.totalEntryCount > 0;
  const allSettled = isWon && data.myRewards.every((reward) => reward.settledAt !== null);
  const totalRewardAmount = data.myRewards.reduce((sum, reward) => sum + reward.amount, 0);

  // The draw runs at the end of the day the round covers.
  const drawDate = dayjs(date).add(12, "hours").toISOString();

  return (
    <>
      {/* The round's date is the label in the stepper directly above, so this
          line carries only what the stepper cannot: when it was drawn, how
          many entries it took, and how it ended for this user. */}
      <div className="flex items-center justify-between gap-3 px-5 pt-1 pb-1.5">
        <p className="min-w-0 break-keep text-[13px] font-medium text-[#8B95A1]">
          {t("Drawn {{when}} · {{entries}} entries", {
            when: fmt.relative(drawDate),
            entries: fmt.number(data.totalEntryCount),
          })}
        </p>
        {isWon && (
          <Chip size="sm" tone={allSettled ? "saved" : "neutral"} className="shrink-0">
            {allSettled ? t("Paid") : t("Won · pending payout")}
          </Chip>
        )}
        {/* Grey, not red. Red in this app means the shopper overpaid, and
            spending it on "you did not win" gives the one colour the ledger
            relies on a second meaning. */}
        {isLost && (
          <Chip size="sm" className="shrink-0">
            {t("Lost")}
          </Chip>
        )}
      </div>

      {data.pools.map((pool, index) => (
        <div key={index}>
          {index > 0 && <RowRule inset={false} />}
          <Row
            title={
              <span className="tabular-nums">
                {fmt.amount(pool.amount)} {currency}
              </span>
            }
            right={
              pool.winner ? (
                <span className="block max-w-[160px] truncate text-[13px] font-medium text-[#4E5968]">
                  @{pool.winner.username || pool.winner.address.slice(0, 10) + "..."}
                </span>
              ) : (
                <span className="block text-[13px] font-medium text-[#8B95A1]">
                  {t("No entries")}
                </span>
              )
            }
          />
        </div>
      ))}

      {isWon && data.myRewards.length > 0 && (
        <>
          {/* Two calls, not one with a ternary inside it. A key chosen inline
              is invisible to `check-locales`, which is how four sentences
              reached production untranslated in every locale while the check
              reported OK — and how these two did the same.

              `{{amount}}` here is a bare number and `{{currency}}` carries the
              code beside it, which is the opposite of every other `{{amount}}`
              in the app. Deliberate: a prize is a token amount (`7.5 USDT`),
              not grocery money, and `fmt.amount` formats it to the token's
              decimals rather than a locale's currency. Translators have asked
              about this twice. */}
          <GroupHead
            title={
              data.myRewards.length > 1
                ? t('Your Rewards ({{amount}} {{currency}})', {
                    amount: fmt.amount(totalRewardAmount),
                    currency,
                  })
                : t('Your Reward ({{amount}} {{currency}})', {
                    amount: fmt.amount(totalRewardAmount),
                    currency,
                  })
            }
          />
          {data.myRewards.map((reward, index) => (
            <div key={index}>
              {index > 0 && <RowRule inset={false} />}
              <Row
                title={
                  <span className="tabular-nums">
                    {fmt.amount(reward.amount)} {currency}
                  </span>
                }
                action={
                  <RewardSettlement
                    reward={reward}
                    platform={platform}
                    isClaiming={
                      reward.claimUrl !== undefined &&
                      claimingUrls.has(reward.claimUrl)
                    }
                    onClaim={onClaim}
                  />
                }
              />
            </div>
          ))}
          {!allSettled && (
            <p className="px-5 pt-3 break-keep text-[13px] font-medium leading-[1.55] text-[#8B95A1]">
              {data.myRewards.some((reward) => reward.claimUrl)
                ? t("Tap Claim to collect your prize.")
                : t(
                    "Payouts are processed at the end of each month. You will receive {{currency}} in your wallet.",
                    { currency },
                  )}
            </p>
          )}
        </>
      )}
    </>
  );
}

/**
 * How a prize reaches the winner differs by chain: World hands out a claim
 * link the user opens themselves, the other chains are paid out by us and
 * show the payout transaction once it has been sent.
 */
function RewardSettlement({
  reward,
  platform,
  isClaiming,
  onClaim,
}: {
  reward: RaffleHistoryView["myRewards"][number];
  platform: Platform | null;
  isClaiming: boolean;
  onClaim: (claimUrl: string) => void;
}) {
  const { t } = useTranslation();
  const settled = reward.settledAt !== null;
  const claimUrl = reward.claimUrl;

  if (!settled && claimUrl) {
    return (
      <button
        type="button"
        onClick={() => onClaim(claimUrl)}
        disabled={isClaiming}
        className="shrink-0 rounded-[12px] bg-[#191F28] px-3.5 py-2 text-[13px] font-bold tracking-[-.02em] text-white transition-transform active:scale-95 disabled:opacity-50"
      >
        {/* The label already says the claim is running; a spinner beside it
            says the same thing a second time. */}
        {isClaiming ? t("L-qHrxRpu3") : t("L-HZTnPZQA")}
      </button>
    );
  }

  if (!settled) {
    return <Chip size="sm">{t("Pending")}</Chip>;
  }

  if (reward.txHash && platform) {
    return (
      <a
        href={`${EXPLORER_TX_URL[platform]}${reward.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
        className="pressed shrink-0 rounded-[12px] bg-[#F2F4F6] px-3 py-1.5 text-[12.5px] font-bold tracking-[-.02em] text-[#4E5968]"
      >
        {t("View TX")}
      </a>
    );
  }

  return (
    <Chip size="sm" tone="saved">
      {t("Paid")}
    </Chip>
  );
}

function EmptyState() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center px-10 pt-16 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-[#F2F4F6] text-[#B0B8C1]">
        <GiftIcon />
      </span>
      <p className="mt-5 text-[19px] font-bold tracking-[-.03em]">
        {t("No raffle entries")}
      </p>
      <p className="mt-2 break-keep text-[15px] font-medium text-[#8B95A1]">
        {t("Join raffle pools to see results here")}
      </p>
    </div>
  );
}

export default RaffleHistory;
