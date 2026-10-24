# Module marketing: Facebook Content Studio

Soạn, lên lịch và đăng bài lên Fanpage; phân tích hiệu quả; tự trả lời bình luận. Cần kết nối `composio` (toolkit `facebook`).

## Bật và tắt

- **Add** tạo 12 bảng `fb_*` (migration `001_init`), chép skill `fb-content`, `fb-comment-reply` và hai agent mẫu `content-fb`, `fb-analyst`.
- Công tắc tổng **Bật Content Studio** (setting `enabled`) mặc định **tắt**: khi tắt, bộ đăng bài và bộ trả lời bình luận không chạy. Hai công tắc phụ: `publish` (đăng bài) và `autoreply` (trả lời tự động), mặc định bật. Đổi ở Module › Marketing Facebook hoặc ở tab Pages.
- **Remove** dừng cả ba bộ nền (đăng bài, bình luận, phân tích). **Purge** xoá bảng `fb_*`.

## Màn hình (nhóm Marketing)

Pages · Kho nội dung · Lịch đăng · Phân tích (Hiệu quả kênh, Bài đã đăng) · Bình luận AI · Quy tắc bình luận, tất cả dưới `/m/marketing/...`. Bảng điều khiển có widget "Bài sắp đăng".

## Quyết định giữ nguyên

Media nằm trên máy (`data/modules/marketing/media/`); app tự đăng đúng phút hẹn; Reels đăng như video dọc; duyệt bài theo từng Page; một Page mỗi lần xem; thao tác cần quyền Page đi qua `graphAsPage`. Bình luận đi theo thứ tự spam → phàn nàn → mẫu từ khoá → agent (từ N chữ trở lên hoặc có "?") → bỏ qua.

## Quyền (scope)

| Scope | Ý nghĩa |
|---|---|
| `content.write` | Soạn và sửa bài trong Kho nội dung (không được đăng) |
| `publish` | Duyệt và đăng bài |
| `comments.reply` | Trả lời công khai bình luận. Agent chưa có scope này thì bình luận chuyển cho người và hiện ở "Cần bạn" |
| `analytics.read` | Đọc số liệu phân tích |

Cấp trong `agent.yaml`, mục `access.modules.marketing`. Agent trả lời bình luận mặc định là `main`: chọn lại ở Quy tắc bình luận hoặc cấp `comments.reply` cho `main`.

## Agent

- Lượt trả lời bình luận và lượt phân tích đi qua `ctx.agents.runLean` (có phân quyền, ghi lượt chạy, tính chi phí), vẫn dùng hợp đồng JSON `{action, text, privateText, topic, reason}` của bản gốc và kiểm tra lại trước khi gửi.
- Khung chat ở Kho nội dung dùng cuộc trò chuyện của lõi (`ChatThread`), mặc định với agent `content-fb`; các bài tick chọn được gửi kèm làm ngữ cảnh.
- Skill `fb-content` ghi vào Kho bằng hành động module: agent kết thúc câu trả lời bằng `<aios-action module="marketing" name="content.add|content.update|content.schedule">{json}</aios-action>`. Lõi kiểm scope `content.write`, chạy handler (`server/actions.ts`, dùng lại luật và kiểm tra của bản gốc), ghi kết quả thành bình luận task và nhật ký. Hành động không đính kèm media.

## Cho module khác (`provides`)

`topPosts(pageId?, days)` trả bài organic kèm reach, reactions, comments, shares; `pageInfo(pageId)` trả `{ id, name, timezone, status }`. Module `ads` lấy qua `ctx.modules.get('marketing')`.

## Thông báo

Phàn nàn, kết nối hết hạn, lỗi đăng bài và bình luận cần người đều thành mục "Cần bạn" (`ctx.attention.raise`).

## Kiểm thử

`npx vitest run modules/marketing` (không gọi Facebook hay Composio thật; Composio được giả bằng `vi.mock`, lượt agent bằng `test-runtime.ts`).
