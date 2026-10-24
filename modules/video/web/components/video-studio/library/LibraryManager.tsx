// "Quản lý kho": browse, preview, upload, edit and delete library assets; install the starter pack.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  Check, Download, FileUp, Music2, Pause, Pencil, Play, RefreshCw, Search, Square, Trash2, Upload, X,
} from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { AssetVisual } from '../AssetVisual';
import { ASSET_KINDS, type AssetKind } from '@modules/video/web/lib/video-edit/types';
import {
  assetFileUrl, formatBytes, formatDuration, libraryApi, libraryErrorMessage, uploadAsset, UPLOAD_ACCEPT,
  type LibraryAsset, type LibraryResponse, type SeedStatus,
} from '@modules/video/web/lib/video-edit/library-api';
import '@modules/video/web/styles/video-studio.css';
import '@modules/video/web/styles/video-library.css';

const FONT_SAMPLE = 'Dựng video như người thật';
const MOODS = ['Năng lượng', 'Tươi sáng', 'Tập trung', 'Hồi hộp', 'Suy tư', 'Bình yên'];
const SEED_LABELS: Record<string, string> = { fonts: 'Font', sfx: 'Tiếng động', music: 'Nhạc', luts: 'LUT', stickers: 'Nhãn dán' };
const AUDIO_KINDS: AssetKind[] = ['bgm', 'sfx'];
const IMAGE_KINDS: AssetKind[] = ['image', 'background', 'icon', 'overlay'];

type Draft = {
  name: string; description: string; tags: string; mood: string; bpm: string;
  license: string; attribution: string; sourceUrl: string; enabled: boolean;
};

const draftOf = (a: LibraryAsset): Draft => ({
  name: a.name, description: a.description ?? '', tags: a.tags.join(', '), mood: a.mood ?? '', bpm: a.bpm ? String(a.bpm) : '',
  license: a.license ?? '', attribution: a.attribution ?? '', sourceUrl: a.sourceUrl ?? '', enabled: a.enabled !== false,
});

function licenseTone(a: LibraryAsset): string {
  const l = (a.license ?? '').toLowerCase();
  if (!l || l.includes('chưa rõ') || l.includes('cần bổ sung')) return 'warn';
  if (a.attribution || l.includes('by')) return 'attr';
  return 'ok';
}

/** One @font-face per font asset, named after the asset id so two uploads never collide. */
function fontFamilyName(id: string): string {
  return `vl-${id.replace(/[^a-z0-9]/gi, '-')}`;
}

function FontFaceStyle({ asset }: { asset: LibraryAsset }) {
  if (!asset.available || !asset.file) return null;
  const face = asset.faces?.find((f) => f.file === asset.file) ?? asset.faces?.[0];
  const weight = face?.variable ? `${face.weightMin ?? 100} ${face.weightMax ?? 900}` : String(face?.weight ?? 400);
  const css = `@font-face{font-family:'${fontFamilyName(asset.id)}';src:url('${assetFileUrl(asset.id, asset.updatedAt)}');font-weight:${weight};font-style:${face?.style ?? 'normal'};font-display:swap}`;
  return <style>{css}</style>;
}

