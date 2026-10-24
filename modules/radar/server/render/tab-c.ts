/** Tab C: profession map (nganh), competitor strategy room (vn), trend map (world). */

import type { AdView, ItemView, LayerKey } from '../types.js';
import { fmtInt } from '../util.js';
import {
  PRICE_MODELS, adStats, approxCount, competitorPosts, groupItems, itemComments, positioning, professionStats, sharedPains,
} from './derive.js';
import { Raw, cat, html, textLink } from './html.js';
import { type Ctx, sharedBlock } from './shared.js';

const ACCENT: Record<LayerKey, [string, string]> = { nganh: ['#2dd4bf', '#0f766e'], world: ['#818cf8', '#4338ca'], vn: ['#fb923c', '#c2410c'] };

const slotShort = (slot: string): string => slot.replace(/^phiên\s*/i, '');

function wrap(ctx: Ctx, on: boolean, inner: Raw): Raw {
  return html`<div class="sv${on ? ' on' : ''}" data-s="${ctx.s.key}">${inner}</div>`;
}

// ── nganh: Bản đồ ngành nghề ────────────────────────────────────────────

function nganhTab(ctx: Ctx): Raw {
  const { s, p } = ctx;
  const profs = professionStats(s);
  const maxC = profs[0]?.comments ?? 0;
  const shared = sharedPains(s);
  const totalComments = s.items.reduce((n, it) => n + itemComments(it), 0);
  const [acc, dark] = ACCENT.nganh;
  const lens = ctx.multi ? s.label : `Lớp ${p.layerLabel} · ${slotShort(p.slotLabel)}`;
  return html`<style>:root{--c-acc:${acc};--c-dark:${dark}}</style><div class="bar"><span class="lchip">${lens}</span><h1>Bản đồ <em>ngành nghề</em></h1><p>${p.dateLabel} · Cộng đồng không chuyên về AI trên Facebook, Threads, TikTok · Chỉ bài và bình luận nói về AI</p></div>
<div class="w"><div class="topr"><div class="pn"><h2>Ngành nào đang đau nhất vì AI <small>(xếp theo tổng bình luận các bài về AI trong phiên)</small></h2><div class="bars">${
    profs.map((x) => html`<div class="br"><span>${x.p.name}</span><i style="width:${maxC > 0 ? Math.max(3, Math.round((x.comments / maxC) * 100)) : 3}%"></i><b>${x.items.length} bài, ${fmtInt(x.comments)} bình luận</b></div>`)}</div>${
    s.missingProfessions.length ? html`<p class="tz">Chưa thấy bài về AI ở: ${s.missingProfessions.join(', ')}.</p>` : ''}</div>
<div class="pn"><h2>Tổng quan</h2><div class="sts"><div class="st "><b>${profs.length}</b><span>ngành nghề có bài về AI</span></div><div class="st "><b>${s.items.length}</b><span>bài nói về AI</span></div><div class="st "><b>${fmtInt(totalComments)}</b><span>bình luận</span></div><div class="st "><b>${s.pains.length}</b><span>nỗi đau</span></div><div class="st g"><b>${s.buySignals.length}</b><span>tín hiệu mua</span></div><div class="st "><b>${s.fears.length}</b><span>câu lo bị thay thế</span></div></div></div></div>
<h2 style="font-size:15px;margin:18px 0 10px">Từng ngành nghề</h2><div class="tiles">${
    profs.map((x) => html`<div class="tile" style="--o:${x.opacity.toFixed(2)}"><div class="th"><span class="av">${x.p.initials}</span><div><h4>${x.p.name}</h4><small>${x.p.summary}</small></div></div><div class="tn"><div><b>${x.items.length}</b><span>bài về AI</span></div><div><b>${fmtInt(x.comments)}</b><span>bình luận</span></div><div><b>${x.buys}</b><span>tín hiệu mua</span></div></div>${
      x.pains.map((pn) => html`<div class="tp">${pn.title}</div>`)}${x.p.quote ? html`<div class="tq">“${x.p.quote}”</div>` : ''}${
      x.hottest && itemComments(x.hottest) > 0 ? html`<div class="ts"><b>Bài nóng nhất:</b> ${x.hottest.title} (${fmtInt(itemComments(x.hottest))} bình luận) ${textLink('xem', x.hottest.url, 'xem')}</div>` : ''}</div>`)}</div>
<div class="board" style="--n:2"><div class="col"><h3>Nỗi đau chung nhiều nghề <span>${shared.length}</span></h3>${
    shared.map((x) => html`<div class="cd"><b>${x.title}</b><div class="ps">${[...new Set(x.professions)].map((n) => html`<span class=p>${n}</span>`)}</div><div class="an">${x.detail}</div></div>`)}</div><div class="col"><h3>Nỗi sợ bị thay thế <span>${s.fears.length}</span></h3>${
    s.fears.map((f) => html`<div class="cd"><div class="an" style="font-style:italic;color:#0f172a">“${f.text}”</div><div class="ps"><span class=p>${f.profession}</span>${f.context ? html`<span class=p>${f.context}</span>` : ''}</div></div>`)}</div></div>
${sharedBlock(ctx)}</div>`;
}

