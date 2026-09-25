import { useEffect } from 'react';
import confetti from 'canvas-confetti';
import { useTranslation } from 'react-i18next';
import ModalCard from '@/components/ModalCard';
import { GiftIcon } from '@/components/ui/icons';
import { useFormatters } from '@/lib/format';

type ClaimSuccessModalProps = {
  points: number;
  onClose: () => void;
};

/**
 * Points landed.
 *
 * On the shared modal chassis rather than its own: this pops out of the
 * rewards screen and the receipts list, both of which were rebuilt, and it was
 * still a 32px pill card with a lime-green tick and three floating PNG
 * sparkles left over from the Kaia build.
 *
 * The confetti stays. It is the one moment in the app where something is
 * simply good news, and the rest of the product is deliberately quiet enough
 * that it costs nothing to say so here.
 */
function ClaimSuccessModal({ points, onClose }: ClaimSuccessModalProps) {
  const { t } = useTranslation();
  const fmt = useFormatters();

  useEffect(() => {
    const timeout = setTimeout(() => {
      confetti({
        particleCount: 160,
        spread: 80,
        origin: { y: 0.4 },
        // The product's two colours and its near-black. The default palette is
        // a rainbow, which is the only place in the app that would be.
        colors: ['#00A06A', '#E8833A', '#191F28'],
      });
    }, 150);

    return () => clearTimeout(timeout);
  }, []);

  return (
    <ModalCard
      onClose={onClose}
      icon={
        <span className="flex h-[60px] w-[60px] items-center justify-center rounded-[20px] bg-[#FFF1E6] text-[#E8833A]">
          <GiftIcon />
        </span>
      }
      title={t('{{points}} Points Claimed.', { points: fmt.number(points) })}
      description={
        <>
          {t('L-vU6og8Va')}
          <br />
          {t('L-RVS9Ayhl')}
        </>
      }
      actions={[{ label: t('L-sf2kdr9c'), tone: 'primary', onClick: onClose }]}
    />
  );
}

export default ClaimSuccessModal;
