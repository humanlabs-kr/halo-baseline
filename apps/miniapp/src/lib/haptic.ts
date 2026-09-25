import { MiniKit } from '@worldcoin/minikit-js';
import { detectPlatform } from './platform';

/**
 * Haptics, where the host supports them.
 *
 * World App exposes a haptics command through MiniKit. MiniPay and the LINE
 * DappPortal webview do not expose anything equivalent, so these calls are
 * no-ops there rather than a branch at every call site.
 */

export type ImpactStyle = 'light' | 'medium' | 'heavy';
export type NotificationStyle = 'success' | 'warning' | 'error';

export type HapticFeedback =
  | { hapticsType: 'impact'; style: ImpactStyle }
  | { hapticsType: 'notification'; style: NotificationStyle }
  | { hapticsType: 'selection-changed' };

function supportsHaptics(): boolean {
  return detectPlatform() === 'world' && MiniKit.isInstalled();
}

export function sendHapticFeedback(options: HapticFeedback): void {
  if (!supportsHaptics()) return;
  MiniKit.commands.sendHapticFeedback(options);
}

export function sendLightImpactHaptic(): void {
  sendHapticFeedback({ hapticsType: 'impact', style: 'light' });
}

export function sendSuccessNotificationHaptic(): void {
  sendHapticFeedback({ hapticsType: 'notification', style: 'success' });
}

export function sendSelectionHaptic(): void {
  sendHapticFeedback({ hapticsType: 'selection-changed' });
}
