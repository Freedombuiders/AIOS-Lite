// Shared building blocks for KOL Studio screens. Styling reuses the Facebook
// ops tokens (components/fb/ops-shared.tsx) and theme variables only.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Film, ImageOff, Music, Play, Upload, UserRound } from 'lucide-preact';
import { Pill } from '@/components/Pill';
import { PlatformBadge } from '@/components/social/PlatformBadge';
import { INPUT, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { markdownClass } from '@/components/mission-detail-shared';
import { renderMarkdown } from '@/lib/markdown';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import {
  KOL, PERSONA_STATUS, PLATFORM_META, VERDICT, media, meterColor, meterPercent, fmtUsd,
  type Aspect, type AssetDto, type ConsistencyDto, type KolStatusDto, type KolTone, type ModelOption, type Platform, type PersonaStatus,
} from '@modules/kol/web/lib/kol';

export function useKolStatus(pollMs = 0) {
  return useFetch<KolStatusDto>(KOL.status, pollMs);
}

/** Error toast with the server's Vietnamese message. */
export function toastError(title: string, err: unknown) {
  pushToast({ tone: 'error', title, description: apiFail(err).message, ttlMs: 7000 });
}

/** CSS colour of a Pill tone (calendar chips, dots). */
export function toneColor(tone: KolTone): string {
  switch (tone) {
    case 'queued': return 'var(--color-status-queued)';
    case 'running': return 'var(--color-status-running)';
    case 'done': return 'var(--color-status-done)';
    case 'failed': return 'var(--color-status-failed)';
    case 'high': return 'var(--color-priority-high)';
    case 'medium': return 'var(--color-priority-medium)';
    case 'accent': return 'var(--color-accent)';
    default: return 'var(--color-text-faint)';
  }
}

export function TonePill({ tone, children }: { tone: KolTone; children: ComponentChildren }) {
  return <Pill tone={tone}>{children}</Pill>;
}

export function PersonaStatusPill({ status }: { status: PersonaStatus }) {
  const meta = PERSONA_STATUS[status] ?? PERSONA_STATUS.draft;
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

/** <img> for a /api/m/kol/media URL (token added). Shows a neutral tile when missing or broken. */
export function KolImg({ src, alt = '', class: cls = '', fit = 'cover' }: { src: string | null | undefined; alt?: string; class?: string; fit?: 'cover' | 'contain' }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <span class={`flex items-center justify-center bg-[var(--color-elevated)] text-[var(--color-text-faint)] ${cls}`} role={alt ? 'img' : undefined} aria-label={alt || undefined}>
        <ImageOff size={18} aria-hidden="true" />
      </span>
    );
  }
  return (
    <img
      src={media(src)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      class={`${fit === 'cover' ? 'object-cover' : 'object-contain'} ${cls}`}
    />
  );
}

export function Avatar({ url, name, size = 40 }: { url: string | null | undefined; name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(-2).map((w) => w[0]?.toUpperCase() ?? '').join('');
  return (
    <span
      class="shrink-0 inline-flex items-center justify-center rounded-full overflow-hidden bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-semibold"
      style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.36)}px` }}
      aria-hidden="true"
    >
      {url ? <KolImg src={url} class="w-full h-full" /> : initials || <UserRound size={Math.round(size * 0.5)} />}
    </span>
  );
}

export function PlatformIcons({ platforms, size = 18 }: { platforms: Platform[]; size?: number }) {
  if (!platforms.length) return null;
  return (
    <span class="inline-flex items-center gap-1" aria-label={platforms.map((p) => PLATFORM_META[p].name).join(', ')}>
      {platforms.map((p) => <PlatformBadge key={p} platform={p} size={size} />)}
    </span>
  );
}

/** Identity QA chip: green pass, amber warn, red fail, with the score. */
export function ConsistencyBadge({ c, compact }: { c: ConsistencyDto | null | undefined; compact?: boolean }) {
  if (!c || !c.verdict) return null;
  const meta = VERDICT[c.verdict];
  const score = c.score === null ? '' : String(Math.round(c.score));
  return (
    <span
      title={`${meta.label}${score ? ` · ${score}/100` : ''}${c.notes ? ` — ${c.notes}` : ''}`}
      class="inline-flex items-center gap-1 h-[22px] px-1.5 rounded-md text-[11px] font-semibold tabular-nums border"
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 45%, transparent)`,
        background: `color-mix(in srgb, var(--color-card) 82%, ${meta.color})`,
      }}
    >
      <span class="w-1.5 h-1.5 rounded-full" style={{ background: meta.color }} aria-hidden="true" />
      {compact ? score || meta.label : `${meta.label}${score ? ` ${score}` : ''}`}
    </span>
  );
}

