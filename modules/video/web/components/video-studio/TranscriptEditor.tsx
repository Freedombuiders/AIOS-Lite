// Lời thoại: every word is a toggle. Struck = cut. Click strikes/restores it (debounced PATCH);
// selecting a stretch of words starts a mark for it. Hook, B-roll, keywords and mark pins are annotated inline.
import { Fragment } from 'preact';
import { useMemo } from 'preact/hooks';
import { formatClock, formatTimeDec } from '@modules/video/web/lib/video-edit/format';
import { cleanWord, highlightSet, removedKindByWord, wordAtOutput, wordNearOutput, type PlanModel } from '@modules/video/web/lib/video-edit/plan-geometry';
import { playerControls, playerTime, startMark, toggleWord } from '@modules/video/web/lib/video-edit/editor';
import type { EditPlan, TranscriptWord, VideoMark } from '@modules/video/web/lib/video-edit/types';

const SENTENCE_END = /[.?!…]["”’)]?$/;

function paragraphs(words: TranscriptWord[]): TranscriptWord[][] {
  const out: TranscriptWord[][] = [];
  let cur: TranscriptWord[] = [];
  words.forEach((w, idx) => {
    cur.push(w);
    const next = words[idx + 1];
    const longGap = next ? next.start - w.end > 1.2 : false;
    if (!next || longGap || (cur.length >= 9 && SENTENCE_END.test(w.text)) || cur.length >= 32) { out.push(cur); cur = []; }
  });
  return out;
}

export function TranscriptEditor({ plan, words, model, cut, marks, readOnly, loading }: {
  plan: EditPlan;
  words: TranscriptWord[];
  model: PlanModel;
  cut: ReadonlySet<number>;
  marks: VideoMark[];
  readOnly: boolean;
  loading: boolean;
}) {
  const paras = useMemo(() => paragraphs(words), [words]);
  const kinds = useMemo(() => removedKindByWord(plan, words), [plan, words]);
  const keys = useMemo(() => highlightSet(plan), [plan]);
  const hook = plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
  const brollAt = useMemo(() => {
    const m = new Map<number, number[]>();
    plan.brolls.forEach((b, i) => { if (b.enabled) m.set(b.anchorWord, [...(m.get(b.anchorWord) ?? []), i + 1]); });
    return m;
  }, [plan]);
  const pins = useMemo(() => {
    const m = new Map<number, number[]>();
    marks.forEach((mk, i) => {
      const w = wordNearOutput(words, model, cut, mk.start);
      if (w >= 0) m.set(w, [...(m.get(w) ?? []), i + 1]);
    });
    return m;
  }, [marks, words, model, cut]);
  const now = wordAtOutput(words, model, cut, playerTime.value);
  const firstKept = words.find((w) => !cut.has(w.i))?.i ?? -1;

  const onSelect = () => {
    if (readOnly) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const idx = (n: Node | null) => {
      const el = n instanceof Element ? n : n?.parentElement;
      const hit = el?.closest<HTMLElement>('[data-w]');
      return hit ? Number(hit.dataset.w) : -1;
    };
    const a = idx(sel.anchorNode);
    const b = idx(sel.focusNode);
    if (a < 0 || b < 0 || a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    let start: number | null = null;
    let end: number | null = null;
    for (let i = lo; i <= hi; i++) {
      if (cut.has(i)) continue;
      const w = words[i];
      const o = w ? model.toOut(w.start) : null;
      if (o === null || !w) continue;
      if (start === null) start = o;
      end = model.toOut(w.end) ?? o;
    }
    if (start !== null) { sel.removeAllRanges(); startMark({ start, end: end !== null && end > start ? end : undefined }); }
  };

  return (
    <section class="vs-tr" aria-label="Lời thoại">
      <div class="vs-tr-head">
        <span class="vs-eyebrow">Lời thoại</span>
        <span class="vs-tr-legend" aria-hidden="true">
          <span class="vs-tr-w is-cut">đã bỏ</span>
          <span class="vs-tr-tag">hook</span>
          <span class="vs-tr-tag vs-tr-tag-broll">B-roll</span>
          <span class="vs-tr-w is-key">từ khoá</span>
        </span>
      </div>
      <div class="vs-tr-body" onMouseUp={onSelect}>
        {loading && words.length === 0 && <div class="vs-skel" role="status" aria-label="Đang tải lời thoại"><span /><span /><span /></div>}
        {!loading && words.length === 0 && <p class="vs-muted">Chưa có lời thoại. Chờ bước chép lời chạy xong.</p>}
        {paras.map((para, pi) => {
          const firstOut = para.map((w) => (cut.has(w.i) ? null : model.toOut(w.start))).find((v) => v !== null && v !== undefined) ?? null;
          return (
            <p class="vs-tr-p" key={pi}>
              <button
                type="button"
                class="vs-tr-time"
                title={firstOut !== null ? `Tới ${formatTimeDec(firstOut)} trong bản dựng` : 'Đoạn này đã bị bỏ hết'}
                disabled={firstOut === null}
                onClick={() => { if (firstOut !== null) playerControls.seek(firstOut); }}
              >{formatClock(para[0].start)}</button>
              <span class="vs-tr-text">
                {para.map((w, k) => {
                  const isCut = cut.has(w.i);
                  const next = para[k + 1] ?? words[w.i + 1];
                  const gap = next ? next.start - w.end : 0;
                  const showGap = !!next && gap * 1000 > plan.gapMs && gap >= 0.4 && !(isCut && cut.has(next.i));
                  const inMoved = hook?.mode === 'moved' && hook.moveFromWord !== undefined && hook.moveToWord !== undefined && w.i >= hook.moveFromWord && w.i <= hook.moveToWord;
                  const hookTag = hook && ((hook.mode === 'moved' && w.i === hook.moveFromWord) || (hook.mode === 'overlay' && w.i === firstKept));
                  const cls = ['vs-tr-w'];
                  if (isCut) cls.push('is-cut');
                  const kind = kinds.get(w.i);
                  if (kind === 'filler' || kind === 'retake') cls.push('is-filler');
                  if (!isCut && keys.has(cleanWord(w.text))) cls.push('is-key');
                  if (inMoved) cls.push('is-hook');
                  if (w.i === now) cls.push('is-now');
                  return (
                    <Fragment key={w.i}>
                      {pins.get(w.i)?.map((n) => <span key={`p${n}`} class="vs-tr-pin" aria-label={`Góp ý ${n}`}>{n}</span>)}
                      {hookTag && <span class="vs-tr-tag">HOOK</span>}
                      <span
                        data-w={w.i}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isCut}
                        aria-label={`${w.text}, ${isCut ? 'đã bỏ, bấm để giữ lại' : 'đang giữ, bấm để bỏ'}`}
                        title={formatTimeDec(w.start)}
                        class={cls.join(' ')}
                        onClick={() => { if (!readOnly && (window.getSelection()?.isCollapsed ?? true)) toggleWord(w.i); }}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !readOnly) { e.preventDefault(); toggleWord(w.i); } }}
                      >{w.text}</span>
                      {brollAt.get(w.i)?.map((n) => <span key={`b${n}`} class="vs-tr-tag vs-tr-tag-broll">B-roll {n}</span>)}
                      {showGap && <span class="vs-tr-silence" title="Khoảng lặng">lặng {gap.toFixed(1).replace('.', ',')}s</span>}
                      {' '}
                    </Fragment>
                  );
                })}
              </span>
            </p>
          );
        })}
      </div>
      <p class="vs-muted vs-tr-help">{readOnly ? 'Đang xem bản cũ, chỉ đọc.' : 'Bấm một từ để bỏ hoặc giữ lại. Bôi đen một đoạn để thêm góp ý.'}</p>
    </section>
  );
}
