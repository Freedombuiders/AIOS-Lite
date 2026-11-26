# T14 · Module `learn` 1: bài là ghi chú, gắn nhãn, phân tích

> Nhánh Marketing · 3 ngày · Phụ thuộc: T02, T12 · Kế hoạch mục 5.6.1, 5.6.2

## Mục tiêu

Mỗi bài đã đăng thành một ghi chú có số đo và nhãn. Từ đó tính được dạng bài nào hiệu quả.

## Bản vẽ tham chiếu

`ContentLab.dc.html`, `ContentNote.dc.html`.

## File đụng tới

| File | Loại |
|---|---|
| `modules/learn/` (`module.json`, `migrations/001_init.sql`, `server/index.ts`, `server/post-notes.ts`, `server/label.ts`, `server/stats.ts`, `web/`) | MỚI |
| `modules/marketing/server/core/publisher.ts`, `analytics/worker.ts` | SỬA: phát sự kiện |
| `modules/social/server/` | SỬA: phát sự kiện khi có số đo video mới |

## Các bước

- [ ] Kiểm `marketing` đã phát sự kiện khi bài chuyển `published` và khi ghi một mốc vào `fb_post_metrics` chưa. Chưa thì thêm `ctx.events.emit('content.published', { id })` và `ctx.events.emit('metrics.snapshot', { postId, milestone })`.
- [ ] Module `learn`: `requires.modules: ["marketing"]`, `enhances: ["social"]`. Bảng `learn_post_index(source, source_id, rel_path, labels_hash, PRIMARY KEY(source, source_id))`.
- [ ] Nghe `content.published`: tạo `noi-dung/bai/<ngày>-<slug>.md` với các khoá tĩnh. Chép `cong_thuc` và `hoc_tu` từ `fb_content.meta` nếu có (xem T18).
- [ ] Nghe `metrics.snapshot`: cập nhật `reach`, `er`, `tb_xem`, `binh_luan`, `chia_se`, `moc_da_do`. ER lấy từ hàm sẵn có của `marketing`.
- [ ] Bài trên Instagram, TikTok, YouTube: cùng đường, nguồn là `social_video_stats`. Chỉ số nào nền tảng không cho thì bỏ khoá đó, không ghi 0.
- [ ] Lúc cài: tạo ghi chú cho các bài 90 ngày gần nhất, theo lô.
- [ ] Gắn nhãn (`label.ts`): một lượt `lean` cho mỗi bài mới. Đưa nội dung bài bọc `untrusted` và danh sách giá trị cho phép của `tru_cot` (lấy từ `noi-dung/tru-cot-noi-dung.md`) và `mo_dau`. Đòi `{ tru_cot, mo_dau }`. Giá trị ngoài danh sách thì bỏ.
- [ ] Chủ sửa nhãn trong Obsidian thì giữ bản của chủ: lưu `labels_hash` lúc máy gắn; khác đi nghĩa là người đã sửa, máy không gắn lại.
- [ ] `stats.ts`, hàm thuần đọc các ghi chú `bai-dang`: ER trung vị theo `dinh_dang` × `tru_cot`, theo `mo_dau`, theo khoảng `do_dai`; kèm số bài mỗi ô.
- [ ] API `GET /api/m/learn/content-lab?days=90` và `GET /api/m/learn/posts/:path`.
- [ ] Trang Phân tích nội dung (thành tab thứ tư của Mạng xã hội qua `useProvides`) và trang Phân tích một bài.
- [ ] Ô có dưới 3 bài hiện mờ kèm chữ "ít mẫu". Ô chưa có bài hiện "chưa thử".

## Test

- Sự kiện đăng bài tạo đúng một ghi chú; phát lại sự kiện không tạo bản thứ hai.
- Mốc 1 giờ rồi 24 giờ: `moc_da_do` có cả hai, `reach` là số mới.
- Agent trả nhãn lạ: không ghi nhãn đó.
- Chủ đổi `mo_dau`, lượt gắn nhãn sau không ghi đè.
- `stats.test.ts` với 24 ghi chú mẫu ra đúng bảng trung vị.

## Xong khi

- `npx vitest run modules/learn modules/marketing` qua.
- Đăng một bài thử: có ghi chú trong 5 giây; sau mốc 1 giờ có `reach`.

## Ghi chú

Mọi con số do code tính. Agent chỉ gắn nhãn và, ở trang một bài, viết lời giải thích dựa trên các số code đưa cho.
