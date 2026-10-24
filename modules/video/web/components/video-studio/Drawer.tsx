import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { X } from 'lucide-preact';

/** Left drawer used by the narrow layout of the studio (profiles and projects list). */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ComponentChildren }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      <div class={`viewport-overlay fixed inset-0 z-[80] bg-black/50 transition-opacity ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`} onClick={onClose} />
      <div
        role="dialog"
        aria-label={title}
        aria-hidden={!open}
        class={`fixed inset-y-0 left-0 z-[81] flex w-[min(340px,92vw)] flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl transition-transform ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div class="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2.5">
          <h2 class="m-0 text-[13px] font-semibold">{title}</h2>
          <button type="button" class="control-button control-sm" style={{ width: '24px', padding: 0 }} aria-label="Đóng" onClick={onClose}><X size={13} /></button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">{open ? children : null}</div>
      </div>
    </>
  );
}
