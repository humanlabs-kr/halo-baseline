/**
 * The icon set, inline.
 *
 * Lucide outlines at the two weights the mock-up uses. Inline rather than a
 * package because the app ships eleven of them and pulling a whole icon
 * library into a mini-app bundle for eleven paths is a cost the user pays in
 * load time on a mid-range Android.
 */
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden width={size} height={size} {...S}>
      {d.split('|').map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

export const BasketIcon = () => <Icon d="M5 11h14l-1.2 7.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z|M9 11L7.5 4|M15 11l1.5-7|M3 11h18" />;
export const BoxIcon = () => <Icon d="M21 8l-9-5-9 5 9 5 9-5z|M3 8v8l9 5 9-5V8|M12 13v8" />;
export const QuestionIcon = () => <Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3|M12 17h.01" />;
export const ReceiptIcon = () => <Icon d="M4 2v20l2-1.5L8 22l2-1.5L12 22l2-1.5L16 22l2-1.5L20 22V2l-2 1.5L16 2l-2 1.5L12 2l-2 1.5L8 2 6 3.5z|M8 7h8|M8 11h8|M8 15h5" />;
export const CameraIcon = () => <Icon d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4z|M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />;
export const GiftIcon = () => <Icon d="M20 12v10H4V12|M2 7h20v5H2z|M12 22V7|M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z|M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />;
export const WheatIcon = () => <Icon d="M2 22l10-10|M16 8l-1.4 1.4a2 2 0 0 1-2.8 0L10.4 8a2 2 0 0 1 0-2.8L11.8 4|M20 12l-1.4 1.4a2 2 0 0 1-2.8 0L14.4 12a2 2 0 0 1 0-2.8L15.8 8|M22 16l-1.4 1.4a2 2 0 0 1-2.8 0L16.4 16a2 2 0 0 1 0-2.8L17.8 12" />;
export const EggIcon = () => <Icon d="M12 22c4 0 7-3.1 7-7 0-5-3.5-13-7-13S5 10 5 15c0 3.9 3 7 7 7z" />;
export const BottleIcon = () => <Icon d="M10 2h4v3.2a4 4 0 0 0 .9 2.5l1.2 1.5a4 4 0 0 1 .9 2.5V20a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8.3a4 4 0 0 1 .9-2.5l1.2-1.5A4 4 0 0 0 10 5.2z" />;
export const BreadIcon = () => <Icon d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 0 8v4a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-4a4 4 0 0 1-2-4z" />;
export const SugarIcon = () => <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M14.1 10.4L19 6l1 4-4 1|M9.9 13.6L5 18l-1-4 4-1" />;
export const SoapIcon = () => <Icon d="M7 16.3C7 19.5 9.2 22 12 22s5-2.5 5-5.7c0-3.3-5-11.3-5-11.3s-5 8-5 11.3z" />;
export const NoodleIcon = () => <Icon d="M3 12h18|M4 12a8 8 0 0 0 16 0|M7 12V8|M12 12V6|M17 12V8" />;
export const CalendarCheckIcon = () => <Icon d="M8 2v4|M16 2v4|M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z|M3 10h18|M9 16l2 2 4-4" />;
export const TicketIcon = () => <Icon d="M2 9a3 3 0 0 0 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z|M13 5v2|M13 11v2|M13 17v2" />;
export const HistoryIcon = () => <Icon d="M3 12a9 9 0 1 0 2.6-6.4L3 8|M3 3v5h5|M12 7v5l3.5 2" />;
// The camera screen and the verified-email screen used to draw these three as
// `<img src="/fi_check.svg">` and friends, whose stroke colour is baked into
// the file: a white camera glyph landed on a white shutter and disappeared.
// Inline they inherit `currentColor`, so the surface decides.
export const CloseIcon = () => <Icon d="M18 6L6 18|M6 6l12 12" />;
export const InfoIcon = () => <Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 16v-4|M12 8h.01" />;
// Sized, unlike the rest of the set: the same tick is a 14px pip on a scan
// step dot and a 36px mark on the verified-email tile.
export const CheckIcon = ({ size = 20 }: { size?: number }) => <Icon d="M20 6L9 17l-5-5" size={size} />;
export const RefreshIcon = () => <Icon d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16|M3 21v-5h5" />;
export const PlusIcon = () => <Icon d="M12 5v14|M5 12h14" />;
export const MinusIcon = () => <Icon d="M5 12h14" />;
// A trend, not a direction. These were an arrow running into a bar — the
// "log in" glyph — and rendered on the scan screen as something that looked
// like a return key sitting over the sentence "you paid less than most".
export const DownIcon = () => <Icon d="M22 17L13.5 8.5 8.5 13.5 2 7|M16 17h6v-6" size={22} />;
export const UpIcon = () => <Icon d="M22 7l-8.5 8.5-5-5L2 18|M16 7h6v6" size={22} />;
export const EqualIcon = () => <Icon d="M5 9h14|M5 15h14" size={22} />;
