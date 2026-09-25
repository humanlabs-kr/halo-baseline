import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

type ModalAction = {
  label: string;
  onClick: () => void;
  tone?: 'primary' | 'secondary';
};

type ModalCardProps = {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  actions?: ModalAction[];
  footer?: ReactNode;
  onClose?: () => void;
};

/**
 * The chassis every modal in the app sits in.
 *
 * On the app's own radius and its own buttons. It used to be a 32px pill card
 * with `bg-black` and `bg-slate-100` actions, which is a different app's
 * modal appearing on top of this one's screens — and a modal is the one
 * surface a user cannot look away from while they decide.
 */
function ModalCard({ icon, title, description, actions = [], footer, onClose }: ModalCardProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#191F28]/60 px-5"
      style={{ zIndex: 60 }}
      onClick={() => onClose?.()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="animate-rise w-full rounded-[20px] bg-white px-5 pt-6 pb-5 text-center text-[#191F28] shadow-[0_8px_40px_rgba(25,31,40,.22)]"
        onClick={(event) => event.stopPropagation()}
      >
        {icon && (
          <div className="mx-auto mb-4 flex h-[60px] w-[60px] items-center justify-center">
            {icon}
          </div>
        )}
        <div className="space-y-2">
          <h2 className="break-keep text-[20px] font-extrabold tracking-[-.035em]">{title}</h2>
          {description && (
            <div className="break-keep text-[14.5px] leading-[1.55] font-medium text-[#8B95A1]">
              {description}
            </div>
          )}
        </div>
        {Boolean(actions.length) && (
          <div className="mt-6 flex flex-col gap-2.5">
            {actions.map(({ label, tone = 'secondary', onClick }) => (
              <Button key={label} variant={tone === 'primary' ? 'primary' : 'ghost'} onClick={onClick}>
                {label}
              </Button>
            ))}
          </div>
        )}
        {footer && <div className="mt-3">{footer}</div>}
      </div>
    </div>
  );
}

export default ModalCard;
