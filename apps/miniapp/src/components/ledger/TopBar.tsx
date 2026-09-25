import { useLocation, useNavigate } from 'react-router';
import { sendLightImpactHaptic } from '@/lib/haptic';

/**
 * The title bar. `back` draws the arrow; the root tabs do not have one.
 *
 * `fallback` is where back goes when there is nowhere to go back to. A screen
 * opened directly — a push notification, a shared link, a bookmark — has no
 * in-app history behind it, and `navigate(-1)` there walks out of the mini app
 * entirely. React Router marks that first entry with `key === 'default'`,
 * which is the only reliable way to tell it apart from a normal push.
 */
export function TopBar({
  title,
  back = false,
  fallback = '/ledger',
  onBack,
}: {
  /** Omitted where the screen is its own headline — a full-bleed wait. */
  title?: string;
  back?: boolean;
  fallback?: string;
  /**
   * Takes over from the navigation above, for a screen whose back arrow has
   * somewhere to go inside the screen. Email verification is three steps on
   * one route: leaving it from step two throws away a code that has already
   * been sent, and the user has to wait out the cooldown to get another.
   */
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <header className="flex items-center gap-2 px-5 pt-[max(12px,env(safe-area-inset-top))] pb-1">
      {back && (
        <button
          type="button"
          aria-label="Back"
          className="pressed -ml-2 p-2"
          onClick={() => {
            sendLightImpactHaptic();
            if (onBack) {
              onBack();
              return;
            }
            if (location.key === 'default') navigate(fallback, { replace: true });
            else navigate(-1);
          }}
        >
          <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" aria-hidden>
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {title && (
        <h1 className={`font-bold tracking-[-.035em] ${back ? 'text-[20px]' : 'text-[25px]'}`}>
          {title}
        </h1>
      )}
    </header>
  );
}
