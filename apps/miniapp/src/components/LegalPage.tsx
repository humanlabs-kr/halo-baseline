import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TopBar } from '@/components/ledger/TopBar';

/**
 * The chassis the two legal pages sit in.
 *
 * Legal copy is the one place this app writes 합니다체 rather than 해요체, and
 * the one place a sentence is allowed to be long. Everything else — the bar,
 * the measure, the palette — is the app's, because a policy that looks like it
 * came from somewhere else reads like boilerplate nobody chose.
 *
 * `updated` is a prop rather than a constant so the two pages cannot drift to
 * different dates by being edited on different days.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  // Not shown to an English reader. The line is there to be honest about a
  // translation, and printing it on the page it says governs is the one place
  // it becomes a lie — no locale file can fix that, because the sentence is
  // correct in every locale except the source one.
  const translated = !i18n.resolvedLanguage?.startsWith('en');

  return (
    <div className="flex min-h-full flex-col bg-white pb-10 text-[#191F28]">
      <TopBar title={title} back fallback="/" />
      <p className="px-5 pt-1 text-[13px] font-medium text-[#8B95A1]">
        {t('Last updated {{date}}', { date: updated })}
      </p>
      <div className="mt-6 space-y-7 px-5">{children}</div>
      {/* Said plainly rather than buried. A translated policy that silently
          governs is worse than an English one that admits it does not. */}
      {translated && (
        <p className="mt-10 px-5 text-[12.5px] leading-[1.6] font-medium text-[#B0B8C1]">
          {t('Translated for convenience. The English version governs.')}
        </p>
      )}
    </div>
  );
}

/** One numbered clause: a heading and its paragraphs. */
export function Clause({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="break-keep text-[16px] font-bold tracking-[-.03em]">{heading}</h2>
      <div className="space-y-2 break-keep text-[14.5px] leading-[1.65] font-medium text-[#4E5968]">
        {children}
      </div>
    </section>
  );
}

/** A list inside a clause. */
export function Points({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5 pt-0.5">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2">
          <span aria-hidden className="mt-[9px] h-[3px] w-[3px] shrink-0 rounded-full bg-[#B0B8C1]" />
          <span className="min-w-0 flex-1">{item}</span>
        </li>
      ))}
    </ul>
  );
}
