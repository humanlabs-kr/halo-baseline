import { MiniKit } from '@worldcoin/minikit-js';
import { detectPlatform } from './platform';

/** iOS home-indicator height, used when World App reports no inset. */
const IOS_HOME_INDICATOR = 34;

/**
 * Bottom safe-area inset in pixels.
 *
 * Only World App reports insets (through MiniKit); MiniPay and the LINE
 * webview render inside a normal viewport where CSS `env(safe-area-inset-*)`
 * already applies, so 0 is the right answer there.
 */
export function getSafeAreaInsetBottom(): number {
  if (detectPlatform() !== 'world' || !MiniKit.isInstalled()) return 0;
  const inset = MiniKit.deviceProperties.safeAreaInsets?.bottom ?? 0;
  const isIOS = MiniKit.deviceProperties.deviceOS === 'ios';
  return Math.max(inset, isIOS ? IOS_HOME_INDICATOR : 0);
}
