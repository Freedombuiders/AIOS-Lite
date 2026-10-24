import { Paperclip, X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, RefObject } from 'preact';
import { PlaceholderText } from './PlaceholderText';
import { formatBytes } from '@modules/care/web/lib/care/timeFormat';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { ChatAttachment } from '@modules/care/web/lib/care/composer';
import type { CareApiChannel } from '@modules/care/web/lib/care/dto';
import { countPlaceholders, nextPlaceholder } from '@modules/care/web/lib/care/placeholders';
import type { CannedPicker } from '@modules/care/web/lib/care/useCannedPicker';
import { EMOJI_CATEGORIES } from '@modules/care/web/lib/care/emoji';
import { MENTION_ALL_UID, type MentionCandidate } from '@modules/care/web/lib/care/zaloEdit';

export type ComposerTab = 'reply' | 'note';

/** Trả lời / Ghi chú nội bộ, with a note on the right ("Gửi từ ..." or "Chỉ người trong FreedomOS thấy"). */
export function ComposerTabs({ channel, tab, onTab, right }: { channel: CareApiChannel; tab: ComposerTab; onTab: (t: ComposerTab) => void; right?: ComponentChildren }) {
  const tabs: Array<[ComposerTab, string]> = [
    ['reply', channel === 'email' ? ct('inbox2.composer.tabReplyEmail') : ct('inbox2.composer.tabReply', { channel: ct(`channel.${channel}`) })],
    ['note', ct('inbox2.composer.tabNote')],
  ];
  return (
    <div class="care-ctabs">
      <div role="tablist" aria-label={ct('inbox2.composer.tabs')} class="care-ctabs-list">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} class={`care-ctab is-${id}${tab === id ? ' is-on' : ''}`} data-testid={`care-composer-tab-${id}`} onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {right && <span class="care-ctabs-right">{right}</span>}
    </div>
  );
}

/** Menu of canned replies, anchored to the composer. */
export function CannedMenu({ picker, id, hasItems }: { picker: CannedPicker; id: string; hasItems: boolean }) {
  if (!picker.open) return null;
  return (
    <div class="care-canned" role="listbox" id={id} aria-label={ct('inbox2.canned.menu')} data-testid="care-canned-menu">
      <span class="care-canned-head">{ct('inbox2.canned.head')}</span>
      {picker.matches.length === 0 && <span class="care-canned-empty">{hasItems ? ct('inbox2.canned.noMatch') : ct('inbox2.canned.none')}</span>}
      {picker.matches.map((c, i) => (
        <button
          key={c.id}
          type="button"
          role="option"
          id={`${id}-${i}`}
          aria-selected={i === picker.active}
          class={`care-canned-item${i === picker.active ? ' is-active' : ''}`}
          data-testid="care-canned-item"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => picker.choose(c)}
        >
          <span class="care-canned-title"><b>/{c.shortcut}</b> · {c.title}</span>
          <span class="care-canned-body">{c.body}</span>
        </button>
      ))}
    </div>
  );
}

/** Group members to @mention (from the loaded messages) plus "@Tất cả"; same look and keys as the canned menu. */
export function MentionMenu({ id, matches, active, onChoose, onHover }: {
  id: string;
  matches: MentionCandidate[];
  active: number;
  onChoose: (c: MentionCandidate) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div class="care-canned care-mention" role="listbox" id={id} aria-label={ct('inbox2.mention.menu')} data-testid="care-mention-menu">
      <span class="care-canned-head">{ct('inbox2.mention.head')}</span>
      {matches.map((c, i) => (
        <button
          key={c.uid}
          type="button"
          role="option"
          id={`${id}-${i}`}
          aria-selected={i === active}
          class={`care-canned-item${i === active ? ' is-active' : ''}`}
          data-testid="care-mention-item"
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onChoose(c)}
        >
          <span class="care-canned-title"><b>@</b>{c.name}{c.uid === MENTION_ALL_UID ? <span class="care-faint"> · {ct('inbox2.mention.allHint')}</span> : null}</span>
        </button>
      ))}
    </div>
  );
}

