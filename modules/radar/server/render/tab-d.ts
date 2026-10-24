/** Tab D: "Bảng cơ hội" — left sidebar and kanban columns that differ per layer. */

import type { AdView, ItemView, LayerKey, PainView, TrendView } from '../types.js';
import { fmtInt } from '../util.js';
import { approxCount, freshStats, itemComments, professionStats } from './derive.js';
import { Raw, cat, html, raw, textLink } from './html.js';
import { type Ctx, sharedBlock, statusLabel } from './shared.js';

interface Column { title: string; color: string; cards: Raw[]; }

const ROSE = '#e11d48';
const VIOLET = '#7c3aed';
const BLUE = '#2563eb';
const GREEN = '#059669';
const AMBER = '#d97706';

const srcLabel = (layer: LayerKey): string => (layer === 'nganh' ? 'Cộng đồng nghề' : layer === 'world' ? 'Nguồn nước ngoài' : 'Nhóm FB');

function painCard(ctx: Ctx, p: PainView): Raw {
  const byId = new Map(ctx.s.items.map((it) => [it.id, it]));
  const items = p.itemIds.map((id) => byId.get(id)).filter((x): x is ItemView => !!x).slice(0, 3);
  return html`<div class="cd"><div class="ti"><span class="num">#${p.rank}</span>${p.title}</div><p>${p.detail}</p>${
    items.length ? html`<ul>${items.map((it) => html`<li>${it.title} <em>${[itemComments(it) ? `${fmtInt(itemComments(it))} bình luận` : '', it.sourceName].filter(Boolean).join(', ')}</em>${textLink('lk', it.url, 'xem')}</li>`)}</ul>` : ''}<div class="ft"><span class="s fb">${srcLabel(ctx.layer)}</span></div></div>`;
}

const quoteCard = (text: string, tag: string): Raw => html`<div class="cd q"><p>“${text}”</p><div class="ft"><span class="s tag">${tag}</span><span class="s fb">Trích bình luận</span></div></div>`;

function buyCards(ctx: Ctx): Raw[] {
  const byId = new Map(ctx.s.items.map((it) => [it.id, it]));
  const cards = ctx.s.buySignals.map((b) => {
    const it = b.itemId ? byId.get(b.itemId) : undefined;
    return html`<div class="cd"><div class="ti">“${b.text}”</div><p>${b.context}</p><div class="ft"><span class="s fb">${srcLabel(ctx.layer)}</span>${textLink('lk', b.url ?? it?.url, 'xem')}</div></div>`;
  });
  if (ctx.s.sellerNote) cards.push(html`<div class="cd"><div class="ti">Người bán tài khoản</div><p>${ctx.s.sellerNote}</p></div>`);
  return cards;
}

function ideaCards(ctx: Ctx): Raw[] {
  return ctx.s.ideas.map((i) => html`<div class="cd"><div class="who">${i.channel}</div><div class="ti">${i.title}</div><ul>${i.evidence.map((e) => html`<li>${e}</li>`)}</ul><div class="ft"><span class="st">${statusLabel(i.status)}</span></div></div>`);
}

function kindLabel(it: ItemView): string {
  switch (it.kind) {
    case 'x': return 'X';
    case 'hn': return 'HN';
    case 'youtube': return 'YouTube';
    case 'github': return 'GitHub';
    case 'reddit': return 'Reddit';
    default:
      try { return new URL(it.url).hostname.replace(/^www\./, ''); } catch { return 'Nguồn'; }
  }
}

function trendCards(ctx: Ctx, trends: TrendView[]): Raw[] {
  const byId = new Map(ctx.s.items.map((it) => [it.id, it]));
  return trends.map((t) => {
    const items = t.itemIds.map((id) => byId.get(id)).filter((x): x is ItemView => !!x);
    return html`<div class="cd"><div class=big>${t.metricLabel}</div><div class="ti">${t.title}</div><p>${t.vnAngle}</p><div class="ft"><span class="s x">${t.sourceLine.split(',')[0]}</span>${items.map((it) => textLink('lk', it.url, kindLabel(it)))}</div></div>`;
  });
}

