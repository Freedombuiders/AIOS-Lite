/** Video Studio › Kết nối: engines and finishing tools, HeyGen voice per KOL, RocketFlow. */
import { useEffect, useState } from 'preact/hooks';
import { ExternalLink, Loader2, Mic, Palette, Pause, Play } from 'lucide-preact';

import { videoEditApi } from '@modules/video/web/lib/video-edit/api';

import { errorText, productionApi } from '@modules/video/web/lib/video-production-api';
import type { CastMember, EngineStatus, HeygenVoice, KolBrand } from '@modules/video/web/lib/video-production';
import { RocketFlowSettings } from '../RocketFlowSettings';
import { KolAvatar } from './MentionComposer';

const SERVICE_OF: Record<string, string> = { heygen: 'heygen', fal: 'fal', elevenlabs: 'elevenlabs', stock: 'pexels' };

const EMPTY_BRAND: KolBrand = { styleId: null, cta: '', intro: '', outro: '', captionNote: '', music: 'auto' };

function BrandEditor({ kol, styles, onSaved }: { kol: CastMember; styles: { id: string; name: string }[]; onSaved: () => void }) {
  const [b, setB] = useState<KolBrand>({ ...EMPTY_BRAND, ...(kol.brand ?? {}) });
  const [state, setState] = useState<'' | 'saving' | 'saved'>('');
  const [error, setError] = useState('');
  const set = <K extends keyof KolBrand>(k: K, v: KolBrand[K]) => { setB({ ...b, [k]: v }); setState(''); };
  async function save() {
    setState('saving'); setError('');
    try { await productionApi.setBrand(kol.id, b); setState('saved'); onSaved(); } catch (e) { setError(errorText(e)); setState(''); }
  }
  return (
    <details class="vx-brand">
      <summary><Palette size={13} /> Bộ nhận diện của {kol.name}{kol.brand?.cta ? ` · CTA "${kol.brand.cta.slice(0, 30)}"` : ''}</summary>
      <div class="vx-brand-grid">
        <label><span class="vp-label">Phong cách hoàn thiện mặc định</span>
          <select class="vp-select" value={b.styleId ?? ''} onChange={(e) => set('styleId', e.currentTarget.value || null)}>
            <option value="">Để Đạo diễn AI chọn</option>
            {styles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label><span class="vp-label">Nhạc nền</span>
          <select class="vp-select" value={b.music} onChange={(e) => set('music', e.currentTarget.value as KolBrand['music'])}>
            <option value="auto">Đạo diễn chọn nhạc hợp</option>
            <option value="none">Không dùng nhạc nền</option>
          </select>
        </label>
        <label class="is-wide"><span class="vp-label">Lời kêu gọi luôn dùng cuối video</span>
          <input class="vp-input" value={b.cta} placeholder='Ví dụ: Bình luận "HỆ THỐNG", tôi gửi bạn quy trình.' onInput={(e) => set('cta', e.currentTarget.value)} /></label>
        <label><span class="vp-label">Câu mở quen thuộc (tuỳ chọn)</span>
          <input class="vp-input" value={b.intro} onInput={(e) => set('intro', e.currentTarget.value)} /></label>
        <label><span class="vp-label">Câu chào kết (tuỳ chọn)</span>
          <input class="vp-input" value={b.outro} onInput={(e) => set('outro', e.currentTarget.value)} /></label>
        <label class="is-wide"><span class="vp-label">Kiểu phụ đề</span>
          <input class="vp-input" value={b.captionNote} placeholder="Ví dụ: chữ to, đậm, từ khoá màu vàng, đặt trên vùng nút bấm" onInput={(e) => set('captionNote', e.currentTarget.value)} /></label>
      </div>
      <div class="vp-row" style={{ marginTop: '10px' }}>
        <button type="button" class="vp-btn vp-btn-primary vp-btn-sm" disabled={state === 'saving'} onClick={() => void save()}>{state === 'saving' ? 'Đang lưu…' : 'Lưu bộ nhận diện'}</button>
        {state === 'saved' && <span class="vp-pill is-done">Đã lưu</span>}
        {error && <span class="vp-error">{error}</span>}
      </div>
    </details>
  );
}

export function ConnectionsPanel({ engines, cast, onChanged }: { engines: EngineStatus[] | null; cast: CastMember[] | null; onChanged: () => void }) {
  const [voices, setVoices] = useState<HeygenVoice[] | null>(null);
  const [heygenOn, setHeygenOn] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [styles, setStyles] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    productionApi.heygenVoices({ scope: 'all' }).then((r) => { setHeygenOn(r.configured); setVoices(r.voices); }).catch((e) => { setError(errorText(e)); setVoices([]); });
    videoEditApi.styles().then((r) => setStyles(r.styles.map((s) => ({ id: s.id, name: s.name })))).catch(() => setStyles([]));
  }, []);

  const shown = (voices ?? [])
    .filter((v) => showAll || v.language.toLowerCase().startsWith('viet') || v.type === 'private')
    .sort((a, b) => Number(b.type === 'private') - Number(a.type === 'private') || a.name.localeCompare(b.name, 'vi'));
  const mine = shown.filter((v) => v.type === 'private');
  const stock = shown.filter((v) => v.type !== 'private');
  const [playing, setPlaying] = useState<string | null>(null);
  const [audio] = useState(() => (typeof Audio === 'undefined' ? null : new Audio()));
  useEffect(() => () => { audio?.pause(); }, [audio]);
  function preview(voiceId: string) {
    const v = voices?.find((x) => x.voiceId === voiceId);
    if (!audio || !v?.previewUrl) return;
    if (playing === voiceId) { audio.pause(); setPlaying(null); return; }
    audio.src = v.previewUrl;
    audio.onended = () => setPlaying(null);
    void audio.play().then(() => setPlaying(voiceId)).catch(() => setPlaying(null));
  }
  const label = (v: HeygenVoice) => `${v.name}${v.gender ? ` · ${v.gender === 'male' ? 'nam' : v.gender === 'female' ? 'nữ' : v.gender}` : ''}${showAll ? ` · ${v.language}` : ''}`;

  async function setVoice(kol: CastMember, voiceId: string) {
    setSaving(kol.id);
    setError('');
    try {
      const v = voices?.find((x) => x.voiceId === voiceId);
      await productionApi.setVoice(kol.id, voiceId ? { voiceId, name: v?.name ?? voiceId } : null);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving('');
    }
  }

  return (
    <div class="vp-wrap">
      <section class="vp-card" aria-labelledby="vp-conn">
        <div class="vp-card-head">
          <h2 id="vp-conn">Công cụ tạo & hoàn thiện video</h2>
          <a href="/integrations">Mở Integrations <ExternalLink size={11} style={{ verticalAlign: '-1px' }} /></a>
        </div>
        {!engines ? <p class="vp-faint">Đang kiểm tra…</p> : (
          <div class="vp-engines">
            {engines.map((e) => (
              <div key={e.id} class={`vp-engine ${e.ready ? '' : 'is-off'}`}>
                <b><span class={`vp-dot ${e.ready ? 'is-on' : ''}`} />{e.label}</b>
                <p>{e.role}</p>
                <small>{e.detail}</small>
                {!e.ready && e.fix && (SERVICE_OF[e.id]
                  ? <a class="vp-link" href={`/integrations?service=${SERVICE_OF[e.id]}`}>{e.fix} →</a>
                  : <small class="vp-muted">{e.fix}</small>)}
              </div>
            ))}
          </div>
        )}
      </section>

      <section class="vp-card" aria-labelledby="vp-voices">
        <div class="vp-card-head">
          <h2 id="vp-voices"><Mic size={15} style={{ verticalAlign: '-2px' }} /> Giọng & bộ nhận diện của từng KOL</h2>
          {voices && voices.length > 0 && (
            <label class="vp-row vp-muted" style={{ fontSize: '12px' }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.currentTarget.checked)} /> Hiện cả giọng không phải tiếng Việt
            </label>
          )}
        </div>
        <p class="vp-muted" style={{ fontSize: '12px', marginBottom: '12px', lineHeight: 1.5 }}>
          Cảnh "KOL nói" dựng bằng HeyGen dùng giọng gán ở đây (ví dụ giọng nhân bản của chính bạn). KOL Studio vẫn là nơi giữ khuôn mặt và hồ sơ nhân vật.
        </p>
        {heygenOn === false && <p class="vp-muted">Chưa kết nối HeyGen. <a class="vp-link" href="/integrations?service=heygen">Dán API key ở Integrations › HeyGen →</a></p>}
        {cast === null || voices === null ? <p class="vp-faint"><Loader2 size={13} class="animate-spin" style={{ verticalAlign: '-2px' }} /> Đang tải…</p> : (
          <ul class="vp-voices">
            {cast.map((k) => (
              <li key={k.id} class="vp-voice">
                <KolAvatar kol={k} size="lg" />
                <span class="min-w-0"><b>{k.name}</b><small>@{k.handle} · {k.images.length} ảnh · {k.videos.length} video{k.realPerson ? ' · người thật: cảnh nói cần HeyGen' : ''}</small></span>
                <select class="vp-select" aria-label={`Giọng HeyGen của ${k.name}`} value={k.voice?.voiceId ?? ''} disabled={!heygenOn || saving === k.id}
                  onChange={(e) => setVoice(k, e.currentTarget.value)}>
                  <option value="">Chưa chọn giọng</option>
                  {k.voice && !shown.some((v) => v.voiceId === k.voice!.voiceId) && <option value={k.voice.voiceId}>{k.voice.name}</option>}
                  {mine.length > 0 && <optgroup label="Giọng của bạn (nhân bản)">{mine.map((v) => <option key={v.voiceId} value={v.voiceId}>{label(v)}</option>)}</optgroup>}
                  {stock.length > 0 && <optgroup label="Giọng có sẵn của HeyGen">{stock.map((v) => <option key={v.voiceId} value={v.voiceId}>{label(v)}</option>)}</optgroup>}
                </select>
                {k.voice && voices?.find((v) => v.voiceId === k.voice!.voiceId)?.previewUrl ? (
                  <button type="button" class="vp-icon-btn" aria-label={playing === k.voice.voiceId ? 'Dừng nghe thử' : `Nghe thử giọng ${k.voice.name}`} onClick={() => preview(k.voice!.voiceId)}>
                    {playing === k.voice.voiceId ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                ) : <span class={`vp-pill ${k.voice ? 'is-done' : ''}`}>{saving === k.id ? 'Đang lưu…' : k.voice ? 'Đã gán' : 'Chưa gán'}</span>}
                <div class="vx-brand-row"><BrandEditor kol={k} styles={styles} onSaved={onChanged} /></div>
              </li>
            ))}
          </ul>
        )}
        {error && <p class="vp-error" role="alert" style={{ marginTop: '10px' }}>{error}</p>}
      </section>

      <section class="vp-card" aria-label="RocketFlow">
        <div class="vp-card-head"><h2>RocketFlow · Google Flow</h2></div>
        <p class="vp-muted" style={{ fontSize: '12px', marginBottom: '8px' }}>Tạo cảnh B-roll qua Google Flow bằng tài khoản của bạn (tiện ích Chrome trên cùng máy).</p>
        <RocketFlowSettings />
      </section>
    </div>
  );
}
