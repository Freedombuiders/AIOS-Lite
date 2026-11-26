// Test helpers for the dream server: a module context on the sample brain (real notes service), the module's
// migrations, fake agent turns and a record of attention items. Not imported by production code.
import fs from 'node:fs';
import path from 'node:path';
import type { AppDeps } from '../../../src/core/deps.js';
import { createModuleContext } from '../../../src/modules/context.js';
import type { LeanRunInput, LeanRunResult, ModuleContext, ModuleManifest } from '../../../src/modules/sdk.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import { createNotes, type Notes } from '../../../src/shared/notes.js';
import { REPO_ROOT, sampleBrain, testLog } from '../../../src/shared/test-kit.js';
import type { VideoRow } from './analyze.js';

export const FOLDER = 'cong-ty-b';

export interface DreamKit {
  h: TestHarness;
  ctx: ModuleContext;
  notes: Notes;
  brainRoot: string;
  settings: Map<string, unknown>;
  lean: { calls: LeanRunInput[]; answer: (input: LeanRunInput) => string };
  attention: { raised: Array<{ key: string; title: string; link?: string }>; resolved: string[] };
  provides: Map<string, unknown>;
  read(rel: string): string;
  cleanup(): void;
}

export function makeDreamKit(): DreamKit {
  const h = createTestHarness();
  const sb = sampleBrain(h.deps.db);
  const brainRoot = path.join(sb.root, 'brain');
  const deps = h.deps as AppDeps & { brain: AppDeps['brain']; notes: AppDeps['notes'] };
  deps.brain = sb.brain;
  // agents may write everything their grants say; the notes service itself refuses cong-thuc/
  const notes = createNotes({ brain: sb.brain, canRead: () => true, canWrite: () => true, log: testLog, bus: deps.bus });
  deps.notes = notes;
  const dir = path.join(REPO_ROOT, 'modules', 'dream');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')) as ModuleManifest;
  const settings = new Map<string, unknown>([['brain_folder', FOLDER]]);
  const provides = new Map<string, unknown>();
  const base = createModuleContext(deps, manifest, dir, { stops: new Set() }, {
    settings: { all: () => ({}), patch() {} } as never,
    provides: (id: string) => provides.get(id) as never,
    isEnabled: () => true,
  });
  const lean: DreamKit['lean'] = { calls: [], answer: () => '{}' };
  const attention: DreamKit['attention'] = { raised: [], resolved: [] };
  const ctx = {
    ...base,
    settings: { get: (k: string, fb?: unknown) => (settings.has(k) ? settings.get(k) : fb), set: (k: string, v: unknown) => void settings.set(k, v), all: () => Object.fromEntries(settings) },
    attention: { raise: (i: { key: string; title: string; link?: string }) => void attention.raised.push(i), resolve: (k: string) => void attention.resolved.push(k) },
    modules: { get: (id: string) => provides.get(id) as never, isEnabled: (id: string) => provides.has(id) },
    agents: {
      list: () => [{ id: 'main', name: 'Main', enabled: true }] as never,
      get: (id: string) => (id === 'main' ? ({ id: 'main', name: 'Main' } as never) : undefined),
      attachments: () => ({ images: false, documents: false }),
      runLean: async (input: LeanRunInput): Promise<LeanRunResult> => {
        lean.calls.push(input);
        return { ok: true, output: lean.answer(input), taskId: lean.calls.length, runId: 1 };
      },
    },
  } as unknown as ModuleContext;
  for (const f of fs.readdirSync(path.join(dir, 'migrations')).sort()) h.deps.db.exec(fs.readFileSync(path.join(dir, 'migrations', f), 'utf8'));
  return {
    h, ctx, notes, brainRoot, settings, lean, attention, provides,
    read: (rel) => fs.readFileSync(path.join(brainRoot, FOLDER, rel), 'utf8'),
    cleanup: () => h.cleanup(),
  };
}

/** An analysed video row plus its video-dream note, as runJob leaves them. */
export function addVideo(kit: DreamKit, id: string, over: Partial<VideoRow> = {}, now = Date.now()): VideoRow {
  const v: VideoRow = {
    id, channel_id: null, url: `https://www.tiktok.com/@kenh/video/${id}`, folder_id: FOLDER, status: 'done', step: null, reason: null,
    platform: 'tiktok', native_id: id, title: `Video ${id}`, uploader: 'kenh-mau', views: 100_000, likes: 5000, comments: 100, captured_at: now,
    duration_s: 38, cuts: 12, cuts_per_min: 19, cuts_first3s: 2, longest_scene_s: 4, has_subtitles: 1, used_frames: 0,
    mo_dau: 'cau-hoi', cau_truc: 'huong-dan-buoc', keu_goi: 'theo-doi', giay_keu_goi: 30, label_note: null, agent_id: 'main', task_id: 1,
    note_path: `dream-100/video/2026-11-26-kenh-mau-${id}.md`, formula_slug: null, created_at: now, started_at: now, finished_at: now, ...over,
  };
  const cols = Object.keys(v);
  kit.h.deps.db.prepare(`INSERT INTO dream_videos (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => (v as unknown as Record<string, unknown>)[k] ?? null));
  if (v.note_path) {
    kit.notes.forModule('dream').create(
      { folderId: FOLDER, relPath: v.note_path },
      { loai: 'video-dream', kenh: 'kenh-mau', luot_xem: v.views, mo_dau: v.mo_dau, cau_truc: v.cau_truc, do_dai: v.duration_s, cat_moi_phut: v.cuts_per_min },
      `# Video mẫu ${id}\n`,
      { message: 'test' },
    );
  }
  return v;
}

/** A bai-dang note (what learn writes), with ERs per milestone. */
export function addPost(kit: DreamKit, slug: string, ers: Partial<Record<'24h' | '7d', number>>, over: Record<string, unknown> = {}): string {
  const relPath = `noi-dung/bai/${slug}.md`;
  kit.notes.forModule('learn').create(
    { folderId: FOLDER, relPath },
    {
      loai: 'bai-dang', id: slug, nen_tang: 'facebook', tieu_de: slug, dinh_dang: 'video-ngan', dang_luc: '2026-11-20T19:00:00+07:00',
      so_do: Object.entries(ers).map(([moc, er]) => ({ moc, reach: 1000, er })), ...over,
    },
    `# ${slug}\n`,
    { message: 'test' },
  );
  return relPath;
}
