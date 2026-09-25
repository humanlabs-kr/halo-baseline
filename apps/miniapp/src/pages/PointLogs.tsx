import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TopBar } from '@/components/ledger/TopBar';
import { Failed } from '@/components/ledger/Failed';
import { Button } from '@/components/ui/Button';
import { GroupHead, Row, RowRule } from '@/components/ui/Row';
import { usePointLogs } from '@/lib/api/queries';
import { useFormatters } from '@/lib/format';
import { pointLogLabel } from '@/lib/point-log';
import type { PointLog } from '@/lib/api/point';

const PAGE_SIZE = 30;

/**
 * Every point in and every point out, newest first, grouped by day.
 *
 * The running balance sits under each movement rather than only at the top,
 * because the question people bring to this screen is almost never "what is my
 * balance" — they know that — it is "where did it go", and that is answered by
 * seeing the balance step down next to the thing that stepped on it.
 */
function PointLogs() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const [page, setPage] = useState(0);
  const { data, isPending, isError } = usePointLogs({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  const days = groupByDay(data?.list ?? []);
  const hasMore = data ? (page + 1) * PAGE_SIZE < data.totalCount : false;

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar title={t('Point history')} back fallback="/rewards" />

      {isError ? (
        <Failed />
      ) : isPending ? (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">{t('Loading…')}</p>
      ) : days.length === 0 ? (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">{t('Nothing yet.')}</p>
      ) : (
        days.map(([day, logs]) => (
          <section key={day}>
            <GroupHead title={fmt.day(day)} />
            {logs.map((log, index) => (
              <div key={log.id}>
                {index > 0 && <RowRule inset={false} />}
                <Row
                  title={pointLogLabel(log, t)}
                  caption={fmt.time(log.createdAt)}
                  right={
                    <>
                      <b
                        className={`block text-[16px] font-bold tabular-nums tracking-[-.03em] ${
                          log.diff < 0 ? 'text-[#F04452]' : 'text-[#00A06A]'
                        }`}
                      >
                        {log.diff > 0 ? '+' : '−'}
                        {t('{{points}}P', { points: fmt.number(Math.abs(log.diff)) })}
                      </b>
                      {/* The balance after the movement, which is the answer
                          to "where did it go" — the movement alone only says
                          that something happened. */}
                      <span className="mt-[5px] block text-[13px] font-medium tabular-nums text-[#8B95A1]">
                        {t('{{points}}P', { points: fmt.number(log.afterBalance) })}
                      </span>
                    </>
                  }
                />
              </div>
            ))}
          </section>
        ))
      )}

      {(page > 0 || hasMore) && (
        <div className="flex gap-2.5 px-5 pt-6">
          <Button
            variant="ghost"
            disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            {t('Newer')}
          </Button>
          <Button
            variant="ghost"
            disabled={!hasMore}
            onClick={() => setPage((current) => current + 1)}
          >
            {t('Older')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Local day, matching the receipts list so the two read as one ledger. */
function groupByDay(list: PointLog[]): [string, PointLog[]][] {
  const days = new Map<string, PointLog[]>();

  for (const log of list) {
    const date = new Date(log.createdAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const bucket = days.get(key);
    if (bucket) bucket.push(log);
    else days.set(key, [log]);
  }

  return [...days.entries()];
}

export default PointLogs;
