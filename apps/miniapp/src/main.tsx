import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { WagmiProvider } from 'wagmi';
import App from '@/App';
import { queryClient } from '@/lib/api/query-instance';
import { GA_MEASUREMENT_ID } from '@/lib/constants';
import { IS_DEV } from '@/lib/env';
import { detectPlatform } from '@/lib/platform';
import { getWagmiConfig } from '@/lib/wagmi';
import '@/lib/i18n';
import '@/index.css';

declare global {
  interface Window {
    /** gtag.js command queue, created by the snippet below. */
    dataLayer?: unknown[];
  }
}

/**
 * Load Google Analytics for whichever product this host is serving.
 *
 * Each chain reports into its own GA4 property (see `GA_MEASUREMENT_ID`). The
 * three apps used to be three HTML files with the tag hardcoded in each; there
 * is one HTML file now, so the tag has to be chosen at runtime from the host.
 *
 * Skipped outside production. Dev and staging traffic in a property makes its
 * conversion and retention numbers wrong in a way nobody notices until a
 * decision has already been made on them.
 */
function loadAnalytics(): void {
  if (IS_DEV) return;

  const platform = detectPlatform();
  // An unrecognised host has no property to report to, and inventing one would
  // file the traffic under the wrong product.
  if (!platform) return;

  const measurementId = GA_MEASUREMENT_ID[platform];

  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(tag);

  // gtag's contract is positional: each call is pushed to the queue as one
  // argument list, which gtag.js reads back by index once it loads.
  const dataLayer = (window.dataLayer ??= []);
  function gtag(...args: unknown[]): void {
    dataLayer.push(args);
  }
  gtag('js', new Date());
  gtag('config', measurementId);
}

loadAnalytics();

// Mini apps run inside a wallet webview with no devtools. eruda is an on-screen
// console; the dynamic import keeps it out of the production bundle entirely.
if (IS_DEV) {
  // Optional: a failed load (offline, blocked) must not take the app with it.
  void import('eruda')
    .then(({ default: eruda }) => eruda.init())
    .catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={getWagmiConfig()}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <Toaster position="top-center" />
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
