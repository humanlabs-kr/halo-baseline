import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { sendSelectionHaptic } from '@/lib/haptic';
import { getSafeAreaInsetBottom } from '@/lib/safe-area';

/**
 * Three tabs: the ledger, the camera, the points.
 *
 * The camera sits in the middle and is not a tab — it pushes a full-screen
 * route and comes back. It is there because scanning is the one thing the user
 * does that makes everything else in the app work, and burying it inside the
 * ledger made the app's only input a secondary action.
 *
 * The active tab is derived from the URL rather than held in state. The old
 * version mirrored the route into a `useState` and synced it in an effect,
 * which meant a redirect or a back gesture left the highlight on the tab the
 * user had tapped instead of the screen they were looking at.
 */
/**
 * `owns` is every route that should light this tab up, not just its landing
 * page. A tab that goes dark the moment you open something from it tells the
 * user they have left the section they are plainly still inside — which is
 * what happened on the receipts list, reached only from the ledger.
 */
const TABS = [
  { path: '/ledger', owns: ['/ledger', '/receipts'], labelKey: 'Ledger', icon: <ReceiptIcon /> },
  { path: '/camera-scan', owns: ['/camera-scan', '/scan'], labelKey: 'Scan', icon: <CameraIcon /> },
  {
    path: '/rewards',
    owns: ['/rewards', '/raffle', '/point-logs', '/payouts', '/raffle-history'],
    labelKey: 'L-42p9Zgx7',
    icon: <GiftIcon />,
  },
] as const;

function BottomTab() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-[#F2F4F6] bg-white/95 backdrop-blur"
      style={{ paddingBottom: getSafeAreaInsetBottom() }}
    >
      <div className="mx-auto flex max-w-[420px]">
        {TABS.map(({ path, owns, labelKey, icon }) => {
          const active = owns.some(
            (route) => pathname === route || pathname.startsWith(`${route}/`),
          );

          return (
            <button
              key={path}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                sendSelectionHaptic();
                navigate(path);
              }}
              onContextMenu={(event) => event.preventDefault()}
              className={`flex flex-1 select-none flex-col items-center gap-1 py-2.5 text-[11px] font-semibold ${
                active ? 'text-[#191F28]' : 'text-[#B0B8C1]'
              }`}
            >
              {icon}
              <span>{t(labelKey)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/*
 * Drawn inline rather than loaded from `/public`.
 *
 * The old tabs were `<img>` tags, which meant the icon could not take the
 * active colour — it was faked with opacity, so the inactive state was a
 * washed-out black rather than the muted green everything else uses. Three
 * small paths also cost three fewer requests on the first screen after login.
 */
function ReceiptIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" aria-hidden>
      <path
        d="M5 21V4a1 1 0 011-1h12a1 1 0 011 1v17l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" aria-hidden>
      <path
        d="M3 8.5A1.5 1.5 0 014.5 7h2.8l1.3-2h6.8l1.3 2h2.8A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5v-9z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.4" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" aria-hidden>
      <path
        d="M4 11h16v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9zM3 7.5h18V11H3V7.5zM12 7.5V21"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M12 7.5S11 3 8.5 3a2.2 2.2 0 000 4.5H12zm0 0S13 3 15.5 3a2.2 2.2 0 010 4.5H12z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default BottomTab;
