/** One storyboard scene: kind, KOL + face, line, visual, engine, preview, status, actions. */
import { useEffect, useState } from 'preact/hooks';
import { AlertTriangle, ArrowDown, ArrowUp, Clapperboard, Loader2, Play, RotateCcw, Scissors, Trash2, UserRound } from 'lucide-preact';

import { media } from '@modules/video/web/lib/media';
import { productionApi } from '@modules/video/web/lib/video-production-api';
import {
  ENGINE_LABEL, ENGINES_FOR, KIND_LABEL, STATUS_LABEL, fmtSec,
  type CastMember, type EngineStatus, type Production, type ProductionScene, type SceneKind,
} from '@modules/video/web/lib/video-production';

const frameClass = (aspect: Production['aspect']) => (aspect === '16:9' ? ' is-wide' : aspect === '1:1' ? ' is-square' : aspect === '4:5' ? ' is-feed' : '');

/** Re-trim a finished take: where it starts inside the file and how long it plays (free, no new take). */
function TrimRow({ scene, onTrim }: { scene: ProductionScene; onTrim: (t: { start?: number; durationSec?: number }) => void }) {
  const out = scene.output!;
  const total = out.sourceSec ?? out.durationSec + (scene.trimStart ?? 0);
  const [start, setStart] = useState(String(scene.trimStart ?? 0));
  const [dur, setDur] = useState(String(out.durationSec));
  useEffect(() => { setStart(String(scene.trimStart ?? 0)); setDur(String(out.durationSec)); }, [scene.trimStart, out.durationSec]);
  const commit = () => {
    const s = Number(start), d = Number(dur);
    if (!Number.isFinite(s) || !Number.isFinite(d)) return;
    if (s !== (scene.trimStart ?? 0) || d !== out.durationSec) onTrim({ start: s, durationSec: d });
  };
  if (total - out.durationSec < 0.3 && !(scene.trimStart ?? 0)) return null;
  return (
    <div class="vx-trim">
      <Scissors size={13} aria-hidden="true" />
      <label>Bắt đầu <input class="vp-input" type="number" min={0} max={Math.max(0, total - 0.5)} step={0.1} value={start} onInput={(e) => setStart(e.currentTarget.value)} onBlur={commit} /> s</label>
      <label>Dài <input class="vp-input" type="number" min={0.5} max={total} step={0.1} value={dur} onInput={(e) => setDur(e.currentTarget.value)} onBlur={commit} /> s</label>
      <span class="vp-faint">/ gốc {fmtSec(total)} · cắt không tốn phí</span>
    </div>
  );
}

