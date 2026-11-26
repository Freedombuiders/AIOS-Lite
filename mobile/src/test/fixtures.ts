import type { ApiPack, ApiRelease, ApiSession, ApiUser, MeResponse, PackDetail, PackListItem } from '../../../packages/api-types/src/index';

const T = '2026-11-26T09:00:00.000Z';

export const release = (over: Partial<ApiRelease> = {}): ApiRelease => ({
  id: 'rel_1', version: '1.2.0', status: 'published', size: 148_000, sha256: 'a'.repeat(64), notesCount: 12, keyId: 'k2026',
  minAppVersion: null, license: 'CC-BY-4.0', author: 'AgenticOS', createdAt: T, publishedAt: T, yankedAt: null, ...over,
});

const basePack = (over: Partial<ApiPack> = {}): ApiPack => ({
  id: 'tra-va-qua-tang-co-ban', module: 'learn', name: 'Trà và quà tặng: bộ khởi đầu', summary: 'Bài học nội dung cho shop trà',
  industry: 'tra', visibility: 'public', coverUrl: null, createdAt: T, updatedAt: T, ...over,
});

export const listItem = (over: Partial<PackListItem> = {}): PackListItem => ({ ...basePack(), latest: release(), ...over });

export const detail = (over: Partial<PackDetail> = {}): PackDetail => ({
  ...basePack(),
  license: 'CC-BY-4.0',
  author: 'AgenticOS',
  latest: release(),
  releases: [release()],
  files: [
    { path: 'notes/bai-hoc/video-huong-dan-ngan.md', loai: 'bai-hoc', sha256: 'b'.repeat(64) },
    { path: 'notes/cong-thuc/huong-dan-3-buoc.md', loai: 'cong-thuc', sha256: 'c'.repeat(64) },
    { path: 'assets/bia.png', loai: null, sha256: 'd'.repeat(64) },
  ],
  ...over,
});

export const user = (over: Partial<ApiUser> = {}): ApiUser => ({
  id: 'usr_1', email: 'lan@example.com', name: 'Chị Lan', avatarUrl: null, role: 'user', status: 'active', createdAt: T, lastSeenAt: T, ...over,
});

export const session = (over: Partial<ApiSession> = {}): ApiSession => ({
  id: 'ses_1', kind: 'mobile', label: 'iPhone của Lan', createdAt: T, expiresAt: '2027-02-24T09:00:00.000Z', current: true, ...over,
});

export const me = (over: Partial<MeResponse> = {}): MeResponse => ({
  user: user(),
  sessions: [session(), session({ id: 'ses_2', kind: 'machine', label: 'Máy ở nhà', current: false })],
  ...over,
});
