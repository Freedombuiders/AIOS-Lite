/** Radar › Kênh & lịch: scheduler switch, followed channels, owner profile, per-layer sources, tools. */
import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { ChevronDown, ChevronRight } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { Toggle } from '@/components/Toggle';
import { Card } from '@modules/radar/web/components/ui';
import { BTN, BTN_DANGER, BTN_PRIMARY, INPUT, InlineError, TEXTAREA, apiFail } from '@modules/radar/web/components/ui';
import { pushToast } from '@/lib/toasts';
import { LAYER_ORDER, radarApi, type LayerConfig, type LayerKey, type RadarConfig, type RadarStatus } from '@modules/radar/web/lib/radar';
import { Check, Chips, NumCell, Row, RowsTable, TextCell } from './editors';
import { FollowedChannels } from './FollowedChannels';

export function RadarSettings({ status, onChanged }: { status: RadarStatus | null; onChanged: () => void }) {
  const [cfg, setCfg] = useState<RadarConfig | null>(null);
  // JSON of the last loaded/saved config, to flag unsaved edits.
  const [saved, setSaved] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<LayerKey | null>('vn');

  useEffect(() => {
    radarApi.config().then((r) => { setCfg(r.config); setSaved(JSON.stringify(r.config)); }).catch((e) => setLoadError(apiFail(e).message));
  }, []);

  if (!cfg) return <PageState loading={!loadError} error={loadError} />;

  const dirty = JSON.stringify(cfg) !== saved;
  const setLayer = (k: LayerKey, patch: Partial<LayerConfig>) =>
    setCfg({ ...cfg, layers: { ...cfg.layers, [k]: { ...cfg.layers[k], ...patch } } });

  async function toggleEnabled() {
    if (!cfg) return;
    const next = !cfg.enabled;
    try {
      await radarApi.setEnabled(next);
      setCfg({ ...cfg, enabled: next });
      setSaved((s) => (s ? JSON.stringify({ ...JSON.parse(s), enabled: next }) : s));
      onChanged();
      pushToast({ tone: 'success', title: next ? 'Đã bật lịch tự động' : 'Đã tắt lịch tự động' });
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không đổi được công tắc', description: apiFail(err).message });
    }
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await radarApi.saveConfig(cfg);
      setCfg(r.config);
      setSaved(JSON.stringify(r.config));
      onChanged();
      pushToast({ tone: 'success', title: 'Đã lưu cấu hình Radar' });
    } catch (err) {
      setSaveError(apiFail(err).message);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!window.confirm('Khôi phục toàn bộ nguồn và lịch về mặc định? Cấu hình hiện tại sẽ mất.')) return;
    try {
      const r = await radarApi.resetConfig();
      setCfg(r.config);
      setSaved(JSON.stringify(r.config));
      setSaveError(null);
      onChanged();
      pushToast({ tone: 'success', title: 'Đã khôi phục mặc định' });
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không khôi phục được', description: apiFail(err).message });
    }
  }

  return (
    <div class="flex-1 min-h-0 overflow-auto px-6 py-4">
      <div class="flex flex-col gap-4">
        <Card title="Lịch tự động" aside={<Toggle on={cfg.enabled} onChange={toggleEnabled} ariaLabel="Bật lịch tự động" />}>
          <p class="text-[12.5px] text-[var(--color-text-muted)]">
            Khi bật, Radar tự quét ba lớp vào giờ đã đặt ({cfg.timezone}). Khi tắt, bạn vẫn chạy tay được bằng nút “Chạy ngay”.
          </p>
        </Card>

        <FollowedChannels cfg={cfg} onChange={setCfg} tools={status?.tools} />

        <ToolsPanel status={status} />

        <Card title="Về bạn">
          <Row label="Tên" hint="Dùng trong “Ý tưởng cho …”"><input class={`${INPUT} w-64`} aria-label="Tên chủ kênh" value={cfg.owner.name} onInput={(e) => setCfg({ ...cfg, owner: { ...cfg.owner, name: (e.target as HTMLInputElement).value } })} /></Row>
          <Row label="Kênh / sản phẩm" hint="Ý tưởng được xếp vào đây"><Chips label="Kênh" value={cfg.owner.channels} onChange={(v) => setCfg({ ...cfg, owner: { ...cfg.owner, channels: v } })} /></Row>
          <Row label="Giới thiệu" hint="Bạn bán gì, cho ai"><textarea class={`${TEXTAREA} w-full`} rows={3} aria-label="Giới thiệu" value={cfg.owner.about} onInput={(e) => setCfg({ ...cfg, owner: { ...cfg.owner, about: (e.target as HTMLTextAreaElement).value } })} /></Row>
        </Card>

        {LAYER_ORDER.map((k) => (
          <LayerEditor key={k} layer={cfg.layers[k]} open={open === k} onToggle={() => setOpen(open === k ? null : k)} onChange={(p) => setLayer(k, p)} />
        ))}

        {saveError && <InlineError>{saveError}</InlineError>}
        <div class="flex gap-2 sticky bottom-0 py-3 bg-[var(--color-bg)]">
          <button type="button" class={BTN_PRIMARY} disabled={saving} onClick={save}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
          <button type="button" class={BTN_DANGER} onClick={reset}>Khôi phục mặc định</button>
          {dirty && <span class="self-center text-[12.5px] text-amber-600">Có thay đổi chưa lưu</span>}
        </div>
      </div>
    </div>
  );
}