// ── vn: Phòng chiến lược đối thủ ────────────────────────────────────────

function adCardC(ad: AdView, maxDays: number): Raw {
  return html`<div class="cd"><div class="ct"><b>${ad.advertiser}</b>${textLink('xem', ad.libraryUrl, 'Ad Library')}</div><div class="ps"><span class="p f">${ad.funnelLabel}</span>${ad.format && ad.format !== 'Không ghi' ? html`<span class="p">${ad.format}</span>` : ''}${
    ad.audience ? html`<span class="p j">${ad.audience}</span>` : ''}${ad.sellsBook ? html`<span class="p b">Sách</span>` : ''}</div>
<div class="pr">${ad.product}</div><div class="an">${ad.headline}</div>
<div class="dy"><span style="width:${maxDays > 0 ? Math.round((ad.daysRunning / maxDays) * 100) : 0}%"></span></div><div class="mt"><span><b>${ad.daysRunning}</b> ngày${ad.versions ? html` · <b>${ad.versions}</b> phiên bản` : ''}${
    ad.startDate ? ` · từ ${shortDate(ad.startDate)}` : ''}</span><span>Giá: <b>${ad.price}</b></span></div></div>`;
}

function shortDate(iso: string): string {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00+07:00` : iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const v = new Date(d.getTime() + 7 * 3600 * 1000);
  return `${v.getUTCDate()}/${v.getUTCMonth() + 1}`;
}

function vnTab(ctx: Ctx): Raw {
  const { s, p } = ctx;
  const ads = ctx.groups.ads.map((it) => it.ad).filter((a): a is AdView => !!a).sort((a, b) => b.daysRunning - a.daysRunning);
  const pos = positioning(s);
  const st = adStats(ads);
  const maxDays = st.maxDays;
  const columns: { title: string; cards: Raw[] }[] = [
    { title: 'Kéo vào Zoom free', cards: ads.filter((a) => a.funnel === 'zoom').map((a) => adCardC(a, maxDays)) },
    { title: 'Inbox, Form, Comment', cards: ads.filter((a) => a.funnel === 'messenger' || a.funnel === 'form' || a.funnel === 'comment').map((a) => adCardC(a, maxDays)) },
    { title: 'Bán qua web', cards: ads.filter((a) => a.funnel === 'web').map((a) => adCardC(a, maxDays)) },
    {
      title: 'Khác, chưa rõ phễu',
      cards: [
        ...ads.filter((a) => a.funnel === 'unknown').map((a) => adCardC(a, maxDays)),
        ...s.otherAdvertisers.map((o) => html`<div class="cd"><div class="ct"><b>${o.name}</b></div><div class="an">${o.note}${o.since ? `, từ ${o.since}` : ''}</div></div>`),
      ],
    },
    {
      title: 'Fanpage nội dung',
      cards: s.competitors.map((c) => {
        const { top, others } = competitorPosts(s, c);
        const pp = (it: ItemView, link: boolean): Raw => html`<div class="pp">${it.title} <em>${[
          it.metrics.reactions ? `${fmtInt(it.metrics.reactions)} lượt cảm xúc` : '', it.metrics.comments ? `${fmtInt(it.metrics.comments)} bình luận` : '', it.metrics.shares ? `${fmtInt(it.metrics.shares)} lượt chia sẻ` : '',
        ].filter(Boolean).join(' · ')}</em>${link ? textLink('xem', it.url, 'xem') : ''}</div>`;
        return html`<div class="cd"><div class="ct"><b>${c.name}</b>${textLink('xem', c.url, 'xem')}</div><div class="ps">${
          c.followers ? html`<span class="p">${fmtInt(c.followers)} người theo dõi</span>` : ''}<span class="p z">${c.activeAds} quảng cáo đang chạy</span></div>
<div class="an"><b>Đăng:</b> ${c.posts}</div><div class="an"><b>Bán:</b> ${c.sells}</div>${top ? pp(top, true) : ''}${others.map((o) => pp(o, false))}</div>`;
      }),
    },
  ].filter((c) => c.cards.length > 0 || c.title === 'Fanpage nội dung' || c.title === 'Kéo vào Zoom free');
  const cellRow = (row: number) => PRICE_MODELS.map((_, col) => {
    const isGap = pos.gapCell && pos.gapCell.row === row && pos.gapCell.col === col;
    const chips = pos.cells[row][col].map((c) => c.kind === 'ad'
      ? html`<span class="ch ad" style="--s:${c.size.toFixed(2)}">${c.label}<em>${c.days} ngày</em></span>`
      : html`<span class="ch pg" style="--s:${c.size.toFixed(2)}">${c.label}</span>`);
    return isGap
      ? html`<div class="cell gap"><div class="gp"><b>Khoảng trống cho ${p.owner || 'bạn'}</b>${s.gap?.title ?? ''}</div>${chips}</div>`
      : html`<div class="cell">${chips}</div>`;
  });
  const lens = ctx.multi ? s.label : `Lớp ${p.layerLabel} · ${slotShort(p.slotLabel)}`;
  return html`<div class="bar"><h1>Phòng chiến lược <em>đối thủ</em></h1><p>${p.dateLabel} · ${ctx.multi ? `Phiên: ${s.label}` : lens} · Meta Ad Library (VN, đang chạy) + fanpage · Ad Library không công khai chi tiêu, tương tác</p></div>
<div class="w"><div class="topr">
<div class="pn"><h2>Bản đồ định vị <small>(vị trí do Radar xếp theo nội dung quảng cáo, không phải số đo; số = ngày đang chạy)</small></h2><div class="map"><div class="yl"><span>Doanh nghiệp, chuyên sâu</span><span>Theo nghề</span><span>Người mới, đại trà</span></div><div class="mg">${
    [0, 1, 2].map((r) => cellRow(r))}</div><div></div><div class="xl"><span>Miễn phí (Zoom, nội dung free)</span><span>Giá ẩn (inbox, form, web)</span><span>Giá công khai</span></div></div><div class="lg"><i style="background:#1e3a8a"></i>Quảng cáo đang chạy<i style="background:#fff;border:1px solid #94a3b8"></i>Fanpage, nhà quảng cáo khác (không có số ngày chạy)</div></div>
<div class="pn"><h2>Tổng quan</h2><div class="sts"><div class="st "><b>${st.total}</b><span>quảng cáo theo dõi</span></div><div class="st "><b>${st.maxDays}</b><span>ngày, dài nhất${st.maxDaysName ? ` (${st.maxDaysName})` : ''}</span></div><div class="st "><b>${st.maxVersions}</b><span>phiên bản${st.maxVersionsName ? ` (${st.maxVersionsName})` : ''}</span></div><div class="st "><b>${st.zoom}/${st.total}</b><span>kéo Zoom free</span></div><div class="st "><b>${st.profession}/${st.total}</b><span>nhắm theo nghề</span></div><div class="st g"><b>${st.books}/${st.total}</b><span>bán sách</span></div></div>${
    s.gap ? html`<div class="gapbox"><b>Khoảng trống cho ${p.owner || 'bạn'}: ${s.gap.title}</b><ul>${s.gap.bullets.map((b) => html`<li>${b}</li>`)}</ul></div>` : ''}</div></div>
<div class="board" style="--n:${columns.length}">${columns.map((c) => html`<div class="col"><h3>${c.title} <span>${c.cards.length}</span></h3>${c.cards}</div>`)}</div>
${sharedBlock(ctx)}</div>`;
}

// ── world: Bản đồ xu hướng ──────────────────────────────────────────────

function worldTab(ctx: Ctx): Raw {
  const { s, p } = ctx;
  const g = groupItems('world', s);
  const [acc, dark] = ACCENT.world;
  const lens = ctx.multi ? s.label : `Lớp ${p.layerLabel} · ${slotShort(p.slotLabel)}`;
  const platforms: { name: string; items: ItemView[] }[] = [
    { name: 'X', items: g.x }, { name: 'Hacker News, Reddit', items: g.hn }, { name: 'YouTube, GitHub, web', items: g.web },
  ].filter((x) => x.items.length > 0);
  const weight = (it: ItemView): number => it.metrics.likes ?? it.metrics.points ?? it.metrics.stars ?? it.metrics.views ?? 0;
  const maxTrend = Math.max(1, ...s.trends.map((t) => t.itemIds.length));
  const byId = new Map(s.items.map((it) => [it.id, it]));
  const cardOf = (it: ItemView): Raw => html`<div class="cd"><div class="ct"><b>${it.title}</b>${textLink('xem', it.url, 'xem')}</div><div class="ps"><span class="p">${it.sourceName}</span>${
    it.metrics.likes ? html`<span class="p">${fmtInt(it.metrics.likes)} lượt thích</span>` : ''}${it.metrics.points ? html`<span class="p">${fmtInt(it.metrics.points)} điểm</span>` : ''}${
    it.metrics.views ? html`<span class="p">${approxCount(it.metrics.views)} lượt xem</span>` : ''}</div>${it.quote ? html`<div class="an" style="font-style:italic">${it.quote}</div>` : it.note ? html`<div class="an">${it.note}</div>` : ''}</div>`;
  const colsDef = [
    { title: 'Tin nổi bật trên X', items: g.x },
    { title: 'Hacker News và Reddit', items: g.hn },
    { title: 'YouTube, GitHub, web', items: g.web },
  ].filter((c) => c.items.length > 0);
  return html`<style>:root{--c-acc:${acc};--c-dark:${dark}}</style><div class="bar"><span class="lchip">${lens}</span><h1>Bản đồ <em>xu hướng</em></h1><p>${p.dateLabel} · X, Hacker News, Reddit, YouTube, GitHub · Chỉ giữ chủ đề chưa phổ biến ở Việt Nam</p></div>
<div class="w"><div class="topr"><div class="pn"><h2>Nguồn nào có nhiều tin nhất <small>(số mục thu được trong phiên)</small></h2><div class="bars">${
    platforms.map((x) => html`<div class="br"><span>${x.name}</span><i style="width:${Math.max(3, Math.round((x.items.length / Math.max(1, ...platforms.map((y) => y.items.length))) * 100))}%"></i><b>${x.items.length} mục</b></div>`)}</div></div>
<div class="pn"><h2>Tổng quan</h2><div class="sts"><div class="st "><b>${s.trends.length}</b><span>xu hướng chính</span></div><div class="st "><b>${g.x.length}</b><span>tin trên X</span></div><div class="st "><b>${g.hn.length}</b><span>tin Hacker News, Reddit</span></div><div class="st "><b>${g.web.length}</b><span>video, bài báo, kho mã</span></div><div class="st "><b>${s.pains.length}</b><span>nỗi đau</span></div><div class="st g"><b>${s.ideas.length}</b><span>ý tưởng nội dung</span></div></div></div></div>
<h2 style="font-size:15px;margin:18px 0 10px">Xu hướng nước ngoài chính</h2><div class="tiles">${
    s.trends.map((t) => {
      const links = t.itemIds.map((id) => byId.get(id)).filter((x): x is ItemView => !!x);
      return html`<div class="tile" style="--o:${(0.35 + 0.65 * (t.itemIds.length / maxTrend)).toFixed(2)}"><div class="th"><span class="av">${t.rank}</span><div><h4>${t.title}</h4><small>${t.sourceLine}</small></div></div><div class="tn"><div><b>${t.metricLabel.split(' ')[0]}</b><span>${t.metricLabel.split(' ').slice(1).join(' ') || 'tương tác'}</span></div><div><b>${t.itemIds.length}</b><span>mục liên quan</span></div></div><div class="tp">${t.subtitle}</div><div class="tq">${t.vnAngle}</div>${
        links.length ? html`<div class="ts">${links.slice(0, 3).map((l) => html`${textLink('xem', l.url, l.kind === 'x' ? 'X' : l.kind === 'hn' ? 'HN' : l.kind === 'youtube' ? 'YouTube' : 'xem')} `)}</div>` : ''}</div>`;
    })}</div>
${colsDef.length ? html`<div class="board" style="--n:${colsDef.length}">${colsDef.map((c) => html`<div class="col"><h3>${c.title} <span>${c.items.length}</span></h3>${
    [...c.items].sort((a, b) => weight(b) - weight(a)).slice(0, 8).map(cardOf)}</div>`)}</div>` : ''}
${sharedBlock(ctx)}</div>`;
}

export function tabCSession(ctx: Ctx, on: boolean): Raw {
  const inner = ctx.layer === 'nganh' ? nganhTab(ctx) : ctx.layer === 'world' ? worldTab(ctx) : vnTab(ctx);
  return wrap(ctx, on, inner);
}

export const tabCSessions = (ctxs: Ctx[]): Raw => cat(ctxs.map((c, i) => tabCSession(c, i === 0)));
