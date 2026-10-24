import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './test-db.js';
import { kolDb } from './core.js';

// Local copies of the report shapes the Radar module writes (only the fields KOL reads).
interface SessionView { key: string; ideas: { channel: string; title: string; evidence: string[]; status: string }[]; trends: Record<string, unknown>[]; [k: string]: unknown }
interface ReportPayload { layer: string; date: string; sessions: SessionView[]; [k: string]: unknown }

function saveReport(p: ReportPayload): void {
  kolDb().exec('CREATE TABLE IF NOT EXISTS radar_reports (day TEXT NOT NULL, layer TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (day, layer))');
  kolDb().prepare('INSERT INTO radar_reports (day, layer, payload_json, updated_at) VALUES (?, ?, ?, ?)').run(p.date, p.layer, JSON.stringify(p), new Date().toISOString());
}
import { bindModuleCompat, unbindModuleCompat } from './compat.js';
import { ideasFromPayload, listRadarIdeas, radarEnabled } from './radar-ideas.js';

function session(key: string, ideas: SessionView['ideas'], trends: Partial<SessionView['trends'][number]>[] = []): SessionView {
  return {
    key, label: key, scan: { when: '', sources: '', top: '' }, topics: [], communities: [], items: [], pains: [], quotes: [], buySignals: [], tools: [],
    ideas, fears: [], professions: [], missingProfessions: [], competitors: [], otherAdvertisers: [], gap: null,
    trends: trends.map((t, i) => ({ rank: i + 1, metricLabel: '', sourceLine: '', title: '', subtitle: '', description: '', vnAngle: '', itemIds: [], ...t })),
    dataNotes: [],
  };
}

function payload(date: string, sessions: SessionView[]): ReportPayload {
  return { version: 1, layer: 'vn', layerLabel: 'Việt Nam', slotLabel: '', date, dateLabel: '', weekday: '', owner: '', generatedAt: '', sessions };
}

beforeEach(() => _initTestDatabase());

describe('ideasFromPayload', () => {
  it('uses the merged "all" session when present; skips done ideas; adds trends', () => {
    const p = payload('2026-10-19', [
      session('all', [
        { channel: 'TikTok', title: 'Video 30s dạy prompt', evidence: ['12 bình luận hỏi', 'bài 2k like'], status: 'todo' },
        { channel: 'Mọi kênh', title: 'Đã làm', evidence: [], status: 'done' },
      ], [{ title: 'AI agent', description: 'Đang lên', vnAngle: 'Chưa ai làm tiếng Việt' }]),
      session('s1', [{ channel: 'TikTok', title: 'Trùng lặp', evidence: [], status: 'todo' }]),
    ]);
    const out = ideasFromPayload('2026-10-19', 'vn', p);
    expect(out).toEqual([
      { key: '2026-10-19:vn:all:i0', day: '2026-10-19', layer: 'vn', title: 'Video 30s dạy prompt', detail: 'Kênh: TikTok · 12 bình luận hỏi · bài 2k like', url: '' },
      { key: '2026-10-19:vn:all:t0', day: '2026-10-19', layer: 'vn', title: 'AI agent', detail: 'Đang lên — Chưa ai làm tiếng Việt', url: '' },
    ]);
    expect(ideasFromPayload('d', 'vn', null)).toEqual([]);
    expect(ideasFromPayload('d', 'vn', { sessions: 'x' })).toEqual([]);
  });
});

describe('listRadarIdeas', () => {
  it('newest reports first, deduplicated by title, limited', () => {
    saveReport(payload('2026-10-18', [session('s1', [{ channel: 'A', title: 'Cũ', evidence: [], status: 'todo' }, { channel: 'A', title: 'Chung', evidence: [], status: 'todo' }])]));
    saveReport(payload('2026-10-19', [session('s1', [{ channel: 'B', title: 'Mới', evidence: [], status: 'todo' }, { channel: 'B', title: 'chung', evidence: [], status: 'todo' }])]));
    expect(listRadarIdeas(10).map((i) => i.title)).toEqual(['Mới', 'chung', 'Cũ']);
    expect(listRadarIdeas(1)).toHaveLength(1);
  });

  it('no table or a corrupt payload means no ideas', () => {
    kolDb().exec('CREATE TABLE IF NOT EXISTS radar_reports (day TEXT NOT NULL, layer TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (day, layer))');
    kolDb().prepare(`INSERT INTO radar_reports (day, layer, payload_json, updated_at) VALUES ('2026-10-20', 'world', '{oops', '')`).run();
    expect(listRadarIdeas()).toEqual([]);
    kolDb().exec('DROP TABLE radar_reports');
    expect(listRadarIdeas()).toEqual([]);
  });
});

describe('radar gating', () => {
  it('returns no ideas while the Radar module is off, and reads them once it is on', () => {
    saveReport(payload('2026-10-19', [session('s1', [{ channel: 'B', title: 'Mới', evidence: [], status: 'todo' }])]));
    let on = false;
    bindModuleCompat('kol', { modules: { isEnabled: (id: string) => id === 'radar' && on } } as never);
    try {
      expect(radarEnabled()).toBe(false);
      expect(listRadarIdeas()).toEqual([]);
      on = true;
      expect(radarEnabled()).toBe(true);
      expect(listRadarIdeas().map((i) => i.title)).toEqual(['Mới']);
    } finally {
      unbindModuleCompat('kol');
    }
  });
});