function adGroupCards(ctx: Ctx): Raw[] {
  const ads = ctx.groups.ads.map((it) => it.ad).filter((a): a is AdView => !!a);
  const total = ads.length;
  const names = (list: AdView[]): string => list.map((a) => `${a.advertiser} (${a.daysRunning} ngày)`).join(', ');
  const group = (title: string, list: AdView[], hi = false): Raw | null => list.length
    ? html`<div class="cd ${hi ? 'hi' : ''}"><div class="ti">${title}</div><p>${list.length}/${total} quảng cáo: ${names(list)}</p><div class="ft"><span class="s ad">Ad Library</span>${list.map((a) => textLink('lk', a.libraryUrl, 'Quảng cáo'))}</div></div>`
    : null;
  const cards = [
    group('Zoom free + quà', ads.filter((a) => a.funnel === 'zoom')),
    group('Khóa học theo nghề', ads.filter((a) => a.segment === 'profession')),
    group('Quảng cáo sách', ads.filter((a) => a.sellsBook), true),
    group('Bán qua web', ads.filter((a) => a.funnel === 'web' && !a.sellsBook)),
  ].filter((c): c is Raw => !!c);
  for (const c of ctx.s.competitors) {
    cards.push(html`<div class="cd"><div class="ti">${c.name}</div><p>${c.posts}. ${c.sells}</p><div class="ft"><span class="s ad">Fanpage</span>${textLink('lk', c.url, 'Trang')}</div></div>`);
  }
  return cards;
}

function itemCards(items: ItemView[], limit = 8): Raw[] {
  const weight = (it: ItemView): number => it.metrics.likes ?? it.metrics.points ?? it.metrics.stars ?? it.metrics.views ?? 0;
  return [...items].sort((a, b) => weight(b) - weight(a)).slice(0, limit).map((it) => {
    const big = it.metrics.likes ? `${fmtInt(it.metrics.likes)} lượt thích` : it.metrics.points ? `${fmtInt(it.metrics.points)} điểm` : it.metrics.stars ? `${approxCount(it.metrics.stars)} sao` : '';
    return html`<div class="cd">${big ? html`<div class=big>${big}</div>` : ''}<div class="ti">${it.title}</div>${it.note ? html`<p>${it.note}</p>` : it.quote ? html`<p>${it.quote}</p>` : ''}<div class="ft"><span class="s x">${it.sourceName}</span>${textLink('lk', it.url, kindLabel(it))}${it.hnUrl ? textLink('lk', it.hnUrl, 'HN') : ''}</div></div>`;
  });
}

function columnsFor(ctx: Ctx): Column[] {
  const { s, p } = ctx;
  const owner = p.owner || 'bạn';
  if (ctx.layer === 'nganh') {
    const profs = professionStats(s);
    return [
      { title: 'Nỗi đau theo nghề', color: ROSE, cards: [...s.pains.map((x) => painCard(ctx, x)), ...s.quotes.map((q) => quoteCard(q.text, q.tag))] },
      {
        title: 'Nỗi sợ bị thay thế', color: VIOLET,
        cards: s.fears.map((f) => html`<div class="cd q"><p>“${f.text}”</p><div class="ft"><span class="s tag">${f.profession}</span>${textLink('lk', f.url, 'xem')}</div></div>`),
      },
      {
        title: 'Ngành nào nóng', color: BLUE,
        cards: profs.map((x) => html`<div class="cd"><div class="big">${fmtInt(x.comments)}</div><div class="ti">${x.p.name}</div><p>${x.items.length} bài về AI, ${fmtInt(x.comments)} bình luận</p></div>`),
      },
      { title: 'Tín hiệu mua', color: GREEN, cards: buyCards(ctx) },
      { title: `Ý tưởng cho ${owner}`, color: AMBER, cards: ideaCards(ctx) },
    ];
  }
  if (ctx.layer === 'world') {
    return [
      { title: 'Xu hướng nước ngoài', color: VIOLET, cards: trendCards(ctx, s.trends) },
      { title: 'Tin nổi bật trên X', color: ROSE, cards: itemCards(ctx.groups.x) },
      { title: 'Hacker News & Reddit', color: BLUE, cards: itemCards(ctx.groups.hn) },
      { title: 'YouTube, GitHub', color: GREEN, cards: itemCards(ctx.groups.web) },
      { title: 'Ý tưởng nội dung', color: AMBER, cards: ideaCards(ctx) },
    ];
  }
  const cols: Column[] = [
    { title: 'Nỗi đau', color: ROSE, cards: [...s.pains.map((x) => painCard(ctx, x)), ...s.quotes.map((q) => quoteCard(q.text, q.tag))] },
    { title: 'Tín hiệu mua', color: GREEN, cards: buyCards(ctx) },
    { title: 'Đối thủ làm gì', color: BLUE, cards: adGroupCards(ctx) },
  ];
  if (s.trends.length) cols.push({ title: 'Xu hướng nước ngoài', color: VIOLET, cards: trendCards(ctx, s.trends) });
  cols.push({ title: 'Ý tưởng nội dung', color: AMBER, cards: ideaCards(ctx) });
  return cols;
}

