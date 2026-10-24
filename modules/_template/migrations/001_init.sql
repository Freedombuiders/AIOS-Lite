-- Chỉ được tạo các bảng đã khai báo trong module.json ("tables").
CREATE TABLE IF NOT EXISTS template_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  answer     TEXT,
  task_id    INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
