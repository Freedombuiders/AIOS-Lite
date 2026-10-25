// Mẫu edit: search, tag filters and the card grid (Trang đầu, and the "Đổi mẫu" dialog of Thiết lập).
import { useState } from 'preact/hooks';
import { Check, RefreshCw, Search, Sparkles } from 'lucide-preact';
import { templatePosterUrl, type TemplateSummary } from '@modules/video/web/lib/video-edit/quick-api';
import { filterTemplates, templateBadge, templateFilters } from './quick-model';
import { loadTemplates, templates, templatesError, templatesStatus } from './quick-state';

/** Sample titles use the template markup: *word* = highlight, | = new line. */
function SampleTitle({ title }: { title: string }) {
  const lines = title.split('|');
  return <>{lines.map((line, i) => <span key={i}>{i > 0 && <br />}{line.replace(/\*/g, '').trim()}</span>)}</>;
}

/** Poster when the pack has one, else drawn from `sample` (font, colour, tone). */
export function TemplateThumb({ template, small }: { template: TemplateSummary; small?: boolean }) {
  const poster = templatePosterUrl(template);
  const sample = template.sample;
  return <span class={`vs-dn-thumb${small ? ' is-small' : ''}`} style={{ background: sample?.tone }} aria-hidden="true">
    {poster ? <img src={poster} alt="" loading="lazy" /> : <>
      <svg class="vs-dn-thumb-person" viewBox="0 0 100 100"><circle cx="50" cy="40" r="17" /><path d="M14 100c0-22 16-38 36-38s36 16 36 38z" /></svg>
      <span class="vs-dn-thumb-text">
        {sample?.kicker && !small && <span class="vs-dn-thumb-kicker">{sample.kicker}</span>}
        <span class="vs-dn-thumb-title" style={{ color: sample?.color, fontFamily: sample?.font ? `"${sample.font}", var(--font-sans)` : undefined }}>
          <SampleTitle title={sample?.title ?? template.name} />
        </span>
      </span>
    </>}
  </span>;
}

export function TemplateCard({ template, selected, onPick }: { template: TemplateSummary; selected: boolean; onPick: (t: TemplateSummary) => void }) {
  const badge = templateBadge(template);
  return <button type="button" class={`vs-dn-card${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={() => onPick(template)}>
    <span class="vs-dn-card-visual">
      <TemplateThumb template={template} />
      <span class={`vs-dn-badge is-${badge.tone}`}>{badge.label}</span>
      {selected && <span class="vs-dn-card-check" aria-hidden="true"><Check size={14} strokeWidth={3} /></span>}
    </span>
    <span class="vs-dn-card-body">
      <span class="vs-dn-card-name">{template.name}</span>
      <span class="vs-dn-card-desc">{template.description}</span>
      {template.tags.length > 0 && <span class="vs-dn-card-tags">{template.tags.join(' · ')}</span>}
    </span>
  </button>;
}

export function TemplateLibrary({ selectedId, onPick, headingLevel = 2 }: {
  selectedId: string;
  onPick: (t: TemplateSummary) => void;
  headingLevel?: 2 | 3;
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const list = templates.value;
  const filters = templateFilters(list);
  const shown = filterTemplates(list, filter, query);
  const status = templatesStatus.value;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return <section class="vs-dn-library" aria-labelledby="vs-dn-tpl-title">
    <div class="vs-dn-library-head">
      <div>
        <Heading id="vs-dn-tpl-title">Mẫu edit</Heading>
        <p class="vs-muted">Mẫu quyết định font, màu, phụ đề, hiệu ứng, chuyển cảnh và âm thanh. AI dựng theo luật của mẫu.</p>
      </div>
      <label class="vs-dn-search">
        <Search size={16} aria-hidden="true" />
        <span class="vs-dn-sr">Tìm mẫu</span>
        <input type="search" placeholder="Tìm mẫu…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
    </div>

    <div class="vs-dn-chips" role="group" aria-label="Lọc mẫu">
      {filters.map((f) => <button key={f.id} type="button" class="vs-dn-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
    </div>

    {status === 'error' && <div class="vs-error" role="alert">
      Không tải được danh sách mẫu: {templatesError.value}{' '}
      <button type="button" class="vs-btn" onClick={() => void loadTemplates(true)}><RefreshCw size={14} aria-hidden="true" /> Thử lại</button>
    </div>}
    {(status === 'loading' || status === 'idle') && !list.length && <div class="vs-skel" role="status" aria-label="Đang tải mẫu"><span /><span /></div>}
    {status === 'ready' && !shown.length && <p class="vs-muted" role="status">Không có mẫu nào khớp. Thử bỏ bộ lọc hoặc từ khoá.</p>}

    <div class="vs-dn-grid">
      {shown.map((t) => <TemplateCard key={t.id} template={t} selected={t.id === selectedId} onPick={onPick} />)}
      {filter === 'all' && !query.trim() && <div class="vs-dn-soon">
        <span class="vs-dn-soon-icon" aria-hidden="true"><Sparkles size={20} /></span>
        <strong>Tạo mẫu từ video tham khảo</strong>
        <span>Dán link Reel hoặc TikTok bạn thích. AI đo nhịp cắt, kiểu chữ, màu rồi tạo một mẫu mới.</span>
        <span class="vs-dn-soon-tag">Sắp có</span>
      </div>}
    </div>
  </section>;
}