function sidebar(ctx: Ctx): Raw {
  const { s, p, pre } = ctx;
  const f = freshStats(s);
  const short = p.dateLabel.slice(0, 5);
  const groupsTitle = ctx.layer === 'nganh' ? 'CỘNG ĐỒNG NGÀNH NGHỀ' : ctx.layer === 'world' ? 'NGUỒN' : 'NHÓM FACEBOOK';
  const link = (id: string, label: string, count?: number | string): Raw => html`<a href="#${pre}-fd-${id}">${label}${count !== undefined ? html`<em>${count}</em>` : ''}</a>`;
  return html`<nav class="sb"><div class="ws"><b>R</b>Radar Cộng Đồng AI</div>
<a class="on" href="#${pre}-top">Bảng cơ hội ${short}</a>${link('fresh', 'Mới hôm nay', f.newPosts)}${link('fresh', 'Đang lớn dần', f.recurringPains + f.risingPosts)}${link('insight', 'Tóm tắt')}${
    ctx.stats.length ? html`<h4>${groupsTitle}</h4>${ctx.stats.map((st) => html`<a href="#${pre}-fd-g-${st.index}"><span class="dot ${st.heat.cls}"></span>${st.c.name}<em>${st.c.members ? fmtInt(st.c.members) : ''}</em></a>`)}` : ''}${
    ctx.layer === 'vn' ? html`<h4>ĐỐI THỦ</h4>${link('pages', 'Fanpage đối thủ', s.competitors.length)}${link('ads', 'Quảng cáo', ctx.groups.ads.length)}${link('buy', 'Tín hiệu mua', s.buySignals.length)}`
      : html`<h4>TÍN HIỆU</h4>${link('buy', 'Tín hiệu mua', s.buySignals.length)}`}${
    ctx.layer !== 'nganh' || ctx.groups.x.length + ctx.groups.hn.length + ctx.groups.web.length ? html`<h4>NƯỚC NGOÀI</h4>${s.trends.length ? link('trends', 'Xu hướng chính', s.trends.length) : ''}${link('x', 'X', ctx.groups.x.length)}${link('hn', 'Hacker News', ctx.groups.hn.length)}${link('yt', 'YouTube, Web, GitHub', ctx.groups.web.length)}` : ''}
<h4>KHÁC</h4>${link('notes', 'Ghi chú dữ liệu')}</nav>`;
}

export function tabDSession(ctx: Ctx, on: boolean): Raw {
  const { s, p } = ctx;
  const cols = columnsFor(ctx);
  const owner = p.owner || 'bạn';
  const lens = ctx.multi ? s.label : `Lớp ${p.layerLabel}`;
  const hint = ctx.layer === 'nganh'
    ? `Đọc từ trái sang phải: nỗi đau của từng nghề khi dùng AI, nỗi sợ bị thay thế, ngành nào đang nóng, tín hiệu mua, rồi ý tưởng cho ${owner}. Mỗi thẻ có link nguồn.`
    : ctx.layer === 'world'
      ? `Đọc từ trái sang phải: xu hướng đang lên ở nước ngoài, tin nổi bật trên X, Hacker News và Reddit, YouTube và GitHub, rồi ý tưởng cho ${owner}. Mỗi thẻ có link nguồn nhỏ.`
      : `Đọc từ trái sang phải: nỗi đau và tín hiệu mua ngoài cộng đồng, đối thủ đang làm gì${s.trends.length ? ', xu hướng sắp về' : ''}, rồi ý tưởng cho ${owner}. Mỗi thẻ có link nguồn nhỏ; chi tiết từng nguồn ở thanh bên trái.`;
  return html`<div class="sv${on ? ' on' : ''}" data-s="${s.key}">${sidebar(ctx)}
<main class="mn" id="${ctx.pre}-top"><div class="ic">◎</div><h1>Bảng cơ hội, ${p.dateLabel} · ${lens}</h1>
<div class="props"><span>Phiên quét</span><b>${s.scan.when}</b><span>Nguồn</span><b>${s.scan.sources}</b>
<span>Bài top</span><b>${s.scan.top}</b></div>
<div class="co"><span>💡</span><div>${hint}</div></div>
<div class="kb" style="--n:${cols.length}">${cols.map((c) => html`<div class="kc"><div class="kh"><i style="background:${raw(c.color)}"></i>${c.title}<span>${c.cards.length}</span></div>${c.cards}</div>`)}</div>
${sharedBlock(ctx)}
</main></div>`;
}

export const tabDSessions = (ctxs: Ctx[]): Raw => cat(ctxs.map((c, i) => tabDSession(c, i === 0)));
