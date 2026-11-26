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
