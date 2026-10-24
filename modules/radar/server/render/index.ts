/**
 * Renderer: ReportPayload / IndexPayload → standalone HTML documents that
 * look like the original Radar Cộng Đồng AI pages. Pure functions, no I/O.
 * OWNER: renderer agent.
 */

import type { IndexLayerCard, IndexPayload, LayerKey, RenderLinks, ReportPayload } from '../types.js';
import { fmtInt } from '../util.js';
import { CSS_B, CSS_C_NGANH, CSS_C_VN, CSS_D, CSS_INDEX, CSS_SHELL } from './css.js';
import { Raw, esc, html, raw } from './html.js';
import { type IconName, iconSized } from './icons.js';
import { makeCtx } from './shared.js';
import { PANEL_SCRIPT, tabBSessions } from './tab-b.js';
import { tabCSessions } from './tab-c.js';
import { tabDSessions } from './tab-d.js';

const FONT_LINKS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap" rel="stylesheet">';

function documentOf(title: string, css: string, body: Raw | string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONT_LINKS}<style>${css}</style></head>${body}</html>`;
}

// ── index ───────────────────────────────────────────────────────────────

const THEMES: Record<LayerKey, { acc: string; soft: string; ink: string; from: string; to: string; icon: IconName }> = {
  vn: { acc: '#ea580c', soft: '#fff7ed', ink: '#9a3412', from: '#f97316', to: '#c2410c', icon: 'flag' },
  world: { acc: '#6366f1', soft: '#eef2ff', ink: '#3730a3', from: '#818cf8', to: '#4338ca', icon: 'globe' },
  nganh: { acc: '#0d9488', soft: '#f0fdfa', ink: '#115e59', from: '#2dd4bf', to: '#0f766e', icon: 'people' },
};

/** "07:00" → "7h", "20:30" → "20h30". */
function shortTime(time: string): string {
  const [h, m] = time.split(':');
  const hour = String(Number(h));
  return m && Number(m) !== 0 ? `${hour}h${m}` : `${hour}h`;
}

function layerCard(card: IndexLayerCard, links: RenderLinks): Raw {
  const t = THEMES[card.key];
  const latest = card.latest;
  const style = `--acc:${t.acc};--soft:${t.soft};--ink:${t.ink}`;
  const body = latest
    ? html`<div class="dt">${latest.dateLabel} · ${latest.sources} nguồn · ${latest.posts} bài · ${fmtInt(latest.comments)} bình luận</div><div class=kp><div class="k"><b>${latest.newPosts}</b><span>bài mới</span></div><div class="k"><b>${latest.newPains}</b><span>nỗi đau mới</span></div><div class="k"><b>${latest.recurringPains}</b><span>nỗi đau lặp lại</span></div></div><ul class=pl>${
      latest.topPains.map((p) => html`<li><i class="${p.isNew ? 'dn' : 'dg'}"></i>${p.title}${p.isNew ? '' : html`<em>×${p.times}</em>`}</li>`)}</ul><a class="go" href="${links.report(latest.date, card.key)}" target="_top" data-radar-nav="${links.report(latest.date, card.key)}">Mở dashboard <span>→</span></a>`
    : html`<div class="none">Chưa có báo cáo. Bản đầu tiên sẽ xuất hiện sau phiên ${shortTime(card.time)}.</div>`;
  return html`<article class="cd${latest ? '' : ' off'}" style="${style}"><div class="ch" style="background:linear-gradient(135deg,${t.from},${t.to})"><div class="ci">${raw(iconSized(t.icon, 26))}</div><div><span class="hr">Phiên ${shortTime(card.time)} mỗi ngày</span><h2>${card.label}</h2></div></div><div class="cb"><p class="ds">${card.description}</p>${body}</div></article>`;
}

/** The index page: hero, three layer cards, archive by day. */
export function renderIndex(payload: IndexPayload, links: RenderLinks): string {
  const time = (k: LayerKey): string => shortTime(payload.layers.find((l) => l.key === k)?.time ?? '');
  const hero = payload.layers.length === 3
    ? `Radar đọc cộng đồng AI Việt Nam lúc ${time('vn')}, thế giới lúc ${time('world')} và các cộng đồng ngành nghề lúc ${time('nganh')}. Bài và nỗi đau đã báo sẽ không hiện lại như mới, chỉ được nhắc khi đang lớn dần.`
    : 'Radar đọc cộng đồng AI Việt Nam, thế giới và các cộng đồng ngành nghề mỗi ngày. Bài và nỗi đau đã báo sẽ không hiện lại như mới, chỉ được nhắc khi đang lớn dần.';
  const body = html`<body>
<header class="hero"><div class="wrap"><div class="brand"><i>R</i>Radar Cộng Đồng AI</div>
<h1>Ba ống kính, mỗi ngày một lần, <em>chỉ thứ mới</em>.</h1>
<p>${hero}</p>
<div class="upd"><b></b>${payload.updatedLabel ? `Cập nhật gần nhất: ${payload.updatedLabel}` : 'Chưa có báo cáo nào'}</div></div></header>
<main class="wrap"><section class="cards">${payload.layers.map((c) => layerCard(c, links))}</section>
<div class="legend"><span><i class="dn"></i>Nỗi đau lần đầu xuất hiện</span><span><i class="dg"></i>Nỗi đau lặp lại, kèm số lần</span></div>
<h3>Lưu trữ theo ngày</h3><p class="sub">Mỗi ngày tối đa ba báo cáo, mỗi lớp một báo cáo.</p>
<section class="arch">${payload.archive.map((day) => html`<div class="row"><div class="day"><b>${day.day}</b><span>${day.weekday}<br>${day.monthLabel}</span></div><div class="chips">${
    day.layers.map((l) => {
      const t = THEMES[l.key];
      const label = `${shortTime(l.time)} ${l.label}`;
      if (l.newPosts === null) return html`<span class="chip ghost">${raw(iconSized(t.icon, 15))}${label}</span>`;
      const href = links.report(day.date, l.key);
      return html`<a class="chip" style="--acc:${t.acc};--soft:${t.soft};--ink:${t.ink}" href="${href}" target="_top" data-radar-nav="${href}">${raw(iconSized(t.icon, 15))}<b>${label}</b><em>${l.newPosts} bài mới</em></a>`;
    })}</div></div>`)}</section>
