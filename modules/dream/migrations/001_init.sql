-- Dream 100, bản đầu: kênh chủ tự thêm và video chủ dán link. Không có quét tự động.
CREATE TABLE IF NOT EXISTS dream_channels (
  id         TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,                       -- youtube | tiktok | facebook | instagram | threads | web
  url        TEXT NOT NULL UNIQUE,                -- link đã chuẩn hoá
  handle     TEXT NOT NULL,
  why        TEXT,                                -- "học gì ở kênh này", chủ viết
  folder_id  TEXT NOT NULL,
  note_path  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dream_videos (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT,                           -- kênh chủ gắn (có thể trống)
  url             TEXT NOT NULL,
  folder_id       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  step            TEXT,                           -- bước đang chạy, để hiện tiến độ
  reason          TEXT,                           -- lý do lỗi hoặc thiếu dữ liệu, tiếng Việt
  platform        TEXT,
  native_id       TEXT,
  title           TEXT,
  uploader        TEXT,
  views           INTEGER,
  likes           INTEGER,
  comments        INTEGER,
  captured_at     INTEGER,                        -- lúc đọc số đo công khai
  duration_s      REAL,
  cuts            INTEGER,
  cuts_per_min    REAL,
  cuts_first3s    INTEGER,
  longest_scene_s REAL,
  has_subtitles   INTEGER,
  used_frames     INTEGER,
  mo_dau          TEXT,
  cau_truc        TEXT,
  keu_goi         TEXT,
  giay_keu_goi    REAL,
  label_note      TEXT,                           -- vì sao nhãn trống (thiếu phụ đề, bot trả sai…)
  agent_id        TEXT,
  task_id         INTEGER,
  note_path       TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS dream_videos_status ON dream_videos(status, created_at);
