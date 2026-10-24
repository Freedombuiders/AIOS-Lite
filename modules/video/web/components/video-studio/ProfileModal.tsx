// Channel profile editor: create + edit, five tabs.
import { useEffect, useState } from 'preact/hooks';
import { ExternalLink, Plus, Trash2 } from 'lucide-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Modal } from '@/components/Modal';
import { Toggle } from '@/components/Toggle';
import { videoEditApi, type BrainChoicesResponse } from '@modules/video/web/lib/video-edit/api';
import { isHex, PROFILE_COLORS } from '@modules/video/web/lib/video-edit/format';
import {
  createProfile, currentProfile, deleteProfile, dropPendingUpload, profileModal, resumePendingUpload,
  saveProfile, styles, type ProfileTab,
} from '@modules/video/web/lib/video-edit/studio';
import type { VideoAsset, VideoAspect, VideoProfile } from '@modules/video/web/lib/video-edit/types';
import { ONBOARDING_QUESTIONS } from '@modules/video/web/lib/video-edit/types';

const TABS: { id: ProfileTab; label: string }[] = [
  { id: 'info', label: 'Thông tin' },
  { id: 'brand', label: 'Thương hiệu' },
  { id: 'audio', label: 'Âm thanh & từ khoá' },
  { id: 'taste', label: 'Gu & góp ý' },
  { id: 'questions', label: '6 câu hỏi' },
  { id: 'channels', label: 'Học từ kênh' },
];
const ASPECTS: VideoAspect[] = ['9:16', '16:9', '1:1', '4:5'];
const MAX_CHANNELS = 10;
const STARTERS: { id: NonNullable<VideoProfile['starter']>; label: string; hint: string }[] = [
  { id: 'blank', label: 'Trống', hint: 'Không đặt sẵn gì, tự điền sau.' },
  { id: 'editorial', label: 'Biên tập', hint: 'Sạch, chữ trắng, nhịp vừa, ít hiệu ứng.' },
  { id: 'neon', label: 'Neon', hint: 'Nền tối, chữ phát sáng, nhạc điện tử.' },
  { id: 'energetic', label: 'Sôi động', hint: 'Cắt nhanh, nhiều hiệu ứng, màu rực.' },
];
const AUDIO_DEFAULTS = { speechRate: 1, voiceLufs: -16, musicLufs: -34, finalLufs: -15.5 };
type ColorKey = 'primary' | 'accent' | 'light' | 'dark' | 'text' | 'cardBg';
type FontKey = 'fontHeading' | 'fontBody' | 'fontCaption' | 'fontCover';
const COLOR_FIELDS: { key: ColorKey; label: string }[] = [
  { key: 'primary', label: 'Màu chính' }, { key: 'accent', label: 'Màu nhấn' },
  { key: 'light', label: 'Màu sáng' }, { key: 'dark', label: 'Màu tối' },
  { key: 'text', label: 'Màu chữ' }, { key: 'cardBg', label: 'Màu nền thẻ' },
];
const FONT_FIELDS: { key: FontKey; label: string }[] = [
  { key: 'fontHeading', label: 'Font tiêu đề' }, { key: 'fontBody', label: 'Font nội dung' },
  { key: 'fontCaption', label: 'Font phụ đề' }, { key: 'fontCover', label: 'Font ảnh bìa' },
];

interface Draft {
  name: string; defaultAspect: VideoAspect; defaultStyleId: string; color: string;
  autoApprovePlan: boolean; brand: VideoProfile['brand']; taste: string; onboarding: Record<string, string>; referenceChannels: string[];
  seriesName: string; deliverDir: string; coverStyle: string; keepWords: string; starter: NonNullable<VideoProfile['starter']>;
  brainVaultId: string;
  audio: { speechRate: string; voiceLufs: string; musicLufs: string; finalLufs: string };
}

const num = (v: string, fallback: number) => { const n = Number(v.replace(',', '.')); return v.trim() !== '' && Number.isFinite(n) ? n : fallback; };

