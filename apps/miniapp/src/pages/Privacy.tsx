import { useTranslation } from 'react-i18next';
import { Clause, LegalPage, Points } from '@/components/LegalPage';
import { SUPPORT_EMAIL } from '@/lib/env';

/**
 * Privacy policy.
 *
 * The version this replaces listed what we collect as "merchant name, date,
 * and total amount" — which stopped being true the day the app started reading
 * every line off the receipt, keeping what was bought, and pooling those lines
 * into a price index other people are shown. That is the single most
 * privacy-relevant thing this product does and the policy did not mention it.
 *
 * It also said "your Celo wallet address" and "recorded on the Celo
 * blockchain" to an app that runs on three chains.
 *
 * The clause about the index says what actually protects the reader: the lines
 * are pooled by country and category with nothing identifying attached, a
 * price is only published once enough separate receipts carry the item, and a
 * reader's own receipts are excluded from the figure they are compared
 * against. Those are the properties of the query, not promises — see
 * `apps/api/src/lib/market.ts`.
 */
function Privacy() {
  const { t } = useTranslation();

  return (
    <LegalPage title={t('Privacy Policy')} updated={t('September 2026')}>
      <Clause heading={t('1. Who we are')}>
        <p>
          {t(
            'Halo is operated by Human Labs. This policy says what Halo collects, what it does with it, and what you can ask us to do about it.',
          )}
        </p>
      </Clause>

      <Clause heading={t('2. What we collect')}>
        <Points
          items={[
            t('Your wallet address. It is the only identifier Halo has for you — there is no name, no email and no phone number unless you give us one.'),
            t('The photograph of each receipt you send.'),
            t('What we read off it: the shop, the date, the total, and every line — what was bought, how much of it, and what it cost.'),
            t('Your point balance and the on-chain transactions that claim it.'),
            t('Which screens you open, so we can tell which parts of Halo are worth keeping.'),
          ]}
        />
      </Clause>

      <Clause heading={t('3. What we do with it')}>
        <Points
          items={[
            t('Build your ledger — the months, the categories and the prices that are yours.'),
            t('Award points, and refuse a receipt that has already been sent.'),
            t('Work out what groceries cost in your country, from everyone’s lines together.'),
          ]}
        />
      </Clause>

      <Clause heading={t('4. The price index')}>
        <p>
          {t(
            'The lines Halo reads off your receipts go into a pool, grouped by country and by item. Nothing identifying you goes with them.',
          )}
        </p>
        <p>
          {t(
            'A price is only published once enough separate receipts carry that item, so no single shopper’s prices can be read back out of it. Your own receipts are left out of the figure you are compared against — otherwise a frequent buyer would be measured mostly against themselves.',
          )}
        </p>
        <p>
          {t(
            'Nobody sees your receipts, your shops or your totals. What other people see is a median, drawn from many households.',
          )}
        </p>
      </Clause>

      <Clause heading={t('5. Where it is kept')}>
        <p>
          {t(
            'On Cloudflare infrastructure. Receipt photographs are held in encrypted object storage and are not public.',
          )}
        </p>
      </Clause>

      <Clause heading={t('6. What is on the blockchain')}>
        <p>
          {t(
            'Point claims are recorded on the blockchain your wallet belongs to. That record is public and permanent: your wallet address and the points claimed against it can be read by anyone. Your receipts, their contents and your ledger are not on any blockchain.',
          )}
        </p>
      </Clause>

      <Clause heading={t('7. Who else sees it')}>
        <p>{t('We do not sell your information. We share it only with:')}</p>
        <Points
          items={[
            t('The providers that run Halo for us — hosting, storage, and the model that reads a receipt.'),
            t('Law enforcement, where the law requires it.'),
          ]}
        />
      </Clause>

      <Clause heading={t('8. How long we keep it')}>
        <p>
          {t(
            'For as long as your account is in use. Receipt photographs are kept after that as well, because the same receipt being sent twice is the fraud this depends on catching.',
          )}
        </p>
      </Clause>

      <Clause heading={t('9. What you can ask for')}>
        <p>
          {t(
            'Write to us and you can have a copy of your data, a correction to it, or its deletion. Two things cannot be undone: a point claim already written to a blockchain, and a line already pooled into a published median, which by then is part of a figure with no way back to you.',
          )}
        </p>
      </Clause>

      <Clause heading={t('10. Children')}>
        <p>
          {t('Halo is not for anyone under 18, and we do not knowingly collect anything from a child.')}
        </p>
      </Clause>

      <Clause heading={t('11. Changes')}>
        <p>{t('If this policy changes in a way that matters, Halo will tell you inside the app.')}</p>
      </Clause>

      <Clause heading={t('12. Contact')}>
        <p>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="font-bold text-[#191F28] underline">
            {SUPPORT_EMAIL}
          </a>
        </p>
      </Clause>
    </LegalPage>
  );
}

export default Privacy;