<footer>Radar Cộng Đồng AI · nghiên cứu thị trường${payload.owner ? ` cho ${payload.owner}` : ''} · giờ Việt Nam (UTC+7)</footer></main></body>`;
  return documentOf('Radar Cộng Đồng AI', CSS_INDEX, body);
}

// ── report ──────────────────────────────────────────────────────────────

const SWITCH_SCRIPT = `(function(){var b=document.querySelectorAll('.sess button');function go(k){document.querySelectorAll('.sv').forEach(function(v){v.classList.toggle('on',v.dataset.s===k)});
b.forEach(function(x){x.classList.toggle('on',x.dataset.s===k)});}
b.forEach(function(x){x.onclick=function(){go(x.dataset.s)}});
document.querySelectorAll('.sv').forEach(function(v){var pl=v.querySelector('script.pl');if(window.initVariant)window.initVariant(v,pl?JSON.parse(pl.textContent):null);});
document.addEventListener('click',function(e){var a=e.target.closest('a[href^="#"]');if(!a)return;var t=document.getElementById(a.getAttribute('href').slice(1));if(t){e.preventDefault();t.scrollIntoView({block:'start'});}});})();`;

const TAB_TITLES: Record<LayerKey, string> = { nganh: 'Bản đồ ngành nghề', vn: 'Phòng chiến lược đối thủ', world: 'Bản đồ xu hướng' };

function sessionPill(p: ReportPayload): Raw {
  if (p.sessions.length < 2) return raw('');
  return html`<div class="sess"><span>Phiên</span>${p.sessions.map((s, i) => html`<button data-s="${s.key}"${i === 0 ? ' class=on' : ''}>${s.label}</button>`)}</div>`;
}

function tabDocument(title: string, css: string, p: ReportPayload, content: Raw, withPanel: boolean): string {
  const script = `${withPanel ? PANEL_SCRIPT : ''}\n${SWITCH_SCRIPT}`;
  return documentOf(title, css, html`<body>${content}${sessionPill(p)}<script>${raw(script)}</script></body>`);
}

/** One report: top bar with tabs B/C/D, each tab a full document in an iframe srcdoc; hash #B/#C/#D picks the tab. */
export function renderReport(payload: ReportPayload, links: RenderLinks): string {
  const ctxs = payload.sessions.map((s) => makeCtx(payload, s, links));
  const cTitle = TAB_TITLES[payload.layer];
  const docs = {
    B: tabDocument('Bản đồ nhiệt chủ đề', CSS_B, payload, tabBSessions(ctxs), true),
    C: tabDocument(cTitle, payload.layer === 'vn' ? CSS_C_VN : CSS_C_NGANH, payload, tabCSessions(ctxs), false),
    D: tabDocument('Bảng cơ hội', CSS_D, payload, tabDSessions(ctxs), false),
  };
  const tabs: { key: 'B' | 'C' | 'D'; title: string }[] = [
    { key: 'B', title: 'Bản đồ nhiệt chủ đề' }, { key: 'C', title: cTitle }, { key: 'D', title: 'Bảng cơ hội' },
  ];
  const home = links.index();
  const body = html`<body><div class="tb"><a class="back" href="${home}" target="_top" data-radar-nav="${home}">← Radar</a><h1>Radar ${payload.layerLabel}, ${payload.dateLabel} <span>· tổng hợp</span></h1>${
    tabs.map((t) => html`<button data-t="${t.key}"${t.key === 'B' ? ' class=on' : ''}><b>${t.key}</b> ${t.title}</button>`)}</div>${
    tabs.map((t) => html`<iframe data-t="${t.key}" title="${t.title}"${t.key === 'B' ? ' class=on' : ''} srcdoc="${docs[t.key]}"></iframe>`)}
<script>${raw(`document.querySelectorAll('.tb button').forEach(function(b){b.onclick=function(){document.querySelectorAll('.tb button,iframe').forEach(function(x){x.classList.toggle('on',x.dataset.t===b.dataset.t)});location.hash=b.dataset.t;}});
function pick(){var b=location.hash&&document.querySelector('.tb button[data-t="'+location.hash.slice(1)+'"]');if(b&&!b.classList.contains('on'))b.click();}pick();window.addEventListener('hashchange',pick);`)}</script></body>`;
  const shellCss = `${CSS_SHELL}\n.tb a.back{color:#d1d5db;text-decoration:none;font-size:13px;white-space:nowrap;margin-right:4px;padding:6px 8px;border-radius:8px}.tb a.back:hover{background:#1f2937;color:#fff}`;
  return documentOf(`Radar ${payload.layerLabel}, ${payload.dateLabel}`, shellCss, body);
}

