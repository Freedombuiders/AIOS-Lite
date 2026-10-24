/** Sections appended to the bottom of every report tab (original ".fd" block) and the helpers they share. */

import type { AdView, ItemView, LayerKey, Metrics, RenderLinks, ReportPayload, SessionView } from '../types.js';
import { fmtInt } from '../util.js';
import {
  type CommunityStat, type MetricDef, fmtMembers, FB_METRICS, X_METRICS, approxCount, communityStats, competitorPosts, fmtDayMonth, fmtPosted, fmtStamp,
  freshStats, groupItems, itemComments, sessionTotals, type ItemGroups,
} from './derive.js';
import { Raw, cat, extLink, html, raw, safeUrl } from './html.js';
import { icon, type IconName } from './icons.js';

export interface Ctx {
  p: ReportPayload;
  s: SessionView;
  links: RenderLinks;
  layer: LayerKey;
  /** Element id prefix of this session ("all", "s1", …). */
  pre: string;
  multi: boolean;
  stats: CommunityStat[];
  groups: ItemGroups;
}

export function makeCtx(p: ReportPayload, s: SessionView, links: RenderLinks): Ctx {
  return {
    p, s, links, layer: p.layer, pre: s.key, multi: p.sessions.length > 1,
    stats: communityStats(p.layer, s), groups: groupItems(p.layer, s),
  };
}

export const emptyCard = (text: string): Raw => html`<div class="fd-empty">${raw(icon('info'))}${text}</div>`;

// ── small pieces ────────────────────────────────────────────────────────

const STATUS: Record<string, string> = { todo: 'Chưa làm', doing: 'Đang làm', done: 'Đã xong' };
export const statusLabel = (s: string): string => STATUS[s] ?? STATUS.todo;

/** `<span class="fd-m"><icon><b>179</b> bình luận</span>` */
function metricB(icn: IconName, value: number, label: string): Raw {
  return html`<span class="fd-m ">${raw(icon(icn))}<b>${fmtInt(value)}</b> ${label}</span>`;
}

function metricsB(m: Metrics, defs: MetricDef[]): Raw[] {
  const seen = new Set<string>();
  const out: Raw[] = [];
  for (const d of defs) {
    const v = m[d.key];
    if (typeof v !== 'number' || v <= 0 || seen.has(String(d.key))) continue;
    seen.add(String(d.key));
    out.push(metricB(d.icon, v, d.label));
  }
  return out;
}

/** Platform chip text for a post card. */
function platName(kind: ItemView['kind']): string {
  switch (kind) {
    case 'fb_group': case 'fb_page': return 'facebook';
    case 'news': return 'báo, web';
    case 'ad': return 'quảng cáo';
    default: return kind;
  }
}

function fmtIcon(it: ItemView): IconName {
  const t = it.typeLabel.toLowerCase();
  if (t.includes('video')) return 'video';
  if (t.includes('ảnh')) return 'image';
  return 'doc';
}

function sessionChip(ctx: Ctx, it: ItemView): Raw {
  if (!(ctx.multi && ctx.s.key === 'all')) return raw('');
  const label = ctx.p.sessions.find((x) => x.key === it.sessionKey)?.label;
  return label ? html`<span class="fd-b">${label}</span>` : raw('');
}

// ── post card (community block) ─────────────────────────────────────────

export function postCard(ctx: Ctx, it: ItemView): Raw {
  const posted = fmtPosted(it, ctx.p.generatedAt);
  const metrics = metricsB(it.metrics, FB_METRICS.filter((d) => d.key !== 'shares'));
  const cls = ['fd-pc', it.buy ? 'buy' : '', it.within24h ? '' : 'out'].filter(Boolean).join(' ');
  return html`<article class="${cls}"><div class="fd-pt"><span class="fd-fmt">${raw(icon(fmtIcon(it)))}${it.typeLabel}</span>${
    it.isNew ? html`<span class="fd-b new">${raw(icon('flame'))}Mới hôm nay</span>` : ''}${
    it.rising ? html`<span class="fd-b top">${raw(icon('up'))}Đang lên</span>` : ''}<span class="fd-b plat">${platName(it.kind)}</span>${
    it.buy ? html`<span class="fd-b buy">${raw(icon('cart'))}Có tín hiệu mua</span>` : ''}${
    it.top ? html`<span class="fd-b top">${raw(icon('flame'))}Bài top</span>` : ''}${
    it.within24h ? '' : html`<span class="fd-b out">${raw(icon('clock'))}Ngoài 24 giờ, không tính nhiệt</span>`}${sessionChip(ctx, it)}</div><h4>${it.title}</h4>${
    it.note ? html`<p>${it.note}</p>` : ''}<div class="fd-ms">${
    metrics.length || posted ? cat([metrics, posted ? html`<span class="fd-m t">${raw(icon('clock'))}${posted}</span>` : '']) : html`<span class="fd-m none">Chưa ghi số liệu cho bài này</span>`
  }</div><div class="fd-pf">${extLink('fd-btn', it.url, 'Xem bài gốc')}</div></article>`;
}