function ToolsPanel({ status }: { status: RadarStatus | null }) {
  const [busy, setBusy] = useState(false);
  const t = status?.tools;
  async function login() {
    setBusy(true);
    try {
      const r = await radarApi.browserLogin();
      pushToast({ tone: r.ok ? 'success' : 'warn', title: r.ok ? 'Đã mở Chrome của Radar' : 'Chưa mở được Chrome', description: r.detail });
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không mở được Chrome', description: apiFail(err).message });
    } finally { setBusy(false); }
  }
  return (
    <Card title="Công cụ" aside="RSSHub miễn phí; Apify tính theo kết quả, khoảng $2–7 cho 1.000 bài/quảng cáo">
      {!t ? <p class="text-[12.5px] text-[var(--color-text-muted)]">Đang kiểm tra…</p> : (
        <div class="flex flex-col gap-3 text-[13px]">
          <div class="flex flex-wrap items-center gap-3">
            <b class="w-36">Apify</b>
            <span>{!t.apify.configured ? 'Chưa có token' : (t.apify.keys ?? 1) > 1 ? `${t.apify.keys} token, dùng lần lượt` : 'Đã có 1 token'}</span>
            <Link href="/connections" class={BTN}>{t.apify.configured ? 'Quản lý token' : 'Thêm Apify token'}</Link>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <b class="w-36">RSSHub</b>
            <span>{!t.rsshub ? 'Máy chủ chưa hỗ trợ' : t.rsshub.reachable ? `Đang chạy ở ${t.rsshub.url}` : `Không thấy ở ${t.rsshub.url}`}</span>
            <Link href="/connections" class={BTN}>Cấu hình</Link>
            <span class="text-[12px] text-[var(--color-text-muted)]">{t.rsshub && !t.rsshub.reachable ? 'Chạy “docker start rsshub” trong Terminal.' : 'Đọc Facebook, Threads, TikTok miễn phí.'}</span>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <b class="w-36">Agent đọc X</b>
            <span>{t.grok.installed ? `Đã có agent ${t.grok.path ?? 'radar-analyst'} (runtime Grok)` : 'Chưa có agent radar-analyst'}</span>
            <Link href="/agents" class={BTN}>{t.grok.installed ? 'Mở Agents' : 'Thêm agent từ mẫu'}</Link>
            <span class="text-[12px] text-[var(--color-text-muted)]">{t.grok.detail}</span>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <b class="w-36">Chrome của Radar</b>
            <span>{t.browser.available ? 'Sẵn sàng' : 'Không có'}</span>
            <button type="button" class={BTN} disabled={busy || !t.browser.available} onClick={login}>Đăng nhập Facebook</button>
            <span class="text-[12px] text-[var(--color-text-muted)]">Chỉ cần cho nhóm Facebook riêng tư.</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function LayerEditor({ layer: l, open, onToggle, onChange: set }: {
  layer: LayerConfig; open: boolean; onToggle: () => void; onChange: (p: Partial<LayerConfig>) => void;
}) {
  const N = (v: string) => v;
  return (
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] min-w-0">
      <button type="button" aria-expanded={open} class="w-full flex items-center gap-2 px-4 py-3 text-left" onClick={onToggle}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span class="text-[14px] font-semibold">{l.label}</span>
        <span class="text-[12px] text-[var(--color-text-muted)]">{l.time} · {l.enabled ? 'bật' : 'tắt'}</span>
      </button>
      {open && (
        <div class="flex flex-col gap-4 px-4 pb-4">
          <Row label="Trạng thái"><div class="flex flex-wrap items-center gap-4">
            <Check label="Bật lớp này" checked={l.enabled} onChange={(v) => set({ enabled: v })} />
            <label class="inline-flex items-center gap-2 text-[13px]">Giờ chạy
              <input type="time" class={`${INPUT} w-28`} aria-label={`Giờ chạy ${l.label}`} value={l.time} onInput={(e) => set({ time: (e.target as HTMLInputElement).value })} />
            </label>
          </div></Row>
          <Row label="Mô tả"><textarea class={`${TEXTAREA} w-full`} rows={2} aria-label={`Mô tả ${l.label}`} value={l.description} onInput={(e) => set({ description: (e.target as HTMLTextAreaElement).value })} /></Row>

          <Row label="Nhóm Facebook">
            <RowsTable
              rows={l.fbGroups} onChange={(fbGroups) => set({ fbGroups })} addLabel="Thêm nhóm"
              blank={() => ({ name: '', url: '', members: undefined, profession: '', mode: 'auto' as const, enabled: true })}
              cols={[
                { head: 'Tên', w: '140px', cell: (r, s) => <TextCell label="Tên nhóm" value={r.name} onChange={(name) => s({ name })} /> },
                { head: 'URL', w: '200px', cell: (r, s) => <TextCell label="URL nhóm" value={r.url} onChange={(url) => s({ url })} /> },
                { head: 'Thành viên', cell: (r, s) => <NumCell label="Thành viên" value={r.members} onChange={(members) => s({ members })} /> },
                { head: 'Ngành', w: '110px', cell: (r, s) => <TextCell label="Ngành" value={r.profession ?? ''} onChange={(profession) => s({ profession })} /> },
                { head: 'Cách đọc', cell: (r, s) => (
                  <select class={`${INPUT} h-8 text-[12.5px]`} aria-label="Cách đọc" title="Tự động: RSSHub trước, rồi Apify, rồi Chrome của Radar" value={r.mode ?? 'auto'} onChange={(e) => s({ mode: (e.target as HTMLSelectElement).value as NonNullable<typeof r.mode> })}>
                    <option value="auto">Tự động</option><option value="rsshub">RSSHub</option><option value="apify">Apify</option><option value="browser">Trình duyệt</option>
                  </select>) },
                { head: 'Bật', cell: (r, s) => <input type="checkbox" class="w-4 h-4 accent-[var(--color-accent)]" aria-label="Bật nhóm" checked={r.enabled !== false} onChange={(e) => s({ enabled: (e.target as HTMLInputElement).checked })} /> },
              ]}
            />
          </Row>
          <Row label="Fanpage đối thủ">
            <RowsTable
              rows={l.fbPages} onChange={(fbPages) => set({ fbPages })} addLabel="Thêm fanpage"
              blank={() => ({ name: '', url: '', enabled: true })}
              cols={[
                { head: 'Tên', w: '160px', cell: (r, s) => <TextCell label="Tên fanpage" value={r.name} onChange={(name) => s({ name })} /> },
                { head: 'URL', w: '260px', cell: (r, s) => <TextCell label="URL fanpage" value={r.url} onChange={(url) => s({ url })} /> },
                { head: 'Bật', cell: (r, s) => <input type="checkbox" class="w-4 h-4 accent-[var(--color-accent)]" aria-label="Bật fanpage" checked={r.enabled !== false} onChange={(e) => s({ enabled: (e.target as HTMLInputElement).checked })} /> },
              ]}
            />
          </Row>
          <Row label="Instagram" hint="Tên tài khoản, không có @"><Chips label="Instagram" value={l.instagram} onChange={(instagram) => set({ instagram })} /></Row>

          <Row label="Thư viện quảng cáo Meta"><div class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-4">
              <Check label="Bật" checked={l.adLibrary.enabled} onChange={(enabled) => set({ adLibrary: { ...l.adLibrary, enabled } })} />
              <label class="inline-flex items-center gap-2 text-[13px]">Quốc gia
                <input class={`${INPUT} w-20`} aria-label="Quốc gia" value={l.adLibrary.country} onInput={(e) => set({ adLibrary: { ...l.adLibrary, country: (e.target as HTMLInputElement).value } })} />
              </label>
            </div>
            <Chips label="Từ khóa quảng cáo" placeholder="Từ khóa, Enter" value={l.adLibrary.queries} onChange={(queries) => set({ adLibrary: { ...l.adLibrary, queries } })} />
            <Chips label="URL trang quảng cáo" placeholder="URL trang, Enter" value={l.adLibrary.pageUrls} onChange={(pageUrls) => set({ adLibrary: { ...l.adLibrary, pageUrls } })} />
          </div></Row>

          <Row label="X (qua Grok)"><div class="flex flex-col gap-2">
            <div class="flex flex-wrap gap-4">
              <Check label="Bật" checked={l.x.enabled} onChange={(enabled) => set({ x: { ...l.x, enabled } })} />
              <Check label="Kiểm tra X tiếng Việt đã nói gì" checked={l.x.vnCheck} onChange={(vnCheck) => set({ x: { ...l.x, vnCheck } })} />
            </div>
            <Chips label="Tài khoản X" placeholder="Tài khoản, Enter" value={l.x.accounts} onChange={(accounts) => set({ x: { ...l.x, accounts } })} />
            <Chips label="Từ khóa X" placeholder="Từ khóa, Enter" value={l.x.queries} onChange={(queries) => set({ x: { ...l.x, queries } })} />
          </div></Row>

          <Row label="Reddit"><div class="flex flex-col gap-2">
            <Check label="Bật" checked={l.reddit.enabled} onChange={(enabled) => set({ reddit: { ...l.reddit, enabled } })} />
            <Chips label="Subreddit" placeholder="Subreddit, Enter" value={l.reddit.subreddits} onChange={(subreddits) => set({ reddit: { ...l.reddit, subreddits } })} />
          </div></Row>
          <Row label="Hacker News"><div class="flex flex-wrap items-center gap-4">
            <Check label="Bật" checked={l.hackerNews.enabled} onChange={(enabled) => set({ hackerNews: { ...l.hackerNews, enabled } })} />
            <label class="inline-flex items-center gap-2 text-[13px]">Điểm tối thiểu
              <NumCell label="Điểm tối thiểu" w="w-24" value={l.hackerNews.minPoints} onChange={(v) => set({ hackerNews: { ...l.hackerNews, minPoints: v ?? 0 } })} />
            </label>
          </div></Row>
          <Row label="YouTube"><div class="flex flex-col gap-2">
            <Check label="Bật" checked={l.youtube.enabled} onChange={(enabled) => set({ youtube: { ...l.youtube, enabled } })} />
            <RowsTable
              rows={l.youtube.channels} onChange={(channels) => set({ youtube: { ...l.youtube, channels } })} addLabel="Thêm kênh"
              blank={() => ({ name: '', channelId: '' })}
              cols={[
                { head: 'Tên kênh', w: '180px', cell: (r, s) => <TextCell label="Tên kênh" value={r.name} onChange={(name) => s({ name })} /> },
                { head: 'Link kênh, @handle hoặc ID', w: '260px', cell: (r, s) => <TextCell label="Kênh YouTube" value={r.channelId} onChange={(channelId) => s({ channelId })} /> },
              ]}
            />
          </div></Row>
          <Row label="TikTok"><div class="flex flex-col gap-2">
            <Check label="Bật" checked={l.tiktok.enabled} onChange={(enabled) => set({ tiktok: { ...l.tiktok, enabled } })} />
            <Chips label="Tài khoản TikTok" placeholder="Tài khoản (RSSHub), Enter" value={l.tiktok.accounts} onChange={(accounts) => set({ tiktok: { ...l.tiktok, accounts } })} />
            <Chips label="Từ khóa TikTok" placeholder="Từ khoá (Apify), Enter" value={l.tiktok.queries} onChange={(queries) => set({ tiktok: { ...l.tiktok, queries } })} />
          </div></Row>
          <Row label="Threads"><div class="flex flex-col gap-2">
            <Check label="Bật" checked={l.threads.enabled} onChange={(enabled) => set({ threads: { ...l.threads, enabled } })} />
            <Chips label="Tài khoản Threads" placeholder="Tài khoản, Enter" value={l.threads.accounts} onChange={(accounts) => set({ threads: { ...l.threads, accounts } })} />
            <Chips label="Từ khóa Threads" placeholder="Từ khoá, Enter" value={l.threads.queries} onChange={(queries) => set({ threads: { ...l.threads, queries } })} />
          </div></Row>
          <Row label="GitHub"><div class="flex flex-col gap-2">
            <Check label="Bật" checked={l.github.enabled} onChange={(enabled) => set({ github: { ...l.github, enabled } })} />
            <Chips label="Từ khóa GitHub" value={l.github.queries} onChange={(queries) => set({ github: { ...l.github, queries } })} />
          </div></Row>
          <Row label="Báo chí (RSS)"><div class="flex flex-col gap-2">
            <Check label="Bật" checked={l.news.enabled} onChange={(enabled) => set({ news: { ...l.news, enabled } })} />
            <Chips label="RSS" placeholder="URL RSS, Enter" value={l.news.rss} onChange={(rss) => set({ news: { ...l.news, rss } })} />
          </div></Row>

          <Row label="Ngành nghề" hint="Bản đồ ngành"><div class="flex flex-col gap-2">
            <Chips label="Ngành nghề" value={l.professions} onChange={(professions) => set({ professions })} />
            <Check label="Chỉ giữ bài có nhắc tới AI" checked={l.aiOnly} onChange={(aiOnly) => set({ aiOnly })} />
          </div></Row>

          <Row label="Chủ đề" hint="Hàng của bản đồ nhiệt">
            <RowsTable
              rows={l.topics} onChange={(topics) => set({ topics })} addLabel="Thêm chủ đề"
              blank={() => ({ key: `topic${Date.now() % 100000}`, label: '', keywords: [] as string[] })}
              cols={[
                { head: 'Nhãn', w: '180px', cell: (r, s) => <TextCell label="Nhãn chủ đề" value={r.label} onChange={(label) => s({ label, key: r.key })} /> },
                { head: 'Từ khóa', w: '320px', cell: (r, s) => <Chips label="Từ khóa chủ đề" value={r.keywords} onChange={(keywords) => s({ keywords })} /> },
              ]}
            />
          </Row>

          <Row label="Cửa sổ & giới hạn"><div class="flex flex-wrap gap-4 text-[13px]">
            {([
              ['windowHours', 'Cửa sổ quét (giờ)'], ['firstWindowHours', 'Lần quét đầu (giờ)'],
              ['maxPerSource', 'Tối đa mỗi nguồn'], ['commentPosts', 'Bài đọc bình luận'],
            ] as const).map(([key, label]) => (
              <label key={key} class="inline-flex flex-col gap-1">{N(label)}
                <NumCell label={label} value={l[key]} onChange={(v) => set({ [key]: v ?? 0 } as Partial<LayerConfig>)} />
              </label>
            ))}
          </div></Row>
        </div>
      )}
    </section>
  );
}
