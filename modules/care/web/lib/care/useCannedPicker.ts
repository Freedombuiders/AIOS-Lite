// State machine of the canned-reply picker: opens on a `/` at the start of a line (or from the `/` button), filters as the
// owner types, moves with the arrow keys, inserts with Enter/Tab/click. The text itself stays owned by the composer.

import { useRef, useState } from 'preact/hooks';
import { applyCanned, cannedBody, detectSlash, filterCanned } from './canned';
import type { CareApiChannel, CareCannedReplyDto } from './dto';

export function useCannedPicker(args: {
  items: CareCannedReplyDto[];
  channel: CareApiChannel;
  text: string;
  setText: (text: string) => void;
}) {
  const { items, channel, text, setText } = args;
  const ta = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [buttonOpen, setButtonOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const trigger = detectSlash(text, caret);
  const triggerKey = trigger ? `${trigger.start}:${trigger.query}` : null;
  const matches = filterCanned(items, trigger?.query ?? '');
  const typedOpen = trigger !== null && triggerKey !== dismissed && matches.length > 0;
  const open = typedOpen || buttonOpen;
  const active = Math.min(index, Math.max(0, matches.length - 1));

  function syncCaret(): void {
    const el = ta.current;
    if (el) setCaret(el.selectionStart ?? text.length);
  }

  function close(): void {
    setButtonOpen(false);
    setDismissed(triggerKey);
  }

  function choose(item: CareCannedReplyDto): void {
    const el = ta.current;
    const at = el?.selectionStart ?? caret;
    const next = applyCanned(text, at, trigger, cannedBody(item, channel));
    setText(next.text);
    setButtonOpen(false);
    setDismissed(null);
    setIndex(0);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  }

  /** True when the key was used by the picker (the caller must not treat it as typing / send). */
  function onKeyDown(e: KeyboardEvent): boolean {
    if (!open || e.isComposing) return false;
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    if (matches.length === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
      e.preventDefault();
      choose(matches[active]);
      return true;
    }
    return false;
  }

  return {
    ta, open, matches, active, trigger, buttonOpen,
    syncCaret, onKeyDown, choose, close,
    setActive: setIndex,
    toggleButton: () => { setButtonOpen((o) => !o); setIndex(0); ta.current?.focus(); },
  };
}

export type CannedPicker = ReturnType<typeof useCannedPicker>;
