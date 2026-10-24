/** /kol/:id?tab=video — image → video (animate) and talking videos (voice + lip-sync). */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Clapperboard, Film, Megaphone, Mic } from 'lucide-preact';
import { Toggle } from '@/components/Toggle';
import { Card } from '@modules/kol/web/components/shared/common';
import { BTN, BTN_PRIMARY, BTN_SM, Field, INPUT, InlineError, TEXTAREA, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { usePreview } from '@modules/kol/web/components/hooks';
import { StudioReadiness } from '@modules/kol/web/components/Readiness';
import { CameraPickerModal } from '@modules/kol/web/components/camera';
import { GenerationStrip, SlotCard } from '@modules/kol/web/components/studio';
import { ConsistencyBadge, EmptyHint, KolImg, ModelSelect, TonePill, toastError } from '@modules/kol/web/components/ui';
import { useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  ASPECT_LABEL, ASSET_STATUS, KOL, findModel, fmtDateTime, fmtDuration, fmtEstimate, fmtUsd, generateBlocker, kolApi, media,
  modelOptions, pickModel,
  type Aspect, type AssetDto, type GenerationRequest, type LibraryItemDto,
} from '@modules/kol/web/lib/kol';
import type { WorkspaceTabProps } from './workspace-types';

const SCRIPT_MAX = 1500;

export function KolVideoTab({ persona, status, go, query, refreshPersona }: WorkspaceTabProps) {
  const prefill = query.get('asset') ?? '';
  const images = useFetch<{ assets: AssetDto[]; nextBefore: number | null }>(KOL.assets({ personaId: persona.id, kind: 'image', limit: 60 }));
  const videos = useFetch<{ assets: AssetDto[]; nextBefore: number | null }>(KOL.assets({ personaId: persona.id, kind: 'video', limit: 24 }));
  const [prefilled, setPrefilled] = useState<AssetDto | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // An asset handed over from the gallery may be outside the first page: look further back once.
  useEffect(() => {
    if (!prefill || !images.data || images.data.assets.some((a) => a.id === prefill)) return;
    let cancelled = false;
    kolApi.assets({ personaId: persona.id, kind: 'image', limit: 200 })
      .then((r) => { if (!cancelled) setPrefilled(r.assets.find((a) => a.id === prefill) ?? null); })
      .catch(() => { /* the picker still lists the first page */ });
    return () => { cancelled = true; };
  }, [prefill, images.data]);

  const sources = useMemo(() => {
    const list = images.data?.assets ?? [];
    const merged = prefilled && !list.some((a) => a.id === prefilled.id) ? [prefilled, ...list] : list;
    return merged.filter((a) => a.status !== 'rejected');
  }, [images.data, prefilled]);

  const onQueued = () => { setRefreshKey((k) => k + 1); };

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-4">
      <StudioReadiness status={status} />
      {images.error && <InlineError>{images.error}</InlineError>}
      {images.data && sources.length === 0 ? (
        <EmptyHint icon={<Film size={20} />} title="Chưa có ảnh nào để làm video" action={<button type="button" class={BTN_PRIMARY} onClick={() => go('studio')}>Tạo ảnh ở Studio</button>}>
          Video bắt đầu từ một ảnh của {persona.name}. Tạo và duyệt vài ảnh trước, rồi quay lại đây.
        </EmptyHint>
      ) : (
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <AnimateCard key={`a-${prefill}`} {...{ persona, status, sources, initialSource: prefill, onQueued }} />
          <TalkingCard key={`t-${prefill}`} {...{ persona, status, sources, initialSource: prefill, onQueued, go }} />
        </div>
      )}

      <GenerationStrip
        personaId={persona.id}
        kinds={['video', 'lipsync', 'speech']}
        title="Video đang tạo & vừa xong"
        refreshKey={refreshKey}
        onRefAdded={refreshPersona}
        onCreatePost={(a) => go('content', { compose: a.id })}
      />

      <section class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <h2 class="text-[13.5px] font-semibold">Video đã có</h2>
          <button type="button" class={`${BTN_SM} ml-auto`} onClick={videos.refresh}>Làm mới</button>
        </div>
        {videos.error && <InlineError>{videos.error}</InlineError>}
        {videos.data && videos.data.assets.length === 0 && <p class="text-[12.5px] text-[var(--color-text-muted)]">Chưa có video nào.</p>}
        {videos.data && videos.data.assets.length > 0 && (
          <ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3 list-none m-0 p-0">
            {videos.data.assets.map((v) => (
              <li key={v.id} class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden flex flex-col min-w-0">
                <video src={media(v.url)} poster={v.thumbUrl ? media(v.thumbUrl) : undefined} controls preload="metadata" playsInline class="w-full bg-black" style={{ aspectRatio: v.width && v.height ? `${v.width} / ${v.height}` : '9 / 16', maxHeight: '420px' }} />
                <div class="p-2.5 flex flex-col gap-1.5 text-[12px]">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <TonePill tone={ASSET_STATUS[v.status].tone}>{ASSET_STATUS[v.status].label}</TonePill>
                    <ConsistencyBadge c={v.consistency} compact />
                    <span class="ml-auto text-[var(--color-text-muted)] tabular-nums">{fmtDuration(v.durationSec)} · {fmtUsd(v.costUsd)}</span>
                  </div>
                  <div class="text-[var(--color-text-muted)] truncate" title={v.model}>{v.model} · {fmtDateTime(v.createdAt)}</div>
                  <div class="flex gap-1.5">
                    {v.status !== 'approved' && <ApproveButton asset={v} onDone={videos.refresh} />}
                    <button type="button" class={BTN_SM} onClick={() => go('content', { compose: v.id })}><Megaphone size={12} class="mr-1" />Tạo bài đăng</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ApproveButton({ asset, onDone }: { asset: AssetDto; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" class={BTN_SM} disabled={busy} onClick={() => {
      setBusy(true);
      kolApi.updateAsset(asset.id, { status: 'approved' })
        .then(() => { pushToast({ tone: 'success', title: 'Đã duyệt video' }); onDone(); })
        .catch((err) => toastError('Không duyệt được', err))
        .finally(() => setBusy(false));
    }}>Duyệt</button>
  );
}

interface CardProps {
  persona: WorkspaceTabProps['persona'];
  status: WorkspaceTabProps['status'];
  sources: AssetDto[];
  initialSource: string;
  onQueued: () => void;
}

/** Horizontal strip of source images (radio semantics). */
function SourcePicker({ sources, value, onChange, name }: { sources: AssetDto[]; value: string; onChange: (id: string) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label="Ảnh nguồn" class="flex gap-2 overflow-x-auto pb-1">
      {sources.map((a) => (
        <button
          key={a.id}
          type="button"
          role="radio"
          aria-checked={a.id === value}
          name={name}
          onClick={() => onChange(a.id)}
          class={`relative shrink-0 w-[72px] h-[90px] rounded-md overflow-hidden border-2 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${a.id === value ? 'border-[var(--color-accent)]' : 'border-transparent opacity-80 hover:opacity-100'}`}
        >
          <KolImg src={a.thumbUrl ?? a.url} class="w-full h-full" />
          {a.status === 'approved' && <span class="absolute bottom-0.5 right-0.5 w-2 h-2 rounded-full bg-[var(--color-status-done)]" title="Đã duyệt" />}
        </button>
      ))}
    </div>
  );
}

function useSubmit(onQueued: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(req: GenerationRequest, label: string) {
    setBusy(true);
    setError(null);
    try {
      const { generation } = await kolApi.generate(req);
      pushToast({ tone: 'success', title: label, description: `${fmtEstimate(generation.estimateUsd)} · thường mất 1–5 phút` });
      onQueued();
    } catch (err) {
      const f = apiFail(err);
      const prefix = f.status === 402 ? 'Vượt hạn mức chi tiêu' : f.status === 409 ? 'Studio đang tắt hoặc bị khoá' : f.status === 412 ? 'Thiếu API key' : 'Không tạo được';
      setError(`${prefix}: ${f.message}`);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, submit };
}

function AnimateCard({ persona, status, sources, initialSource, onQueued }: CardProps) {
  const options = useMemo(() => modelOptions(status, 'video'), [status]);
  const [source, setSource] = useState(initialSource || sources.find((a) => a.status === 'approved')?.id || sources[0]?.id || '');
  const [modelId, setModelId] = useState('');
  const [duration, setDuration] = useState<number | null>(null);
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [audio, setAudio] = useState(false);
  const [motion, setMotion] = useState('');
  const [line, setLine] = useState('');
  const [cameraIds, setCameraIds] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const cams = useFetch<{ items: LibraryItemDto[] }>(KOL.library({ kind: 'camera', personaId: persona.id }));
  const { busy, error, submit } = useSubmit(onQueued);

  useEffect(() => { if (!modelId && status) setModelId(pickModel(status, 'video', [persona.videoModel])); }, [status]);
  useEffect(() => { if (!source && sources[0]) setSource(sources[0].id); }, [sources]);
  const model = findModel(status, modelId)?.model ?? null;
  const durations = model?.durations?.length ? model.durations : [5];
  const aspects = model?.aspects.length ? model.aspects : (['9:16', '16:9', '1:1'] as Aspect[]);
  useEffect(() => {
    if (duration === null || !durations.includes(duration)) setDuration(durations[0]);
    if (!aspects.includes(aspect)) setAspect(aspects.includes('9:16') ? '9:16' : aspects[0]);
    if (!model?.audio) setAudio(false);
  }, [modelId, model]);

  const req: GenerationRequest | null = source ? {
    personaId: persona.id,
    mode: 'animate',
    selection: { sourceAssetId: source, ...(cameraIds.length ? { cameraIds } : {}) },
    params: { ...(modelId ? { model: modelId } : {}), aspect, ...(duration ? { durationSec: duration } : {}), audio: audio || !!line.trim(), ...(motion.trim() ? { extraPrompt: motion.trim() } : {}), ...(line.trim() ? { script: line.trim() } : {}) },
  } : null;
  const pv = usePreview(req);
  const blocker = !source ? 'Chọn một ảnh nguồn.' : generateBlocker({ status, persona, mode: 'animate', model: modelId });
  const camItems = useMemo(() => cams.data?.items.filter((i) => i.kind === 'camera') ?? [], [cams.data]);
  const cameraPicks = cameraIds.map((id) => camItems.find((i) => i.id === id)).filter((i): i is LibraryItemDto => !!i);

  return (
    <Card title={<span class="inline-flex items-center gap-2"><Clapperboard size={16} />Ảnh → video</span>} aside="Ảnh chuyển động, giữ nguyên khuôn mặt">
      <Field label="Ảnh nguồn"><SourcePicker name="animate-source" sources={sources} value={source} onChange={setSource} /></Field>
      <Field label="Mô hình video" hint={model?.priceNote}>
        <ModelSelect options={options} value={modelId} allowEmpty={false} compact onChange={setModelId} label="Mô hình video" />
      </Field>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Thời lượng">
          <select class={`${INPUT} w-full`} value={duration ?? ''} onChange={(e) => setDuration(Number((e.target as HTMLSelectElement).value))}>
            {durations.map((d) => <option key={d} value={d}>{d} giây</option>)}
          </select>
        </Field>
        <Field label="Tỷ lệ">
          <select class={`${INPUT} w-full`} value={aspect} onChange={(e) => setAspect((e.target as HTMLSelectElement).value as Aspect)}>
            {aspects.map((a) => <option key={a} value={a}>{ASPECT_LABEL[a]}</option>)}
          </select>
        </Field>
      </div>
      {model?.audio && (
        <label class="flex items-center justify-between gap-3 text-[13px]">
          <span>Âm thanh tự nhiên (tiếng động, nhạc nền)<span class="block text-[12px] text-[var(--color-text-muted)]">Tốn thêm chi phí với một số mô hình.</span></span>
          <Toggle on={audio} onChange={() => setAudio(!audio)} ariaLabel="Tạo âm thanh" />
        </label>
      )}
      <Field label="Chuyển động" hint="Mô tả hành động và chuyển động máy quay, ngắn gọn.">
        <textarea class={`${TEXTAREA} w-full`} rows={2} placeholder="Cô ấy quay đầu nhìn máy và mỉm cười, tóc bay nhẹ trong gió, máy quay tiến chậm" value={motion} onInput={(e) => setMotion((e.target as HTMLTextAreaElement).value)} />
      </Field>
      <Field label="Lời nhân vật nói (tuỳ chọn)" hint={`${line.trim().length}/220 ký tự · khoảng 2,5 từ mỗi giây. Chỉ với mô hình có âm thanh (Veo 3.1): mô hình tự tạo giọng và khớp môi; giọng có thể khác nhau giữa các video. Muốn giọng cố định, dùng thẻ Video nói chuyện.`}>
        <textarea class={`${TEXTAREA} w-full`} rows={2} maxLength={220} placeholder="Hi, I'm Genie — your AI bestie!" value={line} onInput={(e) => setLine((e.target as HTMLTextAreaElement).value)} />
      </Field>
      <SlotCard kind="camera" item={cameraPicks[0] ?? null} choices={camItems} label={cameraPicks.map((i) => i.name).join(' · ')} onOpen={() => setPicker(true)} onClear={() => setCameraIds([])} />
      {pv.preview && pv.preview.warnings.length > 0 && <ul class="text-[12px] text-[var(--color-priority-medium)] list-disc pl-5">{pv.preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {pv.error && <InlineError>{pv.error}</InlineError>}
      <button type="button" class={`${BTN_PRIMARY} h-11`} disabled={!!blocker || busy || !req} onClick={() => { if (req) void submit(req, 'Đang tạo video'); }}>
        <Film size={15} />{busy ? 'Đang gửi…' : `Tạo video${pv.preview ? ` · ${fmtEstimate(pv.preview.estimateUsd)}` : ''}`}
      </button>
      {blocker && <p class="text-[12px] text-[var(--color-text-muted)]">{blocker}</p>}
      {error && <InlineError>{error}</InlineError>}
      {picker && <CameraPickerModal items={camItems} loading={cams.loading} value={cameraIds} context="video" onApply={setCameraIds} onClose={() => setPicker(false)} />}
    </Card>
  );
}

function TalkingCard({ persona, status, sources, initialSource, onQueued, go }: CardProps & { go: WorkspaceTabProps['go'] }) {
  const options = useMemo(() => modelOptions(status, 'lipsync'), [status]);
  const [source, setSource] = useState(initialSource || sources.find((a) => a.status === 'approved')?.id || sources[0]?.id || '');
  const [modelId, setModelId] = useState('');
  const [script, setScript] = useState('');
  const { busy, error, submit } = useSubmit(onQueued);
  useEffect(() => { if (!modelId && status) setModelId(pickModel(status, 'lipsync')); }, [status]);
  useEffect(() => { if (!source && sources[0]) setSource(sources[0].id); }, [sources]);
  const model = findModel(status, modelId)?.model ?? null;

  const ready = !!persona.voiceId && !!status?.voice.configured && options.some((o) => o.configured);
  const req: GenerationRequest | null = source && script.trim() && ready ? {
    personaId: persona.id,
    mode: 'talking',
    selection: { sourceAssetId: source },
    params: { ...(modelId ? { model: modelId } : {}), script: script.trim() },
  } : null;
  const pv = usePreview(req);
  const blocker = !persona.voiceId ? 'KOL chưa có giọng nói (voice ID).'
    : !status?.voice.configured ? 'Chưa có ElevenLabs API key.'
      : !options.some((o) => o.configured) ? 'Chưa có mô hình nhép miệng nào có API key.'
        : !source ? 'Chọn một ảnh nguồn.'
          : !script.trim() ? 'Viết lời thoại trước.'
            : generateBlocker({ status, persona, mode: 'talking', model: modelId });
  const seconds = Math.round(script.trim().length / 14);

  return (
    <Card title={<span class="inline-flex items-center gap-2"><Mic size={16} />Video nói chuyện</span>} aside="Giọng ElevenLabs + nhép miệng">
      {!persona.voiceId && (
        <div class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-[12.5px] text-[var(--color-text-muted)]">
          Cần voice ID ElevenLabs của {persona.name} trong Hồ sơ › Giọng nói.
          <button type="button" class={`${BTN_SM} ml-2`} onClick={() => go('profile')}>Mở Hồ sơ</button>
        </div>
      )}
      <Field label="Ảnh nguồn" hint="Ảnh chính diện, miệng nhìn rõ cho kết quả tốt nhất."><SourcePicker name="talking-source" sources={sources} value={source} onChange={setSource} /></Field>
      <Field label="Mô hình nhép miệng" hint={model?.priceNote}>
        <ModelSelect options={options} value={modelId} allowEmpty={false} compact onChange={setModelId} label="Mô hình nhép miệng" />
      </Field>
      <Field label="Lời thoại" hint={`${script.length}/${SCRIPT_MAX} ký tự · khoảng ${seconds} giây`}>
        <textarea
          class={`${TEXTAREA} w-full`}
          rows={5}
          maxLength={SCRIPT_MAX}
          placeholder="Chào cả nhà, hôm nay mình thử ba cách phối áo sơ mi trắng cho tuần làm việc…"
          value={script}
          onInput={(e) => setScript((e.target as HTMLTextAreaElement).value)}
        />
      </Field>
      {pv.error && <InlineError>{pv.error}</InlineError>}
      <button type="button" class={`${BTN_PRIMARY} h-11`} disabled={!!blocker || busy || !req} onClick={() => { if (req) void submit(req, 'Đang tạo video nói chuyện'); }}>
        <Mic size={15} />{busy ? 'Đang gửi…' : `Tạo video nói chuyện${pv.preview ? ` · ${fmtEstimate(pv.preview.estimateUsd)}` : ''}`}
      </button>
      {blocker && <p class="text-[12px] text-[var(--color-text-muted)]">{blocker}</p>}
      {error && <InlineError>{error}</InlineError>}
      {persona.voiceId && !status?.voice.configured && <Link href="/connections" class={`${BTN} self-start`}>Thêm ElevenLabs key</Link>}
    </Card>
  );
}
