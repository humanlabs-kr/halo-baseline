import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import BlacklistModal from '@/components/BlacklistModal';
import BottomTab from '@/components/BottomTab';
import { HaloMiniPopup } from '@/components/HaloMiniPopup';
import { getSafeAreaInsetBottom } from '@/lib/safe-area';
import { useAuthStore } from '@/stores/auth';

const TAB_BAR_HEIGHT = 68;

/** Placeholder shown while a lazily loaded page chunk arrives. */
function PageFallback() {
  return <div className="min-h-[60vh]" />;
}

/**
 * Shell for the tabbed part of the app.
 *
 * The `<Suspense>` here is deliberately a second boundary, inside the one that
 * wraps the router: it keeps the bottom tab bar mounted while the next tab's
 * chunk downloads, instead of blanking the whole screen on every tab switch.
 */
export default function AppLayout() {
  const location = useLocation();
  const isBlacklisted = useAuthStore((s) => s.isBlacklisted);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    // Set here rather than on each page: the tab bar is translucent, and a
    // page whose own background stops at its last row let the body colour
    // show through behind it. It was the old paper green, which is now the
    // one surface in the app that is not white — visible in over-scroll and
    // behind the tab bar on every screen.
    <div
      className="min-h-screen bg-white"
      style={{ paddingBottom: getSafeAreaInsetBottom() + TAB_BAR_HEIGHT }}
    >
      <div className="flex-1 overflow-y-auto">
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </div>
      <BottomTab />
      {isBlacklisted && <BlacklistModal />}
      <HaloMiniPopup />
    </div>
  );
}
