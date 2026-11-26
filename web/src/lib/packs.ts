// Kho dữ liệu: data packs from the AgenticOS cloud, and the desktop sign-in (src/api/routes/packs.ts).
import { apiGet, apiPost } from './api';

export const PACK_MODULE_LABEL: Record<string, string> = {
  brain: 'Hồ sơ shop',
  learn: 'Bài học & công thức',
  dream: 'Dream',
  crm: 'Mẫu khách hàng',
};
export const PACK_MODULES = Object.keys(PACK_MODULE_LABEL);

export interface CloudStatus {
  connected: boolean;
  cloudUrl: string;
  account: string;
  status: string;
  returnUrl: string;
  /** a sign-in started here is waiting for the browser to come back */
  pending: boolean;
  lastLogin: ({ ok: true; email: string } | { ok: false; message: string }) & { at: number } | null;
}

export interface PackRelease {
  id: string;
  version: string;
  status: string;
  size: number | null;
  notesCount: number | null;
  license: string | null;
  author: string | null;
  publishedAt: string | null;
  yankedAt: string | null;
}

export interface PackInstallRef { folderId: string; version: string }

export interface PackListItem {
  id: string;
  module: string;
  name: string;
  summary: string | null;
  industry: string | null;
  coverUrl: string | null;
  latest?: Partial<PackRelease> | null;
  installs: PackInstallRef[];
  updateAvailable: boolean;
}

export type FileStatus = 'unchanged' | 'edited' | 'missing' | 'unsafe';

export interface InstalledPack {
  packId: string;
  version: string;
  folderId: string;
  module: string;
  name: string;
  installedAt: string;
  updatedAt: string;
  files: number;
}

export interface PackDetail extends Omit<PackListItem, 'installs' | 'updateAvailable'> {
  license: string | null;
  author: string | null;
  releases: PackRelease[];
  files: { path: string; loai: string | null; sha256: string }[];
  installs: (InstalledPack & { fileStatus: { path: string; status: FileStatus }[] })[];
}

export type PlanAction = 'create' | 'update' | 'same' | 'skip' | 'delete' | 'keep' | 'forget';

export interface PackPlan {
  packId: string;
  version: string;
  name: string;
  module: string;
  folderId: string;
  from: string | null;
  items: { path: string; action: PlanAction; loai?: string; reason?: string }[];
  assets: string[];
  counts: { create: number; update: number; same: number; skip: number; delete: number; keep: number };
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

export interface PackUpdate { id: string; have: string; latest: string | null; update: boolean; yanked: boolean; warning?: string }

export const ACTION_LABEL: Record<PlanAction, string> = {
  create: 'Thêm',
  update: 'Cập nhật',
  same: 'Giữ nguyên',
  skip: 'Bỏ qua',
  delete: 'Xoá',
  keep: 'Giữ lại',
  forget: 'Đã không còn',
};

export const FILE_STATUS_LABEL: Record<FileStatus, string> = {
  unchanged: 'Chưa sửa',
  edited: 'Bạn đã sửa',
  missing: 'Đã xoá',
  unsafe: 'Không đọc được',
};

export const cloudStatus = () => apiGet<CloudStatus>('/cloud/status');

/**
 * Opens the cloud's sign-in page in a new tab and resolves when the callback has come back to this machine
 * (polls /cloud/status for up to 10 minutes). The tab is opened before the request so popup blockers allow it.
 */
export async function signInToCloud(cloudUrl: string | undefined, signal?: AbortSignal): Promise<CloudStatus> {
  const before = (await cloudStatus().catch(() => null))?.lastLogin?.at ?? 0;
  const tab = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
  try {
    const { url } = await apiPost<{ url: string }>('/cloud/login/start', cloudUrl ? { cloudUrl } : {});
    if (tab) tab.location.href = url;
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    tab?.close();
    throw e;
  }
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    if (signal?.aborted) throw new Error('Đã huỷ chờ đăng nhập.');
    const s = await cloudStatus().catch(() => null);
    const last = s?.lastLogin;
    if (s && last && last.at > before) {
      if (!last.ok) throw new Error(last.message);
      return s;
    }
  }
  throw new Error('Hết thời gian chờ đăng nhập cloud. Bấm đăng nhập lại.');
}

export const previewPack = (id: string, version: string, folder: string) =>
  apiPost<PackPlan>(`/packs/${encodeURIComponent(id)}/preview`, { version, folder });
export const installPack = (id: string, version: string, folder: string, planId: string) =>
  apiPost<InstallResult>(`/packs/${encodeURIComponent(id)}/install`, { version, folder, planId });
export const previewUninstall = (id: string, folder: string) =>
  apiPost<PackPlan>(`/packs/${encodeURIComponent(id)}/uninstall/preview`, { folder });
export const uninstallPack = (id: string, folder: string, planId: string) =>
  apiPost<InstallResult>(`/packs/${encodeURIComponent(id)}/uninstall`, { folder, planId });
