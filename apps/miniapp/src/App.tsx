import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useParams } from 'react-router';
import AppLayout from '@/components/AppLayout';
import { useCrossPromoEnabled } from '@/hooks/useHaloMiniCampaign';
import { getAuthAdapter } from '@/lib/auth/adapter';
import { platformFeatures } from '@/lib/constants';
import { useAuthStore } from '@/stores/auth';

// Every page is its own chunk. The login screen is the only thing most first
// visits need, and the scanner pulls in the camera stack it alone uses.
const CameraScan = lazy(() => import('@/pages/CameraScan'));
const EventHaloMini = lazy(() => import('@/pages/EventHaloMini'));
const Receipts = lazy(() => import('@/pages/Receipts'));
const Ledger = lazy(() => import('@/pages/Ledger'));
const ScanResult = lazy(() => import('@/pages/ScanResult'));
const LedgerItem = lazy(() => import('@/pages/LedgerItem'));
const CoverPreview = lazy(() => import('@/pages/CoverPreview'));
const EnsLive = lazy(() => import('@/pages/EnsLive'));
const ReceiptDetail = lazy(() => import('@/pages/ReceiptDetail'));
const Login = lazy(() => import('@/pages/Login'));
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const Payouts = lazy(() => import('@/pages/Payouts'));
const SpendGroup = lazy(() => import('@/pages/SpendGroup'));
const PointLogs = lazy(() => import('@/pages/PointLogs'));
const Privacy = lazy(() => import('@/pages/Privacy'));
const RaffleHistory = lazy(() => import('@/pages/RaffleHistory'));
const Raffle = lazy(() => import('@/pages/Raffle'));
const Rewards = lazy(() => import('@/pages/Rewards'));
const Terms = lazy(() => import('@/pages/Terms'));
const VerifyEmail = lazy(() => import('@/pages/VerifyEmail'));

function RouteFallback() {
  return <div className="min-h-screen bg-white" />;
}

/** The screens a back gesture would exit from rather than navigate within. */
const ROOT_PATHS = new Set(['/ledger', '/rewards', '/']);

/**
 * Ask before a back gesture leaves the app.
 *
 * Only on chains whose host closes the mini app on back (see
 * `PLATFORM_FEATURES.confirmOnBack`): there the gesture is one-way, so a
 * mis-swipe on a root screen drops the user out with no way back in. The guard
 * re-pushes the current entry when the user declines, which is why it only
 * arms on the tab roots — anywhere else, back is just navigation.
 *
 * The list used to be `/home` and `/`. `/home` was deleted with that screen,
 * and the authenticated wildcard replaces `/` immediately, so the guard armed
 * on nothing at all and the gesture it exists to catch went straight through.
 */
function useConfirmOnBack(enabled: boolean) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!enabled) return;

    const preventGoBack = () => {
      const path = window.location.pathname;
      if (!ROOT_PATHS.has(path)) return;
      if (!window.confirm(t('L-IYP2erLe'))) {
        window.history.pushState(null, '', path);
      }
    };

    window.addEventListener('popstate', preventGoBack);
    return () => window.removeEventListener('popstate', preventGoBack);
  }, [enabled, t]);
}

/**
 * `/history/:id` moved to `/receipts/:id`.
 *
 * A plain `<Navigate>` cannot carry the id across, so the param is read and
 * put back. Worth the eight lines: these URLs are in push notifications already
 * delivered to phones, and a dead link there looks like the app lost the
 * receipt rather than like we renamed a route.
 */