export function SceneCard({ p, scene, index, cast, engines, busy, onPatch, onTrim, onGenerate, onMove, onRemove }: {
  p: Production; scene: ProductionScene; index: number; cast: CastMember[]; engines: EngineStatus[] | null; busy: boolean;
  onPatch: (patch: Parameters<typeof productionApi.patchScene>[2]) => void;
  onTrim: (trim: { start?: number; durationSec?: number }) => void;
  onGenerate: () => void; onMove: (to: number) => void; onRemove: () => void;
}) {
  const [text, setText] = useState(scene.text);
  const [visual, setVisual] = useState(scene.visual);
  useEffect(() => { setText(scene.text); }, [scene.text]);
  useEffect(() => { setVisual(scene.visual); }, [scene.visual]);

  const kol = cast.find((c) => c.id === scene.kolId) ?? null;
  const castHere = cast.filter((c) => p.cast.includes(c.id));
  const face = kol ? kol.images.find((i) => i.id === scene.sourceAssetId) ?? kol.images[0] ?? null : null;
  const locked = scene.status === 'running' || scene.status === 'queued';
  const ready = (id: string) => engines?.find((e) => e.id === id)?.ready ?? true;
  const stamp = scene.output ? scene.updatedAt : '';

  const maxSec = scene.engine === 'fal' ? 15 : scene.engine === 'stock' || scene.engine === 'clip' ? 30 : 8;
  const pill = scene.status === 'done' ? 'is-done' : locked ? 'is-busy' : scene.status === 'failed' ? 'is-bad' : '';
  const kinds: SceneKind[] = ['talking', 'broll', 'clip'];

  return (
    <article class={`vp-scene${locked ? ' is-running' : ''}${scene.status === 'failed' ? ' is-failed' : ''}`} aria-label={`Cảnh ${index + 1}`}>
      <div class="vp-scene-no">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <button type="button" class="vp-icon-btn" aria-label="Lên" disabled={index === 0 || busy} onClick={() => onMove(index - 1)}><ArrowUp size={14} /></button>
        <button type="button" class="vp-icon-btn" aria-label="Xuống" disabled={index === p.scenes.length - 1 || busy} onClick={() => onMove(index + 1)}><ArrowDown size={14} /></button>
      </div>

      <div class={`vp-scene-media${frameClass(p.aspect)}`}>
        {scene.output ? (
          <video
            src={productionApi.sceneMedia(p.id, scene.id, 'video', stamp)}
            poster={scene.output.thumb ? productionApi.sceneMedia(p.id, scene.id, 'thumb', stamp) : undefined}
            controls playsInline preload="none"
          />
        ) : scene.kind === 'clip' && kol?.videos.find((v) => v.id === scene.clipAssetId)?.thumbUrl ? (
          <img src={media(kol.videos.find((v) => v.id === scene.clipAssetId)!.thumbUrl)} alt="" />
        ) : face && scene.kind !== 'clip' ? (
          <img src={media(face.thumbUrl ?? face.url)} alt="" loading="lazy" />
        ) : (
          <Clapperboard size={26} />
        )}
        {locked && (
          <div class="vp-veil">
            <span>
              <Loader2 size={18} class="animate-spin" style={{ margin: '0 auto 6px', display: 'block' }} />
              {scene.status === 'queued' && scene.retry
                ? <>{ENGINE_LABEL[scene.engine]} quá tải · tự thử lại lúc {new Date(scene.retry.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false })}</>
                : <>Đang tạo bằng {ENGINE_LABEL[scene.engine]}…</>}
            </span>
          </div>
        )}
        <span class={`vp-pill vp-badge ${pill}`}>{STATUS_LABEL[scene.status]}{scene.output ? ` · ${fmtSec(scene.output.durationSec)}` : ''}</span>
      </div>

      <div class="vp-scene-body">
        <div class="vp-scene-top">
          <div class="vp-seg" role="group" aria-label="Loại cảnh">
            {kinds.map((k) => <button key={k} type="button" aria-pressed={scene.kind === k} disabled={locked} onClick={() => onPatch({ kind: k, ...(k !== 'broll' && !scene.kolId && castHere[0] ? { kolId: castHere[0].id } : {}) })}>{KIND_LABEL[k]}</button>)}
          </div>
          <select class="vp-select" style={{ width: 'auto', height: '34px', padding: '0 10px' }} aria-label="KOL trong cảnh" value={scene.kolId ?? ''} disabled={locked}
            onChange={(e) => onPatch({ kolId: e.currentTarget.value || null, sourceAssetId: null })}>
            {scene.kind === 'broll' && <option value="">Không có KOL</option>}
            {castHere.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span class="vp-spacer" />
          {scene.kind !== 'talking' && scene.kind !== 'clip' && (
            <label class="vp-row vp-muted" style={{ fontSize: '12px' }}>
              <input class="vp-input" type="number" min={2} max={maxSec} step={1} value={Math.min(maxSec, Math.round(scene.durationSec))} disabled={locked} style={{ width: '64px', height: '32px', padding: '0 8px' }}
                onChange={(e) => onPatch({ durationSec: Number(e.currentTarget.value) || 5 })} /> giây
            </label>
          )}
        </div>

        {scene.kind !== 'clip' && kol && kol.images.length > 0 && (
          <div>
            <span class="vp-label">{scene.kind === 'talking' ? 'Khuôn mặt' : 'Ảnh khởi đầu'}</span>
            <div class="vp-faces">
              {kol.images.slice(0, 14).map((img) => (
                <button key={img.id} type="button" aria-pressed={(scene.sourceAssetId ?? kol.images[0]?.id) === img.id} disabled={locked} title="Chọn ảnh này"
                  onClick={() => onPatch({ sourceAssetId: img.id })}>
                  <img src={media(img.thumbUrl ?? img.url)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        )}

        {scene.kind === 'clip' ? (
          <div>
            <span class="vp-label">Video có sẵn trong thư viện KOL</span>
            {kol && kol.videos.length ? (
              <select class="vp-select" value={scene.clipAssetId ?? ''} onChange={(e) => onPatch({ clipAssetId: e.currentTarget.value || null })}>
                <option value="">Chọn video…</option>
                {kol.videos.map((v, i) => <option key={v.id} value={v.id}>Video {i + 1}{v.durationSec ? ` · ${fmtSec(v.durationSec)}` : ''}</option>)}
              </select>
            ) : <p class="vp-muted">KOL này chưa có video trong thư viện.</p>}
          </div>
        ) : (
          <>
            <div>
              <span class="vp-label">{scene.kind === 'talking' ? `Lời ${kol?.name ?? 'KOL'} nói` : 'Lời dẫn / chữ trên màn hình (tuỳ chọn)'}</span>
              <textarea class="vp-textarea" rows={scene.kind === 'talking' ? 3 : 2} value={text} disabled={locked}
                placeholder={scene.kind === 'talking' ? 'Câu KOL nói, văn nói tự nhiên, câu ngắn' : 'Ví dụ: "Từ 1 ý tưởng → sản phẩm sẵn sàng đăng bán"'}
                onInput={(e) => setText(e.currentTarget.value)} onBlur={() => { if (text !== scene.text) onPatch({ text }); }} />
            </div>
            <div>
              <span class="vp-label">{scene.kind === 'talking' ? 'Bối cảnh & cử chỉ (tuỳ chọn)' : 'Hình ảnh & chuyển động'}</span>
              <input class="vp-input" value={visual} disabled={locked}
                placeholder={scene.kind === 'talking' ? 'Ví dụ: đứng trong xưởng in, cười nhẹ, tay chỉ về màn hình' : 'Ví dụ: close-up of a printer pressing a Christmas design onto a white t-shirt, slow push-in'}
                onInput={(e) => setVisual(e.currentTarget.value)} onBlur={() => { if (visual !== scene.visual) onPatch({ visual }); }} />
            </div>
          </>
        )}

        <div class="vp-scene-foot">
          <span class="vp-label" style={{ margin: 0 }}>Dựng bằng</span>
          {ENGINES_FOR[scene.kind].map((e) => {
            const blocked = e === 'veo' && Boolean(kol?.realPerson);
            return (
              <button key={e} type="button" class="vp-chip" aria-pressed={scene.engine === e} disabled={locked || (blocked && scene.engine !== e)}
                title={blocked ? `${kol!.name} là người thật: Veo không dựng người thật` : engines?.find((x) => x.id === e)?.role}
                onClick={() => onPatch({ engine: e })}>
                <span class={`vp-dot ${ready(e) ? 'is-on' : ''}`} aria-hidden="true" />{ENGINE_LABEL[e]}<span class="sr-only">{ready(e) ? ' (đã kết nối)' : ' (chưa kết nối)'}</span>
              </button>
            );
          })}
          <span class="vp-spacer" />
          <button type="button" class="vp-icon-btn" aria-label="Xoá cảnh" disabled={locked || busy} onClick={onRemove}><Trash2 size={14} /></button>
          <button type="button" class={`vp-btn vp-btn-sm ${scene.status === 'done' ? '' : 'vp-btn-primary'}`} disabled={locked || busy || Boolean(scene.problem) || Boolean(p.pendingApproval?.sceneIds.includes(scene.id))} onClick={onGenerate}
            title={scene.problem ?? 'Gửi thẻ duyệt chi phí cho riêng cảnh này'}>
            {p.pendingApproval?.sceneIds.includes(scene.id) ? 'Chờ duyệt' : scene.status === 'done' || scene.status === 'failed' ? <><RotateCcw size={13} /> Xin duyệt tạo lại</> : <><Play size={13} /> Xin duyệt</>}
          </button>
        </div>
        {scene.problem && scene.status !== 'done' && <p class="vp-problem"><UserRound size={13} /> {scene.problem}</p>}
        {scene.status === 'done' && scene.output && <TrimRow scene={scene} onTrim={onTrim} />}
        {scene.output?.credit && <p class="vp-faint" style={{ fontSize: '11px' }}>{scene.output.credit}</p>}
        {scene.error && scene.status === 'failed' && <p class="vp-error"><AlertTriangle size={12} style={{ verticalAlign: '-2px' }} /> {scene.error}</p>}
      </div>
    </article>
  );
}
