// Kênh: linked account cards with posting rules, and the "Liên kết tài khoản" flow.

import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { ChevronDown, ChevronRight, RefreshCw, Unlink } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Toggle } from '@/components/Toggle';
import { PlatformBadge } from '@/components/social/PlatformBadge';
import { BTN, BTN_PRIMARY, BTN_SM, ConnDot, Field, INPUT, InlineError, apiFail, useFbPages } from '@modules/kol/web/components/shared/ops-shared';
import { TonePill, toastError } from '@modules/kol/web/components/ui';
import { pushToast } from '@/lib/toasts';
import {
  ACCOUNT_STATUS, PLATFORMS, PLATFORM_META, TIKTOK_PRIVACY, YOUTUBE_CATEGORIES, YOUTUBE_PRIVACY, fmtAgo, fmtCompact, kolApi, media,
  type AccountDto, type AccountInput, type ConnectionDto, type Platform,
} from '@modules/kol/web/lib/kol';

const TIMEZONES = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Europe/London', 'America/Los_Angeles', 'America/New_York', 'UTC'];

const picture = (url: string) => (url.startsWith('/api/') ? media(url) : url);

type Rules = Pick<AccountDto, 'enabled' | 'autoPublish' | 'maxPostsPerDay' | 'minGapMinutes' | 'windowStart' | 'windowEnd' | 'timezone' | 'tiktokPrivacy' | 'youtubePrivacy' | 'youtubeCategory'>;
const rulesOf = (a: AccountDto): Rules => ({
  enabled: a.enabled, autoPublish: a.autoPublish, maxPostsPerDay: a.maxPostsPerDay, minGapMinutes: a.minGapMinutes,
  windowStart: a.windowStart, windowEnd: a.windowEnd, timezone: a.timezone, tiktokPrivacy: a.tiktokPrivacy,
  youtubePrivacy: a.youtubePrivacy, youtubeCategory: a.youtubeCategory,
});