// ── Hôm nay có gì mới? ──────────────────────────────────────────────────

export function freshSection(ctx: Ctx): Raw {
  const f = freshStats(ctx.s);
  const lensLabel = ctx.multi && ctx.s.key !== 'all' ? `Lớp ${ctx.p.layerLabel} · ${ctx.s.label}` : `Lớp ${ctx.p.layerLabel} · ${ctx.p.slotLabel}`;
  const maxTimes = Math.max(1, ...f.recurringList.map((x) => x.times));
  return html`<section class="fr" id="${ctx.pre}-fd-fresh"><div class="fr-head"><div><span class="fr-lens">${raw(icon(ctx.layer === 'vn' ? 'flag' : ctx.layer === 'world' ? 'globe' : 'people'))}${lensLabel}</span>
<h2>Hôm nay có gì mới?</h2><p>Radar so mọi bài và nỗi đau với sổ ghi nhớ. Bên trái chỉ có thứ lần đầu xuất hiện. Bên phải là thứ đã gặp trước đây và đang lớn dần, kèm số lần xuất hiện.</p></div>
<div class="fr-kpis"><div class="fr-k new"><b>${f.newPosts}</b><span>bài mới</span></div><div class="fr-k new"><b>${f.newPains}</b><span>nỗi đau mới</span></div>
<div class="fr-k up"><b>${f.risingPosts}</b><span>bài đang lên</span></div><div class="fr-k up"><b>${f.recurringPains}</b><span>nỗi đau lặp lại</span></div></div></div>
<div class="fr-cols"><div class="fr-col new"><h3>${raw(icon('flame'))}Mới hôm nay</h3><h5>Nỗi đau lần đầu gặp</h5><div class="fr-list">${
    f.newPainList.length
      ? f.newPainList.map((p) => html`<div class="fr-pain"><span class="fr-id">${p.id}</span><div><h4>${p.title}</h4><p>${p.detail}</p>${p.professions.length ? html`<div class="fr-sm">${p.professions.join(', ')}</div>` : ''}</div></div>`)
      : emptyCard('Chưa có nỗi đau mới trong phiên này.')
  }</div><h5>Bài mới nổi bật</h5><div class="fr-list">${
    f.newPostList.length
      ? f.newPostList.map((it) => html`<div class="fr-post"><div class="fr-pt">${it.sourceName} · ${platName(it.kind)}</div><b>${it.title}</b><div class="fr-pm">${
          metricsB(it.metrics, FB_METRICS.slice(0, 2).concat(X_METRICS.slice(0, 1)))}${extLink('fd-lk', it.url, 'Xem bài gốc')}</div></div>`)
      : emptyCard('Chưa có bài mới trong phiên này.')
  }</div></div>
<div class="fr-col up"><h3>${raw(icon('up'))}Đang lớn dần</h3><h5>Nỗi đau lặp lại qua nhiều phiên</h5><div class="fr-list">${
    f.recurringList.length
      ? f.recurringList.map((p) => html`<div class="fr-gp"><span class="fr-id">${p.id}</span><div class="fr-gm"><h4>${p.title}</h4><div class="fr-bar"><i style="width:${Math.max(8, Math.round((p.times / maxTimes) * 100))}%"></i></div><div class="fr-sm"><b>×${p.times}</b> lần xuất hiện, thấy đầu tiên ${p.firstSeen}${p.professions.length ? ` · ${p.professions.join(', ')}` : ''}</div></div></div>`)
      : emptyCard('Chưa có nỗi đau lặp lại. Mục này đầy dần khi sổ ghi nhớ có thêm ngày.')
  }${f.risingPostList.map((it) => html`<div class="fr-post up"><div class="fr-pt">${it.sourceName} · ${platName(it.kind)}</div><b>${it.title}</b><div class="fr-pm">${
    metricsB(it.metrics, FB_METRICS.slice(0, 2))}${it.rising ? html`<span class="fd-m">+${fmtInt(Math.max(0, itemComments(it) - it.rising.prevComments))} bình luận so với lần trước</span>` : ''}${extLink('fd-lk', it.url, 'Xem bài gốc')}</div></div>`)}</div></div></div></section>`;
}

// ── intro: toc + legend ─────────────────────────────────────────────────

