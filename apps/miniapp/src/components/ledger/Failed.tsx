import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';

/**
 * What a screen shows when its request did not come back.
 *
 * Every ledger screen destructured `{ data, isPending }` and nothing else, so
 * a 400 or a dropped connection fell through to the loaded branch and rendered
 * zeroes in the fallback currency: "Groceries this month $0". A ledger that
 * shows a confident wrong number instead of admitting it could not load is
 * worse than one that fails, because the user has no way to tell.
 */
export function Failed() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="px-5 pt-16">
      <p className="text-center text-[19px] font-bold tracking-[-.03em]">
        {t('We could not load this')}
      </p>
      <div className="mt-6">
        <Button variant="ghost" onClick={() => navigate(0)}>
          {t('Try again')}
        </Button>
      </div>
    </div>
  );
}