export function AccountCard({ account: a, onChanged }: { account: AccountDto; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<Rules>(() => rulesOf(a));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const dirty = JSON.stringify(rules) !== JSON.stringify(rulesOf(a));
  const st = ACCOUNT_STATUS[a.status] ?? ACCOUNT_STATUS.ERROR;
  const set = (p: Partial<Rules>) => setRules((r) => ({ ...r, ...p }));

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const patch: AccountInput = { ...rules };
      const { account } = await kolApi.updateAccount(a.id, patch);
      setRules(rulesOf(account));
      pushToast({ tone: 'success', title: 'Đã lưu quy tắc đăng' });
      onChanged();
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy('refresh');
    try {
      await kolApi.refreshAccount(a.id);
      pushToast({ tone: 'success', title: 'Đã làm mới tài khoản' });
      onChanged();
    } catch (err) {
      toastError('Không làm mới được', err);
    } finally {
      setBusy(null);
    }
  }

  async function unlink() {
    setBusy('unlink');
    try {
      await kolApi.deleteAccount(a.id);
      pushToast({ tone: 'success', title: `Đã gỡ @${a.handle}` });
      onChanged();
    } catch (err) {
      toastError('Không gỡ được', err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3.5 flex flex-col gap-3 min-w-0">
      <div class="flex items-start gap-3 min-w-0">
        <span class="relative shrink-0">
          {a.pictureUrl
            ? <img src={picture(a.pictureUrl)} alt="" class="w-11 h-11 rounded-full object-cover border border-[var(--color-border)]" loading="lazy" />
            : <span class="w-11 h-11 rounded-full bg-[var(--color-elevated)] block" />}
          <span class="absolute -bottom-1 -right-1"><PlatformBadge platform={a.platform} size={20} /></span>
        </span>
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[14px] font-semibold truncate">{a.displayName || a.handle}</span>
            <TonePill tone={st.tone}>{st.label}</TonePill>
            {!a.enabled && <TonePill tone="neutral">Tạm ngưng</TonePill>}
            {a.sharedWith?.length > 0 && (
              <span title="Quy tắc đăng tính chung cho kênh: số bài/ngày và khoảng cách gồm cả bài của các KOL này.">
                <TonePill tone="neutral">Dùng chung với {a.sharedWith.join(', ')}</TonePill>
              </span>
            )}
          </div>
          <div class="text-[12px] text-[var(--color-text-muted)] truncate">@{a.handle} · {PLATFORM_META[a.platform].name}</div>
          <div class="text-[12px] text-[var(--color-text-muted)] tabular-nums">
            {fmtCompact(a.followers)} người theo dõi{a.followersAt ? ` · cập nhật ${fmtAgo(a.followersAt)}` : ''}
          </div>
        </div>
        <div class="flex gap-1.5">
          <button type="button" class={`${BTN_SM} px-2`} disabled={!!busy} aria-label="Làm mới" title="Làm mới" onClick={() => { void refresh(); }}><RefreshCw size={13} class={busy === 'refresh' ? 'animate-spin' : ''} /></button>
          <button type="button" class={`${BTN_SM} px-2`} disabled={!!busy} aria-label="Gỡ tài khoản" title="Gỡ" onClick={() => setConfirm(true)}><Unlink size={13} /></button>
        </div>
      </div>

      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} class="flex items-center gap-1.5 text-left text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span class="font-medium text-[var(--color-text)]">Quy tắc đăng</span>
        <span class="truncate">· {a.enabled ? `${a.maxPostsPerDay ? `tối đa ${a.maxPostsPerDay}/ngày` : 'không giới hạn bài/ngày'}, cách ${a.minGapMinutes} phút, ${a.windowStart}–${a.windowEnd}` : 'đang tạm ngưng'}</span>
      </button>
      {open && (
        <div class="flex flex-col gap-3">
          <RuleToggle label="Đăng lên tài khoản này" desc="Tắt để tạm ngưng mà không gỡ liên kết." on={rules.enabled} onChange={() => set({ enabled: !rules.enabled })} />
          <RuleToggle label="Tự đăng bài đã duyệt" desc="Bài đã duyệt đăng đúng giờ, không cần xác nhận lần nữa." on={rules.autoPublish} onChange={() => set({ autoPublish: !rules.autoPublish })} />
          <div class="grid grid-cols-2 gap-3">
            <Field label="Tối đa bài/ngày" hint="0 = không giới hạn"><input type="number" min={0} max={50} class={`${INPUT} w-full`} value={rules.maxPostsPerDay} onInput={(e) => set({ maxPostsPerDay: Math.max(0, Math.min(50, Math.round(Number((e.target as HTMLInputElement).value) || 0))) })} /></Field>
            <Field label="Cách nhau (phút)"><input type="number" min={0} max={1440} class={`${INPUT} w-full`} value={rules.minGapMinutes} onInput={(e) => set({ minGapMinutes: Math.max(0, Math.min(1440, Math.round(Number((e.target as HTMLInputElement).value) || 0))) })} /></Field>
            <Field label="Từ"><input type="time" class={`${INPUT} w-full`} value={rules.windowStart} onInput={(e) => set({ windowStart: (e.target as HTMLInputElement).value })} /></Field>
            <Field label="Đến"><input type="time" class={`${INPUT} w-full`} value={rules.windowEnd} onInput={(e) => set({ windowEnd: (e.target as HTMLInputElement).value })} /></Field>
          </div>
          <Field label="Múi giờ của kênh">
            <input class={`${INPUT} w-full`} list="kol-timezones" value={rules.timezone} onInput={(e) => set({ timezone: (e.target as HTMLInputElement).value })} />
            <datalist id="kol-timezones">{TIMEZONES.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
          {a.platform === 'tiktok' && (
            <Field label="Quyền xem trên TikTok" hint="App TikTok chưa được TikTok duyệt (audit) chỉ đăng được ở chế độ “Chỉ mình tôi”. Đổi sau khi app được duyệt.">
              <select class={`${INPUT} w-full`} value={rules.tiktokPrivacy} onChange={(e) => set({ tiktokPrivacy: (e.target as HTMLSelectElement).value })}>
                {TIKTOK_PRIVACY.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          )}
          {a.platform === 'youtube' && (
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Quyền xem trên YouTube">
                <select class={`${INPUT} w-full`} value={rules.youtubePrivacy} onChange={(e) => set({ youtubePrivacy: (e.target as HTMLSelectElement).value as AccountDto['youtubePrivacy'] })}>
                  {YOUTUBE_PRIVACY.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="Danh mục">
                <select class={`${INPUT} w-full`} value={rules.youtubeCategory} onChange={(e) => set({ youtubeCategory: (e.target as HTMLSelectElement).value })}>
                  {!YOUTUBE_CATEGORIES.some((c) => c.value === rules.youtubeCategory) && rules.youtubeCategory && <option value={rules.youtubeCategory}>{rules.youtubeCategory}</option>}
                  {YOUTUBE_CATEGORIES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
            </div>
          )}
          {error && <InlineError>{error}</InlineError>}
          <div class="flex gap-2">
            <button type="button" class={BTN_PRIMARY} disabled={!dirty || !!busy} onClick={() => { void save(); }}>{busy === 'save' ? 'Đang lưu…' : 'Lưu quy tắc'}</button>
            {dirty && <button type="button" class={BTN} onClick={() => setRules(rulesOf(a))}>Hoàn tác</button>}
          </div>
        </div>
      )}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => { void unlink(); }}
        title={`Gỡ @${a.handle}?`}
        body="KOL không đăng lên tài khoản này nữa. Bài đã đăng vẫn còn trên nền tảng; kết nối Composio không bị xoá."
        confirmLabel="Gỡ"
        cancelLabel="Huỷ"
        destructive
      />
    </div>
  );
}

function RuleToggle({ label, desc, on, onChange }: { label: string; desc: string; on: boolean; onChange: () => void }) {
  return (
    <div class="flex items-start gap-3">
      <div class="flex-1 min-w-0"><div class="text-[13px]">{label}</div><div class="text-[12px] text-[var(--color-text-muted)]">{desc}</div></div>
      <Toggle size="sm" on={on} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

/** Pick platform → connection → (Facebook Page / optional Instagram user id) → link. */
export function LinkAccountModal({ personaId, connections, onRefreshConnections, onClose, onLinked }: {
  personaId: string;
  connections: ConnectionDto[];
  onRefreshConnections: () => void;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [externalId, setExternalId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fb = useFbPages();
  const forPlatform = connections.filter((c) => c.toolkit === platform);

  const isFb = platform === 'facebook';
  const ready = !!platform && (isFb ? !!externalId : !!connectionId);

  async function link() {
    if (!platform || !ready) { setError(isFb ? 'Chọn một Fanpage.' : 'Chọn một kết nối Composio.'); return; }
    setBusy(true);
    setError(null);
    try {
      const { account } = await kolApi.linkAccount(personaId, { platform, connectionId, ...(externalId.trim() ? { externalId: externalId.trim() } : {}) });
      pushToast({ tone: 'success', title: `Đã liên kết @${account.handle || account.displayName}` });
      onLinked();
      onClose();
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="Liên kết tài khoản"
      width={620}
      onClose={() => { if (!busy) onClose(); }}
      closeDisabled={busy}
      footer={<>
        <button type="button" class={BTN} disabled={busy} onClick={onClose}>Huỷ</button>
        <button type="button" class={`${BTN_PRIMARY} ml-auto`} disabled={busy || !ready} onClick={() => { void link(); }}>{busy ? 'Đang liên kết…' : 'Liên kết'}</button>
      </>}
    >
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <span class="text-[12px] text-[var(--color-text-muted)]">1. Nền tảng</span>
          <div role="radiogroup" aria-label="Nền tảng" class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PLATFORMS.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={platform === p}
                onClick={() => { setPlatform(p); setConnectionId(''); setExternalId(''); setError(null); }}
                class={`h-12 rounded-lg border inline-flex items-center justify-center gap-2 text-[13px] ${platform === p ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-semibold' : 'border-[var(--color-border)] hover:bg-[var(--color-control-hover)]'}`}>
                <PlatformBadge platform={p} size={22} />{PLATFORM_META[p].name}
              </button>
            ))}
          </div>
        </div>

        {platform && !isFb && (
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center gap-2">
              <span class="text-[12px] text-[var(--color-text-muted)]">2. Kết nối Composio</span>
              <button type="button" class={`${BTN_SM} ml-auto`} onClick={onRefreshConnections}><RefreshCw size={12} class="mr-1" />Làm mới</button>
            </div>
            {forPlatform.length === 0 ? (
              <p class="text-[12.5px] text-[var(--color-text-muted)]">
                Chưa có kết nối {PLATFORM_META[platform].name} trong Composio. Kết nối tài khoản ở{' '}
                <Link href="/connections" class="text-[var(--color-accent)] underline">Kết nối › Composio</Link> rồi bấm Làm mới.
              </p>
            ) : (
              <div role="radiogroup" aria-label="Kết nối" class="flex flex-col gap-1.5">
                {forPlatform.map((c) => (
                  <label key={c.id} class={`flex items-center gap-2.5 rounded-md border px-3 py-2 cursor-pointer text-[13px] ${connectionId === c.id ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-control-hover)]'}`}>
                    <input type="radio" name="kol-connection" class="accent-[var(--color-accent)]" checked={connectionId === c.id} onChange={() => setConnectionId(c.id)} />
                    <ConnDot status={c.status} />
                    <span class="flex-1 min-w-0 truncate">{c.alias || c.id}</span>
                    <span class="text-[11.5px] text-[var(--color-text-muted)]">{c.status}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {isFb && (
          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-[var(--color-text-muted)]">2. Fanpage (bài Facebook đi qua Facebook Content Studio; kết nối lấy từ Page)</span>
            {fb.loading && !fb.data && <p class="text-[12px] text-[var(--color-text-faint)]">Đang tải Page…</p>}
            {fb.error && <InlineError>{fb.error}</InlineError>}
            {fb.data && fb.enabledPages.length === 0 && (
              <p class="text-[12.5px] text-[var(--color-text-muted)]">
                {fb.pages.length ? 'Chưa có Fanpage nào được bật.' : 'Chưa có Fanpage nào.'} Đồng bộ và bật Page ở{' '}
                <Link href="/m/marketing" class="text-[var(--color-accent)] underline">Marketing › Pages</Link> rồi quay lại.
              </p>
            )}
            {fb.pages.length > 0 && (
              <select class={`${INPUT} w-full`} value={externalId} onChange={(e) => setExternalId((e.target as HTMLSelectElement).value)}>
                <option value="">Chọn Fanpage…</option>
                {fb.pages.map((p) => <option key={p.id} value={p.id} disabled={!p.enabled}>{p.name}{p.enabled ? '' : ' (chưa bật trong Marketing › Pages)'}</option>)}
              </select>
            )}
          </div>
        )}
        {platform === 'instagram' && connectionId && (
          <Field label="3. Instagram user ID (tuỳ chọn)" hint="Để trống để tự tìm tài khoản Instagram Business gắn với kết nối.">
            <input class={`${INPUT} w-full font-mono`} placeholder="17841400000000000" value={externalId} onInput={(e) => setExternalId((e.target as HTMLInputElement).value)} />
          </Field>
        )}
        {platform === 'tiktok' && <p class="text-[12px] text-[var(--color-text-muted)]">TikTok chỉ nhận video. App chưa được TikTok duyệt chỉ đăng được ở chế độ riêng tư.</p>}
        {platform === 'youtube' && <p class="text-[12px] text-[var(--color-text-muted)]">YouTube chỉ nhận video. Video dọc ≤ 3 phút được đăng dạng Shorts.</p>}
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}