export function introBlock(ctx: Ctx): Raw {
  const { s, pre, layer } = ctx;
  const t = sessionTotals(layer, s);
  const foreign = t.foreign;
  const toc: [string, IconName, string][] = [['fresh', 'flame', 'Mới hôm nay']];
  if (ctx.stats.length || layer !== 'world') toc.push(['groups', 'people', layer === 'nganh' ? `${ctx.stats.length} cộng đồng ngành nghề` : layer === 'world' ? `${ctx.stats.length} cộng đồng` : `${ctx.stats.length} nhóm Facebook`]);
  toc.push(['buy', 'cart', `${s.buySignals.length} tín hiệu mua`], ['insight', 'bulb', 'Tóm tắt định tính']);
  toc.push(['pages', 'flag', `${s.competitors.length} fanpage đối thủ`], ['ads', 'megaphone', `${t.ads} quảng cáo`]);
  if (s.trends.length) toc.push(['trends', 'globe', `${s.trends.length} xu hướng nước ngoài`]);
  toc.push(['x', 'globe', `${foreign} tin nước ngoài`], ['notes', 'info', 'Ghi chú dữ liệu']);
  const lg: [IconName, string][] = [
    ['chat', 'bình luận'], ['heart', 'lượt cảm xúc (thích, thả tim...)'], ['share', 'lượt chia sẻ'], ['clock', 'thời điểm đăng tính đến lúc quét'], ['eye', 'lượt xem'],
    ['repost', 'lượt đăng lại trên X'], ['bookmark', 'lượt lưu'], ['up', 'điểm Hacker News'], ['star', 'sao GitHub'],
  ];
  return html`<div class="fd-intro"><div class="fd-it"><div><h2>Dữ liệu gốc theo nguồn</h2><p>Mọi mục Radar thu được trong phiên này, sắp theo nguồn. Bấm "Xem bài gốc" để mở bài thật trên Facebook, X, Hacker News.</p></div><nav class="fd-toc">${
    toc.map(([id, ic, label]) => html`<a href="#${pre}-fd-${id}">${raw(icon(ic))}${label}</a>`)}</nav></div><div class="fd-lg"><b>Chú giải</b>${
    lg.map(([ic, label]) => html`<span>${raw(icon(ic))}${label}</span>`)}</div><div class="fd-lg b"><span><span class="fd-b buy">${raw(icon('cart'))}Có tín hiệu mua</span> có bình luận hỏi mua, hỏi giá, xin tài liệu</span><span><span class="fd-b top">${raw(icon('flame'))}Bài top</span> nằm trong bảng bài nổi bật của phiên quét</span><span><span class="fd-hb h4">${raw(icon('flame'))}Rất nóng</span> từ 100 bình luận · Nóng từ 50 · Ấm từ 20 · Yên dưới 20</span></div></div>`;
}

// ── section frame ───────────────────────────────────────────────────────

function secHead(ic: IconName, title: string, count: string, desc: string): Raw {
  return html`<div class="fd-hd"><span class="fd-ic">${raw(icon(ic))}</span><div><h3>${title}<span class="fd-cnt">${count}</span></h3><p>${desc}</p></div></div>`;
}

// ── communities ─────────────────────────────────────────────────────────

