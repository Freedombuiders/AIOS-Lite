/**
 * The platform boundary. Business code (routes, auth, packs, uploads) only
 * touches the database, file store, clock, randomness and outbound HTTP through
 * `Env`, never a Workers or Node API directly. src/index.ts builds an `Env` from
 * Workers bindings; a Node entry point could build one from better-sqlite3 and
 * an S3 client without changing any route.
 */
import type { JWTVerifyGetKey } from 'jose';

/** The subset of D1's prepared statement the app uses. better-sqlite3 can be adapted to it. */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  /** Runs the statements in one transaction: all apply or none. */
  batch(statements: SqlStatement[]): Promise<unknown[]>;
}

export interface BlobHead { size: number; contentType?: string }

export interface PresignedPut {
  url: string;
  /** Headers the uploader must send exactly as given; they are part of the signature. */
  headers: Record<string, string>;
}

/** Object storage (R2). Keys never contain user-supplied file names. */
export interface BlobStore {
  head(key: string): Promise<BlobHead | null>;
  /** Whole object, or `length` bytes from `offset`. Null when missing. */
  get(key: string, range?: { offset: number; length: number }): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  delete(keys: string | string[]): Promise<void>;
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>;
  /** A URL the client PUTs the file to directly; the Worker never relays the bytes. */
  presignPut(key: string, opts: { contentType: string; contentLength: number; expiresInSec: number }): Promise<PresignedPut>;
  /** A URL anyone holding it can GET until it expires. */
  presignGet(key: string, expiresInSec: number): Promise<string>;
}

export interface Logger {
  /** Never pass tokens, ID tokens, one-time codes or signed URLs here. */
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Config {
  /** OAuth client ids accepted as `aud` of a Google ID token (iOS, Android, web). */
  googleClientIds: string[];
  /** Web client used by the desktop login flow (/auth/web/*). */
  googleWebClientId?: string;
  googleWebClientSecret?: string;
  /** Lower-cased emails that become admins when they sign in. */
  adminEmails: string[];
  /** Public origin of the Worker, used for the OAuth redirect URI. Falls back to the request origin. */
  publicUrl?: string;
  authRateLimit: { limit: number; windowSec: number };
  /** keyId → base64 raw Ed25519 public key, for pack signatures. */
  packSigningKeys: Record<string, string>;
  /** Bytes each user may keep in R2 uploads (pending and ready). */
  uploadQuotaBytes: number;
  /** Local development only: enables /auth/dev and local blob URLs, and only on localhost. */
  devMode: boolean;
}

export interface Env {
  db: SqlDb;
  blobs: BlobStore;
  /** Milliseconds since epoch. */
  now(): number;
  randomBytes(length: number): Uint8Array;
  /** Outbound HTTP (Google token endpoint). Injected so tests never reach the network. */
  fetch: FetchLike;
  /** Google's signing keys for ID tokens. */
  googleKeys: JWTVerifyGetKey;
  config: Config;
  log: Logger;
}
