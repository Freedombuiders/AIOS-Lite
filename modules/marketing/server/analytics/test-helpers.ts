/**
 * Test fixtures for analytics tests. The db module keeps its connection
 * private, so fixtures that have no production writer here (Pages, comments,
 * studio posts) are inserted through a second connection to the same file.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { _initTestDatabase } from '../store.js';

export interface AnalyticsTestDb {
  raw: Database.Database;
  cleanup: () => void;
}

export function setupAnalyticsDb(): AnalyticsTestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-analytics-'));
  const file = path.join(dir, 'test.db');
  _initTestDatabase(file);
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  return {
    raw,
    cleanup: () => {
      raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface PageFixture {
  id: string;
  name?: string;
  enabled?: number;
  status?: string;
  timezone?: string;
  connectionId?: string;
  entityId?: string;
  pillars?: string[];
  followers?: number | null;
}

export function insertPage(raw: Database.Database, p: PageFixture): void {
  const now = Math.floor(Date.now() / 1000);
  raw.prepare(
    `INSERT INTO fb_pages (id, name, connection_id, entity_id, enabled, status, timezone, pillars_json, followers, role, main_kpi, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Nhận biết', 'reach', ?, ?)`,
  ).run(
    p.id, p.name ?? `Page ${p.id}`, p.connectionId ?? 'ca_1', p.entityId ?? 'user_1', p.enabled ?? 1, p.status ?? 'ACTIVE',
    p.timezone ?? 'Asia/Ho_Chi_Minh', JSON.stringify((p.pillars ?? []).map((name) => ({ name, targetPct: 20 }))), p.followers ?? null, now, now,
  );
}

export interface StudioPostFixture {
  pageId: string;
  fbPostId: string;
  publishedAt: number;
  title?: string;
  format?: string;
  pillar?: string;
  status?: string;
  source?: string;
}

export function insertStudioPost(raw: Database.Database, p: StudioPostFixture): number {
  const now = Math.floor(Date.now() / 1000);
  const info = raw.prepare(
    `INSERT INTO fb_content (page_id, title, caption, format, pillar, status, published_at, fb_post_id, source, origin, created_at, updated_at)
     VALUES (?, ?, 'caption', ?, ?, ?, ?, ?, ?, 'studio', ?, ?)`,
  ).run(p.pageId, p.title ?? `Bài ${p.fbPostId}`, p.format ?? 'reel', p.pillar ?? '', p.status ?? 'published', p.publishedAt, p.fbPostId, p.source ?? 'main', now, now);
  return Number(info.lastInsertRowid);
}

export function insertComment(raw: Database.Database, c: {
  id: string; pageId: string; postId: string; status: string; createdTime: number; fromPage?: number;
}): void {
  raw.prepare(
    `INSERT INTO fb_comments (id, page_id, post_id, message, created_time, fetched_at, from_page, status) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
  ).run(c.id, c.pageId, c.postId, c.createdTime, c.createdTime, c.fromPage ?? 0, c.status);
}