function LegacyReceiptRedirect() {
  const { receiptId } = useParams<{ receiptId: string }>();
  return <Navigate to={`/receipts/${receiptId ?? ''}`} replace />;
}

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const sessionChecked = useAuthStore((s) => s.sessionChecked);
  const platform = useAuthStore((s) => s.platform);
  const checkSession = useAuthStore((s) => s.checkSession);
  const crossPromoEnabled = useCrossPromoEnabled();

  useConfirmOnBack(platformFeatures(platform).confirmOnBack);

  // Boot the platform SDK and re-validate the cookie session. The store
  // persists `isAuthenticated` so the app can render immediately; this
  // confirms it against the server and signs the user out if it expired.
  useEffect(() => {
    if (!platform) return;
    void getAuthAdapter(platform)
      .init()
      .catch(() => {
        // A wallet SDK that will not start is reported when the user tries to
        // sign in; it must not block the app from rendering.
      });
    void checkSession();
  }, [platform, checkSession]);

  /*
   * Nothing is routed until we know whether there is a session.
   *
   * `isAuthenticated` starts `false`, so rendering immediately matched the
   * signed-out tree, whose wildcard redirects to `/`. By the time the session
   * arrived the URL had already been replaced, and the authenticated tree then
   * sent `/` to the ledger. Every deep link — a push notification pointing at
   * a receipt, a shared link, a bookmark — landed on the ledger instead.
   *
   * A wallet already signed in on this device skips the wait: `isAuthenticated`
   * is restored from storage before the first paint, and re-checking it is a
   * refresh, not a gate.
   */
  if (!sessionChecked && !isAuthenticated) {
    // No platform means no host to ask, so there is nothing to wait for.
    if (platform) return <RouteFallback />;
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Reachable signed out — store review and shared links need them. */}
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/payouts" element={<Payouts />} />
        <Route path="/onboarding" element={<Onboarding />} />

        {/* Development-only. The cover flow cannot be reached without an
            on-chain position, so without a harness it would be the one screen
            that never gets looked at before shipping. */}
        {import.meta.env.DEV && <Route path="/preview/cover" element={<CoverPreview />} />}

        {/* Public and signed out on purpose: it is the live demo for the ENS
            integration, and every value on it is read from Sepolia when the
            page loads rather than prepared here. */}
        <Route path="/ens" element={<EnsLive />} />

        {isAuthenticated ? (
          <>
            <Route element={<AppLayout />}>
              <Route path="/ledger" element={<Ledger />} />
              <Route path="/ledger/item/:category" element={<LedgerItem />} />
              {/* Enumerated, not a wildcard. `/ledger/:group` also matched
                  `/ledger/anything`, and because the screens only destructured
                  `{ data, isPending }` a 400 from the API rendered as
                  "Groceries this month $0" rather than as an error. */}
              <Route path="/ledger/groceries" element={<SpendGroup group="groceries" />} />
              <Route path="/ledger/household" element={<SpendGroup group="household" />} />
              <Route path="/receipts" element={<Receipts />} />
              <Route path="/receipts/:receiptId" element={<ReceiptDetail />} />
              {/* The old names. Links live in push notifications and in
                  screenshots people have already sent each other. */}
              <Route path="/history" element={<Navigate to="/receipts" replace />} />
              <Route path="/history/:receiptId" element={<LegacyReceiptRedirect />} />
              <Route path="/rewards" element={<Rewards />} />
              <Route path="/raffle" element={<Raffle />} />
              <Route path="/raffle-history" element={<RaffleHistory />} />
              <Route path="/point-logs" element={<PointLogs />} />
              <Route path="/verify-email" element={<VerifyEmail />} />
            </Route>
            {/* Full-screen, outside the tab shell. Both are the middle of an
                action: the result screen carries its own two-button footer, and
                stacking a tab bar under it would put four targets in the same
                thumb zone at the one moment the user has a decision to make. */}
            <Route path="/camera-scan" element={<CameraScan />} />
            <Route path="/scan/:receiptId" element={<ScanResult />} />
            {/* Absent, not hidden, where the chain does not run the
                cross-promo: the wildcard below then sends the URL home. */}
            {crossPromoEnabled && (
              <Route path="/event/halo-mini" element={<EventHaloMini />} />
            )}
            <Route path="*" element={<Navigate to="/ledger" replace />} />
          </>
        ) : (
          <>
            <Route path="/" element={<Login />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
    </Suspense>
  );
}