function Preview({ asset, playing, onToggle }: { asset: LibraryAsset; playing: boolean; onToggle: () => void }) {
  if (asset.kind === 'effect' || asset.kind === 'caption') return <div class="vl-prev vl-prev-demo" aria-hidden="true"><AssetVisual asset={asset} /></div>;
  if (!asset.available || !asset.file) return <div class="vl-prev vl-prev-empty" aria-hidden="true"><FileUp size={16} /></div>;
  if (AUDIO_KINDS.includes(asset.kind)) {
    return (
      <button type="button" class="vl-prev vl-prev-play" aria-label={playing ? `Dừng ${asset.name}` : `Nghe ${asset.name}`} aria-pressed={playing} onClick={onToggle}>
        {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
      </button>
    );
  }
  if (IMAGE_KINDS.includes(asset.kind) && /\.(png|jpe?g|webp|gif|svg)$/i.test(asset.file)) {
    return <div class="vl-prev vl-prev-img"><img src={assetFileUrl(asset.id, asset.updatedAt)} alt="" loading="lazy" /></div>;
  }
  if (asset.kind === 'video') {
    return <div class="vl-prev vl-prev-img"><video src={assetFileUrl(asset.id, asset.updatedAt)} preload="metadata" muted playsInline /></div>;
  }
  if (asset.kind === 'font') {
    return <div class="vl-prev vl-prev-font" style={{ fontFamily: `'${fontFamilyName(asset.id)}', system-ui` }} aria-hidden="true">Aa</div>;
  }
  return <div class="vl-prev vl-prev-empty" aria-hidden="true"><Music2 size={16} /></div>;
}

function EditForm({ asset, onSaved, onCancel }: { asset: LibraryAsset; onSaved: (a: LibraryAsset) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(draftOf(asset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));

  async function save(e: Event) {
    e.preventDefault();
    const bpm = d.bpm.trim() ? Number(d.bpm) : null;
    if (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)) { setError('BPM phải từ 20 đến 300.'); return; }
    setBusy(true); setError('');
    try {
      const { asset: saved } = await libraryApi.update(asset.id, {
        name: d.name.trim() || asset.name,
        description: d.description.trim() || null,
        tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 30),
        mood: d.mood.trim() || null,
        bpm,
        license: d.license.trim() || null,
        attribution: d.attribution.trim() || null,
        sourceUrl: d.sourceUrl.trim() || null,
        enabled: d.enabled,
      });
      onSaved(saved);
    } catch (err) { setError(libraryErrorMessage(err)); } finally { setBusy(false); }
  }

  const isAudio = AUDIO_KINDS.includes(asset.kind);
  return (
    <form class="vl-edit" onSubmit={save}>
      <div class="vs-grid2">
        <label class="vs-field">Tên
          <input class="vs-input" value={d.name} maxLength={120} onInput={(e) => set('name', e.currentTarget.value)} />
        </label>
        <label class="vs-field">Thẻ (cách nhau bằng dấu phẩy)
          <input class="vs-input" value={d.tags} onInput={(e) => set('tags', e.currentTarget.value)} />
        </label>
      </div>
      <label class="vs-field">Mô tả
        <textarea class="vs-input" rows={2} maxLength={1000} value={d.description} onInput={(e) => set('description', e.currentTarget.value)} />
      </label>
      {isAudio && (
        <div class="vs-grid2">
          <label class="vs-field">Không khí
            <select class="vs-input" value={d.mood} onChange={(e) => set('mood', e.currentTarget.value)}>
              <option value="">Chưa chọn</option>
              {MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
              {d.mood && !MOODS.includes(d.mood) && <option value={d.mood}>{d.mood}</option>}
            </select>
          </label>
          <label class="vs-field">BPM
            <input class="vs-input" inputMode="numeric" value={d.bpm} onInput={(e) => set('bpm', e.currentTarget.value)} />
          </label>
        </div>
      )}
      <div class="vs-grid2">
        <label class="vs-field">Giấy phép
          <input class="vs-input" value={d.license} maxLength={200} onInput={(e) => set('license', e.currentTarget.value)} />
        </label>
        <label class="vs-field">Link nguồn
          <input class="vs-input" type="url" placeholder="https://" value={d.sourceUrl} onInput={(e) => set('sourceUrl', e.currentTarget.value)} />
        </label>
      </div>
      <label class="vs-field">Dòng ghi công (bắt buộc với CC-BY, tự thêm vào phụ đề)
        <input class="vs-input" value={d.attribution} maxLength={500} onInput={(e) => set('attribution', e.currentTarget.value)} />
      </label>
      <label class="vl-check">
        <input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
        <span>Cho agent dùng mục này</span>
      </label>
      {error && <div class="vs-error" role="alert">{error}</div>}
      <div class="vs-row-gap">
        <button type="submit" class="vs-btn vs-btn-accent" disabled={busy}><Check size={14} aria-hidden="true" /> {busy ? 'Đang lưu…' : 'Lưu'}</button>
        <button type="button" class="vs-btn" onClick={onCancel} disabled={busy}>Huỷ</button>
      </div>
    </form>
  );
}

function SeedBar({ status, onStart, onCancel, busy }: { status: SeedStatus | null; onStart: () => void; onCancel: () => void; busy: boolean }) {
  const running = status?.state === 'running';
  const pct = status && status.progress.total > 0 ? Math.min(100, Math.round((status.progress.done / status.progress.total) * 100)) : 0;
  return (
    <div class="vl-seed" aria-live="polite">
      <div class="vs-row-gap">
        <button type="button" class="vs-btn vs-btn-accent" onClick={onStart} disabled={running || busy}>
          <Download size={14} aria-hidden="true" /> {running ? 'Đang cài…' : 'Cài bộ khởi đầu'}
        </button>
        {running && <button type="button" class="vs-btn" onClick={onCancel}><Square size={13} aria-hidden="true" /> Dừng</button>}
        <span class="vs-muted vl-seed-note">
          {running
            ? `${pct}% · ${status?.current ?? 'đang chuẩn bị'}`
            : status?.state === 'done' ? `Đã cài xong, thư viện có ${formatBytes(status.bytes)} từ bộ khởi đầu.`
              : status?.state === 'error' ? (status.error ?? 'Cài bị lỗi, bấm lại để chạy tiếp.')
                : status?.state === 'cancelled' ? 'Đã dừng. Bấm lại để chạy tiếp, mục đã có sẽ được bỏ qua.'
                  : '60 font tiếng Việt, tiếng động, nhạc CC0, LUT màu, nhãn dán. Cần mạng, khoảng 150 MB.'}
        </span>
      </div>
      {(running || (status && status.state !== 'idle')) && status && status.progress.total > 0 && (
        <>
          <div class="vl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div>
          <div class="vl-seed-groups">
            {(Object.keys(status.byGroup) as (keyof SeedStatus['byGroup'])[]).filter((g) => status.byGroup[g].total > 0).map((g) => {
              const p = status.byGroup[g];
              return <span key={g} class="vs-tag">{SEED_LABELS[g]} {p.done - p.skipped}/{p.total}{p.skipped > 0 ? ` (bỏ qua ${p.skipped})` : ''}</span>;
            })}
          </div>
        </>
      )}
      {!running && status && status.skipped.length > 0 && (
        <details class="vl-skipped">
          <summary>{status.skipped.length} mục bị bỏ qua</summary>
          <ul>{status.skipped.slice(0, 40).map((s, i) => <li key={i}><b>{s.item}</b>: {s.reason}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function LibraryManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<AssetKind>('sfx');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<LibraryAsset | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [seed, setSeed] = useState<SeedStatus | null>(null);
  const [seedBusy, setSeedBusy] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; fraction: number; error?: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [note, setNote] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reload = useRef(0);

  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);

  async function load() {
    const stamp = ++reload.current;
    setLoading(true);
    try {
      const r = await libraryApi.list({ q: debounced });
      if (stamp === reload.current) { setData(r); setError(''); }
    } catch (e) { if (stamp === reload.current) setError(libraryErrorMessage(e)); }
    finally { if (stamp === reload.current) setLoading(false); }
  }

  useEffect(() => { if (open) void load(); }, [open, debounced]);

  // Stop audio when the dialog closes.
  useEffect(() => {
    if (!open) { audioRef.current?.pause(); setPlaying(null); setEditing(null); }
  }, [open]);

  // Seed status: once on open, then every 1.5 s while running.
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasRunning = false;
    const tick = async () => {
      try {
        const s = await libraryApi.seedStatus();
        if (!live) return;
        setSeed(s);
        if (wasRunning && s.state !== 'running') void load();
        wasRunning = s.state === 'running';
        if (wasRunning) timer = setTimeout(tick, 1500);
      } catch { if (live && wasRunning) timer = setTimeout(tick, 3000); }
    };
    void tick();
    (window as unknown as { __vlSeedKick?: () => void }).__vlSeedKick = () => { if (timer) clearTimeout(timer); wasRunning = true; void tick(); };
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [open]);

  async function startSeed() {
    setSeedBusy(true); setError('');
    try {
      setSeed(await libraryApi.startSeed());
      (window as unknown as { __vlSeedKick?: () => void }).__vlSeedKick?.();
    } catch (e) { setError(libraryErrorMessage(e)); } finally { setSeedBusy(false); }
  }

  async function cancelSeed() {
    try { setSeed(await libraryApi.cancelSeed()); } catch (e) { setError(libraryErrorMessage(e)); }
  }

  async function rescan() {
    setRescanning(true); setNote('');
    try {
      const r = await libraryApi.rescan();
      setNote(`Quét xong: thêm ${r.added}, bỏ ${r.removed} mục.`);
      await load();
    } catch (e) { setError(libraryErrorMessage(e)); } finally { setRescanning(false); }
  }

  function togglePlay(a: LibraryAsset) {
    const el = audioRef.current;
    if (!el) return;
    if (playing === a.id) { el.pause(); setPlaying(null); return; }
    el.src = assetFileUrl(a.id, a.updatedAt);
    el.currentTime = 0;
    void el.play().then(() => setPlaying(a.id)).catch(() => { setPlaying(null); setError('Trình duyệt không phát được file này.'); });
  }

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const exts = (UPLOAD_ACCEPT[kind] ?? '').split(',');
    setError(''); setNote('');
    const rows = list.map((f) => ({ name: f.name, fraction: 0 as number, error: undefined as string | undefined }));
    setUploads(rows);
    for (let i = 0; i < list.length; i++) {
      const ext = `.${list[i].name.split('.').pop()?.toLowerCase() ?? ''}`;
      if (!exts.includes(ext)) { rows[i].error = `Loại này chỉ nhận ${exts.join(' ')}`; setUploads([...rows]); continue; }
      try {
        await uploadAsset(kind, list[i], (f) => { rows[i].fraction = f; setUploads([...rows]); });
        rows[i].fraction = 1;
      } catch (e) { rows[i].error = libraryErrorMessage(e); }
      setUploads([...rows]);
    }
    await load();
    setTimeout(() => setUploads((cur) => (cur === rows || cur.every((r) => r.fraction === 1 || r.error) ? cur.filter((r) => r.error) : cur)), 2500);
  }

  async function confirmDelete() {
    const a = deleting;
    if (!a) return;
    try { await libraryApi.remove(a.id); if (playing === a.id) { audioRef.current?.pause(); setPlaying(null); } await load(); }
    catch (e) { setError(libraryErrorMessage(e)); }
  }

  async function toggleEnabled(a: LibraryAsset) {
    try { await libraryApi.update(a.id, { enabled: a.enabled === false }); await load(); }
    catch (e) { setError(libraryErrorMessage(e)); }
  }

  const rows = useMemo(() => (data?.assets ?? []).filter((a) => a.kind === kind), [data, kind]);
  const canUpload = Boolean(UPLOAD_ACCEPT[kind]);
  const total = data?.kinds.reduce((n, k) => n + k.count, 0) ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quản lý kho"
      width={1040}
      height="calc(var(--app-height) - 2rem)"
      bodyClassName="vl-body"
      footer={
        <>
          <span class="vs-muted vl-foot">{total} mục · {formatBytes(seed?.bytes) || 'chưa có file'}</span>
          <button type="button" class="vs-btn ml-auto" onClick={onClose}>Đóng</button>
        </>
      }
    >
      <div class="vs-root-lite vl-wrap">
        <audio ref={audioRef} onEnded={() => setPlaying(null)} onPause={() => { if (audioRef.current?.ended) setPlaying(null); }} preload="none" />
        <SeedBar status={seed} onStart={startSeed} onCancel={cancelSeed} busy={seedBusy} />

        <div class="vl-toolbar">
          <label class="vl-searchbox vl-search">
            <Search size={15} aria-hidden="true" />
            <span class="sr-only">Tìm trong kho</span>
            <input type="search" placeholder="Tìm tên, thẻ, không khí, giấy phép…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          </label>
          <button type="button" class="vs-btn" onClick={() => void rescan()} disabled={rescanning} title="Quét file bạn vừa chép vào thư mục kho">
            <RefreshCw size={14} class={rescanning ? 'vs-spin' : ''} aria-hidden="true" /> Quét lại
          </button>
          <button type="button" class="vs-btn vs-btn-accent" disabled={!canUpload} onClick={() => fileRef.current?.click()}>
            <Upload size={14} aria-hidden="true" /> Tải lên
          </button>
          <input
            ref={fileRef} type="file" multiple hidden accept={UPLOAD_ACCEPT[kind]}
            onChange={(e) => { const f = e.currentTarget.files; if (f) void upload(f); e.currentTarget.value = ''; }}
          />
        </div>

        <div class="vl-tabs" role="tablist" aria-label="Loại mục">
          {ASSET_KINDS.map((k) => (
            <button key={k.kind} type="button" role="tab" aria-selected={kind === k.kind} class={`vl-kind${kind === k.kind ? ' is-active' : ''}`} onClick={() => { setKind(k.kind); setEditing(null); }}>
              {k.label} <span>{data?.kinds.find((x) => x.kind === k.kind)?.count ?? 0}</span>
            </button>
          ))}
        </div>

        {error && <div class="vs-error" role="alert">{error} <button type="button" class="vs-link vl-inline" onClick={() => setError('')}><X size={12} aria-label="Đóng thông báo" /></button></div>}
        {note && <p class="vs-muted vl-note" role="status">{note}</p>}
        {uploads.length > 0 && (
          <ul class="vl-uploads" aria-live="polite">
            {uploads.map((u, i) => (
              <li key={i} class={u.error ? 'is-fail' : ''}>
                <span class="vl-up-name">{u.name}</span>
                {u.error ? <span class="vl-up-err">{u.error}</span> : <span class="vl-bar vl-bar-sm"><span style={{ width: `${Math.round(u.fraction * 100)}%` }} /></span>}
              </li>
            ))}
          </ul>
        )}

        <div
          class={`vl-list-wrap${dragging ? ' is-drag' : ''}`}
          onDragOver={(e) => { if (canUpload) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (canUpload && e.dataTransfer?.files) void upload(e.dataTransfer.files); }}
        >
          {dragging && <div class="vl-drop">Thả file vào đây để thêm vào "{ASSET_KINDS.find((k) => k.kind === kind)?.label}"</div>}
          {loading && !data && <div class="vs-skel" role="status" aria-label="Đang tải kho"><span /><span /><span /></div>}
          {data && rows.length === 0 && !loading && (
            <p class="vs-muted vl-empty">
              {q ? 'Không có mục nào khớp.' : canUpload ? 'Chưa có mục nào. Kéo file vào đây, bấm "Tải lên" hoặc cài bộ khởi đầu.' : 'Loại này là kiểu dựng có sẵn của hệ thống, không có file để thêm.'}
            </p>
          )}
          <ul class={`vl-list${kind === 'font' ? ' vl-list-fonts' : ''}`}>
            {rows.map((a) => {
              const tone = licenseTone(a);
              const isEditing = editing === a.id;
              return (
                <li key={a.id} class={`vl-item${a.enabled === false ? ' is-off' : ''}${isEditing ? ' is-editing' : ''}`}>
                  {a.kind === 'font' && <FontFaceStyle asset={a} />}
                  <div class="vl-row">
                    <Preview asset={a} playing={playing === a.id} onToggle={() => togglePlay(a)} />
                    <div class="vl-main">
                      <div class="vl-title">
                        <span class="vl-name">{a.name}</span>
                        {a.source === 'library' && <span class="vs-badge vs-badge-lib">Của bạn</span>}
                        {!a.available && a.kind !== 'effect' && a.kind !== 'caption' && <span class="vs-badge vs-badge-warn">chưa có file</span>}
                        {a.enabled === false && <span class="vs-badge">đã tắt</span>}
                      </div>
                      {a.kind === 'font' && a.available && (
                        <div class="vl-sample" style={{ fontFamily: `'${fontFamilyName(a.id)}', system-ui` }}>{FONT_SAMPLE}</div>
                      )}
                      {a.description && a.kind !== 'font' && <div class="vs-muted vl-desc">{a.description}</div>}
                      <div class="vl-meta">
                        <span class={`vl-lic vl-lic-${tone}`} title={a.attribution ?? a.license ?? ''}>{a.license ?? 'Chưa rõ giấy phép'}</span>
                        {a.durationSec ? <span class="vs-tag">{formatDuration(a.durationSec)}</span> : null}
                        {a.mood && <span class="vs-tag">{a.mood}</span>}
                        {a.bpm ? <span class="vs-tag">{a.bpm} BPM</span> : null}
                        {a.sizeBytes ? <span class="vs-tag">{formatBytes(a.sizeBytes)}</span> : null}
                        {a.tags.slice(0, 4).map((t) => <span key={t} class="vs-tag">{t}</span>)}
                        {a.sourceUrl && <a class="vl-src" href={a.sourceUrl} target="_blank" rel="noopener noreferrer">Nguồn</a>}
                      </div>
                      {a.attribution && <div class="vl-attr">Ghi công: {a.attribution}</div>}
                    </div>
                    <div class="vl-actions">
                      <button type="button" class="vs-icon-btn" aria-label={`Sửa ${a.name}`} aria-pressed={isEditing} onClick={() => setEditing(isEditing ? null : a.id)}><Pencil size={15} aria-hidden="true" /></button>
                      <button type="button" class="vs-icon-btn" aria-label={a.enabled === false ? `Bật ${a.name}` : `Tắt ${a.name}`} aria-pressed={a.enabled === false} title={a.enabled === false ? 'Bật lại cho agent' : 'Tắt: agent không chọn mục này'} onClick={() => void toggleEnabled(a)}>
                        {a.enabled === false ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
                      </button>
                      <button type="button" class="vs-icon-btn vl-del" aria-label={`Xoá ${a.name}`} title={a.source === 'builtin' && !a.file ? 'Mục có sẵn chỉ tắt được' : 'Xoá'} onClick={() => setDeleting(a)}><Trash2 size={15} aria-hidden="true" /></button>
                    </div>
                  </div>
                  {isEditing && (
                    <EditForm
                      asset={a}
                      onCancel={() => setEditing(null)}
                      onSaved={() => { setEditing(null); void load(); }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title={deleting && deleting.source === 'builtin' && !deleting.file ? 'Tắt mục này?' : 'Xoá mục này?'}
        body={deleting
          ? (deleting.source === 'builtin' && !deleting.file
            ? `"${deleting.name}" là mục có sẵn của hệ thống nên chỉ tắt được. Agent sẽ không chọn nó nữa.`
            : `Xoá "${deleting.name}" và file của nó khỏi kho. Việc này không hoàn tác được.`)
          : ''}
        detail={deleting && deleting.source === 'seed' ? 'Bấm "Cài bộ khởi đầu" lần nữa sẽ tải lại mục này.' : undefined}
        confirmLabel={deleting && deleting.source === 'builtin' && !deleting.file ? 'Tắt' : 'Xoá'}
        cancelLabel="Giữ lại"
        destructive
      />
    </Modal>
  );
}
