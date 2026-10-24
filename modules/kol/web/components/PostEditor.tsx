// Nội dung › post editor: assets, accounts, master caption + per-platform
// variants, AI captions, schedule, and the review/approve/publish workflow.

import { useMemo, useState } from 'preact/hooks';
import { ArrowLeft, ArrowRight, ExternalLink, ImagePlus, RotateCcw, Send, Sparkles, X } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PlatformBadge } from '@/components/social/PlatformBadge';
import {
  BTN, BTN_DANGER, BTN_PRIMARY, BTN_SM, Field, INPUT, InlineError, TEXTAREA, apiFail, fromLocalInput, toLocalInput,
} from '@modules/kol/web/components/shared/ops-shared';
import { AssetPickerModal } from '@modules/kol/web/components/AssetPickerModal';
import { AssetThumb, TonePill, toastError } from '@modules/kol/web/components/ui';
import { pushToast } from '@/lib/toasts';
import {
  PLATFORM_META, POST_FORMATS, POST_FORMAT_LABEL, POST_SOURCE_LABEL, POST_STATUS, TARGET_STATUS, fmtCompact, fmtDateTime,
  formatHashtags, formatWarnings, kolApi, parseHashtags, platformsOf, postActions, postEditable,
  type AccountDto, type AssetDto, type PersonaDto, type Platform, type PlatformVariant, type PostAction, type PostDto, type PostFormat,
  type PostInput,
} from '@modules/kol/web/lib/kol';

export interface PostSeed {
  title?: string;
  brief?: string;
  assets?: AssetDto[];
  format?: PostFormat;
}

/** Platform caps; KOL Studio itself stores at most 5.000 characters per caption. */
const CAPTION_LIMIT: Record<Platform, number> = { facebook: 5000, instagram: 2200, tiktok: 2200, youtube: 5000 };

