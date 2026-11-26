/**
 * Open AgenticOS cloud: the owner's account on the cloud service in cloud/.
 * For now it lets agents put a photo or video on R2 and get a temporary public
 * link, for platforms that must fetch media from a URL. Publishing to Facebook,
 * Instagram and TikTok through Composio already uploads local files itself, so
 * this is an extra option, not a replacement.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IntegrationCommand, IntegrationCommandContext, IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../types.js';
import { IntegrationApiError, IntegrationUsageError } from '../types.js';
import { assertFlags, enumFlag, requirePositional } from '../arg-helpers.js';
import type { FetchImpl } from '../media-http.js';
import { createCloudClient, normaliseCloudUrl, type CloudClient } from './client.js';

/** Same rules as cloud/src/uploads/media.ts. */
const MEDIA = [
  { type: 'image/jpeg', maxBytes: 10 * 1024 * 1024, test: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', maxBytes: 10 * 1024 * 1024, test: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/webp', maxBytes: 10 * 1024 * 1024, test: (b: Buffer) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  { type: 'video/mp4', maxBytes: 200 * 1024 * 1024, test: (b: Buffer) => b.toString('latin1', 4, 8) === 'ftyp' },
] as const;

const PURPOSES = ['post-media', 'avatar'] as const;

export interface CloudDeps { fetchImpl?: FetchImpl }

/** A client for the stored values; throws IntegrationUsageError when the owner has not signed in. */
export function cloudClientFor(values: IntegrationValues | null | undefined, deps: CloudDeps = {}, signal?: AbortSignal): CloudClient {
  return clientFor(values ?? {}, deps, signal);
}

function clientFor(values: IntegrationValues, deps: CloudDeps, signal?: AbortSignal): CloudClient {
  const token = values.session_token?.trim();
  if (!token) throw new IntegrationUsageError('Chưa đăng nhập AgenticOS Cloud. Chủ bấm "Đăng nhập cloud" ở trang Kết nối hoặc Kho dữ liệu.');
  return createCloudClient({ baseUrl: normaliseCloudUrl(values.cloud_url), token, fetchImpl: deps.fetchImpl, signal });
}

/** Reads a local photo or video, recognising its type from the first bytes (never from the extension). */
export async function readMedia(file: string): Promise<{ data: Buffer; contentType: string }> {
  const abs = path.resolve(file);
  let stat;
  try { stat = await fs.stat(abs); } catch { throw new IntegrationUsageError(`Không thấy tệp: ${file}`); }
  if (!stat.isFile() || stat.size === 0) throw new IntegrationUsageError(`Không phải tệp có nội dung: ${file}`);
  if (stat.size > 200 * 1024 * 1024) throw new IntegrationUsageError('Tệp quá 200 MB.');
  const data = await fs.readFile(abs);
  const kind = MEDIA.find((m) => m.test(data));
  if (!kind) throw new IntegrationUsageError('Chỉ tải lên được ảnh JPEG, PNG, WebP hoặc video MP4.');
  if (data.length > kind.maxBytes) throw new IntegrationUsageError(`${kind.type.startsWith('video') ? 'Video' : 'Ảnh'} tối đa ${kind.maxBytes / 1024 / 1024} MB.`);
  return { data, contentType: kind.type };
}

export function buildCloudCommands(deps: CloudDeps = {}): IntegrationCommand[] {
  return [
    {
      name: 'upload',
      access: 'write',
      usage: '<local file> [--purpose post-media|avatar]',
      description: 'Upload a local JPEG/PNG/WebP photo or MP4 video to the cloud. Returns a public read URL valid 24 hours; post media is deleted after 7 days.',
      async run(ctx: IntegrationCommandContext, args) {
        assertFlags(args, ['purpose']);
        const file = requirePositional(args, 0, 'đường dẫn tệp', 'upload /path/anh.jpg');
        if (args.positionals.length > 1) throw new IntegrationUsageError('Chỉ một tệp mỗi lần. Đường dẫn có dấu cách thì đặt trong ngoặc kép.');
        const purpose = enumFlag(args, 'purpose', PURPOSES) ?? 'post-media';
        const { data, contentType } = await readMedia(file);
        const client = clientFor(ctx.values, deps, ctx.signal);
        const started = await client.startUpload({ contentType, size: data.length, purpose });
        await client.putToStorage(started.uploadUrl, started.headers, data);
        const done = await client.completeUpload(started.id);
        return { id: done.id, url: done.url, expiresAt: done.expiresAt, contentType, size: data.length, purpose };
      },
    },
    {
      name: 'uploads list',
      access: 'read',
      usage: '[--purpose post-media|avatar]',
      description: 'List my uploaded files with a fresh 24-hour read URL for each ready one.',
      async run(ctx, args) {
        assertFlags(args, ['purpose']);
        return clientFor(ctx.values, deps, ctx.signal).listUploads(enumFlag(args, 'purpose', PURPOSES));
      },
    },
    {
      name: 'uploads delete',
      access: 'write',
      risk: 'destructive',
      usage: '<upload id>',
      description: 'Delete one uploaded file now; its links stop working.',
      async run(ctx, args) {
        assertFlags(args, []);
        const id = requirePositional(args, 0, 'id tệp', 'uploads delete upl_abc');
        if (!/^upl_[A-Za-z0-9_-]{1,40}$/.test(id)) throw new IntegrationUsageError('id tệp có dạng upl_…');
        return clientFor(ctx.values, deps, ctx.signal).deleteUpload(id);
      },
    },
  ];
}

/** Checks the session with GET /me. Never throws. */
export async function testCloud(values: IntegrationValues, signal?: AbortSignal, deps: CloudDeps = {}): Promise<IntegrationTestResult> {
  try {
    const { user } = await clientFor(values, deps, signal).me();
    return { ok: true, detail: `Đã kết nối cloud với tài khoản ${user.email}.`, accountLabel: user.email };
  } catch (e) {
    const known = e instanceof IntegrationApiError || e instanceof IntegrationUsageError;
    return { ok: false, detail: `Không kết nối được. ${known ? e.message : 'lỗi không xác định'}` };
  }
}

export const agenticosCloudIntegration: IntegrationDefinition = {
  id: 'agenticos-cloud',
  name: 'AgenticOS Cloud',
  category: 'Hệ thống',
  description: 'Tài khoản của bạn trên AgenticOS Cloud: tải gói dữ liệu ở trang Kho dữ liệu, và cho agent tải ảnh, video lên kho tạm để có đường dẫn công khai cho các nền tảng đăng bài lấy file. Ảnh đăng bài tự xoá sau 7 ngày; cloud không giữ dữ liệu khách của shop.',
  authKind: 'api-key',
  setupSteps: [
    'Cách nhanh: nhập địa chỉ cloud rồi bấm "Đăng nhập cloud". Trình duyệt mở trang đăng nhập Google; xong thì phiên của máy (hạn 90 ngày) được lưu mã hoá, không cần dán gì.',
    'Cách thủ công: trong thư mục cloud của AIOS-Lite chạy npm run login -- --url <địa chỉ cloud>, rồi dán địa chỉ cloud và mã phiên in ra vào hai ô dưới và bấm Lưu & kiểm tra.',
  ],
  fields: [
    { key: 'cloud_url', label: 'Địa chỉ cloud', kind: 'text', required: true, placeholder: 'https://cloud.example.com' },
    { key: 'session_token', label: 'Mã phiên của máy', kind: 'secret', required: true, help: 'Thu hồi được bất cứ lúc nào ở GET /me trên cloud.' },
  ],
  test: (values, signal) => testCloud(values, signal),
  commands: buildCloudCommands(),
  agentGuide: 'AgenticOS Cloud holds the owner\'s account and a temporary file store. Use `upload <file>` when a platform needs a public URL for a photo or video: it returns a link valid 24 hours, and post media is deleted after 7 days. Publishing through Composio already uploads local files, so only use this when a URL is required. Delete files you no longer need with `uploads delete <id>`.',
};
