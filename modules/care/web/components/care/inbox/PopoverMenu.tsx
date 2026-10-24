import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * A button that opens a small menu. Closes on Escape (focus returns to the button) and on a click outside; arrow keys
 * move between the items, which are plain buttons with role="menuitem" / "menuitemradio" supplied by the caller.
 */
export function PopoverMenu({ label, className, content, children, testId, disabled, align = 'right', menuLabel }: {
  /** Accessible name of the opening button. */
  label: string;
  className?: string;
  /** What the button shows. */
  content: ComponentChildren;
  children: (close: () => void) => ComponentChildren;
  testId?: string;
  disabled?: boolean;
  align?: 'left' | 'right';
  menuLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Keyboard users land on the first item. Layout effect: it must run at commit, before a fast Escape can close the menu.
  useLayoutEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function close(): void {
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (!open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next].focus();
  }

  return (
    <div class="care-pop" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        class={className ?? 'care-pop-button'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
      >
        {content}
      </button>
      {open && (
        <div class={`care-pop-menu is-${align}`} role="menu" aria-label={menuLabel ?? label} ref={menu}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
