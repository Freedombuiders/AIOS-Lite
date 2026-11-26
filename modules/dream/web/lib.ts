// Types and labels shared by the Dream 100 pages.

export interface ToolStatus {
  tool: 'yt-dlp' | 'ffmpeg' | 'ffprobe';
  path: string | null;
  fix?: string;
}

export interface Overview {
  folder: string | null;
  folderError: string | null;
  channels: number;
  maxChannels: number;
  agent: { id: string; name: string; images: boolean } | null;
  agents: { id: string; name: string; images: boolean }[];
  tools: ToolStatus[];
}

export interface Channel {
  id: string;
  platform: string;
  url: string;
  handle: string;
  why: string | null;
  folder_id: string;
  note_path: string | null;
  created_at: number;
  videos: number;
}

export interface Video {
  id: string;
  channel_id: string | null;
  channel_handle: string | null;
  url: string;
  folder_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  step: string | null;
  reason: string | null;
  platform: string | null;
  title: string | null;
  uploader: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  captured_at: number | null;
  duration_s: number | null;
  cuts: number | null;
  cuts_per_min: number | null;
  cuts_first3s: number | null;
  longest_scene_s: number | null;
  has_subtitles: number | null;
  used_frames: number | null;
  mo_dau: string | null;
  cau_truc: string | null;
  keu_goi: string | null;
  giay_keu_goi: number | null;
  label_note: string | null;
  note_path: string | null;
  created_at: number;
}

export const PLATFORM_LABEL: Record<string, string> = {
  youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', web: 'Trang web',
};

export const LABEL_TEXT: Record<string, string> = {
  'cau-hoi': 'Câu hỏi', 'con-so': 'Con số', 'ten-san-pham': 'Nêu tên sản phẩm', 'cau-chuyen': 'Câu chuyện', 'chi-loi-sai': 'Chỉ ra lỗi sai',
  'van-de-giai-phap': 'Vấn đề rồi cách giải', 'huong-dan-buoc': 'Hướng dẫn từng bước', 'danh-sach': 'Danh sách', 'truoc-sau': 'Trước và sau',
  'so-sanh': 'So sánh', 'giai-thich': 'Giải thích một điều', 'trai-nghiem': 'Trải nghiệm, đánh giá', 'hau-truong': 'Hậu trường', khac: 'Kiểu khác',
  'theo-doi': 'Mời theo dõi', 'binh-luan': 'Mời bình luận', 'luu-chia-se': 'Mời lưu hoặc chia sẻ', 'mua-hang': 'Mời mua', 'nhan-tin': 'Mời nhắn tin',
  'xem-tiep': 'Mời xem tiếp', 'khong-co': 'Không kêu gọi', 'thieu-du-lieu': 'Thiếu dữ liệu',
};

export const STEP_LABEL: Record<string, string> = {
  tai: 'Đang tải video', do: 'Đang đo nhịp cắt', 'khung-hinh': 'Đang trích khung hình', 'gan-nhan': 'Bot đang gắn nhãn',
};

export const num = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined ? '—' : n.toLocaleString('vi-VN', { maximumFractionDigits: digits });

export function lengthText(s: number | null): string {
  if (s === null) return 'chưa rõ độ dài';
  const r = Math.round(s);
  if (r < 60) return `${r} giây`;
  const m = Math.floor(r / 60);
  const rest = r % 60;
  return rest ? `${m} phút ${rest}` : `${m} phút`;
}

export const dateTime = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : '—';

// ── D2: formulas and daily suggestions ─────────────────────────────────

export type FormulaState = 'chua-thu' | 'co-ve-hop' | 'hop' | 'chua-hop';

export interface Formula {
  slug: string;
  path: string;
  name: string;
  moDau: string | null;
  cauTruc: string | null;
  maxLen: number | null;
  cutsPerMin: number | null;
  pillar: string | null;
  kyVong: number;
  evidence: number;
  made: number;
  result: number | null;
  ratio: number | null;
  state: FormulaState;
  stateLabel: string;
  exploratory: boolean;
  version: number;
  rejections: number;
}

export interface FormulaProposal {
  id: number;
  moDau: string;
  cauTruc: string;
  label: string;
  suggestedName: string;
  maxDuration: number | null;
  videos: Array<{ id: string; title: string | null; channel: string | null; views: number | null; durationS: number | null; notePath: string | null }>;
  createdAt: number;
}

export interface FormulasDto {
  folder: string | null;
  formulas: Formula[];
  proposals: FormulaProposal[];
  options: { moDau: { value: string; label: string }[]; cauTruc: { value: string; label: string }[] };
}

export interface PostComparison {
  moc: string;
  er?: number | null;
  trung_vi_kenh?: number | null;
  so_bai_nen?: number | null;
  ti_le?: number | null;
  ky_vong?: number | null;
  so_voi_ky_vong?: number | null;
}

export interface FormulaDetailDto {
  formula: Formula;
  body: string;
  result: { da_lam: number; ket_qua: number | null; ti_le_trung_vi: number | null; trang_thai: FormulaState; tham_do: boolean; label: string };
  posts: Array<{ path: string; title: string; publishedAt: string | null; comparisons: PostComparison[] }>;
  videos: Video[];
  remark: string | null;
}

export interface Idea {
  day: string;
  slot: number;
  formula_slug: string;
  formula_version: number;
  kind: 'hop' | 'thu';
  source_video_slug: string | null;
  expected_ratio: number;
  tru_cot: string | null;
  tieu_de: string;
  cau_mo_dau: string;
  viec_can_lam: string;
  nen_tang: string;
  status: 'new' | 'later' | 'given' | 'rejected';
  reject_reason: string | null;
  content_id: number | null;
  task_id: number | null;
  formula: Formula | null;
}

export interface IdeasDto {
  day: string;
  today: string;
  run: { day: string; status: 'running' | 'done'; picked: number; written: number; note_path: string | null; log: string | null; finished_at: number | null } | null;
  items: Idea[];
  history: { suggested: number; given: number; rejected: number; later: number };
}

/** Colours of a formula state (Formulas.dc.html). */
export const STATE_STYLE: Record<FormulaState, { bg: string; fg: string; edge: string }> = {
  hop: { bg: 'rgba(70,194,138,0.16)', fg: '#46c28a', edge: '#46c28a' },
  'co-ve-hop': { bg: 'rgba(109,141,255,0.18)', fg: '#a9bbff', edge: '#6d8dff' },
  'chua-hop': { bg: 'rgba(240,178,74,0.16)', fg: '#f0b24a', edge: '#f0b24a' },
  'chua-thu': { bg: 'rgba(255,255,255,0.07)', fg: 'var(--color-text-muted)', edge: 'var(--color-border-strong)' },
};

/** "gấp 1,57 lần" / "cao hơn 57%" style texts for a ratio to the channel median. */
export function vsMedianText(ratio: number | null): string {
  if (ratio === null) return 'chưa có số';
  const pct = Math.round((ratio - 1) * 100);
  return pct >= 0 ? `cao hơn trung vị kênh ${pct}%` : `thấp hơn trung vị kênh ${-pct}%`;
}
