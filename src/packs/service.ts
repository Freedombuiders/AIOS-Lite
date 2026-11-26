// Installing data packs from the cloud store into a brain folder.
//
// - Every write goes through the notes service as the trusted principal `system:packs`, inside one
//   notes.batch, so an install, an update or an uninstall is ONE git commit that can be undone at once.
// - Never overwrites the owner's work: a target that exists and is not recorded in pack_files for this pack
//   with the same hash is skipped and listed. Updates delete files the new version dropped only when they are
//   unchanged since install; uninstall removes only unchanged files.
// - The owner sees a preview first. Installing needs the preview's planId: if the brain or the pack changed
//   since, the plan differs and the install is refused (409) until the owner looks again.
// - Assets (assets/** in the zip) are verified with the rest but NOT installed: the brain only takes notes
//   through the notes service, which writes Markdown only, and a published SVG served from the brain would be
//   script from a stranger. The preview lists them as skipped.
// - kenh-dream and mau-khach-hang become notes only; no module rows are created here.
//
// Only the HTTP API (src/api/routes/packs.ts) calls this. No agent action installs or updates packs.
import crypto from 'node:crypto';
import type { DB } from '../core/db.js';
import type { Logger } from '../core/log.js';
import type { CloudClient } from '../integrations/agenticos-cloud/client.js';
import type { BrainService } from '../shared/contracts.js';
import { NoteConflictError, NoteInputError, type NoteRef, type Notes, type NotesService } from '../shared/notes.js';
import { MAX_PACK_BYTES, compareSemver, isSemver, packIdSchema, type PackManifest } from './format.js';
import { applyImportRules, packRef } from './rules.js';
import { verifyPack, type PackKeys, type ReleaseInfo, type VerifiedPack } from './verify.js';
import { PackError, type UnzipOptions } from './zip.js';

export const PACKS_PRINCIPAL = 'packs';

export type PlanAction = 'create' | 'update' | 'same' | 'skip' | 'delete' | 'keep' | 'forget';

export interface PlanItem {
  /** path in the brain folder */
  path: string;
  action: PlanAction;
  loai?: string;
  /** why a file is skipped or kept (Vietnamese, for the owner) */
  reason?: string;
  /** hash of the file now (what a change must find) */
  expectHash?: string;
  /** hash of what will be written */
  hash?: string;
}

export interface PackPlan {
  packId: string;
  version: string;
  name: string;
  module: string;
  folderId: string;
  /** installed version in this folder, when this is an update */
  from: string | null;
  items: PlanItem[];
  /** assets/** in the pack, not installed */
  assets: string[];
  counts: { create: number; update: number; same: number; skip: number; delete: number; keep: number };
  /** pass back to install(); changes whenever the plan would */
  planId: string;
}

export interface InstallResult {
  packId: string;
  version: string;
  folderId: string;
  message: string;
  written: string[];
  deleted: string[];
  skipped: { path: string; reason: string }[];
  kept: { path: string; reason: string }[];
}

export interface InstallRow {
  packId: string;
  version: string;
  folderId: string;
  module: string;
  name: string;
  installedAt: string;
  updatedAt: string;
  files: number;
}

export class PackBusyError extends Error {
  readonly code = 'conflict';
  constructor() {
    super('Đang cài hoặc gỡ một gói khác. Chờ xong rồi thử lại.');
    this.name = 'PackBusyError';
  }
}
export class PlanChangedError extends Error {
  readonly code = 'conflict';
  constructor() {
    super('Brain hoặc gói đã thay đổi từ lúc xem trước. Xem lại bản xem trước rồi cài.');
    this.name = 'PlanChangedError';
  }
}
export class PackInputError extends Error {
  readonly code = 'bad_request';
  constructor(message: string) {
    super(message);
    this.name = 'PackInputError';
  }
}
export class PackNotInstalledError extends Error {
  readonly code = 'not_found';
  constructor(id: string, folderId: string) {
    super(`Gói ${id} chưa được cài vào thư mục "${folderId}".`);
    this.name = 'PackNotInstalledError';
  }
}