/** Categorised emoji grid anchored to the composer. Clicking an emoji inserts it and keeps the panel open; Escape / outside click closes. */
export function EmojiPanel({ id, onPick, onClose }: { id: string; onPick: (emoji: string) => void; onClose: () => void }) {
  const [cat, setCat] = useState(EMOJI_CATEGORIES[0].id);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (root.current && t && !root.current.contains(t) && !t.closest('[data-emoji-toggle]')) onClose();
    };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [onClose]);
  const current = EMOJI_CATEGORIES.find((c) => c.id === cat) ?? EMOJI_CATEGORIES[0];
  return (
    <div class="care-canned care-emoji" id={id} ref={root} role="dialog" aria-label={ct('inbox2.emoji.menu')} data-testid="care-emoji-panel">
      <div class="care-emoji-tabs" role="tablist" aria-label={ct('inbox2.emoji.categories')}>
        {EMOJI_CATEGORIES.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={c.id === current.id} class={`care-emoji-tab${c.id === current.id ? ' is-on' : ''}`} title={ct(`inbox2.emoji.cat.${c.id}`)} aria-label={ct(`inbox2.emoji.cat.${c.id}`)} onMouseDown={(e) => e.preventDefault()} onClick={() => setCat(c.id)}>{c.icon}</button>
        ))}
      </div>
      <span class="care-canned-head">{ct(`inbox2.emoji.cat.${current.id}`)}</span>
      <div class="care-emoji-grid" role="group">
        {current.items.map((e) => (
          <button key={e} type="button" class="care-emoji-item" data-testid="care-emoji-item" onMouseDown={(ev) => ev.preventDefault()} onClick={() => onPick(e)}>{e}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * A textarea that paints a highlight behind every `[BLANK]` and, while any remain, says so with a button that jumps to the
 * next one. The backdrop mirrors the textarea metrics; it only exists while there is something to highlight.
 */
export function HighlightTextarea({ id, value, rows, placeholder, label, onText, onKeyDown, onCaret, onSelect, taRef, maxLength, controls, expanded, testId }: {
  id: string;
  value: string;
  rows: number;
  placeholder: string;
  label: string;
  onText: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onCaret?: () => void;
  /** Selection changed (drag, shift+arrows): lets a toolbar mirror what is selected. */
  onSelect?: () => void;
  taRef?: RefObject<HTMLTextAreaElement>;
  maxLength?: number;
  controls?: string;
  expanded?: boolean;
  testId?: string;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = taRef ?? own;
  const back = useRef<HTMLDivElement>(null);
  const blanks = countPlaceholders(value);

  function jump(): void {
    const el = ref.current;
    if (!el) return;
    const r = nextPlaceholder(value, el.selectionEnd ?? 0);
    if (!r) return;
    el.focus();
    el.setSelectionRange(r.start, r.end);
  }

  return (
    <>
      <label class="care-sr-only" for={id}>{label}</label>
      <div class={`care-hl${blanks > 0 ? ' has-blanks' : ''}`}>
        {blanks > 0 && <div class="care-hl-back" ref={back} aria-hidden="true"><PlaceholderText text={value} />{'\n'}</div>}
        <textarea
          id={id}
          ref={ref}
          rows={rows}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-controls={controls}
          aria-expanded={expanded}
          data-testid={testId}
          onInput={(e) => { onText((e.target as HTMLTextAreaElement).value); onCaret?.(); }}
          onKeyDown={onKeyDown}
          onKeyUp={onCaret}
          onClick={onCaret}
          onSelect={onSelect}
          onScroll={(e) => { if (back.current) back.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop; }}
        />
      </div>
      {blanks > 0 && (
        <div class="care-blanks" role="status" data-testid="care-blanks">
          <span>{ct('inbox2.blanks.left', { n: blanks })}</span>
          <button type="button" class="care-link-button" onClick={jump} data-testid="care-blanks-next">{ct('inbox2.blanks.next')}</button>
        </div>
      )}
    </>
  );
}

/** Files waiting to go out with the next reply; each can be removed. */
export function AttachmentChips({ items, uploading, onRemove }: { items: ChatAttachment[]; uploading: string[]; onRemove: (mediaId: string) => void }) {
  if (items.length === 0 && uploading.length === 0) return null;
  return (
    <ul class="care-attach-chips" aria-label={ct('inbox2.attach.list')} data-testid="care-attach-chips">
      {items.map((a) => (
        <li key={a.mediaId} class="care-attach-chip" data-testid="care-attach-chip">
          <Paperclip size={12} aria-hidden="true" />
          <span class="care-attach-name">{a.name}</span>
          <span class="care-faint">{formatBytes(a.size)}</span>
          <button type="button" class="care-addr-remove" aria-label={ct('inbox2.attach.remove', { name: a.name })} onClick={() => onRemove(a.mediaId)}><X size={11} aria-hidden="true" /></button>
        </li>
      ))}
      {uploading.map((name) => (
        <li key={`up-${name}`} class="care-attach-chip is-uploading" role="status">
          <span class="care-attach-name">{ct('inbox2.attach.uploading', { name })}</span>
        </li>
      ))}
    </ul>
  );
}
