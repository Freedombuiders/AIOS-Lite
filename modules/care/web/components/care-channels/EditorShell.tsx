import type { ComponentChildren } from 'preact';
import { X } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import { Modal } from '@/components/Modal';

/** A select popup that is open must see Escape first (same rule as Modal). */
function hasOpenSelect(): boolean {
  return CSS.supports('selector(select:open)') && document.querySelector('select:open') !== null;
}

/** Right-hand drawer (a bottom sheet on a phone). Focus moves in on open and back to the opener on close. */
export function SideDrawer({ title, width = 560, onClose, footer, children, testId }: {
  title: string; width?: number; onClose: () => void; footer?: ComponentChildren; children: ComponentChildren; testId?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // focus the dialog itself unless something inside already has focus (a field typed into while it opened)
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus();
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      if (e.key === 'Escape' && !hasOpenSelect()) { e.preventDefault(); closeRef.current(); }
      if (e.key === 'Tab' && panel.current) {
        const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter((el) => el.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) { e.preventDefault(); panel.current.focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (opener?.isConnected) opener.focus(); };
  }, []);
  return (
    <div class="cch-drawer-overlay" onClick={onClose}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} class="cch-drawer" style={{ width: `${width}px` }} data-testid={testId} onClick={(e) => e.stopPropagation()}>
        <header class="cch-drawer-head">
          <h2>{title}</h2>
          <button type="button" class="care-icon-button" onClick={onClose} aria-label="Close"><X size={15} aria-hidden="true" /></button>
        </header>
        <div class="cch-drawer-body">{children}</div>
        {footer && <footer class="cch-drawer-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export type EditorPresentation = 'modal' | 'drawer';

/** The frame of an assignment editor: a centred dialog on the legacy screens, a side drawer on the channels page. */
export function EditorShell({ presentation = 'modal', title, width = 620, onClose, footer, children }: {
  presentation?: EditorPresentation; title: string; width?: number; onClose: () => void; footer: ComponentChildren; children: ComponentChildren;
}) {
  if (presentation === 'drawer') return <SideDrawer title={title} width={width} onClose={onClose} footer={footer} testId="cch-rule-drawer">{children}</SideDrawer>;
  return <Modal open onClose={onClose} title={title} width={width} footer={footer}>{children}</Modal>;
}