function toDraft(p: VideoProfile | null): Draft {
  return {
    name: p?.name ?? '', defaultAspect: p?.defaultAspect ?? '9:16',
    defaultStyleId: p?.defaultStyleId ?? '', color: p?.color ?? PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)],
    autoApprovePlan: p?.autoApprovePlan ?? false, brand: { ...(p?.brand ?? {}) }, taste: p?.taste ?? '',
    onboarding: { ...(p?.onboarding ?? {}) }, referenceChannels: [...(p?.referenceChannels ?? [])],
    seriesName: p?.seriesName ?? '', deliverDir: p?.deliverDir ?? '', coverStyle: p?.coverStyle ?? '',
    brainVaultId: p?.brainVaultId ?? '',
    keepWords: (p?.keepWords ?? []).join(', '), starter: p?.starter ?? 'blank',
    audio: {
      speechRate: String(p?.audio?.speechRate ?? AUDIO_DEFAULTS.speechRate), voiceLufs: String(p?.audio?.voiceLufs ?? AUDIO_DEFAULTS.voiceLufs),
      musicLufs: String(p?.audio?.musicLufs ?? AUDIO_DEFAULTS.musicLufs), finalLufs: String(p?.audio?.finalLufs ?? AUDIO_DEFAULTS.finalLufs),
    },
  };
}

export function ProfileModal() {
  const m = profileModal.value;
  if (!m) return null;
  return <ProfileForm mode={m.mode} initialTab={m.tab ?? 'info'} />;
}

