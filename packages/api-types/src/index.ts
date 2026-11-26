/**
 * Request and response shapes of agenticos-cloud (cloud/), as the app sees them.
 *
 * Types only: nothing here exists at run time, so import with `import type`.
 * cloud/ annotates its JSON helpers and responses with these types, so a route
 * that stops matching fails `npm run typecheck` there; cloud/src/routes/contract.test.ts
 * additionally checks the real responses carry exactly these keys.
 *
 * Times are ISO-8601 UTC strings. Errors are `ApiErrorBody`.
 */

/** Kinds of pack the store lists. Mirrors PACK_MODULES in cloud/src/packs/format.ts. */
export type PackModule = 'brain' | 'learn' | 'dream' | 'crm';
export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled';
/** Why a session was created. The app always asks for `mobile`. */
export type SessionKind = 'mobile' | 'machine' | 'web';
export type ReleaseStatus = 'pending' | 'draft' | 'published' | 'yanked';
export type PackVisibility = 'public' | 'unlisted';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface ApiUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface ApiSession {
  id: string;
  kind: SessionKind;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  /** True for the session that made this request. */
  current: boolean;
}

/** POST /auth/google */
export interface GoogleSignInRequest {
  idToken: string;
  kind: SessionKind;
  label?: string;
}

/** Response of POST /auth/google (and /auth/exchange, /auth/dev). `token` is shown once. */
export interface AuthResponse {
  token: string;
  user: ApiUser;
  session: ApiSession;
}

/** GET /me */
export interface MeResponse {
  user: ApiUser;
  sessions: ApiSession[];
}

/** POST /auth/logout, DELETE /me/sessions/:id, DELETE /me */
export interface OkResponse {
  ok: true;
}

export interface ApiRelease {
  id: string;
  version: string;
  status: ReleaseStatus;
  /** Bytes of the zip. */
  size: number | null;
  sha256: string | null;
  notesCount: number | null;
  keyId: string | null;
  minAppVersion: string | null;
  license: string | null;
  author: string | null;
  createdAt: string;
  publishedAt: string | null;
  yankedAt: string | null;
}

export interface ApiPack {
  id: string;
  module: PackModule;
  name: string;
  summary: string | null;
  industry: string | null;
  visibility: PackVisibility;
  coverUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An item of GET /packs: the pack and its newest published release. */
export interface PackListItem extends ApiPack {
  latest: ApiRelease;
}

/** GET /packs?module=&industry=&q= */
export interface PackListResponse {
  items: PackListItem[];
}

export interface PackFile {
  path: string;
  /** Note kind (`loai`) for notes, null for assets. */
  loai: string | null;
  sha256: string;
}

/** GET /packs/:id. `latest` is null only for an admin looking at a pack with no published release. */
export interface PackDetail extends ApiPack {
  license: string | null;
  author: string | null;
  latest: ApiRelease | null;
  releases: ApiRelease[];
  /** Files of the latest release. */
  files: PackFile[];
}
