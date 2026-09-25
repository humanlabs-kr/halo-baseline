const ONBOARDING_STORAGE_KEY = "halo:onboardingComplete";

/**
 * Key the receipto-era build wrote. The merge renamed it, but the app kept the
 * same origin — so every existing user still has the old key and none has the
 * new one, and on first load after the release they would all be shown the
 * onboarding deck again. Read it once, migrate, and never look again.
 */
const LEGACY_ONBOARDING_STORAGE_KEY = "receipto:onboardingComplete";

const canUseStorage = () =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

export const hasCompletedOnboarding = () => {
  if (!canUseStorage()) {
    return false;
  }
  if (window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true") {
    return true;
  }
  if (window.localStorage.getItem(LEGACY_ONBOARDING_STORAGE_KEY) === "true") {
    // Adopt it under the current name so the legacy read happens at most once
    // per device, then drop the old entry.
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    window.localStorage.removeItem(LEGACY_ONBOARDING_STORAGE_KEY);
    return true;
  }
  return false;
};

export const setOnboardingCompleted = () => {
  if (!canUseStorage()) {
    return;
  }
  window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
};

export const resetOnboardingFlag = () => {
  if (!canUseStorage()) {
    return;
  }
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_ONBOARDING_STORAGE_KEY);
};
