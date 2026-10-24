/** Tab B: "Bản đồ nhiệt chủ đề" — topic × community heatmap with the click-through side panel. */

import type { ItemView } from '../types.js';
import { fmtInt } from '../util.js';
import {
  type Heat, buildHeat, groupItems, heatSummary, itemColumnLabel, itemComments, metricsText, fmtPosted,
} from './derive.js';
import { Raw, cat, html, jsonForScript, raw, safeUrl } from './html.js';
import { type Ctx, sharedBlock } from './shared.js';

const GRADIENT_ORANGE = 'linear-gradient(90deg,rgba(234,88,12,.12),rgba(234,88,12,1))';
const GRADIENT_TEAL = 'linear-gradient(90deg,rgba(13,148,136,.15),rgba(13,148,136,1))';

interface PanelItem {
  kind: 'post' | 'buy' | 'page' | 'ad' | 'foreign';
  col: string;
  title: string;
  body: string;
  nums: string;
  c: number;
  url: string;
  buy: boolean;
  t: string[];
}

const cleanUrl = (u: string | undefined): string => (safeUrl(u) === '#' ? '' : (u as string));

/** The JSON the side panel script reads. */
export function panelPayload(ctx: Ctx, heat: Heat): { bando: unknown } {
  const { s, p } = ctx;
  const groups = groupItems(ctx.layer, s);
  const communityIds = new Set(groups.community.map((it) => it.id));
  const pageIds = new Set(groups.pages.map((it) => it.id));
  const adIds = new Set(groups.ads.map((it) => it.id));
  const byId = new Map(s.items.map((it) => [it.id, it]));
  const itemToPanel = (it: ItemView): PanelItem => {
    const nums = [metricsText(it.metrics), fmtPosted(it, p.generatedAt)].filter(Boolean).join(' · ');
    const kind: PanelItem['kind'] = communityIds.has(it.id) ? 'post' : pageIds.has(it.id) ? 'page' : adIds.has(it.id) ? 'ad' : 'foreign';
    return {
      kind,
      col: itemColumnLabel(it, heat.columns),
      title: it.title,
      body: it.ad ? `${it.ad.product}, ${it.ad.funnelLabel}` : (it.note ?? ''),
      nums,
      c: itemComments(it) || (it.metrics.likes ?? it.metrics.points ?? 0),
      url: cleanUrl(it.url),
      buy: it.buy,
      t: it.topics,
    };
  };
  const items: PanelItem[] = s.items.map(itemToPanel);
  for (const b of s.buySignals) {
    const it = b.itemId ? byId.get(b.itemId) : undefined;
    items.push({
      kind: 'buy', col: it ? itemColumnLabel(it, heat.columns) : '', title: `“${b.text}”`, body: b.context, nums: '', c: it ? itemComments(it) : 0,
      url: cleanUrl(b.url ?? it?.url), buy: true, t: it?.topics ?? [],
    });
  }
  return {
    bando: {
      items,
      topics: Object.fromEntries(s.topics.map((t) => [t.key, t.label])),
      pains: s.pains.map((x) => ({ title: x.title, detail: x.detail, i: x.rank, t: x.topics })),
      quotes: s.quotes.map((q) => ({ text: q.text, t: q.topics })),
      first: heat.first,
    },
  };
}

function heatTable(heat: Heat): Raw {
  const { columns, rows } = heat;
  // Platform-only heatmaps (world) count items, not Facebook comments.
  const onlyAgg = columns.length > 0 && columns.every((c) => c.agg);
  return html`<table><colgroup><col style="width:150px">${columns.map(() => html`<col>`)}</colgroup><thead><tr><th></th>${
    columns.map((c) => html`<th><span>${c.label}</span></th>`)}</tr></thead><tbody>${
    rows.map((r) => html`<tr><th class="rl" data-k="${r.topic.key}"><span>${r.topic.label}</span><em>${onlyAgg ? `${r.cells.reduce((n, c) => n + (c?.posts ?? 0), 0)} mục` : `${fmtInt(r.total)} bình luận`}</em></th>${
      r.cells.map((cell, i) => {
        if (!cell) return html`<td class="z"></td>`;
        const col = columns[i];
        if (col.agg) {
          const cls = heat.tealAgg ? 'h o' : 'h';
          return html`<td class="${cls}" data-k="${r.topic.key}" data-c="${col.label}" style="--a:${cell.alpha.toFixed(2)}"><b>${cell.posts}</b><small>${heat.tealAgg ? 'mục' : 'bài'}</small></td>`;
        }
        if (cell.comments === 0) return html`<td class="h" data-k="${r.topic.key}" data-c="${col.label}" style="--a:${cell.alpha.toFixed(2)}"><b>${cell.posts}</b><small>bài</small></td>`;
        return html`<td class="h" data-k="${r.topic.key}" data-c="${col.label}" style="--a:${cell.alpha.toFixed(2)}"><b>${fmtInt(cell.comments)}</b><small>${cell.posts} bài</small></td>`;
      })}</tr>`)}</tbody></table>`;
}

function heading(ctx: Ctx): Raw {
  const { p, s } = ctx;
  const em = ctx.multi ? s.label : `Lớp ${p.layerLabel} · ${p.slotLabel}`;
  return html`<header><h1>Bản đồ nhiệt chủ đề <span>${p.dateLabel}</span><em>${em}</em></h1><div class="kp">${heatSummary(ctx.layer, s)}</div></header>`;
}

