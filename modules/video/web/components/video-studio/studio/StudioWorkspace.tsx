/**
 * Video Studio workspace: video list (left) · canvas (center) · Đạo diễn AI (right).
 * URL: ?p=<productionId>&v=board|preview|finish. No video open = the new-video composer.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { tokenizedSseUrl } from '@/lib/api';
import { productionEvent } from '@modules/video/web/lib/video-edit/studio';
import { Clock, Film, PanelLeftClose, PanelLeftOpen, Plus, Search, Upload } from 'lucide-preact';

import '@modules/video/web/styles/video-production.css';
import '@modules/video/web/styles/video-studio.css';
import { errorText, productionApi } from '@modules/video/web/lib/video-production-api';
import { STATE_LABEL, mergeStudioItems, type Production, type StudioItem } from '@modules/video/web/lib/video-production';
import { ProductionHome } from '../production/ProductionHome';
import { useStudioData } from '../production/ProductionStudio';
import { DirectorPanel, useHostProject } from './DirectorPanel';
import { ProductionCanvas, type CanvasView } from './ProductionCanvas';
import { useMedia } from './useMedia';

type Filter = 'all' | 'ai' | 'footage';

function readRoute(): { p: string | null; v: CanvasView } {
  const q = new URLSearchParams(window.location.search);
  const v = q.get('v');
  return { p: q.get('p'), v: v === 'preview' || v === 'finish' ? v : 'board' };
}

function writeRoute(p: string | null, v: CanvasView, mode: 'push' | 'replace' = 'push') {
  const url = new URL(window.location.href);
  if (p) { url.searchParams.set('p', p); url.searchParams.set('v', v); } else { url.searchParams.delete('p'); url.searchParams.delete('v'); }
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', url.toString());
}

const rel = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.round(s / 60)} phút`;
  if (s < 86_400) return `${Math.round(s / 3600)} giờ`;
  return `${Math.round(s / 86_400)} ngày`;
};

export function StudioWorkspace({ onConnections, onFootage }: { onConnections: () => void; onFootage: (projectId?: string) => void }) {
  const { cast, engines } = useStudioData();
  const [route, setRoute] = useState(readRoute);
  const [items, setItems] = useState<StudioItem[] | null>(null);
  const [prod, setProd] = useState<Production | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [railOpen, setRailOpen] = useState(() => { try { return localStorage.getItem('vx.rail') !== '0'; } catch { return true; } });
  const [peek, setPeek] = useState(false);
  const tablet = useMedia('(max-width: 1200px)');
  const phone = useMedia('(max-width: 980px)');

  const reloadList = () => Promise.all([productionApi.list().catch(() => ({ productions: [] })), productionApi.footage().catch(() => ({ projects: [] }))])
    .then(([a, b]) => setItems(mergeStudioItems(a.productions, b.projects)));

  // The list: open-video changes arrive as events; the slow poll only catches other videos and footage.
  useEffect(() => {
    void reloadList();
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') void reloadList(); }, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void reloadList(); };
    const onPop = () => setRoute(readRoute());
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('popstate', onPop);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('popstate', onPop); };
  }, []);

  // The open production: load once (creates its host project when needed), then follow the host project's stream.
  useEffect(() => {
    setProd(null);
    setError('');
    if (!route.p) return;
    let alive = true;
    productionApi.get(route.p).then((r) => { if (alive) setProd(r.production); }).catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [route.p]);

  const pushed = productionEvent.value;
  useEffect(() => {
    const next = pushed?.production as Production | undefined;
    if (!next?.id) return;
    if (next.id === route.p) setProd(next);
    setItems((list) => list && list.map((it) => (it.type === 'production' && it.id === next.id
      ? { ...it, title: next.title, state: next.state, updatedAt: next.updatedAt, pendingApproval: Boolean(next.pendingApproval), scenes: next.scenes.length, scenesDone: next.scenes.filter((s) => s.status === 'done').length }
      : it)));
  }, [pushed]);

  useHostProject(prod?.projectId ?? null);

  // The list docks on wide screens; beside the director on a tablet, or on a phone, it opens as a drawer.
  const docked = railOpen && !phone && !(tablet && route.p);
  const listOpen = docked || peek;
  const open = (p: string | null, v: CanvasView = 'board') => { writeRoute(p, v); setRoute({ p, v }); setPeek(false); };
  const setView = (v: CanvasView) => { writeRoute(route.p, v, 'replace'); setRoute({ ...route, v }); };
  const toggleRail = () => {
    if (phone || (tablet && route.p)) { setPeek(!peek); return; }
    const next = !railOpen;
    setRailOpen(next);
    try { localStorage.setItem('vx.rail', next ? '1' : '0'); } catch { /* private mode */ }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((it) => (filter === 'all' || (filter === 'ai' ? it.type === 'production' : it.type === 'footage')) && (!q || it.title.toLowerCase().includes(q)));
  }, [items, query, filter]);
  const waiting = (items ?? []).filter((it) => it.type === 'production' && it.pendingApproval).length;

  return (
    <div class={`vx${docked ? '' : ' is-rail-closed'}${peek && !docked ? ' is-rail-peek' : ''}${prod ? ' has-director' : ''}`}>
      {peek && !docked && <button type="button" class="vx-scrim" aria-label="Đóng danh sách" onClick={() => setPeek(false)} />}
      <aside class="vx-rail" aria-label="Danh sách video">
        <div class="vx-rail-head">
          <button type="button" class="vp-icon-btn" aria-label={listOpen ? 'Thu gọn danh sách' : 'Mở danh sách video'} aria-expanded={listOpen} onClick={toggleRail}>{listOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
          {(listOpen || phone) && <b>Video</b>}
          {(listOpen || phone) && waiting > 0 && <span class="vp-pill is-busy" title="Video đang chờ bạn duyệt chi phí">{waiting} chờ duyệt</span>}
          {phone && !listOpen && route.p && <button type="button" class="vp-btn vp-btn-sm" onClick={() => open(null)}><Plus size={13} /> Video mới</button>}
        </div>
        {listOpen && (
          <>
            <div class="vx-rail-actions">
              <button type="button" class="vp-btn vp-btn-primary vp-btn-sm" onClick={() => open(null)}><Plus size={14} /> Video mới</button>
              <button type="button" class="vp-btn vp-btn-sm" title="Dựng video bạn đã quay" onClick={() => onFootage()}><Upload size={13} /> Quay sẵn</button>
            </div>
            <label class="vx-search"><Search size={13} /><input value={query} placeholder="Tìm video…" aria-label="Tìm video" onInput={(e) => setQuery(e.currentTarget.value)} /></label>
            <div class="vp-seg vx-filter" role="group" aria-label="Lọc">
              {([['all', 'Tất cả'], ['ai', 'AI sản xuất'], ['footage', 'Quay sẵn']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
            </div>
            <ul class="vx-list">
              {items === null && <li class="vp-faint" style={{ padding: '10px' }}>Đang tải…</li>}
              {items !== null && shown.length === 0 && <li class="vp-faint" style={{ padding: '10px', fontSize: '12px' }}>{query ? 'Không có video khớp.' : 'Chưa có video. Bấm "Video mới".'}</li>}
              {shown.map((it) => {
                const active = it.type === 'production' && it.id === route.p;
                return (
                  <li key={`${it.type}:${it.id}`}>
                    <button type="button" class={`vx-item${active ? ' is-active' : ''}`} onClick={() => { if (it.type === 'production') open(it.id); else { setPeek(false); onFootage(it.id); } }}>
                      <span class="vx-item-thumb">{it.type === 'production' && it.thumb ? <img src={tokenizedSseUrl(it.thumb)} alt="" loading="lazy" /> : <Film size={14} />}</span>
                      <span class="vx-item-body">
                        <b>{it.title}</b>
                        <small>
                          {it.type === 'production'
                            ? <>{it.pendingApproval ? <em class="is-wait">Chờ duyệt</em> : STATE_LABEL[it.state]} · {it.scenesDone}/{it.scenes} cảnh{it.series ? ` · series ${it.series.index}/${it.series.total}` : ''}</>
                            : <>Quay sẵn · {it.hasSource ? 'đã có video' : 'chưa có video'}</>}
                        </small>
                      </span>
                      <span class="vx-item-time"><Clock size={10} /> {rel(it.updatedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </aside>

      <main class="vx-main">
        {!route.p && (
          <div class="vp">
            <ProductionHome cast={cast} engines={engines} onOpen={(id) => { void reloadList(); open(id); }} onConnections={onConnections} />
          </div>
        )}
        {route.p && !prod && (
          <div class="vx-loading">{error ? <p class="vp-error">{error}</p> : <p class="vp-faint">Đang mở video…</p>}</div>
        )}
        {route.p && prod && (
          <ProductionCanvas
            p={prod} setP={setProd} cast={cast ?? []} engines={engines} view={route.v} onView={setView}
            onDeleted={() => { void reloadList(); open(null); }}
          />
        )}
      </main>

      {route.p && prod && <DirectorPanel p={prod} cast={cast ?? []} />}
    </div>
  );
}