function communityBlock(ctx: Ctx, st: CommunityStat): Raw {
  const { c } = st;
  const best = st.hottest;
  const bars = [...st.items].filter((x) => itemComments(x) > 0).sort((a, b) => itemComments(b) - itemComments(a)).slice(0, 8);
  const members = c.members ?? c.followers;
  return html`<div class="fd-grp ${st.heat.cls}" id="${ctx.pre}-fd-g-${st.index}"><div class="fd-gs"><div class="fd-gtop"><div class="fd-gn">${c.name}</div>${
    c.url && safeUrl(c.url) !== '#' ? extLink('fd-btn ghost', c.url, 'Mở nhóm') : ''}</div>${
    members ? html`<div class="fd-mem">${raw(icon('people'))}<b>${fmtInt(members)}</b><span>${c.members ? 'thành viên' : 'người theo dõi'}</span></div>` : html`<div class="fd-mem none">Chưa có số thành viên</div>`}<div class="fd-heat"><span class="fd-hb ${st.heat.cls}">${raw(icon('flame'))}${st.heat.label}</span><span class="fd-meter">${
    [1, 2, 3, 4].map((n) => html`<i class="${n <= st.heat.bars ? 'on' : ''}"></i>`)}</span><em>mức nhiệt theo bài nhiều bình luận nhất</em></div>${
    c.summary ? html`<p class=fd-gsum>${c.summary}</p>` : ''}<div class="fd-gst"><div><b>${st.posts}</b><span>bài ghi nhận</span></div><div><b>${fmtInt(st.comments24)}</b><span>bình luận trong 24 giờ</span></div><div class="${st.buyPosts ? 'g' : ''}"><b>${st.buyPosts}</b><span>bài có tín hiệu mua</span></div></div>${
    best && itemComments(best) > 0 ? html`<div class="fd-gk">${raw(icon('flame'))}<div><small>Bài sôi nổi nhất</small><b>${best.title}</b><em>${fmtInt(itemComments(best))} bình luận</em></div></div>` : ''}${
    st.pain ? html`<div class="fd-gk pain">${raw(icon('target'))}<div><small>Nỗi đau khớp nhất (theo chủ đề các bài)</small><b>#${st.pain.rank} ${st.pain.title}</b></div></div>` : ''}${
    bars.length ? html`<div class="fd-mini"><div class="fd-mini-h">Bình luận theo bài <span>thanh dài nhất = bài sôi nổi nhất mọi nhóm hôm nay</span></div>${
      bars.map((it) => html`<div class="fd-mr" title="${it.title}"><span>${it.title}</span><i><u style="width:${st.maxComments > 0 ? Math.max(2, Math.round((itemComments(it) / st.maxComments) * 100)) : 0}%"></u></i><b>${fmtInt(itemComments(it))}</b></div>`)}</div>` : ''
  }</div><div class="fd-posts">${st.items.map((it) => postCard(ctx, it))}</div></div>`;
}

export function communitiesSection(ctx: Ctx): Raw {
  const { stats } = ctx;
  if (!stats.length && ctx.layer === 'world') return raw('');
  const members = stats.reduce((n, st) => n + (st.c.members ?? 0), 0);
  const noun = ctx.layer === 'nganh' ? 'cộng đồng ngành nghề' : 'nhóm Facebook';
  const title = ctx.layer === 'nganh' ? 'Cộng đồng ngành nghề' : 'Nhóm Facebook';
  const posts = stats.reduce((n, st) => n + st.posts, 0);
  return html`<section class="fd-sec " id="${ctx.pre}-fd-groups">${secHead('people', title, `${stats.length} ${ctx.layer === 'nganh' ? 'cộng đồng' : 'nhóm'} · ${posts} bài`,
    `Mỗi ${ctx.layer === 'nganh' ? 'cộng đồng' : 'nhóm'} một khung: hồ sơ ${ctx.layer === 'nganh' ? 'cộng đồng' : 'nhóm'} bên trái${members ? `, tổng ${fmtMembers(members)} thành viên` : ''}, từng bài bên phải. Xếp theo bài nhiều bình luận nhất.`)}${
    stats.length ? stats.map((st) => communityBlock(ctx, st)) : emptyCard(`Không có ${noun} trong phiên này.`)}</section>`;
}

// ── buy signals ─────────────────────────────────────────────────────────

const BUY_META: Record<string, { label: string; icon: IconName }> = {
  intent: { label: 'Ý định mua', icon: 'cart' },
  price: { label: 'Hỏi giá', icon: 'tag' },
  material: { label: 'Xin tài liệu', icon: 'doc' },
};

export function buySection(ctx: Ctx): Raw {
  const { s } = ctx;
  const byId = new Map(s.items.map((it) => [it.id, it]));
  const counts = (['intent', 'price', 'material'] as const).map((k) => ({ k, n: s.buySignals.filter((b) => b.type === k).length })).filter((x) => x.n > 0);
  return html`<section class="fd-sec fd-buyzone" id="${ctx.pre}-fd-buy">${secHead('cart', 'Tín hiệu mua', `${s.buySignals.length} bình luận`,
    'Bình luận cho thấy ý định mua, xin tài liệu hoặc hỏi học. Loại tín hiệu do Radar gắn theo từ khóa trong câu.')}${
    s.buySignals.length || s.sellerNote
      ? html`<div class="fd-chips">${counts.map((x) => html`<span class="fd-chip">${BUY_META[x.k].label} <b>${x.n}</b></span>`)}</div><div class="fd-buys">${
        s.buySignals.map((b) => {
          const it = b.itemId ? byId.get(b.itemId) : undefined;
          const meta = BUY_META[b.type] ?? BUY_META.intent;
          return html`<article class="fd-bq"><div class="fd-bqt"><span class="fd-bt">${raw(icon(meta.icon))}${meta.label}</span></div><blockquote>${b.text}</blockquote><div class="fd-bw">${raw(icon('pin'))}<span>${b.context}</span></div>${
            it ? html`<div class="fd-bin">${raw(icon('doc'))}<span>Trong bài: <b>${it.title}</b>${itemComments(it) ? ` · ${fmtInt(itemComments(it))} bình luận` : ''}</span></div>` : ''}<div class="fd-pf">${
            extLink('fd-btn green', b.url ?? it?.url, 'Xem bình luận gốc')}</div></article>`;
        })}${s.sellerNote ? html`<article class="fd-bq res"><div class="fd-bqt"><span class="fd-bt warn">${raw(icon('warn'))}Người bán tài khoản</span></div><p>${s.sellerNote}</p><div class="fd-bw">${raw(icon('info'))}<span>Cạnh tranh giá với người muốn mua gói</span></div></article>` : ''}</div>`
      : emptyCard('Không có tín hiệu mua trong phiên này.')}</section>`;
}

// ── qualitative summary ─────────────────────────────────────────────────

export function insightSection(ctx: Ctx): Raw {
  const { s, p } = ctx;
  const owner = p.owner;
  return html`<section class="fd-sec " id="${ctx.pre}-fd-insight">${secHead('bulb', 'Tóm tắt định tính', `${s.pains.length} nỗi đau · ${s.quotes.length} trích dẫn · ${s.ideas.length} cơ hội`,
    `Đọc từ ghi chú của phiên quét: nỗi đau, câu nói thật của cộng đồng, công cụ được nhắc, ý tưởng${owner ? ` cho ${owner}` : ''}.`)}${
    s.pains.length ? html`<h5 class="fd-sub">${raw(icon('target'))}Nỗi đau xếp hạng <span>thứ tự theo ghi chú, không có số đếm</span></h5><div class="fd-pains">${
      s.pains.map((x) => html`<article class="fd-pain"><b class="fd-rank">#${x.rank}</b><div><h4>${x.title}</h4><p>${x.detail}</p></div></article>`)}</div>` : ''}${
    s.quotes.length ? html`<h5 class="fd-sub">${raw(icon('quote'))}Trích dẫn nguyên văn <span>${s.quotes.length} câu</span></h5><div class="fd-quotes">${
      s.quotes.map((q) => html`<figure class="fd-q"><blockquote>${q.text}</blockquote><figcaption>${q.tag}</figcaption></figure>`)}</div>` : ''}${
    s.tools.length ? html`<h5 class="fd-sub">${raw(icon('trophy'))}Công cụ AI được nhắc <span>xếp hạng theo mức được nhắc, không có số đếm</span></h5><div class="fd-tiers">${
      s.tools.map((t) => html`<div class="fd-tier t${t.rank}"><span class="fd-tn">Hạng ${t.rank}</span><div class="fd-tc">${t.names.map((n) => html`<span>${n}</span>`)}</div>${
        t.note ? html`<em>${t.note}</em>` : t.rank === 4 ? html`<em>Ít được nhắc hơn</em>` : ''}</div>`)}</div>` : ''}${
    s.ideas.length ? html`<h5 class="fd-sub">${raw(icon('bulb'))}Cơ hội nội dung <span>${s.ideas.length} ý tưởng</span></h5><div class="fd-opps">${
      s.ideas.map((i) => html`<article class="fd-opp"><div class="fd-who">${i.channel}</div><h4>${i.title}</h4><ul>${i.evidence.map((e) => html`<li>${e}</li>`)}</ul><span class="fd-st">${statusLabel(i.status)}</span></article>`)}</div>` : ''}${
    !s.pains.length && !s.quotes.length && !s.ideas.length ? emptyCard('Không có dữ liệu.') : ''}</section>`;
}

// ── competitors ─────────────────────────────────────────────────────────

export function pagesSection(ctx: Ctx): Raw {
  const { s } = ctx;
  const featured = s.competitors.reduce((n, c) => n + c.postIds.length, 0);
  return html`<section class="fd-sec " id="${ctx.pre}-fd-pages">${secHead('flag', 'Fanpage đối thủ', `${s.competitors.length} trang · ${featured} bài nổi bật`,
    'Hồ sơ từng trang: đăng gì, bán gì, giá nếu công khai, bài có nhiều tương tác nhất.')}${
    s.competitors.length ? html`<div class="fd-profs">${s.competitors.map((c) => {
      const { top, others } = competitorPosts(s, c);
      return html`<article class="fd-prof"><div class="fd-ph"><span class="fd-av">${c.initials}</span><div><h4>${c.name}</h4><div class="fd-pm">${
        c.followers ? html`<span class="fd-m ">${raw(icon('people'))}<b>${fmtInt(c.followers)}</b> người theo dõi</span>` : ''}<span class=fd-m>${raw(icon('megaphone'))}${c.activeAds} quảng cáo đang chạy</span></div></div>${
        extLink('fd-btn ghost', c.url, 'Mở trang')}</div><div class="fd-kv"><span>${raw(icon('doc'))}Đăng gì</span><p>${c.posts}</p></div><div class="fd-kv"><span>${raw(icon('cart'))}Bán gì</span><p>${c.sells}</p></div><div class="fd-kv"><span>${raw(icon('star'))}Giá</span><p><b>${c.price}</b></p></div>${
        top ? html`<div class="fd-best"><small>${raw(icon('trophy'))}Bài nổi bật nhất trên trang</small><b>${top.title}</b><div class="fd-ms">${
          metricsB(top.metrics, [FB_METRICS[1], FB_METRICS[0], FB_METRICS[2]])}</div>${extLink('fd-btn', top.url, 'Xem bài gốc')}${
          others.length ? html`<ul class="fd-oth">${others.map((o) => html`<li><span>${o.title}</span><em>${[
            o.metrics.reactions ? `${fmtInt(o.metrics.reactions)} lượt cảm xúc` : '', o.metrics.comments ? `${fmtInt(o.metrics.comments)} bình luận` : '', o.metrics.shares ? `${fmtInt(o.metrics.shares)} lượt chia sẻ` : '',
          ].filter(Boolean).join(' · ')}</em></li>`)}</ul>` : ''}</div>` : ''}</article>`;
    })}</div>` : emptyCard('Không có fanpage đối thủ trong phiên này.')}</section>`;
}

// ── ads ─────────────────────────────────────────────────────────────────

const libraryUrl = (id: string): string => `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`;

function adCard(ad: AdView, maxDays: number, isLongest: boolean): Raw {
  const width = maxDays > 0 ? Math.max(2, Math.round((ad.daysRunning / maxDays) * 100)) : 2;
  const fmtIc: IconName = /video/i.test(ad.format) ? 'video' : 'image';
  return html`<article class="fd-ad"><div class="fd-ph"><span class="fd-av">${initialsOf(ad.advertiser)}</span><div><h4>${ad.advertiser}</h4><div class="fd-pt">${
    ad.otherAdIds.length ? html`<span class="fd-b cnt">${raw(icon('layers'))}${ad.otherAdIds.length + 1} quảng cáo đã lưu ID</span>` : ''}<span class="fd-b fun">${raw(icon('target'))}${ad.funnelLabel}</span>${ad.format && ad.format !== 'Không ghi' ? html`<span class="fd-b">${raw(icon(fmtIc))}${ad.format}</span>` : ''}${
    ad.audience ? html`<span class="fd-b job">${raw(icon('people'))}${ad.audience}</span>` : ''}${ad.sellsBook ? html`<span class="fd-b buy">${raw(icon('doc'))}Bán sách</span>` : ''}</div></div></div><div class="fd-prd">${ad.product}</div><blockquote>${ad.headline}</blockquote><div class="fd-days"><div class="fd-dl"><span>${raw(icon('star'))}Đang chạy</span><b>${ad.daysRunning} ngày</b>${
    isLongest ? html`<em>lâu nhất</em>` : ''}</div><i><u style="width:${width}%"></u></i><small>so với quảng cáo chạy lâu nhất (${maxDays} ngày)${ad.startDate ? ` · bắt đầu ${fmtDayMonth(ad.startDate)}` : ''}</small></div><div class="fd-akv"><div><span>Giá</span><b>${ad.price}</b></div><div><span>Phiên bản</span><b>${ad.versions ?? 'Không ghi'}</b></div><div class=w><span>Lời kêu gọi</span><b>${ad.cta}</b></div><div class=w><span>Trang đích</span><b>${ad.landing}</b></div></div>${
    ad.otherAdIds.length ? html`<div class="fd-xids"><small>Quảng cáo khác cùng nhà quảng cáo</small><ul>${ad.otherAdIds.map((id) => html`<li>${extLink('fd-lk', libraryUrl(id), `ID ${id}`)}</li>`)}</ul></div>` : ''}<div class="fd-pf">${
    extLink('fd-btn', ad.libraryUrl, 'Xem trong Ad Library')}</div></article>`;
}

function initialsOf(name: string): string {
  const words = name.replace(/[()[\],]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0][0] : words[0][0] + words[1][0]).toUpperCase();
}

export function adsSection(ctx: Ctx): Raw {
  const { s } = ctx;
  const ads = ctx.groups.ads.map((it) => it.ad).filter((a): a is AdView => !!a).sort((a, b) => b.daysRunning - a.daysRunning);
  const maxDays = ads[0]?.daysRunning ?? 0;
  return html`<section class="fd-sec " id="${ctx.pre}-fd-ads">${secHead('megaphone', 'Quảng cáo Meta Ad Library', `${ads.length} quảng cáo · ${s.otherAdvertisers.length} nhà quảng cáo khác`,
    'Quảng cáo đang chạy ở Việt Nam: sản phẩm, phễu bán hàng, số ngày đã chạy, số phiên bản, giá nếu công khai.')}${
    ads.length ? html`<h5 class="fd-sub">${raw(icon('grid'))}Thư viện quảng cáo <span>xếp theo số ngày đang chạy</span></h5><div class="fd-ads">${ads.map((a, i) => adCard(a, maxDays, i === 0))}</div>
<h5 class="fd-sub">${raw(icon('warn'))}Bảng so sánh quảng cáo <span>số ngày đang chạy tính đến ngày quét; Ad Library không công khai chi tiêu</span></h5><div class="fd-tw"><table class="fd-tbl"><thead><tr><th>#</th><th>Nhà quảng cáo</th><th>Sản phẩm</th><th>Phễu</th><th>Định dạng</th><th>Bắt đầu</th><th>Số ngày đang chạy</th><th>Phiên bản</th><th>Giá</th><th>Lời kêu gọi</th><th>Trang đích</th><th>Link</th></tr></thead><tbody>${
      ads.map((a, i) => html`<tr><td class="n">${i + 1}</td><td><b>${a.advertiser}</b></td><td>${a.product}</td><td><span class="fd-b fun">${a.funnelLabel}</span></td><td>${a.format}</td><td class="n">${fmtDayMonth(a.startDate)}</td><td><div class="fd-tb"><i><u style="width:${maxDays > 0 ? Math.max(2, Math.round((a.daysRunning / maxDays) * 100)) : 2}%"></u></i><b>${a.daysRunning}</b></div></td><td class="n">${a.versions ?? ''}</td><td class="nw">${a.price}</td><td>${a.cta}</td><td>${a.landing}</td><td>${extLink('fd-lk', a.libraryUrl, 'Ad Library')}</td></tr>`)}</tbody></table></div>`
      : emptyCard('Không có quảng cáo trong phiên này.')}${
    s.otherAdvertisers.length ? html`<h5 class="fd-sub">${raw(icon('megaphone'))}Nhà quảng cáo khác <span>thấy trên Ad Library, không có trong bảng số liệu</span></h5><div class="fd-others">${
      s.otherAdvertisers.map((o) => html`<article class="fd-oa"><span class="fd-av sm">${initialsOf(o.name)}</span><div><b>${o.name}</b><p>${o.note}</p>${o.since ? html`<span class=fd-m>${raw(icon('star'))}Chạy từ ${o.since}</span>` : ''}</div></article>`)}</div>` : ''}</section>`;
}

// ── foreign trends ──────────────────────────────────────────────────────

export function trendsSection(ctx: Ctx): Raw {
  const { s } = ctx;
  if (!s.trends.length) return raw('');
  return html`<section class="fd-sec " id="${ctx.pre}-fd-trends">${secHead('globe', 'Xu hướng nước ngoài chính', `${s.trends.length} xu hướng`,
    'Chủ đề đang lên ở X, Hacker News, YouTube mà cộng đồng Việt chưa bàn nhiều. Số là số tương tác lúc quét.')}<div class="fd-trs-g">${
    s.trends.map((t) => html`<article class="fd-tr"><b class="fd-trn">${t.rank}</b><div class=fd-big>${t.metricLabel}</div><div class=fd-bigs>${t.sourceLine}</div><h4>${t.title}</h4><div class=fd-trs>${t.subtitle}</div><p>${t.description}</p><div class=fd-why>${raw(icon('bulb'))}<span>${t.vnAngle}</span></div></article>`)}</div></section>`;
}

// ── X / Hacker News / YouTube-Web-GitHub ────────────────────────────────

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'trang gốc';
  }
}

function openLabel(it: ItemView): string {
  switch (it.kind) {
    case 'x': return 'Mở trên X';
    case 'hn': return 'Mở trên HN';
    case 'youtube': return 'Mở trên YouTube';
    case 'github': return 'Mở trên GitHub';
    case 'reddit': return 'Mở trên Reddit';
    case 'tiktok': return 'Mở trên TikTok';
    case 'threads': return 'Mở trên Threads';
    default: return `Mở trên ${hostLabel(it.url)}`;
  }
}

const PLAT: Partial<Record<ItemView['kind'], [string, string]>> = {
  x: ['x', 'X'], hn: ['hn', 'Hacker News'], youtube: ['yt', 'YouTube'], github: ['gh', 'GitHub'], reddit: ['', 'Reddit'], news: ['web', 'Web'], tiktok: ['', 'TikTok'], threads: ['', 'Threads'],
};

/** The metric the engagement bar compares: likes (X), points (HN/Reddit), stars (GitHub), views otherwise. */
function engagement(it: ItemView): { value: number; label: string } {
  const m = it.metrics;
  if (it.kind === 'github') return { value: m.stars ?? 0, label: 'sao so với tin cao nhất cùng loại' };
  if (it.kind === 'hn' || it.kind === 'reddit') return { value: m.points ?? 0, label: 'điểm so với tin cao nhất cùng loại' };
  if (it.kind === 'x') return { value: m.likes ?? 0, label: 'lượt thích so với tin cao nhất cùng loại' };
  return { value: m.views ?? m.likes ?? 0, label: 'lượt xem so với tin cao nhất cùng loại' };
}

function feedMetrics(it: ItemView): Raw[] {
  const m = it.metrics;
  const out: Raw[] = [];
  const add = (ic: IconName, text: string) => out.push(html`<span class="fd-m">${raw(icon(ic))}${text}</span>`);
  if (m.likes) add('heart', `${fmtInt(m.likes)} lượt thích`);
  if (m.reposts) add('repost', `${fmtInt(m.reposts)} lượt đăng lại`);
  if (m.saves) add('bookmark', `${fmtInt(m.saves)} lượt lưu`);
  if (m.quotes) add('chat', `${fmtInt(m.quotes)} lượt trích dẫn`);
  if (m.replies) add('chat', `${fmtInt(m.replies)} lượt trả lời`);
  if (m.views) add('eye', `${approxCount(m.views)} lượt xem`);
  if (m.points) add('up', `${fmtInt(m.points)} điểm`);
  if (m.comments) add('chat', `${fmtInt(m.comments)} bình luận`);
  if (m.stars) add('star', `${approxCount(m.stars)} sao`);
  if (m.reactions) add('heart', `${fmtInt(m.reactions)} lượt cảm xúc`);
  return out;
}

function feedCard(it: ItemView, max: number): Raw {
  const [cls, name] = PLAT[it.kind] ?? ['', it.kind];
  const eng = engagement(it);
  const when = it.postedAt ? fmtStamp(it.postedAt) || it.postedText || '' : it.postedText ?? '';
  const metrics = feedMetrics(it);
  const body = it.quote ? html`<blockquote>${it.quote}</blockquote>` : it.note ? html`<p>${it.note}</p>` : '';
  return html`<article class="fd-fc"><div class="fd-pt"><span class="fd-plat ${cls}">${name}</span>${it.hnUrl && it.kind !== 'hn' ? html`<span class="fd-plat hn">Hacker News</span>` : ''}${
    when ? html`<span class="fd-date">${raw(icon('clock'))}${when}</span>` : ''}</div>${it.theme ? html`<div class=fd-fg>${it.theme}</div>` : ''}<h4>${it.title}</h4>${body}<div class="fd-ms">${
    metrics.length ? metrics : html`<span class=fd-m none>Chưa có số tương tác</span>`}</div>${
    eng.value > 0 && max > 0 ? html`<div class="fd-eng"><i><u style="width:${Math.max(2, Math.round((eng.value / max) * 100))}%"></u></i><small>${eng.label}</small></div>` : ''}<div class="fd-pf">${
    extLink('fd-btn sm', it.url, openLabel(it))}${it.hnUrl && it.kind !== 'hn' ? extLink('fd-btn sm', it.hnUrl, 'Mở trên HN') : ''}</div></article>`;
}

function feedSection(ctx: Ctx, id: string, ic: IconName, title: string, desc: string, items: ItemView[]): Raw {
  const maxByKind = new Map<string, number>();
  for (const it of items) maxByKind.set(it.kind, Math.max(maxByKind.get(it.kind) ?? 0, engagement(it).value));
  const sorted = [...items].sort((a, b) => engagement(b).value - engagement(a).value);
  return html`<section class="fd-sec " id="${ctx.pre}-fd-${id}">${secHead(ic, title, `${items.length} mục`, desc)}${
    items.length ? html`<div class="fd-fcs">${sorted.map((it) => feedCard(it, maxByKind.get(it.kind) ?? 0))}</div>` : emptyCard('Không có dữ liệu.')}</section>`;
}

export const xSection = (ctx: Ctx): Raw => feedSection(ctx, 'x', 'globe', 'X', 'Bài trên X: số lượt thích, đăng lại, lưu, lượt xem đúng như hiển thị lúc quét.', ctx.groups.x);
export const hnSection = (ctx: Ctx): Raw => feedSection(ctx, 'hn', 'up', 'Hacker News', 'Tin trên trang nhất Hacker News: điểm bình chọn và số bình luận.', ctx.groups.hn);
export const webSection = (ctx: Ctx): Raw => feedSection(ctx, 'yt', 'eye', 'YouTube, Web, GitHub', 'Video, bài báo và kho mã liên quan đến các xu hướng.', ctx.groups.web);

// ── notes ───────────────────────────────────────────────────────────────

export function notesSection(ctx: Ctx): Raw {
  const notes = ctx.s.dataNotes;
  return html`<section class="fd-sec " id="${ctx.pre}-fd-notes">${secHead('info', 'Ghi chú về dữ liệu', `${notes.length} ghi chú`, 'Giới hạn của lần quét này, để đọc số liệu cho đúng.')}${
    notes.length ? html`<ul class="fd-notes">${notes.map((n) => html`<li>${raw(icon('info'))}<span>${n}</span></li>`)}</ul>` : emptyCard('Không có ghi chú.')}</section>`;
}

/** The whole ".fd" block of one session, in the original order. */
export function sharedBlock(ctx: Ctx): Raw {
  return html`<div class="fd">${freshSection(ctx)}${introBlock(ctx)}${communitiesSection(ctx)}${buySection(ctx)}${insightSection(ctx)}${pagesSection(ctx)}${adsSection(ctx)}${trendsSection(ctx)}${
    cat([xSection(ctx), hnSection(ctx), webSection(ctx)])}${notesSection(ctx)}</div>`;
}

