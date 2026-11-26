// Mock of /api/cloud/* and /api/packs/* (Kho dữ liệu) for the UI preview.
type Handler = (params: string[], q: URLSearchParams, body: any) => unknown;
export const packsMockRoutes: Array<[string, string, Handler]> = [];

const ID = 'tra-va-qua-tang-co-ban';
const NOTES = ['bai-hoc/mo-dau-bang-cau-hoi.md', 'bai-hoc/tra-loi-gia-ngay.md', 'bai-hoc/video-huong-dan-ngan.md', 'cong-thuc/huong-dan-3-buoc.md', 'cong-thuc/truoc-va-sau.md'];
const pack = {
  id: ID, module: 'learn', name: 'Trà và quà tặng: bài học cơ bản', summary: 'Năm bài học và công thức nội dung cho shop trà, quà tặng.',
  industry: 'tra', coverUrl: null, latest: { version: '1.0.0' },
};
let installed: { folderId: string; version: string; at: string } | null = null;
const plan = (folder: string, uninstall = false) => ({
  packId: ID, version: '1.0.0', name: pack.name, module: 'learn', folderId: folder, from: installed?.version ?? null,
  items: NOTES.map((p) => ({ path: p, action: uninstall ? 'delete' : installed ? 'same' : 'create', loai: p.startsWith('bai-hoc') ? 'bai-hoc' : 'cong-thuc' })),
  assets: uninstall ? [] : ['assets/bia.svg'],
  counts: { create: uninstall || installed ? 0 : NOTES.length, update: 0, same: !uninstall && installed ? NOTES.length : 0, skip: 0, delete: uninstall ? NOTES.length : 0, keep: 0 },
  planId: 'a'.repeat(64),
});

packsMockRoutes.push(['GET', '/cloud/status', () => ({ connected: true, cloudUrl: 'https://cloud.example.com', account: 'chu@example.com', status: 'ok', returnUrl: 'http://127.0.0.1:4380/api/cloud/callback', pending: false, lastLogin: null })]);
packsMockRoutes.push(['GET', '/packs', (_p, q) => ({
  items: !q.get('module') || q.get('module') === 'learn' ? [{ ...pack, installs: installed ? [{ folderId: installed.folderId, version: installed.version }] : [], updateAvailable: false }] : [],
})]);
packsMockRoutes.push(['GET', '/packs/updates', () => ({ items: [] })]);
packsMockRoutes.push(['GET', '/packs/installed', () => ({ items: [] })]);
packsMockRoutes.push(['GET', '/packs/:id', () => ({
  ...pack, license: 'CC-BY-4.0', author: 'AgenticOS',
  releases: [{ id: 'r1', version: '1.0.0', status: 'published', size: 4096, notesCount: 5, license: 'CC-BY-4.0', author: 'AgenticOS', publishedAt: new Date().toISOString(), yankedAt: null }],
  files: NOTES.map((p) => ({ path: `notes/${p}`, loai: p.startsWith('bai-hoc') ? 'bai-hoc' : 'cong-thuc', sha256: '0'.repeat(64) })),
  installs: installed ? [{ packId: ID, version: installed.version, folderId: installed.folderId, module: 'learn', name: pack.name, installedAt: installed.at, updatedAt: installed.at, files: NOTES.length, fileStatus: NOTES.map((path) => ({ path, status: 'unchanged' })) }] : [],
})]);
packsMockRoutes.push(['POST', '/packs/:id/preview', (_p, _q, b) => plan(b.folder)]);
packsMockRoutes.push(['POST', '/packs/:id/install', (_p, _q, b) => {
  installed = { folderId: b.folder, version: b.version, at: new Date().toISOString() };
  return { packId: ID, version: b.version, folderId: b.folder, message: `goi: cài ${ID}@${b.version}`, written: NOTES, deleted: [], skipped: [], kept: [] };
}]);
packsMockRoutes.push(['POST', '/packs/:id/uninstall/preview', (_p, _q, b) => plan(b.folder, true)]);
packsMockRoutes.push(['POST', '/packs/:id/uninstall', (_p, _q, b) => {
  installed = null;
  return { packId: ID, version: '1.0.0', folderId: b.folder, message: `goi: gỡ ${ID}@1.0.0`, written: [], deleted: NOTES, skipped: [], kept: [] };
}]);