export function PostEditor({ persona, accounts, post: initial, seed, onClose, onChanged }: {
  persona: PersonaDto;
  accounts: AccountDto[];
  post: PostDto | null;
  seed?: PostSeed;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [post, setPost] = useState<PostDto | null>(initial);
  const [title, setTitle] = useState(initial?.title ?? seed?.title ?? '');
  const [pillar, setPillar] = useState(initial?.pillar ?? '');
  const [format, setFormat] = useState<PostFormat>(initial?.format ?? seed?.format ?? (seed?.assets?.[0]?.kind === 'video' ? 'reel' : 'photo'));
  const [caption, setCaption] = useState(initial?.caption ?? '');
  const [hashtags, setHashtags] = useState(formatHashtags(initial?.hashtags ?? []));
  const [variants, setVariants] = useState<Partial<Record<Platform, PlatformVariant>>>(initial?.variants ?? {});
  const [variantTags, setVariantTags] = useState<Partial<Record<Platform, string>>>(() => tagTexts(initial?.variants ?? {}));
  const [assets, setAssets] = useState<AssetDto[]>(initial?.assets ?? seed?.assets ?? []);
  const [accountIds, setAccountIds] = useState<string[]>(() => initial
    ? [...new Set(initial.targets.map((t) => t.accountId))]
    : accounts.filter((a) => a.enabled && a.status === 'ACTIVE').map((a) => a.id));
  const [scheduled, setScheduled] = useState(toLocalInput(initial?.scheduledAt ?? null));
  const [brief, setBrief] = useState(initial?.brief ?? seed?.brief ?? '');
  const [tab, setTab] = useState<'master' | Platform>('master');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [aiHint, setAiHint] = useState('');
  const [confirm, setConfirm] = useState<'publishNow' | 'cancel' | null>(null);
  const [returning, setReturning] = useState(false);
  const [feedback, setFeedback] = useState('');

  const status = post?.status ?? null;
  const editable = postEditable(status);
  const actions = postActions(status);
  const platforms = useMemo(() => platformsOf(accounts, accountIds), [accounts, accountIds]);
  // Caption tabs: the chosen accounts' platforms plus any platform that already has a written variant.
  const tabPlatforms = useMemo(() => {
    const extra = (Object.keys(variants) as Platform[]).filter((p) => variants[p]?.caption && !platforms.includes(p));
    return platformsOf([...accounts, ...extra.map((p) => ({ id: `variant:${p}`, platform: p }))], [...accountIds, ...extra.map((p) => `variant:${p}`)]);
  }, [accounts, accountIds, platforms, variants]);
  const warnings = formatWarnings(format, platforms, assets);
  const scheduledAt = fromLocalInput(scheduled);

  function input(): PostInput {
    const v: Partial<Record<Platform, PlatformVariant>> = {};
    // Keep every written variant, also for platforms not targeted yet (an account may be linked later).
    for (const p of tabPlatforms) {
      const tags = parseHashtags(variantTags[p] ?? '');
      const x = { caption: '', ...variants[p], ...(tags.length ? { hashtags: tags } : { hashtags: undefined }) };
      if (x.caption.trim() || x.title?.trim() || x.hashtags?.length) v[p] = x;
    }
    return {
      title: title.trim(), pillar, format, caption, hashtags: parseHashtags(hashtags), variants: v,
      assetIds: assets.map((a) => a.id), brief, scheduledAt, accountIds,
    };
  }

  function adopt(p: PostDto) {
    setPost(p);
    setCaption(p.caption);
    setVariants(p.variants ?? {});
    setVariantTags(tagTexts(p.variants ?? {}));
    setHashtags(formatHashtags(p.hashtags));
    setAssets(p.assets);
    setScheduled(toLocalInput(p.scheduledAt));
    onChanged();
  }

  async function persist(): Promise<PostDto> {
    if (!post) {
      if (!title.trim()) throw new Error('Đặt tiêu đề cho bài (chỉ bạn thấy).');
      const r = await kolApi.createPost(persona.id, input());
      adopt(r.post);
      return r.post;
    }
    if (!editable) return post;
    const r = await kolApi.updatePost(post.id, input());
    adopt(r.post);
    return r.post;
  }

  async function act(action: PostAction | 'captions') {
    setBusy(action);
    setError(null);
    try {
      if (action === 'cancel') {
        if (post) await kolApi.cancelPost(post.id);
        pushToast({ tone: 'success', title: 'Đã huỷ bài' });
        onChanged();
        onClose();
        return;
      }
      let p = await persist();
      if (action === 'save') pushToast({ tone: 'success', title: 'Đã lưu bài' });
      if (action === 'submit') { p = (await kolApi.submitPost(p.id)).post; pushToast({ tone: 'success', title: 'Đã gửi duyệt' }); }
      if (action === 'approve') {
        p = (await kolApi.approvePost(p.id, scheduledAt)).post;
        pushToast({ tone: 'success', title: p.status === 'scheduled' ? `Đã duyệt, lên lịch ${fmtDateTime(p.scheduledAt)}` : 'Đã duyệt (chưa có giờ đăng)' });
      }
      if (action === 'publishNow') { p = (await kolApi.publishNow(p.id)).post; pushToast({ tone: 'success', title: 'Đang đăng…', description: 'Trạng thái từng kênh hiện ở bảng bên dưới.' }); }
      if (action === 'captions') {
        p = (await kolApi.writeCaptions(p.id, { platforms, ...(aiHint.trim() ? { instructions: aiHint.trim() } : {}) })).post;
        pushToast({ tone: 'success', title: 'AI đã viết caption', description: 'Xem lại từng kênh trước khi duyệt.' });
      }
      adopt(p);
      if (action === 'submit' || action === 'approve') onClose();
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setBusy(null);
    }
  }

  async function sendBack() {
    if (!post || !feedback.trim()) return;
    setBusy('return');
    try {
      adopt((await kolApi.returnPost(post.id, feedback.trim())).post);
      pushToast({ tone: 'success', title: 'Đã trả lại bài kèm góp ý' });
      setReturning(false);
      setFeedback('');
    } catch (err) {
      toastError('Không trả lại được', err);
    } finally {
      setBusy(null);
    }
  }

  async function retry(targetId: string) {
    if (!post) return;
    setBusy(`retry-${targetId}`);
    try {
      adopt((await kolApi.retryTarget(post.id, targetId)).post);
      pushToast({ tone: 'success', title: 'Đã xếp đăng lại ngay' });
    } catch (err) {
      toastError('Không thử lại được', err);
    } finally {
      setBusy(null);
    }
  }

  const moveAsset = (i: number, dir: -1 | 1) => setAssets((cur) => {
    const j = i + dir;
    if (j < 0 || j >= cur.length) return cur;
    const next = [...cur];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const setVariant = (p: Platform, patch: Partial<PlatformVariant>) =>
    setVariants((cur) => ({ ...cur, [p]: { caption: '', ...cur[p], ...patch } }));

  const st = status ? POST_STATUS[status] : null;
  const ACTION_LABEL: Record<PostAction, string> = {
    save: post ? 'Lưu' : 'Lưu nháp', submit: 'Gửi duyệt', approve: scheduledAt ? 'Duyệt & lên lịch' : 'Duyệt', publishNow: 'Đăng ngay', return: 'Trả lại', cancel: 'Huỷ bài',
  };

  return (
    <>
      <Modal
        open
        title={post ? (post.title || 'Bài đăng') : 'Bài mới'}
        dismissOnBackdrop={false}
        width={980}
        height="min(900px, calc(var(--app-height) - 2rem))"
        closeDisabled={!!busy}
        onClose={() => { if (!busy) onClose(); }}
        footer={
          <>
            {actions.includes('cancel') && <button type="button" class={BTN_DANGER} disabled={!!busy} onClick={() => setConfirm('cancel')}>{ACTION_LABEL.cancel}</button>}
            {actions.includes('return') && <button type="button" class={BTN} disabled={!!busy} onClick={() => setReturning(true)}><RotateCcw size={13} />Trả lại</button>}
            <div class="ml-auto flex flex-wrap justify-end gap-2">
              {actions.includes('save') && <button type="button" class={BTN} disabled={!!busy} onClick={() => { void act('save'); }}>{busy === 'save' ? 'Đang lưu…' : ACTION_LABEL.save}</button>}
              {actions.includes('publishNow') && <button type="button" class={BTN} disabled={!!busy || !accountIds.length} onClick={() => setConfirm('publishNow')}><Send size={13} />Đăng ngay</button>}
              {actions.includes('submit') && <button type="button" class={BTN} disabled={!!busy} onClick={() => { void act('submit'); }}>{busy === 'submit' ? '…' : ACTION_LABEL.submit}</button>}
              {actions.includes('approve') && <button type="button" class={BTN_PRIMARY} disabled={!!busy || !accountIds.length} onClick={() => { void act('approve'); }}>{busy === 'approve' ? '…' : ACTION_LABEL.approve}</button>}
              {!actions.length && <button type="button" class={BTN} onClick={onClose}>Đóng</button>}
            </div>
          </>
        }
      >
        <div class="flex flex-col gap-4">
          {post && (
            <div class="flex flex-wrap items-center gap-2 text-[12px]">
              {st && <TonePill tone={st.tone}>{st.label}</TonePill>}
              {post.source !== 'owner' && <TonePill tone="accent">{POST_SOURCE_LABEL[post.source]}</TonePill>}
              <span class="text-[var(--color-text-muted)]">Tạo {fmtDateTime(post.createdAt)} · sửa {fmtDateTime(post.updatedAt)}</span>
            </div>
          )}
          {post?.feedback && (
            <div class="rounded-md border border-[color-mix(in_srgb,var(--color-priority-medium)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-priority-medium)_10%,transparent)] px-3 py-2 text-[12.5px]">
              <b>Góp ý lần trước:</b> {post.feedback}
            </div>
          )}
          {!editable && <p class="text-[12.5px] text-[var(--color-text-muted)]">Bài đã vào quá trình đăng nên không sửa được nội dung.</p>}

          <fieldset disabled={!editable || !!busy} class="contents">
            <div class="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr] gap-3">
              <Field label="Tiêu đề (chỉ bạn thấy)"><input class={`${INPUT} w-full`} value={title} placeholder="Outfit đi làm thứ Hai" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></Field>
              <Field label="Trụ cột">
                <select class={`${INPUT} w-full`} value={pillar} onChange={(e) => setPillar((e.target as HTMLSelectElement).value)}>
                  <option value="">Không chọn</option>
                  {pillar && !persona.pillars.some((p) => p.name === pillar) && <option value={pillar}>{pillar}</option>}
                  {persona.pillars.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Định dạng">
                <select class={`${INPUT} w-full`} value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value as PostFormat)}>
                  {POST_FORMATS.map((f) => <option key={f} value={f}>{POST_FORMAT_LABEL[f]}</option>)}
                </select>
              </Field>
            </div>

            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <span class="text-[12px] text-[var(--color-text-muted)]">Ảnh / video ({assets.length})</span>
                {editable && <button type="button" class={`${BTN_SM} ml-auto`} onClick={() => setPicker(true)}><ImagePlus size={12} class="mr-1" />Chọn</button>}
              </div>
              {assets.length === 0
                ? <p class="text-[12.5px] text-[var(--color-text-faint)]">Chưa chọn. Bấm “Chọn” để lấy ảnh/video đã duyệt.</p>
                : (
                  <ol class="flex gap-2 overflow-x-auto pb-1 list-none m-0 p-0">
                    {assets.map((a, i) => (
                      <li key={a.id} class="shrink-0 w-[96px] flex flex-col gap-1">
                        <span class="relative block w-[96px] h-[120px] rounded-md overflow-hidden border border-[var(--color-border)]">
                          <AssetThumb asset={a} class="w-full h-full" />
                          <span class="absolute top-1 left-1 rounded bg-black/60 text-white text-[10.5px] px-1 tabular-nums">{i + 1}</span>
                        </span>
                        {editable && (
                          <span class="flex gap-1">
                            <button type="button" class={`${BTN_SM} px-1 flex-1`} aria-label="Sang trái" disabled={i === 0} onClick={() => moveAsset(i, -1)}><ArrowLeft size={12} /></button>
                            <button type="button" class={`${BTN_SM} px-1 flex-1`} aria-label="Sang phải" disabled={i === assets.length - 1} onClick={() => moveAsset(i, 1)}><ArrowRight size={12} /></button>
                            <button type="button" class={`${BTN_SM} px-1 flex-1`} aria-label="Bỏ" onClick={() => setAssets(assets.filter((x) => x.id !== a.id))}><X size={12} /></button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
            </div>

            <div class="flex flex-col gap-1.5">
              <span class="text-[12px] text-[var(--color-text-muted)]">Đăng lên</span>
              {accounts.length === 0
                ? <p class="text-[12.5px] text-[var(--color-text-faint)]">Chưa liên kết kênh nào. Liên kết ở tab Kênh.</p>
                : (
                  <div class="flex flex-wrap gap-2">
                    {accounts.map((a) => {
                      const on = accountIds.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setAccountIds(on ? accountIds.filter((x) => x !== a.id) : [...accountIds, a.id])}
                          class={`h-10 pl-1.5 pr-3 rounded-lg border inline-flex items-center gap-2 text-[12.5px] ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)] font-medium' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'} ${a.enabled && a.status === 'ACTIVE' ? '' : 'opacity-60'}`}
                        >
                          <PlatformBadge platform={a.platform} size={24} />@{a.handle || a.displayName}
                          {a.status !== 'ACTIVE' && <span class="text-[11px] text-[var(--color-status-failed)]">lỗi</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
            </div>

            <div class="rounded-lg border border-[var(--color-border)] flex flex-col min-w-0">
              <div role="tablist" aria-label="Caption theo kênh" class="flex gap-1 px-2 pt-2 overflow-x-auto border-b border-[var(--color-border)]">
                {(['master', ...tabPlatforms] as const).map((k) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                    class={`shrink-0 h-8 px-3 rounded-t-md text-[12.5px] inline-flex items-center gap-1.5 border-b-2 ${tab === k ? 'border-[var(--color-accent)] text-[var(--color-text)] font-semibold' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                    {k === 'master' ? 'Caption chung' : <><PlatformBadge platform={k} size={16} />{PLATFORM_META[k].name}{variants[k]?.caption ? ' •' : ''}</>}
                  </button>
                ))}
              </div>
              <div class="p-3 flex flex-col gap-2.5">
                {tab === 'master' ? (
                  <>
                    <textarea class={`${TEXTAREA} w-full`} rows={6} aria-label="Caption chung" placeholder={`Viết bằng giọng của ${persona.name}…`} value={caption} onInput={(e) => setCaption((e.target as HTMLTextAreaElement).value)} />
                    <div class="flex justify-between text-[11.5px] text-[var(--color-text-faint)] tabular-nums">
                      <span>Các kênh dùng caption này nếu không có bản riêng.</span><span>{caption.length} ký tự</span>
                    </div>
                    <Field label="Hashtag"><input class={`${INPUT} w-full`} placeholder="#ootd #dalat" value={hashtags} onInput={(e) => setHashtags((e.target as HTMLInputElement).value)} /></Field>
                  </>
                ) : (
                  <>
                    {tab === 'youtube' && (
                      <Field label="Tiêu đề YouTube" hint={`${(variants.youtube?.title ?? '').length}/100 ký tự. Video dọc ≤ 3 phút đăng dạng Shorts.`}>
                        <input class={`${INPUT} w-full`} maxLength={100} value={variants.youtube?.title ?? ''} onInput={(e) => setVariant('youtube', { title: (e.target as HTMLInputElement).value })} />
                      </Field>
                    )}
                    <textarea class={`${TEXTAREA} w-full`} rows={6} aria-label={`Caption ${PLATFORM_META[tab].name}`} placeholder="Để trống để dùng caption chung" value={variants[tab]?.caption ?? ''} onInput={(e) => setVariant(tab, { caption: (e.target as HTMLTextAreaElement).value })} />
                    <div class="flex justify-between text-[11.5px] tabular-nums">
                      <span class="text-[var(--color-text-faint)]">Tối đa {CAPTION_LIMIT[tab].toLocaleString('vi-VN')} ký tự trên {PLATFORM_META[tab].name}.</span>
                      <span class={(variants[tab]?.caption ?? caption).length > CAPTION_LIMIT[tab] ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text-faint)]'}>{(variants[tab]?.caption ?? '').length} ký tự</span>
                    </div>
                    <Field label={`Hashtag riêng cho ${PLATFORM_META[tab].name}`}>
                      <input class={`${INPUT} w-full`} placeholder="Để trống để dùng hashtag chung" value={variantTags[tab] ?? ''} onInput={(e) => setVariantTags({ ...variantTags, [tab]: (e.target as HTMLInputElement).value })} />
                    </Field>
                  </>
                )}
                {editable && (
                  <div class="flex flex-wrap items-center gap-2 pt-1 border-t border-[var(--color-border)]">
                    <input class={`${INPUT} flex-1 min-w-[180px] h-8 text-[12.5px]`} aria-label="Gợi ý cho AI" placeholder="Gợi ý cho AI (tuỳ chọn): vui hơn, có câu hỏi cuối bài…" value={aiHint} onInput={(e) => setAiHint((e.target as HTMLInputElement).value)} />
                    <button type="button" class={BTN_SM} disabled={!!busy} onClick={() => { void act('captions'); }}><Sparkles size={12} class="mr-1" />{busy === 'captions' ? 'AI đang viết…' : 'AI viết caption'}</button>
                  </div>
                )}
                <p class="text-[11.5px] text-[var(--color-text-muted)]">
                  {persona.disclosureText.trim()
                    ? <>Khi đăng sẽ tự thêm: <i>“{persona.disclosureText.trim()}”</i></>
                    : <span class="text-[var(--color-priority-medium)]">Chưa có dòng công bố AI trong Hồ sơ. Cần có trước khi KOL hoạt động.</span>}
                </p>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Giờ đăng" hint="Theo giờ máy bạn. Mỗi kênh còn có khung giờ và giãn cách riêng (tab Kênh).">
                <input type="datetime-local" class={`${INPUT} w-full`} value={scheduled} onInput={(e) => setScheduled((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Ghi chú / brief">
                <textarea class={`${TEXTAREA} w-full`} rows={2} value={brief} onInput={(e) => setBrief((e.target as HTMLTextAreaElement).value)} />
              </Field>
            </div>
          </fieldset>

          {warnings.length > 0 && editable && (
            <ul class="flex flex-col gap-1 list-none m-0 p-0">{warnings.map((w) => <li key={w} class="text-[12px] text-[var(--color-priority-medium)]">• {w}</li>)}</ul>
          )}
          {error && <InlineError>{error}</InlineError>}

          {post && post.targets.length > 0 && (
            <div class="flex flex-col gap-1.5">
              <span class="text-[12px] text-[var(--color-text-muted)]">Trạng thái theo kênh</span>
              <div class="overflow-x-auto rounded-md border border-[var(--color-border)]">
                <table class="w-full text-[12.5px] min-w-[560px]">
                  <thead><tr class="text-left text-[11px] uppercase tracking-[0.05em] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                    <th class="px-2.5 py-1.5 font-semibold">Kênh</th><th class="px-2.5 py-1.5 font-semibold">Trạng thái</th><th class="px-2.5 py-1.5 font-semibold">Lúc</th><th class="px-2.5 py-1.5 font-semibold">Kết quả</th><th />
                  </tr></thead>
                  <tbody>
                    {post.targets.map((t) => {
                      const ts = TARGET_STATUS[t.status];
                      return (
                        <tr key={t.id} class="border-b border-[var(--color-border)] last:border-b-0 align-top">
                          <td class="px-2.5 py-2"><span class="inline-flex items-center gap-1.5"><PlatformBadge platform={t.platform} size={18} />@{t.handle}</span></td>
                          <td class="px-2.5 py-2"><TonePill tone={ts.tone}>{ts.label}</TonePill>{t.attempts > 1 && <span class="ml-1 text-[11px] text-[var(--color-text-faint)]">lần {t.attempts}</span>}</td>
                          <td class="px-2.5 py-2 tabular-nums">{fmtDateTime(t.publishedAt ?? post.scheduledAt)}</td>
                          <td class="px-2.5 py-2">
                            {t.permalink && <a href={t.permalink} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[var(--color-accent)] underline">Xem bài<ExternalLink size={11} /></a>}
                            {t.metrics && <span class="block text-[11.5px] text-[var(--color-text-muted)] tabular-nums">{fmtCompact(t.metrics.views)} xem · {fmtCompact(t.metrics.likes)} thích · {fmtCompact(t.metrics.comments)} bình luận</span>}
                            {t.error && <span class="block text-[11.5px] text-[var(--color-status-failed)] break-words">{t.error}</span>}
                          </td>
                          <td class="px-2.5 py-2 text-right">
                            {(t.status === 'failed' || t.status === 'missed') && <button type="button" class={BTN_SM} disabled={!!busy} onClick={() => { void retry(t.id); }}>{busy === `retry-${t.id}` ? '…' : 'Thử lại'}</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {picker && (
        <AssetPickerModal
          personaId={persona.id}
          selected={assets.map((a) => a.id)}
          max={format === 'carousel' ? 10 : format === 'photo' ? 10 : 1}
          onDone={(ids, picked) => {
            const map = new Map([...assets, ...picked].map((a) => [a.id, a]));
            setAssets(ids.map((id) => map.get(id)).filter((a): a is AssetDto => !!a));
            if (ids.length > 1 && format === 'photo') setFormat('carousel');
          }}
          onClose={() => setPicker(false)}
        />
      )}
      <ConfirmModal
        open={confirm === 'publishNow'}
        onClose={() => setConfirm(null)}
        onConfirm={() => { void act('publishNow'); }}
        title="Đăng ngay?"
        body={`Bài sẽ được đăng ngay lên ${platforms.map((p) => PLATFORM_META[p].name).join(', ') || 'các kênh đã chọn'}, bỏ qua giờ đã hẹn.`}
        detail="Bài đã đăng không gỡ tự động được từ đây."
        confirmLabel="Đăng ngay"
        cancelLabel="Huỷ"
      />
      <ConfirmModal
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        onConfirm={() => { void act('cancel'); }}
        title="Huỷ bài này?"
        body="Bài chuyển sang Đã huỷ và không được đăng. Ảnh/video vẫn giữ trong thư viện."
        confirmLabel="Huỷ bài"
        cancelLabel="Giữ lại"
        destructive
      />
      <Modal
        open={returning}
        title="Trả lại bài"
        width={480}
        onClose={() => setReturning(false)}
        footer={<>
          <button type="button" class={BTN} onClick={() => setReturning(false)}>Huỷ</button>
          <button type="button" class={`${BTN_PRIMARY} ml-auto`} disabled={!feedback.trim() || busy === 'return'} onClick={() => { void sendBack(); }}>Trả lại</button>
        </>}
      >
        <Field label="Góp ý (AI và người viết sẽ thấy)">
          <textarea class={`${TEXTAREA} w-full`} rows={4} placeholder="Caption dài quá, thêm câu hỏi cuối bài; đổi ảnh 2 vì tay bị lỗi" value={feedback} onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)} />
        </Field>
      </Modal>
    </>
  );
}

function tagTexts(v: Partial<Record<Platform, PlatformVariant>>): Partial<Record<Platform, string>> {
  const out: Partial<Record<Platform, string>> = {};
  for (const [p, x] of Object.entries(v) as [Platform, PlatformVariant | undefined][]) if (x?.hashtags?.length) out[p] = formatHashtags(x.hashtags);
  return out;
}
