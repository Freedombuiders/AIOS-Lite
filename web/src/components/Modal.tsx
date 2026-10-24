import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { X } from 'lucide-preact';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number;
  height?: string;
  bodyClassName?: string;
  closeDisabled?: boolean;
  dismissOnBackdrop?: boolean;
  children: ComponentChildren;
  footer?: ComponentChildren;
}

export function Modal({ open, onClose, title, width = 480, height, bodyClassName = '', closeDisabled, dismissOnBackdrop = true, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !closeDisabled) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeDisabled, onClose]);

  if (!open) return null;
  return (
    <div
      class="viewport-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (dismissOnBackdrop && !closeDisabled && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        class="card flex max-h-full w-full flex-col shadow-2xl"
        style={{ maxWidth: `${width}px`, height }}
      >
        <div class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <h2 class="m-0 text-[13px] font-semibold">{title}</h2>
          <button type="button" class="control-button control-sm" style={{ width: '24px', padding: 0 }} aria-label="Đóng" disabled={closeDisabled} onClick={onClose}>
            <X size={13} />
          </button>
        </div>
        <div class={`min-h-0 flex-1 overflow-y-auto p-4 ${bodyClassName}`}>{children}</div>
        {footer && <div class="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}