export interface PackServiceDeps {
  db: DB;
  notes: Pick<Notes, 'forSystem'>;
  brain: Pick<BrainService, 'folders'>;
  /** publisher public keys configured on this machine */
  keys: () => PackKeys;
  /** the signed-in cloud client; throws when the owner has not signed in */
  cloud: () => CloudClient;
  log: Logger;
  /** this app's version, for pack.json minAppVersion */
  appVersion?: string;
  now?: () => number;
  /** tests: watch inflation */
  unzip?: UnzipOptions;
}

interface FileRow {
  pack_id: string;
  rel_path: string;
  sha256: string;
}
interface InstallDbRow {
  pack_id: string;
  version: string;
  folder_id: string;
  module: string;
  name: string;
  zip_sha256: string;
  key_id: string;
  installed_at: number;
  updated_at: number;
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 4;

const REASON = {
  edited: 'Bạn đã sửa ghi chú này sau khi cài; giữ nguyên bản của bạn.',
  exists: 'Đã có ghi chú cùng đường dẫn không do gói này cài; không ghi đè.',
  deleted: 'Bạn đã xoá ghi chú này sau khi cài; không tạo lại.',
  droppedEdited: 'Bản mới không còn ghi chú này, nhưng bạn đã sửa nó; giữ lại như ghi chú của bạn.',
  uninstallEdited: 'Bạn đã sửa ghi chú này; giữ lại như ghi chú của bạn.',
  raced: 'Ghi chú vừa đổi trong lúc cài; không đụng tới.',
} as const;

function sha(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function countsOf(items: PlanItem[]): PackPlan['counts'] {
  const c = { create: 0, update: 0, same: 0, skip: 0, delete: 0, keep: 0 };
  for (const i of items) if (i.action in c) c[i.action as keyof typeof c] += 1;
  return c;
}

function planIdOf(parts: unknown): string {
  return sha(JSON.stringify(parts));
}

export function createPackService(deps: PackServiceDeps) {
  const { db, log } = deps;
  const now = deps.now ?? Date.now;
  const svc = (): NotesService => deps.notes.forSystem(PACKS_PRINCIPAL);
  const cache = new Map<string, { pack: VerifiedPack; keyId: string; at: number }>();
  let busy = false;

  const getInstall = (packId: string, folderId: string) =>
    db.prepare('SELECT * FROM pack_installs WHERE pack_id = ? AND folder_id = ?').get(packId, folderId) as InstallDbRow | undefined;
  const filesOf = (packId: string, folderId: string) =>
    db.prepare('SELECT pack_id, rel_path, sha256 FROM pack_files WHERE pack_id = ? AND folder_id = ? ORDER BY rel_path').all(packId, folderId) as FileRow[];
  const owner = (folderId: string, rel: string) =>
    db.prepare('SELECT pack_id, rel_path, sha256 FROM pack_files WHERE folder_id = ? AND lower(rel_path) = lower(?)').all(folderId, rel) as FileRow[];

  function checkFolder(folderId: string): void {
    if (!deps.brain.folders().some((f) => f.id === folderId)) throw new PackInputError(`Không có thư mục Second Brain "${folderId}".`);
  }
  function checkIdVersion(id: string, version?: string): void {
    if (!packIdSchema.safeParse(id).success) throw new PackInputError('Mã gói không hợp lệ.');
    if (version !== undefined && !isSemver(version)) throw new PackInputError('Phiên bản không hợp lệ.');
  }

  /** Current hash of a note, undefined when absent; throws NoteInputError for paths the brain refuses. */
  function currentHash(notes: NotesService, ref: NoteRef): string | undefined {
    return notes.read(ref)?.hash;
  }

  /** Download, check size/hash/signature, unzip with caps, check the manifest. Cached a few minutes. */
  async function fetchVerified(id: string, version: string): Promise<{ pack: VerifiedPack; keyId: string }> {
    const key = packRef(id, version);
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit;
    const cloud = deps.cloud();
    const info = await cloud.requestDownload(id, version);
    const zip = await cloud.fetchPackZip(info.url, MAX_PACK_BYTES);
    const pack = verifyLocal(zip, id, version, info);
    const entry = { pack, keyId: info.keyId!, at: now() };
    cache.set(key, entry);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return entry;
  }

  function verifyLocal(zip: Uint8Array, id: string, version: string, info: ReleaseInfo): VerifiedPack {
    const pack = verifyPack(zip, { id, version }, info, deps.keys(), deps.unzip);
    const min = pack.manifest.minAppVersion;
    if (min && deps.appVersion && isSemver(deps.appVersion) && compareSemver(min, deps.appVersion) > 0) {
      throw new PackError('pack.json', `gói cần app bản ${min} trở lên (máy này: ${deps.appVersion})`);
    }
    return pack;
  }

  /** What install would do in this folder now. Pure read: nothing is written. */
  function planInstall(pack: VerifiedPack, folderId: string): PackPlan {
    const m: PackManifest = pack.manifest;
    const notes = svc();
    const install = getInstall(m.id, folderId);
    const recorded = new Map(filesOf(m.id, folderId).map((r) => [r.rel_path, r.sha256]));
    const items: PlanItem[] = [];
    const incoming = new Set<string>();

    for (const n of pack.notes) {
      const text = applyImportRules(n, m.id, m.version);
      const hash = sha(text);
      const ref = { folderId, relPath: n.relPath };
      incoming.add(n.relPath);
      let cur: string | undefined;
      try {
        cur = currentHash(notes, ref);
      } catch (e) {
        items.push({ path: n.relPath, loai: n.loai, action: 'skip', reason: `Brain từ chối đường dẫn này: ${(e as Error).message}` });
        continue;
      }
      const mine = recorded.get(n.relPath);
      const others = owner(folderId, n.relPath).filter((r) => r.pack_id !== m.id);
      if (others.length) {
        items.push({ path: n.relPath, loai: n.loai, action: 'skip', reason: `Đường dẫn này thuộc gói ${others[0]!.pack_id}; không ghi đè.` });
      } else if (cur === undefined) {
        if (mine !== undefined) items.push({ path: n.relPath, loai: n.loai, action: 'skip', reason: REASON.deleted });
        else items.push({ path: n.relPath, loai: n.loai, action: 'create', hash });
      } else if (mine === undefined) {
        items.push({ path: n.relPath, loai: n.loai, action: 'skip', reason: REASON.exists, expectHash: cur });
      } else if (cur !== mine) {
        items.push({ path: n.relPath, loai: n.loai, action: 'skip', reason: REASON.edited, expectHash: cur });
      } else if (cur === hash) {
        items.push({ path: n.relPath, loai: n.loai, action: 'same', hash, expectHash: cur });
      } else {
        items.push({ path: n.relPath, loai: n.loai, action: 'update', hash, expectHash: cur });
      }
    }
    // files of the installed version that the new one dropped
    for (const [rel, rec] of recorded) {
      if (incoming.has(rel)) continue;
      items.push(dropItem(notes, folderId, rel, rec, REASON.droppedEdited));
    }
    items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const plan = {
      packId: m.id, version: m.version, name: m.name, module: m.module, folderId,
      from: install?.version ?? null, items, assets: pack.assets, counts: countsOf(items),
    };
    return { ...plan, planId: planIdOf(['install', pack.sha256, folderId, plan.from, items]) };
  }

  /** A recorded file leaving the pack: delete when unchanged, keep when edited, forget when gone. */
  function dropItem(notes: NotesService, folderId: string, rel: string, recordedHash: string, editedReason: string): PlanItem {
    let cur: string | undefined;
    try {
      cur = currentHash(notes, { folderId, relPath: rel });
    } catch (e) {
      return { path: rel, action: 'keep', reason: `Brain từ chối đường dẫn này: ${(e as Error).message}` };
    }
    if (cur === undefined) return { path: rel, action: 'forget' };
    if (cur !== recordedHash) return { path: rel, action: 'keep', reason: editedReason, expectHash: cur };
    return { path: rel, action: 'delete', expectHash: cur };
  }

  function planUninstall(packId: string, folderId: string): PackPlan {
    const install = getInstall(packId, folderId);
    if (!install) throw new PackNotInstalledError(packId, folderId);
    const notes = svc();
    const items = filesOf(packId, folderId).map((r) => dropItem(notes, folderId, r.rel_path, r.sha256, REASON.uninstallEdited));
    const plan = {
      packId, version: install.version, name: install.name, module: install.module, folderId,
      from: install.version, items, assets: [], counts: countsOf(items),
    };
    return { ...plan, planId: planIdOf(['uninstall', packId, folderId, install.version, items]) };
  }

  function guard<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) return Promise.reject(new PackBusyError());
    busy = true;
    return fn().finally(() => {
      busy = false;
    });
  }