/** Spend meter: "$3,20 / $10" with a bar that turns amber at 80% and red at 100%. */
export function Meter({ label, used, cap, hint }: { label: string; used: number; cap: number | null | undefined; hint?: string }) {
  const pct = meterPercent(used, cap);
  return (
    <div class="flex flex-col gap-1 min-w-0">
      <div class="flex items-baseline justify-between gap-2 text-[12px]">
        <span class="text-[var(--color-text-muted)]">{label}</span>
        <span class="tabular-nums text-[var(--color-text)]">{fmtUsd(used)}{cap ? <span class="text-[var(--color-text-muted)]"> / {fmtUsd(cap)}</span> : <span class="text-[var(--color-text-faint)]"> · không giới hạn</span>}</span>
      </div>
      <div
        class="h-1.5 rounded-full bg-[var(--color-elevated)] overflow-hidden"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div class="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: meterColor(pct) }} />
      </div>
      {hint && <span class="text-[11.5px] text-[var(--color-text-faint)]">{hint}</span>}
    </div>
  );
}

/** Button that opens the file chooser. */
export function UploadButton({ accept = 'image/*', multiple, onFiles, children, class: cls, disabled }: {
  accept?: string; multiple?: boolean; onFiles: (files: File[]) => void; children: ComponentChildren; class: string; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" class={cls} disabled={disabled} onClick={() => ref.current?.click()}>{children}</button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        class="hidden"
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const files = Array.from(input.files ?? []);
          input.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** Drop area for images; also opens the chooser on click/Enter. */
export function DropZone({ onFiles, accept = 'image/*', multiple, children, disabled }: {
  onFiles: (files: File[]) => void; accept?: string; multiple?: boolean; children?: ComponentChildren; disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const kind = accept.split('/')[0];
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => { if (!disabled) ref.current?.click(); }}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ref.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => kind === '*' || f.type.startsWith(`${kind}/`));
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
      class={`flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center text-[12.5px] cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
        over ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]' : 'border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]'
      } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <Upload size={18} aria-hidden="true" />
      {children ?? <span>Kéo thả ảnh vào đây hoặc bấm để chọn</span>}
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        class="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const files = Array.from(input.files ?? []);
          input.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}

/** Small segmented control (radio group semantics). `fill` stretches it to the row with equal segments. */
export function Segmented<T extends string>({ options, value, onChange, label, fill = false }: {
  options: { value: T; label: ComponentChildren; title?: string }[]; value: T; onChange: (v: T) => void; label: string; fill?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} class={`${fill ? 'flex w-full' : 'inline-flex max-w-full'} items-center rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-0.5 overflow-x-auto`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          class={`${fill ? 'flex-1 h-8' : 'h-7'} px-2.5 rounded text-[12.5px] whitespace-nowrap transition-colors ${
            o.value === value ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Next-step empty state inside a tab. */
export function EmptyHint({ icon, title, children, action }: { icon?: ComponentChildren; title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-card)] px-5 py-8 flex flex-col items-center text-center gap-2 min-w-0">
      {icon && <span class="w-11 h-11 rounded-xl bg-[var(--color-elevated)] text-[var(--color-text-faint)] flex items-center justify-center" aria-hidden="true">{icon}</span>}
      <div class="text-[14px] font-semibold text-[var(--color-text)]">{title}</div>
      {children && <div class="text-[12.5px] text-[var(--color-text-muted)] max-w-[460px] leading-relaxed">{children}</div>}
      {action && <div class="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Markdown({ text, class: cls = '' }: { text: string; class?: string }) {
  return <div class={`${markdownClass} text-[13px] ${cls}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

/** Square-ish preview of an asset (thumbnail first, video/audio markers). */
export function AssetThumb({ asset, class: cls = '' }: { asset: AssetDto; class?: string }) {
  if (asset.kind === 'audio') {
    return <span class={`flex items-center justify-center bg-[var(--color-elevated)] text-[var(--color-text-muted)] ${cls}`}><Music size={20} aria-hidden="true" /></span>;
  }
  const src = asset.thumbUrl ?? (asset.kind === 'image' ? asset.url : null);
  return (
    <span class={`relative block overflow-hidden bg-[var(--color-elevated)] ${cls}`}>
      {src
        ? <KolImg src={src} class="w-full h-full" />
        : <span class="w-full h-full flex items-center justify-center text-[var(--color-text-faint)]"><Film size={20} aria-hidden="true" /></span>}
      {asset.kind === 'video' && (
        <span class="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded bg-black/65 text-white text-[10px] px-1 py-0.5">
          <Play size={10} aria-hidden="true" />{asset.durationSec ? `${Math.round(asset.durationSec)}s` : 'Video'}
        </span>
      )}
    </span>
  );
}

/** Local preview of a chosen file (object URL revoked on unmount). */
export function FilePreview({ file, class: cls = 'w-20 h-20' }: { file: File; class?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url
    ? <img src={url} alt={file.name} class={`${cls} rounded-md object-cover border border-[var(--color-border)]`} />
    : <span class={`${cls} block rounded-md bg-[var(--color-elevated)]`} />;
}

/** Thin labelled row in a definition list. */
export function MetaRow({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="flex items-baseline justify-between gap-3 text-[12px] py-1 border-b border-[var(--color-border)] last:border-b-0 min-w-0">
      <span class="text-[var(--color-text-muted)] shrink-0">{label}</span>
      <span class="text-[var(--color-text)] text-right min-w-0 break-words tabular-nums">{children}</span>
    </div>
  );
}

/** Heading for a group of form fields. */
export function FormSection({ title, hint, children, aside }: { title: string; hint?: ComponentChildren; children: ComponentChildren; aside?: ComponentChildren }) {
  return (
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-3 min-w-0">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-[14px] font-semibold text-[var(--color-text)]">{title}</h2>
          {hint && <p class="mt-0.5 text-[12px] text-[var(--color-text-muted)] leading-relaxed">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Two-column responsive field grid (one column on phones). */
export function FieldGrid({ children, cols = 2 }: { children: ComponentChildren; cols?: 2 | 3 }) {
  return <div class={`grid grid-cols-1 gap-3 ${cols === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2'}`}>{children}</div>;
}

/**
 * Model select grouped by provider; unconfigured providers are listed but disabled.
 * `compact` leaves the price note out of each option (show it under the field instead),
 * so the closed select stays on one line.
 */
export function ModelSelect({ options, value, onChange, label, allowEmpty = true, compact = false }: {
  options: ModelOption[]; value: string; onChange: (id: string) => void; label?: string; allowEmpty?: boolean; compact?: boolean;
}) {
  const known = options.some((o) => o.model.id === value);
  const groups: { label: string; items: ModelOption[] }[] = [];
  for (const o of options) {
    const g = groups.find((x) => x.label === o.providerLabel) ?? (groups.push({ label: o.providerLabel, items: [] }), groups[groups.length - 1]);
    g.items.push(o);
  }
  return (
    <select class={`${INPUT} w-full truncate`} aria-label={label} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {allowEmpty && <option value="">Tự chọn (khuyên dùng)</option>}
      {value && !known && <option value={value}>{value}</option>}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.items[0]?.configured ? g.label : `${g.label} · chưa có key`}>
          {g.items.map((o) => (
            <option key={o.model.id} value={o.model.id} disabled={!o.configured}>
              {o.model.label}{o.model.recommended ? ' ★' : ''}{compact ? '' : ` — ${o.model.priceNote}`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Aspect picker: one tile per ratio with its shape drawn to scale; the title names the use. */
export function AspectPicker({ aspects, value, onChange, labels }: {
  aspects: Aspect[]; value: Aspect; onChange: (a: Aspect) => void; labels: Record<Aspect, string>;
}) {
  return (
    <div role="radiogroup" aria-label="Tỷ lệ khung hình" class="grid grid-cols-5 sm:grid-cols-9 lg:grid-cols-5 xl:grid-cols-9 gap-1.5">
      {aspects.map((a) => {
        const [w, h] = a.split(':').map(Number);
        const scale = 22 / Math.max(w, h);
        const on = a === value;
        return (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={on}
            title={labels[a]}
            onClick={() => onChange(a)}
            class={`h-[52px] flex flex-col items-center justify-center gap-1 rounded-md border text-[11px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
              on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-semibold' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]'
            }`}
          >
            <span class="flex items-center justify-center w-6 h-6" aria-hidden="true">
              <span class={`block rounded-[3px] border-[1.5px] ${on ? 'border-current' : 'border-[var(--color-border-strong)]'}`} style={{ width: `${Math.round(w * scale)}px`, height: `${Math.round(h * scale)}px` }} />
            </span>
            {a}
          </button>
        );
      })}
    </div>
  );
}
