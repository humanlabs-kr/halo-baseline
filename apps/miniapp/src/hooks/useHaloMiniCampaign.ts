import { useEffect, useState } from 'react';
import { platformFeatures } from '@/lib/constants';
import { GEO_API_URL, isDeveloperAddress } from '@/lib/env';
import {
  ADMIN_FALLBACK_CAMPAIGN,
  getHaloMiniCampaign,
  type HaloMiniCampaignWithCode,
} from '@/lib/halo-mini-campaigns';
import { useAuthStore } from '@/stores/auth';

/**
 * Whether this chain runs the Halo Mini cross-promo at all.
 *
 * The single gate for the banner, the dwell popup and the `/event/halo-mini`
 * route — `App.tsx` uses it to decide whether the route exists, so a chain with
 * the cross-promo off has no reachable campaign surface, not even by URL.
 */
export function useCrossPromoEnabled(): boolean {
  const platform = useAuthStore((s) => s.platform);
  return platformFeatures(platform).crossPromo;
}

/**
 * Resolves the cross-promo campaign for the user's country, or `null` when
 * there is nothing to show.
 *
 * Shared by the banner, the popup and the campaign page so the geo lookup and
 * the internal-preview bypass exist once. Returns `null` — i.e. renders
 * nothing — when the chain does not run the cross-promo, or when no geo
 * endpoint is configured, so a deployment that does not run it needs no code
 * change.
 */
export function useHaloMiniCampaign(): HaloMiniCampaignWithCode | null {
  const address = useAuthStore((s) => s.user?.address);
  const enabled = useCrossPromoEnabled();
  const [campaign, setCampaign] = useState<HaloMiniCampaignWithCode | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Chain-level switch first: it must also override the developer preview,
    // or internal QA on Kaia would see a surface real users cannot reach.
    if (!enabled) {
      setCampaign(null);
      return;
    }

    // Internal QA sees the neutral fallback variant without spoofing a country.
    if (isDeveloperAddress(address)) {
      setCampaign(ADMIN_FALLBACK_CAMPAIGN);
      return;
    }

    if (!GEO_API_URL) {
      setCampaign(null);
      return;
    }

    void (async () => {
      try {
        const res = await fetch(GEO_API_URL);
        const data = (await res.json()) as { country?: string };
        if (!cancelled) setCampaign(getHaloMiniCampaign(data.country));
      } catch {
        // Geo lookup is best-effort: no campaign rather than a broken banner.
        if (!cancelled) setCampaign(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, enabled]);

  return campaign;
}