function ProfileForm({ mode, initialTab }: { mode: 'create' | 'edit'; initialTab: ProfileTab }) {
  const existing = mode === 'edit' ? currentProfile() : null;
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const [d, setD] = useState<Draft>(() => toDraft(existing));
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [fonts, setFonts] = useState<VideoAsset[]>([]);
  const [images, setImages] = useState<VideoAsset[]>([]);
  const [brains, setBrains] = useState<BrainChoicesResponse | null>(null);
  useEffect(() => {
    let live = true;
    void videoEditApi.assets({ kind: 'font' }).then((r) => { if (live) setFonts(r.assets.filter((a) => a.enabled !== false)); }).catch(() => { /* free-text fallback below */ });
    void videoEditApi.assets({ kind: 'image' }).then((r) => { if (live) setImages(r.assets.filter((a) => a.enabled !== false)); }).catch(() => { /* ignore */ });
    void videoEditApi.brains().then((r) => { if (live) setBrains(r); }).catch(() => { /* unavailable */ });
    return () => { live = false; };
  }, []);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const close = () => { if (mode === 'create') dropPendingUpload(); profileModal.value = null; };

  const save = async () => {
    if (!d.name.trim()) { setTab('info'); return; }
    setSaving(true);
    try {
      const extra = {
        autoApprovePlan: d.autoApprovePlan, brand: d.brand, taste: d.taste, onboarding: d.onboarding, referenceChannels: d.referenceChannels,
        seriesName: d.seriesName.trim(), deliverDir: d.deliverDir.trim(), coverStyle: d.coverStyle.trim(),
        brainVaultId: d.brainVaultId || null,
        keepWords: d.keepWords.split(/[,\n]/).map((w) => w.trim()).filter(Boolean),
        audio: {
          speechRate: num(d.audio.speechRate, AUDIO_DEFAULTS.speechRate), voiceLufs: num(d.audio.voiceLufs, AUDIO_DEFAULTS.voiceLufs),
          musicLufs: num(d.audio.musicLufs, AUDIO_DEFAULTS.musicLufs), finalLufs: num(d.audio.finalLufs, AUDIO_DEFAULTS.finalLufs),
        },
      };
      if (existing) {
        const ok = await saveProfile(existing.id, {
          name: d.name.trim(), defaultAspect: d.defaultAspect,
          defaultStyleId: d.defaultStyleId || null, color: d.color, ...extra,
        });
        if (ok) profileModal.value = null;
      } else {
        const created = await createProfile({
          name: d.name.trim(),
          defaultAspect: d.defaultAspect, ...(d.defaultStyleId ? { defaultStyleId: d.defaultStyleId } : {}), color: d.color,
          starter: d.starter,
        }, extra);
        if (created) { profileModal.value = null; resumePendingUpload(); }
      }
    } finally { setSaving(false); }
  };

  const addChannel = () => {
    const url = newUrl.trim();
    if (!url || d.referenceChannels.length >= MAX_CHANNELS || d.referenceChannels.includes(url)) return;
    set('referenceChannels', [...d.referenceChannels, url]);
    setNewUrl('');
  };
  const color = (key: ColorKey, label: string) => (
    <div class="vs-color-row">
      <input type="color" aria-label={`Chọn ${label.toLowerCase()}`} value={isHex(d.brand[key]) ? d.brand[key] : '#000000'}
        onInput={(e) => set('brand', { ...d.brand, [key]: e.currentTarget.value })} />
      <input class="vs-input" aria-label={`${label} (mã màu)`} placeholder="#RRGGBB" maxLength={7} value={d.brand[key] ?? ''}
        onInput={(e) => set('brand', { ...d.brand, [key]: e.currentTarget.value.trim() || undefined })} />
    </div>
  );
  const fontSelect = (key: FontKey, label: string) => {
    const cur = d.brand[key] ?? '';
    const known = fonts.some((f) => f.id === cur || f.file === cur || f.name === cur);
    return (
      <label class="vs-field" key={key}><span>{label}</span>
        <select class="vs-input" value={cur} onChange={(e) => set('brand', { ...d.brand, [key]: e.currentTarget.value || undefined })}>
          <option value="">Theo phong cách</option>
          {cur && !known && <option value={cur}>{cur} (ngoài kho)</option>}
          {fonts.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
    );
  };
  const setAudio = (k: keyof Draft['audio'], v: string) => set('audio', { ...d.audio, [k]: v });
  const lufs = (k: 'voiceLufs' | 'musicLufs' | 'finalLufs', label: string) => (
    <label class="vs-field" key={k}><span>{label} (LUFS)</span>
      <input class="vs-input" inputMode="decimal" value={d.audio[k]} onInput={(e) => setAudio(k, e.currentTarget.value)} aria-describedby="vs-lufs-help" />
    </label>
  );

  return (
    <Modal
      open
      onClose={close}
      title={existing ? `Hồ sơ thương hiệu: ${existing.name}` : 'Tạo hồ sơ thương hiệu'}
      width={680}
      footer={
        <>
          {existing && (
            <button type="button" class="vs-btn vs-btn-danger" onClick={() => { setDeleteError(''); setConfirmDelete(true); }}>
              <Trash2 size={14} aria-hidden="true" /> Xoá hồ sơ
            </button>
          )}
          <button type="button" class="vs-btn ml-auto" onClick={close}>Huỷ</button>
          <button type="button" class="vs-btn vs-btn-accent" disabled={saving || !d.name.trim()} onClick={() => void save()}>
            {saving ? 'Đang lưu…' : existing ? 'Lưu' : 'Tạo hồ sơ'}
          </button>
        </>
      }
    >
      <div class="vs-seg vs-seg-wrap" role="tablist" aria-label="Mục hồ sơ">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} class={tab === t.id ? 'is-active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {deleteError && <div class="vs-error" role="alert">{deleteError}</div>}

      {tab === 'info' && (
        <div class="vs-form">
          <label class="vs-field"><span>Tên thương hiệu</span>
            <input class="vs-input" maxLength={60} required value={d.name} onInput={(e) => set('name', e.currentTarget.value)} placeholder="VD: Rocket AI" />
          </label>
          <p class="vs-muted">Một hồ sơ thương hiệu dùng cho cùng video trên nhiều kênh mạng xã hội. Kênh đăng sẽ được chọn riêng khi phân phối.</p>
          <div class="vs-grid2">
            <label class="vs-field"><span>Tỉ lệ mặc định</span>
              <select class="vs-input" value={d.defaultAspect} onChange={(e) => set('defaultAspect', e.currentTarget.value as VideoAspect)}>
                {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label class="vs-field"><span>Phong cách mặc định</span>
              <select class="vs-input" value={d.defaultStyleId} onChange={(e) => set('defaultStyleId', e.currentTarget.value)}>
                <option value="">Không đặt</option>
                {styles.value.map((s) => <option key={s.id} value={s.id}>{s.command} · {s.name}</option>)}
              </select>
            </label>
          </div>
          <div class="vs-grid2">
            <label class="vs-field"><span>Tên series</span>
              <input class="vs-input" maxLength={80} value={d.seriesName} onInput={(e) => set('seriesName', e.currentTarget.value)} placeholder="VD: Mẹo AI mỗi ngày" />
            </label>
            <label class="vs-field"><span>Thư mục giao video</span>
              <input class="vs-input" value={d.deliverDir} onInput={(e) => set('deliverDir', e.currentTarget.value)} placeholder="VD: /Users/ban/Videos/ra" />
            </label>
          </div>
          <div class="vs-field">
            <span>Second Brain của thương hiệu</span>
            <div class="vs-grid2">
              <select class="vs-input" value={d.brainVaultId} onChange={(e) => set('brainVaultId', e.currentTarget.value)} disabled={!brains?.enabled} aria-label="Second Brain của thương hiệu">
                <option value="">Brain mặc định</option>
                {brains?.vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <a class="vs-btn" href={brains?.enabled ? `/brain?vault=${encodeURIComponent(d.brainVaultId || brains.activeVaultId)}` : '/settings#knowledge'} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} aria-hidden="true" /> {brains?.enabled ? 'Mở Second Brain' : 'Thiết lập Second Brain'}
              </a>
            </div>
            <span class="vs-muted vs-field-help">Agent tra bài học của thương hiệu trong Brain này khi dựng video. Liên kết được lưu cùng hồ sơ để dùng lại cho tính năng tạo video từ kịch bản sau này.</span>
          </div>
          {!existing && (
            <div class="vs-field"><span>Bộ khởi đầu</span>
              <div class="vs-mark-kinds" role="radiogroup" aria-label="Bộ khởi đầu">
                {STARTERS.map((st) => (
                  <button key={st.id} type="button" role="radio" aria-checked={d.starter === st.id} class={`vs-mark-kind${d.starter === st.id ? ' is-on' : ''}`} onClick={() => set('starter', st.id)}>{st.label}</button>
                ))}
              </div>
              <span class="vs-muted vs-field-help">{STARTERS.find((st) => st.id === d.starter)?.hint}</span>
            </div>
          )}
          <div class="vs-field"><span>Màu hồ sơ</span>
            <div class="vs-swatches" role="radiogroup" aria-label="Màu hồ sơ">
              {PROFILE_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={d.color === c} aria-label={c} class={d.color === c ? 'is-active' : ''} style={{ background: c }} onClick={() => set('color', c)} />
              ))}
            </div>
          </div>
          <div class="vs-switch-row">
            <div>
              <div class="vs-switch-title">Tự duyệt kế hoạch</div>
              <p class="vs-muted">Bật thì agent dựng luôn mà không chờ bạn bấm Duyệt. Nên tắt cho tới khi bạn tin gu của agent; có thể bật lại bất cứ lúc nào.</p>
            </div>
            <Toggle on={d.autoApprovePlan} onChange={() => set('autoApprovePlan', !d.autoApprovePlan)} ariaLabel="Tự duyệt kế hoạch dựng" />
          </div>
        </div>
      )}

      {tab === 'brand' && (
        <div class="vs-form">
          <div class="vs-grid2">
            {COLOR_FIELDS.map((c) => <div class="vs-field" key={c.key}><span>{c.label}</span>{color(c.key, c.label)}</div>)}
          </div>
          <div class="vs-grid2">
            {FONT_FIELDS.map((f) => fontSelect(f.key, f.label))}
          </div>
          <p class="vs-muted">{fonts.length > 0 ? 'Chọn font trong kho. Chỉ nên dùng font có dấu tiếng Việt.' : 'Kho font đang trống hoặc chưa tải được. Mở “Quản lý kho” để thêm font.'}</p>
          <div class="vs-grid2">
            <label class="vs-field"><span>Logo</span>
              <select class="vs-input" value={d.brand.logoAssetId ?? ''} onChange={(e) => set('brand', { ...d.brand, logoAssetId: e.currentTarget.value || undefined })}>
                <option value="">Không dùng logo</option>
                {d.brand.logoAssetId && !images.some((i) => i.id === d.brand.logoAssetId) && <option value={d.brand.logoAssetId}>{d.brand.logoAssetId}</option>}
                {images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
            <label class="vs-field"><span>Kiểu ảnh bìa</span>
              <input class="vs-input" maxLength={80} value={d.coverStyle} onInput={(e) => set('coverStyle', e.currentTarget.value)} placeholder="VD: chữ lớn giữa khung, nền mờ" />
            </label>
          </div>
        </div>
      )}

      {tab === 'audio' && (
        <div class="vs-form">
          <label class="vs-field"><span>Tốc độ nói (×)</span>
            <input class="vs-input" inputMode="decimal" value={d.audio.speechRate} onInput={(e) => setAudio('speechRate', e.currentTarget.value)} placeholder="1" />
          </label>
          <div class="vs-grid2">
            {lufs('voiceLufs', 'Giọng nói')}
            {lufs('musicLufs', 'Nhạc nền')}
            {lufs('finalLufs', 'Bản cuối')}
          </div>
          <p class="vs-muted" id="vs-lufs-help">Số càng gần 0 càng to. Mặc định: giọng −16, nhạc −34, bản cuối −15,5. Nhạc nên nhỏ hơn giọng khoảng 18 dB.</p>
          <label class="vs-field"><span>Từ cần giữ nguyên (cách nhau bằng dấu phẩy)</span>
            <textarea class="vs-input" rows={3} value={d.keepWords} onInput={(e) => set('keepWords', e.currentTarget.value)} placeholder="VD: tên sản phẩm, thương hiệu, tên riêng" />
          </label>
          <p class="vs-muted">Tên sản phẩm, thương hiệu: đưa vào bước chép lời để nghe đúng, và agent không được “sửa” những từ này.</p>
        </div>
      )}

      {tab === 'taste' && (
        <div class="vs-form">
          <label class="vs-field"><span>Gu dựng của kênh (Markdown)</span>
            <textarea class="vs-input vs-mono-input" rows={12} value={d.taste} onInput={(e) => set('taste', e.currentTarget.value)} placeholder={'- Cắt nhanh, bỏ hết chỗ ngập ngừng\n- Chữ vàng cho con số\n- Không nhạc buồn'} />
          </label>
          <p class="vs-muted">Agent đọc phần này trước mỗi kế hoạch dựng, và tự ghi thêm vào đây mỗi khi bạn góp ý.</p>
        </div>
      )}

      {tab === 'questions' && (
        <div class="vs-form">
          {ONBOARDING_QUESTIONS.map((q, i) => (
            <label key={q.id} class="vs-field"><span>{i + 1}. {q.question}</span>
              <textarea class="vs-input" rows={2} placeholder={q.hint} value={d.onboarding[q.id] ?? ''} onInput={(e) => set('onboarding', { ...d.onboarding, [q.id]: e.currentTarget.value })} />
            </label>
          ))}
        </div>
      )}

      {tab === 'channels' && (
        <div class="vs-form">
          <div class="vs-field"><span>Kênh / video mẫu ({d.referenceChannels.length}/{MAX_CHANNELS})</span>
            <div class="vs-row-gap vs-row-nowrap">
              <input class="vs-input" type="url" placeholder="https://www.tiktok.com/@kenh-mau" value={newUrl} disabled={d.referenceChannels.length >= MAX_CHANNELS}
                onInput={(e) => setNewUrl(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addChannel(); } }} />
              <button type="button" class="vs-btn" disabled={!newUrl.trim() || d.referenceChannels.length >= MAX_CHANNELS} onClick={addChannel}><Plus size={14} aria-hidden="true" /> Thêm</button>
            </div>
          </div>
          {d.referenceChannels.length > 0 && (
            <ul class="vs-chan-list">
              {d.referenceChannels.map((u) => (
                <li key={u}>
                  <span class="vs-chan-url" title={u}>{u}</span>
                  <button type="button" class="vs-icon-btn" aria-label={`Bỏ ${u}`} onClick={() => set('referenceChannels', d.referenceChannels.filter((x) => x !== u))}><Trash2 size={15} aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
          <p class="vs-muted">Phân tích nhịp cắt/kiểu chữ/màu — giai đoạn 3; chỉ học cách làm, không lấy nội dung.</p>
        </div>
      )}

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (!existing) return;
          void deleteProfile(existing.id).then((err) => { if (err) setDeleteError(err); else profileModal.value = null; });
        }}
        title="Xoá hồ sơ thương hiệu?"
        body={existing ? `Hồ sơ "${existing.name}" sẽ bị xoá. Hồ sơ còn việc dựng sẽ không xoá được.` : undefined}
        confirmLabel="Xoá hồ sơ"
        cancelLabel="Giữ lại"
        destructive
      />
    </Modal>
  );
}
