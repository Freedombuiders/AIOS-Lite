import { X } from 'lucide-preact';
import { dismissToast, toasts } from '@/lib/toasts';

const BAR: Record<string, string> = {
  success: 'var(--color-status-done)',
  error: 'var(--color-status-failed)',
  warn: 'var(--color-status-review)',
  info: 'var(--color-status-running)',
  neutral: 'var(--color-border-strong)',
};

export function ToastHost() {
  return (
    <div class="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class="card pointer-events-auto flex items-start gap-2 p-2.5 shadow-xl" style={{ borderLeft: `3px solid ${BAR[t.tone]}` }}>
          <div class="min-w-0 flex-1">
            <div class="text-[12px] font-medium">{t.title}</div>
            {t.description && <div class="hint mt-0.5 break-words">{t.description}</div>}
            {t.action && (
              <button type="button" class="control-button mt-1.5" onClick={() => { const a = t.action; dismissToast(t.id); void a?.onClick(); }}>
                {t.action.label}
              </button>
            )}
          </div>
          <button type="button" class="border-0 bg-transparent p-0 text-[var(--color-text-faint)] cursor-pointer" aria-label="Đóng" onClick={() => dismissToast(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