export function tabBSession(ctx: Ctx, on: boolean): Raw {
  const { s } = ctx;
  const heat = buildHeat(ctx.layer, s);
  const hasAgg = heat.columns.some((c) => c.agg) && heat.tealAgg;
  const fbCount = ctx.stats.length;
  const legend = ctx.layer === 'nganh'
    ? html`<span>Cộng đồng nghề: tổng bình luận các bài cùng chủ đề <i style="background:${GRADIENT_ORANGE}"></i></span>`
    : html`<span>${ctx.layer === 'world' ? 'Nền tảng: số mục' : 'Nhóm FB: tổng bình luận các bài cùng chủ đề'} <i style="background:${ctx.layer === 'world' ? GRADIENT_TEAL : GRADIENT_ORANGE}"></i></span>${
      hasAgg && ctx.layer !== 'world' ? html`<span>Đối thủ, nước ngoài: số mục <i style="background:${GRADIENT_TEAL}"></i></span>` : ''}`;
  const rank = html`<div class="rk"><h4>Xếp hạng chủ đề theo tổng bình luận ở ${fbCount} ${ctx.layer === 'nganh' ? 'cộng đồng' : 'nhóm'}</h4>${
    heat.ranking.map((r) => html`<div class="rr" data-k="${r.topic.key}"><span>${r.topic.label}</span><i style="width:${r.pct}%"></i><b>${fmtInt(r.total)}</b></div>`)}</div>`;
  const body = s.topics.length
    ? html`<div class="lay"><div class="card m">
<div class="lg">${legend}<span>Bấm một ô hoặc tên chủ đề để xem bài, nỗi đau, trích dẫn.</span></div>
${heatTable(heat)}
<p class="hint">Chủ đề do Radar gắn theo từ khóa trong tiêu đề, một bài có thể thuộc nhiều chủ đề. Bài ngoài 24h không cộng bình luận. Số bình luận đúng như hiển thị trên nền tảng gốc lúc quét.</p>
${heat.ranking.length ? rank : ''}</div>
<aside class="card side"></aside></div>`
    : html`<div class="lay"><div class="card m"><p class="hint">Chưa có chủ đề nào được cấu hình cho lớp này.</p></div><aside class="card side"></aside></div>`;
  return html`<div class="sv${on ? ' on' : ''}" data-s="${s.key}"><div class="w">${heading(ctx)}
${body}
${sharedBlock(ctx)}</div><script type="application/json" class="pl">${raw(jsonForScript(panelPayload(ctx, heat)))}</script></div>`;
}

export function tabBSessions(ctxs: Ctx[]): Raw {
  return cat(ctxs.map((c, i) => tabBSession(c, i === 0)));
}

/** Side-panel behaviour of the original, driven by the embedded JSON. */
export const PANEL_SCRIPT = `window.initVariant=(function(prev){return function(root,P){if(prev)prev(root,P);if(!P||!P.bando)return;P=P.bando;var side=root.querySelector('.side');if(!side)return;
function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function safe(u){return /^https?:\\/\\//i.test(u||'')?u:''}
function show(k,col){var its=P.items.filter(function(i){return i.t.indexOf(k)>=0&&(!col||i.col===col)});its.sort(function(a,b){return (b.c||0)-(a.c||0)});
var h='<h2>'+esc(P.topics[k])+'</h2><div class="sub">'+(col?esc(col)+' · ':'Tất cả nguồn · ')+its.length+' mục'+(col?' · <a href="#" class="all-src">xem mọi nguồn</a>':'')+'</div>';
P.pains.forEach(function(p){if(p.t.indexOf(k)>=0)h+='<div class="pi"><b>Nỗi đau #'+p.i+': '+esc(p.title)+'</b><br>'+esc(p.detail)+'</div>'});
P.quotes.forEach(function(q){if(q.t.indexOf(k)>=0)h+='<div class="qu">“'+esc(q.text)+'”</div>'});
var KN={post:'Bài nhóm',buy:'Tín hiệu mua',page:'Fanpage',ad:'Quảng cáo',foreign:'Nước ngoài'};
its.forEach(function(i){h+='<div class="ii"><b>'+esc(i.title)+'</b>'+(i.body?'<p>'+esc(i.body)+'</p>':'')+'<div class="m"><span class="k'+(i.kind==='buy'||i.buy?' buy':'')+'">'+KN[i.kind]+(i.buy&&i.kind==='post'?', có tín hiệu mua':'')+'</span>'+(i.col&&i.kind!=='foreign'?'<span class="k">'+esc(i.col)+'</span>':'')+esc(i.nums)+(safe(i.url)?'<a class="xem" target="_blank" rel="noopener" href="'+esc(safe(i.url))+'">Xem bài gốc ↗</a>':'')+'</div></div>'});
if(!its.length)h+='<p class="hint">Không có mục nào.</p>';
side.innerHTML=h;var a=side.querySelector('.all-src');if(a)a.onclick=function(e){e.preventDefault();e.stopPropagation();show(k)};
root.querySelectorAll('td.sel').forEach(function(t){t.classList.remove('sel')});
if(col)root.querySelectorAll('td[data-k="'+k+'"]').forEach(function(t){if(t.dataset.c===col)t.classList.add('sel')});}
root.querySelectorAll('td.h').forEach(function(t){t.onclick=function(){show(t.dataset.k,t.dataset.c)}});
root.querySelectorAll('th.rl,.rr').forEach(function(t){t.onclick=function(){show(t.dataset.k)}});
if(P.first)show(P.first);else side.innerHTML='<p class="hint">Không có dữ liệu.</p>';};})(window.initVariant);
`;

