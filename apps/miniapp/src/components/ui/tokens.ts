/**
 * The app's surface, in one place.
 *
 * Every screen used to open-code its own greys, and the result was a ledger
 * that looked like a printed document rather than an app: thermal-paper
 * backgrounds, monospaced money, rotated ink-stamp icons, torn edges on the
 * chrome itself. That is a document design system, and it is not what a phone
 * app looks like.
 *
 * These values are read off the approved mock-up, which was in turn read off
 * Toss, KakaoPay and mmm가계부. The rules those three share and this app now
 * follows:
 *
 *   - White background. No texture, anywhere.
 *   - Depth comes from a tinted surface, not a shadow. Korean apps almost
 *     never draw shadows on list rows.
 *   - Numbers are set in the body typeface. Monospace is for documents.
 *   - Colour carries meaning and nothing else. There are exactly two:
 *     saved and overpaid. Everything else is neutral, and the primary action
 *     is the product's own near-black — deliberately not Toss blue, because
 *     borrowing a palette makes an app look like that app.
 */
export const C = {
  bg: '#FFFFFF',
  surface: '#F9FAFB',
  fill: '#F2F4F6',
  ink: '#191F28',
  ink2: '#4E5968',
  muted: '#8B95A1',
  faint: '#B0B8C1',
  hair: '#C4CBD3',
  saved: '#00A06A',
  savedBg: '#E7F8F1',
  savedCard: '#F0FAF6',
  over: '#F04452',
  overBg: '#FFEBEE',
  overCard: '#FFF4F5',
} as const;