  /** Apply a plan's file changes in one batch (one commit), then record what was actually done. */
  async function apply(
    plan: PackPlan,
    message: string,
    texts: Map<string, string>,
    record: (done: { written: Map<string, string>; deleted: string[]; forgotten: string[] }) => void,
  ): Promise<InstallResult> {
    const written = new Map<string, string>();
    const deleted: string[] = [];
    const forgotten: string[] = [];
    const skipped: InstallResult['skipped'] = [];
    const kept: InstallResult['kept'] = [];
    try {
      await svc().batch(message, (b) => {
        for (const item of plan.items) {
          const ref = { folderId: plan.folderId, relPath: item.path };
          try {
            switch (item.action) {
              case 'create':
              case 'update': {
                const text = texts.get(item.path)!;
                const note = b.write(ref, text, { message, ...(item.action === 'update' ? { expectHash: item.expectHash } : {}) });
                written.set(item.path, note.hash);
                break;
              }
              case 'delete':
                b.remove(ref, { message, expectHash: item.expectHash });
                deleted.push(item.path);
                break;
              case 'forget':
                forgotten.push(item.path);
                break;
              case 'keep':
                forgotten.push(item.path);
                kept.push({ path: item.path, reason: item.reason ?? '' });
                break;
              case 'skip':
                // a note the owner deleted stays recorded, so later updates keep not recreating it
                skipped.push({ path: item.path, reason: item.reason ?? '' });
                break;
              case 'same':
                break;
            }
          } catch (e) {
            if (!(e instanceof NoteConflictError) && !(e instanceof NoteInputError)) throw e;
            log.warn({ pack: plan.packId, file: item.path, err: e.message }, 'gói: bỏ qua ghi chú vừa đổi');
            (item.action === 'delete' ? kept : skipped).push({ path: item.path, reason: REASON.raced });
          }
        }
      });
    } finally {
      // whatever reached the disk is recorded, even when a later file failed
      db.transaction(() => record({ written, deleted, forgotten }))();
    }
    return { packId: plan.packId, version: plan.version, folderId: plan.folderId, message, written: [...written.keys()], deleted, skipped, kept };
  }

