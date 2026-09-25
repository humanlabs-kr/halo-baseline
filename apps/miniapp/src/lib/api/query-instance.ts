import { QueryClient } from '@tanstack/react-query';

/**
 * The app's single `QueryClient`.
 *
 * It lives here rather than in `main.tsx` so the defaults sit next to the
 * hooks in `queries.ts` that inherit them — a retry policy set three files
 * away from the queries it governs is one nobody rereads.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // These screens read money-shaped state; a stale retry loop against a
      // failing endpoint is worse than showing the error once.
      retry: false,
    },
  },
});
