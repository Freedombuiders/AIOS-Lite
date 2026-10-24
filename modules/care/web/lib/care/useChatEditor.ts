// State behind the Zalo reply box editor: formatting toolbar (acts on the textarea selection), insert-at-caret (emoji, "@"),
// and the @mention picker (groups only). The text, styles and mentions live in the composer draft; every change goes
// through the pure helpers in zaloEdit.ts so the three stay aligned.

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { setExclusive, toggleInline, toggleList } from '@/lib/richText';
import type { ChatDraft, ComposerDraft } from './composer';
import type { CareMessageDto } from './dto';
import {
  detectMention, editText, fieldsOf, filterMentions, insertMention, insertText, mentionCandidates, patchChatFields, setStyles,
  type MentionCandidate, type RichFields,
} from './zaloEdit';

export function useChatEditor(args: {
  ta: RefObject<HTMLTextAreaElement>;
  draft: ChatDraft | null;
  update: (fn: (d: ComposerDraft) => ComposerDraft) => void;
  maxLength?: number;
  /** @mention only exists in group conversations. */
  isGroup: boolean;
  messages: CareMessageDto[];
  allLabel: string;
}) {
  const { ta, draft, update, maxLength, isGroup, messages, allLabel } = args;
  const text = draft?.text ?? '';
  const styles = draft?.styles ?? [];
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [formatHint, setFormatHint] = useState(false);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const candidates = useMemo(() => (isGroup ? mentionCandidates(messages) : []), [isGroup, messages]);

  useEffect(() => {
    if (!formatHint) return undefined;
    const t = setTimeout(() => setFormatHint(false), 2500);
    return () => clearTimeout(t);
  }, [formatHint]);

  function patch(fn: (f: RichFields) => RichFields): void {
    update((d) => patchChatFields(d, fn));
  }

  function readSel(): { start: number; end: number } {
    const el = ta.current;
    return { start: el?.selectionStart ?? text.length, end: el?.selectionEnd ?? text.length };
  }

  /** Call on every caret / selection move (keyup, click, select, input). */
  function syncSel(): void {
    setSel(readSel());
  }

  /** Puts the caret back after a programmatic edit, once the textarea has the new value. */
  function afterEdit(caret: number): void {
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      setSel({ start: caret, end: caret });
    });
  }

  const setText = (v: string): void => patch((f) => editText(f, v));

  // ── formatting (toolbar acts on the selection) ──────────────────────────────────────────────
  function withSelection(apply: (f: RichFields, start: number, end: number) => RichFields): void {
    const { start, end } = readSel();
    if (end <= start) { setFormatHint(true); return; }
    patch((f) => apply(f, start, end));
    ta.current?.focus();
  }
  const inline = (st: string): void => withSelection((f, a, b) => setStyles(f, toggleInline(f.styles, st, a, b)));
  const exclusive = (prefix: 'c_' | 'f_', st: string | null): void => withSelection((f, a, b) => setStyles(f, setExclusive(f.styles, prefix, st, a, b)));
  function list(st: 'lst_1' | 'lst_2'): void {
    const { start, end } = readSel();
    patch((f) => setStyles(f, toggleList(f.styles, f.text, st, start, end)));
    ta.current?.focus();
  }

  // ── insert at the caret (emoji, "@") ────────────────────────────────────────────────────────
  function insertAtCaret(insert: string): void {
    const { start, end } = readSel();
    let caret = -1;
    patch((f) => {
      const r = insertText(f, start, end, insert, maxLength);
      if (!r) return f;
      caret = r.caret;
      return r.fields;
    });
    if (caret >= 0) afterEdit(caret);
  }

  /** The "@" tool button: types an `@` at the caret, which opens the picker. */
  function startMention(): void {
    const { start } = readSel();
    insertAtCaret(start > 0 && !/\s/.test(text[start - 1] ?? '') ? ' @' : '@');
  }

  // ── @mention picker ─────────────────────────────────────────────────────────────────────────
  const trigger = isGroup ? detectMention(text, sel.start) : null;
  const triggerKey = trigger ? `${trigger.start}:${trigger.query}` : null;
  const matches: MentionCandidate[] = trigger ? filterMentions(candidates, trigger.query, allLabel) : [];
  const mentionOpen = trigger !== null && triggerKey !== dismissed && matches.length > 0;
  const active = Math.min(index, Math.max(0, matches.length - 1));

  function chooseMention(c: MentionCandidate): void {
    if (!trigger) return;
    const at = ta.current?.selectionStart ?? sel.start;
    let caret = -1;
    patch((f) => {
      const r = insertMention(f, trigger, at, c, maxLength);
      if (!r) return f;
      caret = r.caret;
      return r.fields;
    });
    setIndex(0);
    setDismissed(null);
    if (caret >= 0) afterEdit(caret);
  }

  /** True when the key belonged to the mention picker (arrows / Enter / Tab / Escape while it is open). */
  function onMentionKey(e: KeyboardEvent): boolean {
    if (!mentionOpen || e.isComposing) return false;
    if (e.key === 'Escape') { e.preventDefault(); setDismissed(triggerKey); return true; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
      e.preventDefault();
      chooseMention(matches[active]);
      return true;
    }
    return false;
  }

  /** Ctrl/Cmd + B / I / U. True when handled. */
  function onShortcut(e: KeyboardEvent): boolean {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
    const st = ({ b: 'b', i: 'i', u: 'u' } as Record<string, string>)[e.key.toLowerCase()];
    if (!st) return false;
    e.preventDefault();
    inline(st);
    return true;
  }

  return {
    text, styles, mentions: draft ? fieldsOf(draft).mentions : [], sel, formatHint, setText, syncSel,
    inline, exclusive, list, insertAtCaret, startMention, onShortcut,
    mention: { open: mentionOpen, matches, active, setActive: setIndex, choose: chooseMention, onKeyDown: onMentionKey },
  };
}

export type ChatEditor = ReturnType<typeof useChatEditor>;