  /** Packs installed on this machine, per folder. */
  function installed(): InstallRow[] {
    const rows = db
      .prepare(
        `SELECT i.*, (SELECT COUNT(*) FROM pack_files f WHERE f.pack_id = i.pack_id AND f.folder_id = i.folder_id) AS files
         FROM pack_installs i ORDER BY i.pack_id, i.folder_id`,
      )
      .all() as (InstallDbRow & { files: number })[];
    return rows.map((r) => ({
      packId: r.pack_id, version: r.version, folderId: r.folder_id, module: r.module, name: r.name,
      installedAt: new Date(r.installed_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), files: r.files,
    }));
  }

  /** Files this pack wrote in a folder, with whether the owner changed them since. */
  function files(packId: string, folderId: string): { path: string; status: 'unchanged' | 'edited' | 'missing' | 'unsafe' }[] {
    const notes = svc();
    return filesOf(packId, folderId).map((r) => {
      try {
        const cur = currentHash(notes, { folderId, relPath: r.rel_path });
        return { path: r.rel_path, status: cur === undefined ? 'missing' : cur === r.sha256 ? 'unchanged' : 'edited' };
      } catch {
        return { path: r.rel_path, status: 'unsafe' as const };
      }
    });
  }

  return {
    installed,

    files,

    async preview(id: string, version: string, folderId: string): Promise<PackPlan> {
      checkIdVersion(id, version);
      checkFolder(folderId);
      const { pack } = await fetchVerified(id, version);
      return planInstall(pack, folderId);
    },

    /** Install or update to `version`. `planId` must be the one the owner saw in the preview. */
    install(id: string, version: string, folderId: string, planId: string): Promise<InstallResult> {
      checkIdVersion(id, version);
      checkFolder(folderId);
      return guard(async () => {
        const { pack, keyId } = await fetchVerified(id, version);
        const plan = planInstall(pack, folderId);
        if (plan.planId !== planId) throw new PlanChangedError();
        const m = pack.manifest;
        const texts = new Map(pack.notes.map((n) => [n.relPath, applyImportRules(n, m.id, m.version)]));
        const message = plan.from ? `goi: cập nhật ${m.id} ${plan.from} → ${m.version}` : `goi: cài ${packRef(m.id, m.version)}`;
        const at = now();
        const result = await apply(plan, message, texts, ({ written, deleted, forgotten }) => {
          db.prepare(
            `INSERT INTO pack_installs (pack_id, version, folder_id, module, name, zip_sha256, key_id, installed_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (pack_id, folder_id) DO UPDATE SET version = excluded.version, module = excluded.module, name = excluded.name,
               zip_sha256 = excluded.zip_sha256, key_id = excluded.key_id, updated_at = excluded.updated_at`,
          ).run(m.id, m.version, folderId, m.module, m.name, pack.sha256, keyId, at, at);
          const upsert = db.prepare(
            `INSERT INTO pack_files (pack_id, folder_id, rel_path, sha256) VALUES (?, ?, ?, ?)
             ON CONFLICT (pack_id, folder_id, rel_path) DO UPDATE SET sha256 = excluded.sha256`,
          );
          for (const [rel, hash] of written) upsert.run(m.id, folderId, rel, hash);
          const drop = db.prepare('DELETE FROM pack_files WHERE pack_id = ? AND folder_id = ? AND rel_path = ?');
          for (const rel of [...deleted, ...forgotten]) drop.run(m.id, folderId, rel);
        });
        log.info({ pack: packRef(m.id, m.version), folderId, written: result.written.length, skipped: result.skipped.length }, 'đã cài gói dữ liệu');
        return result;
      });
    },

    uninstallPreview(id: string, folderId: string): PackPlan {
      checkIdVersion(id);
      return planUninstall(id, folderId);
    },

    uninstall(id: string, folderId: string, planId: string): Promise<InstallResult> {
      checkIdVersion(id);
      return guard(async () => {
        const plan = planUninstall(id, folderId);
        if (plan.planId !== planId) throw new PlanChangedError();
        const message = `goi: gỡ ${packRef(id, plan.version)}`;
        const result = await apply(plan, message, new Map(), ({ deleted }) => {
          const drop = db.prepare('DELETE FROM pack_files WHERE pack_id = ? AND folder_id = ? AND rel_path = ?');
          for (const rel of deleted) drop.run(id, folderId, rel);
          // edited files stay as the owner's own notes: the pack no longer claims anything in this folder
          db.prepare('DELETE FROM pack_files WHERE pack_id = ? AND folder_id = ?').run(id, folderId);
          db.prepare('DELETE FROM pack_installs WHERE pack_id = ? AND folder_id = ?').run(id, folderId);
        });
        log.info({ pack: packRef(id, plan.version), folderId, deleted: result.deleted.length, kept: result.kept.length }, 'đã gỡ gói dữ liệu');
        return result;
      });
    },

    /** Store listing with what is installed here and whether a newer release exists. */
    async catalog(module?: string) {
      const { items } = await deps.cloud().listPacks(module);
      const installs = installed();
      return items.map((p) => {
        const mine = installs.filter((i) => i.packId === p.id).map((i) => ({ folderId: i.folderId, version: i.version }));
        const latest = p.latest?.version;
        return { ...p, installs: mine, updateAvailable: !!latest && mine.some((i) => compareSemver(latest, i.version) > 0) };
      });
    },

    async detail(id: string) {
      checkIdVersion(id);
      const pack = await deps.cloud().getPack(id);
      const installs = installed().filter((i) => i.packId === id);
      return { ...pack, installs: installs.map((i) => ({ ...i, fileStatus: files(id, i.folderId) })) };
    },

    /** Newer or yanked releases of what is installed (cloud GET /packs/updates). */
    async updates() {
      const have = [...new Set(installed().map((i) => packRef(i.packId, i.version)))];
      if (!have.length) return [];
      return (await deps.cloud().packUpdates(have)).items;
    },

    /** tests and the route: drop the cached download (e.g. after a failed install) */
    forget(id: string, version: string): void {
      cache.delete(packRef(id, version));
    },
  };
}

export type PackService = ReturnType<typeof createPackService>;
