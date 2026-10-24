/** Radar › Kênh & lịch: one place to follow Facebook, X, Threads, TikTok, YouTube and Instagram channels across the three layers. */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { ExternalLink, Plus, X as XIcon } from 'lucide-preact';
import { Card } from '@modules/radar/web/components/ui';
import { BTN, BTN_SM, INPUT, InlineError } from '@modules/radar/web/components/ui';
import { LAYER_LABEL, LAYER_ORDER, type LayerConfig, type LayerKey, type RadarConfig, type RadarStatus } from '@modules/radar/web/lib/radar';
import { CHANNEL_LABEL, parseChannel, socialHandle, type ChannelPlatform } from '../../../server/channels';

type Platform = ChannelPlatform | 'auto';
type Section = 'facebook' | 'x' | 'threads' | 'tiktok' | 'youtube' | 'instagram';
/** Platforms whose layer block has its own on/off switch. */
type Toggled = 'x' | 'threads' | 'tiktok' | 'youtube';

interface Entry { platform: ChannelPlatform; layer: LayerKey; index: number; name: string; url: string; off: boolean; key: string }

const SECTIONS: Section[] = ['facebook', 'x', 'threads', 'tiktok', 'youtube', 'instagram'];
const SECTION_TITLE: Record<Section, string> = { facebook: 'Facebook', x: 'X (Twitter)', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' };
const TOGGLED: Toggled[] = ['x', 'threads', 'tiktok', 'youtube'];
const PLATFORM_ORDER: ChannelPlatform[] = ['fb_group', 'fb_page', 'x', 'threads', 'tiktok', 'youtube', 'instagram'];

const ytUrl = (id: string) => (/^https?:\/\//.test(id) ? id : /^UC[\w-]{22}$/.test(id) ? `https://www.youtube.com/channel/${id}` : `https://www.youtube.com/@${id.replace(/^@/, '')}`);

/** How many channels a toggled block holds (accounts, or YouTube channels). */
const toggledCount = (l: LayerConfig, p: Toggled) => (p === 'youtube' ? l.youtube.channels.length : l[p].accounts.length);

function entriesOf(cfg: RadarConfig): Entry[] {
  const out: Entry[] = [];
  for (const layer of LAYER_ORDER) {
    const l = cfg.layers[layer];
    l.fbGroups.forEach((g, index) => out.push({ platform: 'fb_group', layer, index, name: g.name, url: g.url, off: g.enabled === false, key: g.url.toLowerCase() }));
    l.fbPages.forEach((p, index) => out.push({ platform: 'fb_page', layer, index, name: p.name, url: p.url, off: p.enabled === false, key: p.url.toLowerCase() }));
    l.instagram.forEach((h, index) => {
      const handle = socialHandle(h, 'instagram');
      out.push({ platform: 'instagram', layer, index, name: `@${handle}`, url: `https://www.instagram.com/${handle}/`, off: false, key: handle.toLowerCase() });
    });
    l.x.accounts.forEach((h, index) => {
      const handle = socialHandle(h, 'x');
      out.push({ platform: 'x', layer, index, name: `@${handle}`, url: `https://x.com/${handle}`, off: !l.x.enabled, key: handle.toLowerCase() });
    });
    l.threads.accounts.forEach((h, index) => {
      const handle = socialHandle(h, 'threads');
      out.push({ platform: 'threads', layer, index, name: `@${handle}`, url: `https://www.threads.net/@${handle}`, off: !l.threads.enabled, key: handle.toLowerCase() });
    });
    l.tiktok.accounts.forEach((h, index) => {
      const handle = socialHandle(h, 'tiktok');
      out.push({ platform: 'tiktok', layer, index, name: `@${handle}`, url: `https://www.tiktok.com/@${handle}`, off: !l.tiktok.enabled, key: handle.toLowerCase() });
    });
    l.youtube.channels.forEach((c, index) => {
      const id = parseChannel(c.channelId, 'youtube')?.handle ?? c.channelId.trim();
      out.push({ platform: 'youtube', layer, index, name: c.name || id, url: ytUrl(id), off: !l.youtube.enabled, key: id.toLowerCase() });
    });
  }
  return out;
}

const sectionOf = (p: ChannelPlatform): Section => (p === 'fb_group' || p === 'fb_page' ? 'facebook' : p);

export function FollowedChannels({ cfg, onChange, tools }: {
  cfg: RadarConfig; onChange: (cfg: RadarConfig) => void; tools: RadarStatus['tools'] | undefined;
}) {
  const [platform, setPlatform] = useState<Platform>('auto');
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [layer, setLayer] = useState<LayerKey>('vn');
  const [filter, setFilter] = useState<LayerKey | 'all'>('all');
  const [error, setError] = useState<string | null>(null);

  const parsed = link.trim() ? parseChannel(link, platform === 'auto' ? undefined : platform) : null;
  const named = parsed?.platform === 'fb_group' || parsed?.platform === 'fb_page' || parsed?.platform === 'youtube';
  const all = entriesOf(cfg);

  const setLayerCfg = (k: LayerKey, next: LayerConfig) => onChange({ ...cfg, layers: { ...cfg.layers, [k]: next } });

  function add() {
    if (!parsed) {
      setError(platform === 'auto' && link.trim() && !/[./]/.test(link)
        ? 'Chỉ có tên tài khoản thì hãy chọn nền tảng (Threads, TikTok, X…) ở ô bên trái.'
        : 'Không nhận ra link. Dán link nhóm/trang Facebook hoặc trang cá nhân X, Threads, TikTok, YouTube, Instagram, ví dụ https://www.threads.net/@openai.');
      return;
    }
    const key = (parsed.platform === 'fb_group' || parsed.platform === 'fb_page' ? parsed.url : parsed.handle).toLowerCase();
    const dupe = all.find((e) => e.layer === layer && e.platform === parsed.platform && e.key === key);
    if (dupe) { setError(`${dupe.name} đã có trong lớp ${LAYER_LABEL[layer]}.`); return; }
    const l = cfg.layers[layer];
    const label = name.trim() || parsed.handle;
    const next = { ...l };
    if (parsed.platform === 'fb_group') next.fbGroups = [...l.fbGroups, { name: label, url: parsed.url, profession: '', mode: 'auto', enabled: true }];
    if (parsed.platform === 'fb_page') next.fbPages = [...l.fbPages, { name: label, url: parsed.url, enabled: true }];
    if (parsed.platform === 'instagram') next.instagram = [...l.instagram, parsed.handle];
    if (parsed.platform === 'x') next.x = { ...l.x, enabled: true, accounts: [...l.x.accounts, parsed.handle] };
    if (parsed.platform === 'threads') next.threads = { ...l.threads, enabled: true, accounts: [...l.threads.accounts, parsed.handle] };
    if (parsed.platform === 'tiktok') next.tiktok = { ...l.tiktok, enabled: true, accounts: [...l.tiktok.accounts, parsed.handle] };
    if (parsed.platform === 'youtube') next.youtube = { ...l.youtube, enabled: true, channels: [...l.youtube.channels, { name: label, channelId: parsed.handle }] };
    setLayerCfg(layer, next);
    setLink(''); setName(''); setError(null);
  }

  function remove(e: Entry) {
    const l = cfg.layers[e.layer];
    const drop = <T,>(list: T[]) => list.filter((_, i) => i !== e.index);
    const next = { ...l };
    if (e.platform === 'fb_group') next.fbGroups = drop(l.fbGroups);
    if (e.platform === 'fb_page') next.fbPages = drop(l.fbPages);
    if (e.platform === 'instagram') next.instagram = drop(l.instagram);
    if (e.platform === 'x') next.x = { ...l.x, accounts: drop(l.x.accounts) };
    if (e.platform === 'threads') next.threads = { ...l.threads, accounts: drop(l.threads.accounts) };
    if (e.platform === 'tiktok') next.tiktok = { ...l.tiktok, accounts: drop(l.tiktok.accounts) };
    if (e.platform === 'youtube') next.youtube = { ...l.youtube, channels: drop(l.youtube.channels) };
    setLayerCfg(e.layer, next);
  }

  function enable(k: LayerKey, p: Toggled) {
    const l = cfg.layers[k];
    setLayerCfg(k, { ...l, [p]: { ...l[p], enabled: true } });
  }

  const shown = all.filter((e) => filter === 'all' || e.layer === filter);
  const offNotes = (s: Section) => TOGGLED.includes(s as Toggled)
    ? LAYER_ORDER.filter((k) => !cfg.layers[k][s as Toggled].enabled && toggledCount(cfg.layers[k], s as Toggled) > 0 && (filter === 'all' || filter === k)).map((k) => (
      <p key={k} class="text-[12px] text-[var(--color-text-muted)]">
        Lớp {LAYER_LABEL[k]} đang tắt {SECTION_TITLE[s]} nên các kênh trên chưa được đọc.{' '}
        <button type="button" class="underline text-[var(--color-accent)]" onClick={() => enable(k, s as Toggled)}>Bật {SECTION_TITLE[s]} cho lớp này</button>
      </p>
    ))
    : null;

  return (
    <Card title="Kênh theo dõi" aside="Dán link Facebook, X, Threads, TikTok, YouTube hoặc Instagram. Bấm Lưu ở cuối trang để áp dụng.">
      <div class="flex flex-wrap items-center gap-2">
        <select class={`${INPUT} h-9 text-[13px]`} aria-label="Nền tảng" value={platform} onChange={(e) => { setPlatform((e.target as HTMLSelectElement).value as Platform); setError(null); }}>
          <option value="auto">Tự nhận từ link</option>
          {PLATFORM_ORDER.map((p) => <option key={p} value={p}>{CHANNEL_LABEL[p]}</option>)}
        </select>
        <input
          class={`${INPUT} h-9 flex-1 min-w-[220px] text-[13px]`} aria-label="Link hoặc @tên kênh" placeholder="https://www.threads.net/@openai hoặc @tên"
          value={link} onInput={(e) => { setLink((e.target as HTMLInputElement).value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        {named && (
          <input class={`${INPUT} h-9 w-44 text-[13px]`} aria-label="Tên hiển thị" placeholder="Tên hiển thị (tuỳ chọn)" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        )}
        <select class={`${INPUT} h-9 text-[13px]`} aria-label="Thêm vào lớp" value={layer} onChange={(e) => setLayer((e.target as HTMLSelectElement).value as LayerKey)}>
          {LAYER_ORDER.map((k) => <option key={k} value={k}>Lớp {LAYER_LABEL[k]}</option>)}
        </select>
        <button type="button" class={BTN} onClick={add}><Plus size={13} /> Thêm</button>
      </div>
      {parsed && !error && (
        <p class="text-[12px] text-[var(--color-text-muted)]">Nhận ra: <b class="text-[var(--color-text)]">{CHANNEL_LABEL[parsed.platform]}</b> · {parsed.url}</p>
      )}
      {error && <InlineError>{error}</InlineError>}

      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Lọc theo lớp">
        {(['all', ...LAYER_ORDER] as const).map((k) => {
          const n = k === 'all' ? all.length : all.filter((e) => e.layer === k).length;
          return (
            <button key={k} type="button" aria-pressed={filter === k}
              class={BTN_SM} style={filter === k ? { background: 'var(--color-accent)', color: 'var(--color-on-accent)', borderColor: 'transparent' } : undefined}
              onClick={() => setFilter(k)}>
              {k === 'all' ? 'Tất cả' : LAYER_LABEL[k]} ({n})
            </button>
          );
        })}
      </div>

      {SECTIONS.map((s) => (
        <PlatformSection key={s} section={s} entries={shown.filter((e) => sectionOf(e.platform) === s)} tools={tools} onRemove={remove} extra={offNotes(s)} />
      ))}
    </Card>
  );
}

/** One line on how a section is read and whether that works right now; null while the status loads. */
function readiness(section: Section, tools: RadarStatus['tools'] | undefined): { ok: boolean; text: string; fix?: boolean } | null {
  if (!tools) return null;
  const rss = tools.rsshub?.reachable === true;
  const apify = tools.apify.configured;
  switch (section) {
    case 'facebook':
      if (rss) return { ok: true, text: apify ? 'Đọc qua RSSHub (miễn phí), Apify dự phòng' : 'Đọc qua RSSHub (miễn phí; chưa có cookie FB thì mỗi lần chỉ được khoảng 3 bài mới nhất)' };
      return apify ? { ok: true, text: 'Đọc qua Apify' } : { ok: false, text: 'Chưa có RSSHub hay Apify token nên chưa đọc được.', fix: true };
    case 'instagram':
      if (apify) return { ok: true, text: rss ? 'Đọc qua RSSHub, Apify dự phòng' : 'Đọc qua Apify' };
      return rss
        ? { ok: false, text: 'Đọc qua RSSHub, nhưng Instagram thường chặn khi RSSHub chưa có cookie tài khoản phụ (INSTAGRAM_COOKIE).' }
        : { ok: false, text: 'Chưa có RSSHub hay Apify token nên chưa đọc được.', fix: true };
    case 'x':
      if (tools.grok.installed) return { ok: true, text: 'Đọc qua agent radar-analyst (Grok)' };
      return { ok: false, text: 'Chưa có agent radar-analyst nên chưa đọc được X. Thêm agent từ mẫu của module Radar.' };
    case 'threads':
      if (rss) return { ok: true, text: 'Đọc qua RSSHub (miễn phí), cả tài khoản lẫn tìm theo từ khoá' };
      return apify ? { ok: false, text: 'Tài khoản Threads cần RSSHub; Apify chỉ tìm theo từ khoá.', fix: true } : { ok: false, text: 'Chưa có RSSHub nên chưa đọc được.', fix: true };
    case 'tiktok':
      return rss ? { ok: true, text: 'Đọc qua RSSHub (miễn phí)' } : { ok: false, text: 'Tài khoản TikTok cần RSSHub.', fix: true };
    case 'youtube':
      return { ok: true, text: 'Miễn phí qua RSS của YouTube' };
  }
}

function PlatformSection({ section, entries, tools, onRemove, extra }: {
  section: Section; entries: Entry[]; tools: RadarStatus['tools'] | undefined; onRemove: (e: Entry) => void; extra?: ComponentChildren;
}) {
  const r = readiness(section, tools);
  return (
    <div class="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 class="text-[13px] font-semibold">{SECTION_TITLE[section]} <span class="font-normal text-[var(--color-text-muted)]">· {entries.length}</span></h3>
        {r && (
          <span class={`text-[12px] ${r.ok ? 'text-[var(--color-text-muted)]' : 'text-amber-600'}`}>
            {r.text}{r.ok && ' · sẵn sàng'}
            {r.fix && <>{' '}<Link href="/connections" class="underline">Kết nối</Link></>}
            {section === 'facebook' && !r.ok && ' (nhóm riêng tư có thể đọc qua Chrome của Radar: đặt “Cách đọc” = Trình duyệt trong bảng của lớp).'}
          </span>
        )}
      </div>
      {entries.length === 0 ? (
        <p class="text-[12px] text-[var(--color-text-faint,var(--color-text-muted))]">Chưa theo dõi kênh nào.</p>
      ) : (
        <ul class="flex flex-col">
          {entries.map((e) => (
            <li key={`${e.platform}-${e.layer}-${e.index}`} class="flex items-center gap-2 py-1 text-[12.5px] min-w-0">
              <span class="truncate font-medium min-w-0 max-w-[40%]">{e.name}</span>
              {section === 'facebook' && <span class="shrink-0 text-[11px] text-[var(--color-text-muted)]">{e.platform === 'fb_group' ? 'nhóm' : 'trang'}</span>}
              <span class="shrink-0 px-2 h-5 inline-flex items-center rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] text-[11px]">{LAYER_LABEL[e.layer]}</span>
              {e.off && <span class="shrink-0 text-[11px] text-[var(--color-text-muted)]">đang tắt</span>}
              <a href={e.url} target="_blank" rel="noreferrer" class="truncate min-w-0 flex-1 text-[var(--color-text-muted)] hover:underline inline-flex items-center gap-1">
                <ExternalLink size={11} class="shrink-0" /><span class="truncate">{e.url.replace(/^https:\/\/(www\.)?/, '')}</span>
              </a>
              <button type="button" aria-label={`Bỏ theo dõi ${e.name}`} class="shrink-0 p-1 rounded hover:bg-[var(--color-control-hover)]" onClick={() => onRemove(e)}><XIcon size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      {extra}
    </div>
  );
}
