import { useEffect, useRef, useState } from 'preact/hooks';
import { Bold, Braces, Italic, List, ListOrdered, Strikethrough, Underline } from 'lucide-preact';
import type { TemplateVariable } from '@/lib/marketing';
import {
  adjustStylesForEdit,
  buildRichLines,
  isCovered,
  runStyle,
  setExclusive,
  SIZE_BIG,
  SIZE_SMALL,
  STYLE_COLORS,
  toggleInline,
  toggleList,
  type ZaloStyle,
} from '@/lib/richText';

interface PreviewProps {
  text: string;
  styles: ZaloStyle[];
  class?: string;
}

/** Read-only rendering of Zalo text + style ranges (what the recipient sees). */
export function RichTextPreview({ text, styles, class: cls }: PreviewProps) {
  const lines = buildRichLines(text, styles);
  return (
    <div class={`text-[13px] leading-relaxed text-[var(--color-text)] break-words ${cls ?? ''}`}>
      {lines.map((line, i) => (
        <div key={i} class={line.marker ? 'flex gap-1.5 pl-3' : ''} style={{ minHeight: '1.4em' }}>
          {line.marker && <span class="shrink-0 text-[var(--color-text-muted)]">{line.marker}</span>}
          <span class="whitespace-pre-wrap min-w-0">
            {line.runs.map((run, j) => (
              <span key={j} style={runStyle(run.codes)}>{run.text}</span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  value: string;
  styles: ZaloStyle[];
  onChange: (text: string, styles: ZaloStyle[]) => void;
  /** Shows the "Chèn biến" menu when given. */
  variables?: TemplateVariable[];
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
}

const TOOL = 'toolbar-control inline-flex items-center justify-center min-w-[28px] h-7 px-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';
const TOOL_ON = 'bg-[var(--color-accent-soft)] !text-[var(--color-accent)]';

export interface RichToolbarLabels {
  bold: string;
  italic: string;
  underline: string;
  strike: string;
  /** Title / aria-label of a colour swatch, from its code and its default display name ("Đỏ"). */
  color: (st: string, name: string) => string;
  noColor: string;
  small: string;
  big: string;
  bullets: string;
  numbered: string;
}

const DEFAULT_LABELS: RichToolbarLabels = {
  bold: 'Đậm',
  italic: 'Nghiêng',
  underline: 'Gạch chân',
  strike: 'Gạch ngang',
  color: (_st, name) => `Chữ màu ${name.toLowerCase()}`,
  noColor: 'Bỏ màu chữ',
  small: 'Chữ nhỏ',
  big: 'Chữ lớn',
  bullets: 'Danh sách gạch đầu dòng',
  numbered: 'Danh sách đánh số',
};

const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * The formatting buttons (bold … lists), without a wrapper: the host lays them out. Buttons never take focus from the text
 * field, so the selection they act on survives the click. Shared by RichTextEditor and the Care reply box.
 */
export function RichToolbar({ styles, sel, disabled, onInline, onExclusive, onList, labels = DEFAULT_LABELS, shortcuts = true }: {
  styles: ZaloStyle[];
  sel: { start: number; end: number };
  disabled?: boolean;
  onInline: (st: string) => void;
  onExclusive: (prefix: 'c_' | 'f_', st: string | null) => void;
  onList: (st: 'lst_1' | 'lst_2') => void;
  labels?: RichToolbarLabels;
  /** Append the Ctrl+B / I / U hints to the titles (hosts that handle those keys). */
  shortcuts?: boolean;
}) {
  const on = (match: (x: string) => boolean) => isCovered(styles, match, sel.start, sel.end);
  const hint = (label: string, key: string) => (shortcuts ? `${label} (Ctrl+${key})` : label);
  const cls = (active: boolean, extra = '') => `${TOOL} ${extra} ${active ? TOOL_ON : ''}`;
  return (
    <>
      <button type="button" class={cls(on((x) => x === 'b'))} title={hint(labels.bold, 'B')} aria-label={labels.bold} disabled={disabled} onMouseDown={keepFocus} onClick={() => onInline('b')}><Bold size={13} /></button>
      <button type="button" class={cls(on((x) => x === 'i'))} title={hint(labels.italic, 'I')} aria-label={labels.italic} disabled={disabled} onMouseDown={keepFocus} onClick={() => onInline('i')}><Italic size={13} /></button>
      <button type="button" class={cls(on((x) => x === 'u'))} title={hint(labels.underline, 'U')} aria-label={labels.underline} disabled={disabled} onMouseDown={keepFocus} onClick={() => onInline('u')}><Underline size={13} /></button>
      <button type="button" class={cls(on((x) => x === 's'))} title={labels.strike} aria-label={labels.strike} disabled={disabled} onMouseDown={keepFocus} onClick={() => onInline('s')}><Strikethrough size={13} /></button>
      <span class="w-px h-4 bg-[var(--color-border)] mx-1" />
      {STYLE_COLORS.map((c) => (
        <button
          key={c.st}
          type="button"
          class={cls(on((x) => x === c.st), '!min-w-[22px] !px-0')}
          title={labels.color(c.st, c.label)}
          aria-label={labels.color(c.st, c.label)}
          disabled={disabled}
          onMouseDown={keepFocus}
          onClick={() => onExclusive('c_', c.st)}
        >
          <span class="block w-3.5 h-3.5 rounded-full border border-black/10" style={{ background: c.css }} />
        </button>
      ))}
      <button type="button" class={TOOL} title={labels.noColor} aria-label={labels.noColor} disabled={disabled} onMouseDown={keepFocus} onClick={() => onExclusive('c_', null)}>
        <span class="text-[11px]">A</span>
      </button>
      <span class="w-px h-4 bg-[var(--color-border)] mx-1" />
      <button type="button" class={cls(on((x) => x === SIZE_SMALL))} title={labels.small} aria-label={labels.small} disabled={disabled} onMouseDown={keepFocus} onClick={() => onExclusive('f_', SIZE_SMALL)}>
        <span class="text-[10px]">A</span>
      </button>
      <button type="button" class={cls(on((x) => x === SIZE_BIG))} title={labels.big} aria-label={labels.big} disabled={disabled} onMouseDown={keepFocus} onClick={() => onExclusive('f_', SIZE_BIG)}>
        <span class="text-[15px] font-medium leading-none">A</span>
      </button>
      <span class="w-px h-4 bg-[var(--color-border)] mx-1" />
      <button type="button" class={cls(on((x) => x === 'lst_1'))} title={labels.bullets} aria-label={labels.bullets} disabled={disabled} onMouseDown={keepFocus} onClick={() => onList('lst_1')}><List size={13} /></button>
      <button type="button" class={cls(on((x) => x === 'lst_2'))} title={labels.numbered} aria-label={labels.numbered} disabled={disabled} onMouseDown={keepFocus} onClick={() => onList('lst_2')}><ListOrdered size={13} /></button>
    </>
  );
}

/**
 * Plain textarea + toolbar. Styles are Zalo ranges over the plain text; the
 * editor keeps them attached to their words while the user types (see
 * adjustStylesForEdit) and the toolbar applies them to the current selection.
 */
export function RichTextEditor({ value, styles, onChange, variables, rows = 7, placeholder, disabled, maxLength }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [hint, setHint] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 2500);
    return () => clearTimeout(t);
  }, [hint]);

  function readSel() {
    const el = ref.current;
    return { start: el?.selectionStart ?? 0, end: el?.selectionEnd ?? 0 };
  }
  const syncSel = () => setSel(readSel());

  function onInput(e: Event) {
    const el = e.currentTarget as HTMLTextAreaElement;
    onChange(el.value, adjustStylesForEdit(styles, value, el.value));
    setSel({ start: el.selectionStart, end: el.selectionEnd });
  }

  function withSelection(apply: (start: number, end: number) => ZaloStyle[]) {
    const { start, end } = readSel();
    if (end <= start) { setHint(true); return; }
    onChange(value, apply(start, end));
    ref.current?.focus();
  }

  const inline = (st: string) => withSelection((a, b) => toggleInline(styles, st, a, b));
  const exclusive = (prefix: 'c_' | 'f_', st: string | null) => withSelection((a, b) => setExclusive(styles, prefix, st, a, b));

  function list(st: 'lst_1' | 'lst_2') {
    const { start, end } = readSel();
    onChange(value, toggleList(styles, value, st, start, end));
    ref.current?.focus();
  }

  function insertVariable(name: string) {
    const el = ref.current;
    const { start, end } = readSel();
    const token = `{${name}}`;
    const next = value.slice(0, start) + token + value.slice(end);
    if (maxLength && next.length > maxLength) return;
    onChange(next, adjustStylesForEdit(styles, value, next));
    setMenu(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const st = ({ b: 'b', i: 'i', u: 'u' } as Record<string, string>)[e.key.toLowerCase()];
    if (!st) return;
    e.preventDefault();
    inline(st);
  }


  return (
    <div class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-accent)]">
      <div class="flex flex-wrap items-center gap-0.5 px-1.5 py-1 border-b border-[var(--color-border)] relative">
        <RichToolbar styles={styles} sel={sel} disabled={disabled} onInline={inline} onExclusive={exclusive} onList={list} />
        {variables && variables.length > 0 && (
          <div class="ml-auto relative">
            <button type="button" class={`${TOOL} gap-1 px-2`} disabled={disabled} onMouseDown={keepFocus} onClick={() => setMenu((v) => !v)} aria-expanded={menu}>
              <Braces size={13} /> Chèn biến
            </button>
            {menu && (
              <>
                <div class="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <div class="absolute right-0 top-8 z-20 w-72 max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] shadow-xl py-1">
                  {variables.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      class="w-full text-left px-3 py-1.5 hover:bg-[var(--color-control-hover)]"
                      onMouseDown={keepFocus}
                      onClick={() => insertVariable(v.name)}
                    >
                      <div class="text-[12px] text-[var(--color-text)]"><code>{`{${v.name}}`}</code> <span class="text-[var(--color-text-faint)]">· ví dụ: {v.example}</span></div>
                      <div class="text-[11px] text-[var(--color-text-muted)]">{v.description}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <textarea
        ref={ref}
        value={value}
        rows={rows}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        class="w-full px-3 py-2 bg-transparent focus:outline-none text-[13px] leading-relaxed text-[var(--color-text)] resize-y block"
        onInput={onInput}
        onSelect={syncSel}
        onKeyUp={syncSel}
        onMouseUp={syncSel}
        onKeyDown={onKeyDown}
      />

      <div class="flex items-center gap-2 px-3 py-1 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-faint)]">
        <span class={hint ? 'text-[var(--color-accent)]' : ''}>
          {hint ? 'Bôi đen chữ cần định dạng rồi bấm nút.' : 'Bôi đen chữ để định dạng. {a|b|c} chọn ngẫu nhiên một phương án mỗi lần gửi.'}
        </span>
        <span class="ml-auto tabular-nums">{value.length}{maxLength ? ` / ${maxLength}` : ''}</span>
      </div>

      {styles.length > 0 && value.length > 0 && (
        <div class="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-card)] rounded-b">
          <div class="text-[10.5px] uppercase tracking-wide text-[var(--color-text-faint)] mb-1">Định dạng</div>
          <RichTextPreview text={value} styles={styles} />
        </div>
      )}
    </div>
  );
}
