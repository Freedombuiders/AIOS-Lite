/** Video Studio › Sản xuất home: one composer (idea + @KOL + format), connected engines, recent videos. */
import { useState } from 'preact/hooks';
import { Layers, Loader2, Sparkles, Wand2 } from 'lucide-preact';

import { errorText, productionApi } from '@modules/video/web/lib/video-production-api';
import {
  ASPECTS, DURATIONS, IDEA_STARTERS, briefWithNames, mentionedIds,
  type CastMember, type EngineStatus, type VideoAspect,
} from '@modules/video/web/lib/video-production';
import { KolAvatar, MentionComposer } from './MentionComposer';

export function EngineStrip({ engines, onOpen }: { engines: EngineStatus[] | null; onOpen: () => void }) {
  if (!engines) return <p class="vp-faint">Đang kiểm tra công cụ…</p>;
  return (
    <div class="vp-engine-strip" aria-label="Công cụ tạo video">
      {engines.map((e) => (
        <button key={e.id} type="button" class="vp-chip" title={`${e.role}. ${e.detail}${e.fix ? ` — ${e.fix}` : ''}`} onClick={onOpen}>
          <span class={`vp-dot ${e.ready ? 'is-on' : ''}`} />{e.label}
        </button>
      ))}
    </div>
  );
}

export function ProductionHome({ cast, engines, onOpen, onConnections }: {
  cast: CastMember[] | null; engines: EngineStatus[] | null; onOpen: (id: string) => void; onConnections: () => void;
}) {
  const [text, setText] = useState('');
  const [aspect, setAspect] = useState<VideoAspect>('9:16');
  const [seconds, setSeconds] = useState(45);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [series, setSeries] = useState(0);

  const people = cast ?? [];
  const mentioned = mentionedIds(text, people);
  const byId = new Map(people.map((c) => [c.id, c]));

  const toggleKol = (k: CastMember) => {
    const tag = `@${k.handle || k.name.replace(/\s+/g, '')}`;
    setText(mentioned.includes(k.id) ? text.replace(new RegExp(`\\s*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '').trim() : `${tag} ${text}`.trim());
  };

  async function start() {
    if (busy) return;
    if (!mentioned.length) { setError('Gọi ít nhất một KOL bằng @ để Studio viết đúng giọng và dựng đúng mặt.'); return; }
    if (text.trim().length < 8) { setError('Mô tả ý tưởng thêm một chút (chủ đề, thông điệp, lời kêu gọi).'); return; }
    setBusy(true);
    setError('');
    try {
      if (series > 1) {
        const r = await productionApi.series({ brief: briefWithNames(text, people), cast: mentioned, count: series, aspect, targetSec: seconds });
        onOpen(r.productions[0].id);
        return;
      }
      const r = await productionApi.create({ brief: briefWithNames(text, people), cast: mentioned, aspect, targetSec: seconds, agent: true });
      onOpen(r.production.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="vp-wrap">
      <section class="vp-hero" aria-labelledby="vp-hero-title">
        <p class="vp-eyebrow">Video Studio · Agentic</p>
        <h1 id="vp-hero-title">Hôm nay làm video gì<span>?</span></h1>
        <p>Gọi <b>@KOL</b> và kể ý tưởng. <b>Đạo diễn AI</b> lên kịch bản đúng giọng nhân vật, chọn công cụ cho từng cảnh (HeyGen · Veo · fal · Pexels · RocketFlow), xin bạn duyệt chi phí một lần, rồi hoàn thiện bằng HyperFrames và đăng lên kênh của KOL.</p>
        <div class="vp-composer">
          <MentionComposer
            value={text}
            onInput={(v) => { setText(v); if (error) setError(''); }}
            cast={people}
            autoFocus
            onSubmit={start}
            placeholder={people.length ? `Ví dụ: @${people[0].handle} giới thiệu GenPrint AI cho chủ shop quà cá nhân hoá, có cảnh xưởng in, kết bằng lời mời dùng thử sớm` : 'Tạo KOL trong KOL Studio trước, rồi gọi @tên-KOL ở đây'}
          />
          <div class="vp-composer-bar">
            <div class="vp-cast-chips" aria-label="KOL">
              {cast === null ? <span class="vp-faint">Đang tải KOL…</span> : people.length === 0 ? (
                <a class="vp-link" href="/kol">Chưa có KOL — tạo trong KOL Studio</a>
              ) : people.map((k) => (
                <button key={k.id} type="button" class={`vp-cast-chip ${mentioned.includes(k.id) ? 'is-on' : ''}`} onClick={() => toggleKol(k)} title={k.tagline}>
                  <KolAvatar kol={k} />{k.name}
                </button>
              ))}
            </div>
            <span class="vp-spacer" />
            <span class="vp-faint" style={{ fontSize: '11px' }}>⌘↵ để bắt đầu</span>
            <button type="button" class="vp-btn vp-btn-primary vp-btn-lg" disabled={busy || !text.trim()} onClick={start}>
              {busy ? <><Loader2 size={15} class="animate-spin" /> {series > 1 ? 'Đang lên series…' : 'Đang mở…'}</> : series > 1 ? <><Layers size={15} /> Làm series {series} video</> : <><Wand2 size={15} /> Bắt đầu với Đạo diễn AI</>}
            </button>
          </div>
        </div>
        <div class="vp-options">
          <span class="vp-label">Khung hình</span>
          <div class="vp-seg" role="group" aria-label="Khung hình">
            {ASPECTS.map((a) => <button key={a.id} type="button" aria-pressed={aspect === a.id} title={a.hint} onClick={() => setAspect(a.id)}>{a.label}</button>)}
          </div>
          <span class="vp-label">Thời lượng</span>
          <div class="vp-seg" role="group" aria-label="Thời lượng">
            {DURATIONS.map((d) => <button key={d} type="button" aria-pressed={seconds === d} onClick={() => setSeconds(d)}>{d}s</button>)}
          </div>
          <span class="vp-label">Số video</span>
          <div class="vp-seg" role="group" aria-label="Một video hoặc series">
            {[0, 3, 5, 7].map((n) => <button key={n} type="button" aria-pressed={series === n} onClick={() => setSeries(n)}>{n ? `Series ${n}` : '1 video'}</button>)}
          </div>
        </div>
        <div class="vp-starters" aria-label="Gợi ý ý tưởng">
          {IDEA_STARTERS.map((s) => (
            <button key={s.label} type="button" class="vp-chip" onClick={() => setText(`${mentioned.length ? '' : people[0] ? `@${people[0].handle} ` : ''}${text ? `${text} ` : ''}${s.text}`)}>
              <Sparkles size={12} />{s.label}
            </button>
          ))}
        </div>
        {error && <p class="vp-error" role="alert" style={{ marginTop: '12px' }}>{error}</p>}
        {busy && series > 1 && <p class="vp-muted" style={{ marginTop: '10px' }}>Bộ não của {mentioned.map((id) => byId.get(id)?.name).filter(Boolean).join(', ')} đang chia ý tưởng thành {series} góc khai thác…</p>}
      </section>

      <section class="vp-card" aria-labelledby="vp-engines">
        <div class="vp-card-head">
          <h2 id="vp-engines">Công cụ sản xuất</h2>
          <button type="button" class="vp-link" onClick={onConnections}>Kết nối & giọng KOL →</button>
        </div>
        <EngineStrip engines={engines} onOpen={onConnections} />
      </section>

    </div>
  );
}
