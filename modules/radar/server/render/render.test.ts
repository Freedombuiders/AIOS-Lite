import { describe, expect, it } from 'vitest';
import type { IndexPayload, LayerKey, ReportPayload } from '../types.js';
import { emptyReport, indexFixture, nganhFixture, vnFixture, worldFixture } from './fixtures.js';
import { renderIndex, renderReport } from './index.js';
import { buildHeat } from './derive.js';

const links = { report: (d: string, l: LayerKey) => `/m/radar/${d}/${l}`, index: () => '/m/radar' };

/** The three tab documents of a rendered report, with the srcdoc attribute decoded. */
function tabDocs(html: string): Record<'B' | 'C' | 'D', string> {
  const out: Partial<Record<'B' | 'C' | 'D', string>> = {};
  for (const m of html.matchAll(/<iframe data-t="([BCD])"[^>]*srcdoc="([^"]*)"/g)) {
    out[m[1] as 'B' | 'C' | 'D'] = m[2].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return out as Record<'B' | 'C' | 'D', string>;
}

const fixtures: [string, ReportPayload][] = [['nganh', nganhFixture], ['vn', vnFixture], ['world', worldFixture]];

describe('renderReport', () => {
  it.each(fixtures)('renders the %s fixture with three tabs', (_name, payload) => {
    const html = renderReport(payload, links);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    const docs = tabDocs(html);
    for (const key of ['B', 'C', 'D'] as const) {
      expect(docs[key].startsWith('<!doctype html>')).toBe(true);
      expect(docs[key]).toContain('Be+Vietnam+Pro');
      expect(docs[key]).toContain('Hôm nay có gì mới?');
      expect(docs[key]).toContain('Ghi chú về dữ liệu');
    }
    expect(html).toContain(`Radar ${payload.layerLabel}, ${payload.dateLabel}`);
  });

  it.each(['nganh', 'vn', 'world'] as LayerKey[])('renders an empty %s session without throwing', (layer) => {
    const html = renderReport(emptyReport(layer), links);
    const docs = tabDocs(html);
    expect(docs.B).toContain('Không có dữ liệu.');
    expect(docs.D).toContain('Bảng cơ hội');
  });

  it('has the original key strings in the nganh fixture', () => {
    const docs = tabDocs(renderReport(nganhFixture, links));
    expect(docs.B).toContain('Bản đồ nhiệt chủ đề');
    expect(docs.B).toContain('Gian lận, đạo đức, con dùng AI');
    expect(docs.B).toContain('262');
    expect(docs.B).toContain('12 cộng đồng · 2,9 triệu thành viên · 21 bài top · 494 bình luận');
    expect(docs.C).toContain('Ngành nào đang đau nhất vì AI');
    expect(docs.C).toContain('Nỗi đau chung nhiều nghề');
    expect(docs.D).toContain('Ý tưởng cho Minh');
    expect(docs.D).toContain('Nỗi sợ bị thay thế');
    expect(docs.B).toContain('Chưa có nỗi đau lặp lại');
  });

  it('computes the heatmap like the original', () => {
    const heat = buildHeat('nganh', nganhFixture.sessions[0]);
    const row = heat.rows.find((r) => r.topic.key === 'gianlan');
    expect(row?.total).toBe(262);
    expect(heat.ranking[0].topic.key).toBe('gianlan');
    expect(heat.ranking[0].pct).toBe(100);
    expect(heat.columns.map((c) => c.label)).toContain('TikTok');
  });

  it('has the competitor room, gap cell and session switcher for vn', () => {
    const html = renderReport(vnFixture, links);
    const docs = tabDocs(html);
    expect(docs.C).toContain('Phòng chiến lược');
    expect(docs.C).toContain('Khoảng trống cho Minh');
    expect(docs.C).toContain('Kéo vào Zoom free');
    expect(docs.B).toContain('Fanpage đối thủ');
    expect(docs.B).toContain('class="sess"');
    expect(docs.B).toContain('data-s="s1"');
    expect(docs.B).toContain('>Sáng<');
    expect(docs.D).toContain('Đối thủ làm gì');
    expect(docs.D).toContain('Xu hướng nước ngoài');
  });

  it('renders the trend map for world', () => {
    const docs = tabDocs(renderReport(worldFixture, links));
    expect(docs.C).toContain('Xu hướng nước ngoài chính');
    expect(docs.D).toContain('Tin nổi bật trên X');
    expect(docs.D).toContain('Hacker News &amp; Reddit');
    expect(docs.B).not.toContain('class="sess"');
  });

  it('adds the back link to the index and keeps source links in a new tab', () => {
    const html = renderReport(nganhFixture, links);
    expect(html).toContain('data-radar-nav="/m/radar"');
    expect(html).toContain('target="_top"');
    const docs = tabDocs(html);
    expect(docs.B).toContain('target="_blank" rel="noopener"');
    expect(docs.B).not.toMatch(/<a [^>]*href="https?:[^"]*"(?![^>]*target="_blank")/);
  });

  it('escapes untrusted text everywhere, including the srcdoc and the JSON payload', () => {
    const evil = '<script>alert(1)</script> "q" \'a\'';
    const payload: ReportPayload = structuredClone(nganhFixture);
    const s = payload.sessions[0];
    s.items[0].title = evil;
    s.items[0].url = 'javascript:alert(1)';
    s.communities[1].name = 'Nhóm" onmouseover="x';
    s.items.filter((i) => i.sourceName === 'Giáo Viên Tiếng Anh').forEach((i) => (i.sourceName = 'Nhóm" onmouseover="x'));
    s.pains[0].detail = evil;
    s.quotes[0].text = evil;
    s.dataNotes.push(evil);
    const html = renderReport(payload, links);
    expect(html).not.toContain('<script>alert(1)');
    const docs = tabDocs(html);
    for (const key of ['B', 'C', 'D'] as const) {
      expect(docs[key]).not.toContain('<script>alert(1)');
      expect(docs[key]).not.toContain('javascript:alert');
      expect(docs[key]).not.toContain('onmouseover="x"');
    }
    expect(docs.B).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const json = docs.B.match(/<script type="application\/json" class="pl">(.*?)<\/script>/s)?.[1] ?? '';
    expect(json).not.toContain('<');
    const parsed = JSON.parse(json) as { bando: { items: { title: string }[] } };
    expect(parsed.bando.items.some((i) => i.title === evil)).toBe(true);
  });
});

describe('renderIndex', () => {
  it('renders the filled card, empty cards and the archive', () => {
    const html = renderIndex(indexFixture, links);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Ba ống kính, mỗi ngày một lần');
    expect(html).toContain('Chưa có báo cáo. Bản đầu tiên sẽ xuất hiện sau phiên 7h.');
    expect(html).toContain('Thứ Bảy, 17/10/2026 · 12 nguồn · 21 bài · 467 bình luận');
    expect(html).toContain('chip ghost');
    expect(html).toContain('data-radar-nav="/m/radar/2026-10-17/nganh"');
    expect(html).toContain('Radar Cộng Đồng AI · nghiên cứu thị trường cho Minh · giờ Việt Nam (UTC+7)');
  });

  it('drops the owner from the footer when empty and renders with no reports', () => {
    const empty: IndexPayload = { owner: '', updatedLabel: null, layers: indexFixture.layers.map((l) => ({ ...l, latest: null })), archive: [] };
    const html = renderIndex(empty, links);
    expect(html).toContain('Radar Cộng Đồng AI · nghiên cứu thị trường · giờ Việt Nam (UTC+7)');
    expect(html).toContain('Chưa có báo cáo nào');
  });
});
