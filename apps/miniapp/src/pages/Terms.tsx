import { useTranslation } from 'react-i18next';
import { Clause, LegalPage, Points } from '@/components/LegalPage';
import { SUPPORT_EMAIL } from '@/lib/env';

/**
 * Terms of service.
 *
 * Two things were wrong with the version this replaces, and neither was the
 * styling. It said points are "tracked on the Celo blockchain" to users on
 * three chains, and it disclaimed affiliation with Opera and MiniPay to
 * everyone — including the World and Kaia users for whom that sentence is
 * about a product they have never seen. And it described a receipt-scanning
 * rewards app, which this has not been since it started reading what is on the
 * receipt and publishing prices from it.
 *
 * Written in English and translated, with the English governing. A machine
 * translation of a liability clause that silently governs is a worse outcome
 * than an English one a reader has to work through.
 */
function Terms() {
  const { t } = useTranslation();

  return (
    <LegalPage title={t('Terms of Service')} updated={t('September 2026')}>
      <Clause heading={t('1. Acceptance')}>
        <p>
          {t(
            'By using Halo you agree to these terms. Halo is operated by Human Labs. If you do not agree to these terms, do not use Halo.',
          )}
        </p>
      </Clause>

      <Clause heading={t('2. What Halo does')}>
        <p>
          {t(
            'Halo reads the receipts you photograph: the shop, the date, the total, and each line on the receipt. It keeps those as your household ledger, and it pools the line items with everyone else’s to work out what groceries cost in your country. You earn points for each receipt you send.',
          )}
        </p>
      </Clause>

      <Clause heading={t('3. Eligibility')}>
        <p>{t('You must be 18 or older to use Halo.')}</p>
      </Clause>

      <Clause heading={t('4. Your side of it')}>
        <Points
          items={[
            t('Send your own receipts, as printed.'),
            t('Do not send the same receipt twice, and do not alter one before sending it.'),
            t('Keep your wallet credentials to yourself. Anyone holding them is you, as far as Halo can tell.'),
            t('Use Halo within the law where you are.'),
          ]}
        />
      </Clause>

      <Clause heading={t('5. Points')}>
        <p>
          {t(
            'Points are not transferable and have no cash value. They are recorded against your wallet address on the blockchain your wallet belongs to, which for most users is the chain the app you opened Halo in runs on.',
          )}
        </p>
        <p>
          {t(
            'Human Labs may change how points are awarded, refuse a receipt that cannot be read or has already been sent, and take back points obtained by sending receipts that are not genuine.',
          )}
        </p>
      </Clause>

      <Clause heading={t('6. Prices shown to you')}>
        <p>
          {t(
            'The price Halo shows for an item is a median of what other shoppers in your country paid, and it is withheld until enough separate receipts carry that item. It is a description of receipts we have read, not advice, and not a claim about any particular shop.',
          )}
        </p>
      </Clause>

      <Clause heading={t('7. Intellectual property')}>
        <p>{t('Halo and everything in it belongs to Human Labs.')}</p>
      </Clause>

      <Clause heading={t('8. No warranty')}>
        <p>
          {t(
            'Halo is provided as it is. Human Labs does not promise it will always be available or always correct, and is not responsible for points or data lost to a technical fault.',
          )}
        </p>
      </Clause>

      <Clause heading={t('9. Limit of liability')}>
        <p>
          {t(
            'To the extent the law allows, Human Labs is not liable for indirect, incidental, special or consequential damage arising from your use of Halo.',
          )}
        </p>
      </Clause>

      <Clause heading={t('10. Who operates Halo')}>
        <p>
          {t(
            'Halo is operated by Human Labs. It is not operated by, affiliated with, or endorsed by the wallet or the app store you reached it through.',
          )}
        </p>
      </Clause>

      <Clause heading={t('11. Changes')}>
        <p>
          {t('These terms may change. Continuing to use Halo after a change means you accept it.')}
        </p>
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

export default Terms;
