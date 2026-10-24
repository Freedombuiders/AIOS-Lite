/** Textarea with "@" KOL mentions: type @ to pick a KOL from KOL Studio (arrows + Enter, or click). */
import { useRef, useState } from 'preact/hooks';

import { media } from '@modules/video/web/lib/media';
import { activeMention, insertMention, matchCast, type CastMember } from '@modules/video/web/lib/video-production';

export function KolAvatar({ kol, size = 'sm' }: { kol: Pick<CastMember, 'name' | 'avatarUrl'>; size?: 'sm' | 'lg' }) {
  const cls = `vp-avatar${size === 'lg' ? ' vp-avatar-lg' : ''}`;
  return kol.avatarUrl
    ? <img class={cls} src={media(kol.avatarUrl)} alt="" loading="lazy" />
    : <span class={cls} aria-hidden="true">{kol.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>;
}

export function MentionComposer({ value, onInput, cast, placeholder, onSubmit, autoFocus, submitOnEnter }: {
  value: string; onInput: (v: string) => void; cast: CastMember[]; placeholder: string; onSubmit?: () => void; autoFocus?: boolean;
  /** Chat style: Enter sends, Shift+Enter breaks the line. */
  submitOnEnter?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [pick, setPick] = useState(0);
  const options = mention ? matchCast(cast, mention.query) : [];

  const sync = (el: HTMLTextAreaElement) => {
    const m = activeMention(el.value, el.selectionStart ?? el.value.length);
    setMention(m);
    setPick(0);
  };

  const choose = (kol: CastMember) => {
    const el = ref.current;
    if (!el || !mention) return;
    const next = insertMention(el.value, mention, kol.handle || kol.name.replace(/\s+/g, ''));
    onInput(next.text);
    setMention(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(next.caret, next.caret); });
  };

  return (
    <div class="vp-composer-area">
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label="Ý tưởng video"
        onInput={(e) => { onInput(e.currentTarget.value); sync(e.currentTarget); }}
        onClick={(e) => sync(e.currentTarget)}
        onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) sync(e.currentTarget); }}
        onBlur={() => setTimeout(() => setMention(null), 150)}
        onKeyDown={(e) => {
          if (mention && options.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setPick((pick + 1) % options.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setPick((pick - 1 + options.length) % options.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[pick]); return; }
            if (e.key === 'Escape') { setMention(null); return; }
          }
          if (e.key === 'Enter' && onSubmit && !e.isComposing && ((e.metaKey || e.ctrlKey) || (submitOnEnter && !e.shiftKey))) { e.preventDefault(); onSubmit(); }
        }}
      />
      {mention && options.length > 0 && (
        <div class="vp-mention-menu" role="listbox" aria-label="Chọn KOL">
          {options.map((k, i) => (
            <button key={k.id} type="button" role="option" aria-selected={i === pick} onMouseDown={(e) => { e.preventDefault(); choose(k); }}>
              <KolAvatar kol={k} size="lg" />
              <span class="min-w-0">
                <b>{k.name}</b>
                <small>@{k.handle} · {k.images.length} ảnh{k.voice ? ` · giọng ${k.voice.name}` : ''}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
