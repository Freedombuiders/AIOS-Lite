# T25 · App Expo 2: Cần bạn, Hộp thư Zalo, thông báo đẩy

> Nhánh Mobile · 3 ngày · Phụ thuộc: T07, T24

## Mục tiêu

Chủ shop duyệt việc và trả lời khách từ điện thoại. Có việc mới thì điện thoại rung.

## File đụng tới

| File | Loại |
|---|---|
| `src/mobile/routes/attention.ts`, `inbox.ts`, `push.ts` | MỚI (cổng di động của T23) |
| `src/mobile/push.ts` | MỚI: gửi thông báo |
| `mobile/app/(tabs)/index.tsx`, `inbox.tsx`, `inbox/[id].tsx` | MỚI |

## API cổng di động thêm ở task này

| Method | Path | Phạm vi | Ghi chú |
|---|---|---|---|
| GET | `/mobile/attention` | `read` | Đã có ở T23 |
| POST | `/mobile/attention/:key/resolve` | `approve` | |
| GET | `/mobile/inbox` `?filter=&cursor=` | `read` | Danh sách cuộc chat, kèm nhãn trạng thái của T07 |
| GET | `/mobile/inbox/:id/messages` `?before=` | `read` | 40 tin mỗi lần |
| GET | `/mobile/inbox/:id/draft` | `read` | Nháp đang chờ, nếu có |
| POST | `/mobile/drafts/:id/approve` · `/discard` | `approve` | |
| POST | `/mobile/inbox/:id/send` | `reply` | Chỉ chữ ở bản này |
| PUT | `/mobile/inbox/:id/mode` | `approve` | `auto` · `draft` · `off` |
| PUT | `/mobile/push-token` | `read` | Đăng ký mã thông báo của thiết bị |

Mỗi đường là một lớp mỏng gọi vào dịch vụ sẵn có của `care` qua `ctx.modules.get('care')`. Không viết lại nghiệp vụ.

## Các bước

- [ ] Các đường ở bảng trên, mỗi đường có kiểm phạm vi. Lỗi dùng cùng định dạng với lõi.
- [ ] Màn Cần bạn: danh sách mục cần chú ý, kéo để làm mới. Mục là tin nháp thì mở thẳng cuộc chat; mục là bài đăng chờ duyệt thì hiện nội dung và hai nút Duyệt, Để sau.
- [ ] Màn Hộp thư: danh sách có ba bộ lọc; mở một cuộc chat chiếm cả màn; nháp của bot nằm trên ô nhắn với Gửi, Sửa rồi gửi, Bỏ; nút đổi chế độ ở đầu màn.
- [ ] Tin mới khi đang mở cuộc chat: hỏi lại mỗi 5 giây chỉ các tin mới hơn tin cuối. SSE qua đường hầm không đáng tin trên mạng di động; không dùng ở bản này.
- [ ] Gửi tin dùng một mã yêu cầu do điện thoại sinh (`client_request_id` sẵn có trong `care_delivery_intents`), để bấm hai lần hoặc gửi lại sau lỗi mạng không ra hai tin.
- [ ] Thông báo đẩy: điện thoại lấy mã thông báo của Expo và gửi cho máy. Máy gọi thẳng dịch vụ thông báo của Expo khi có mục cần chú ý mới. Không cần máy chủ riêng.
- [ ] Nội dung thông báo chỉ là loại việc và tên khách ("Chị Lan: có tin nháp chờ duyệt"). Không đưa nội dung tin nhắn vào thông báo.
- [ ] Gộp thông báo: nhiều mục trong 60 giây thành một thông báo có số đếm. Cài đặt giờ yên lặng trên điện thoại.
- [ ] Bấm thông báo mở đúng cuộc chat hoặc đúng mục.
- [ ] Mã thông báo bị dịch vụ báo không còn hợp lệ thì xoá khỏi `devices`.

## Test

- Mỗi đường với thiết bị thiếu phạm vi nhận 403.
- Gửi hai lần cùng `client_request_id` chỉ tạo một dòng trong hàng chờ gửi.
- Duyệt một nháp đã bị thay bằng nháp mới hơn: trả lỗi rõ, không gửi bản cũ.
- Bộ gửi thông báo với dịch vụ giả: gộp đúng, không chứa nội dung tin.
- Luồng Maestro: mở Cần bạn, mở một tin nháp, bấm Gửi.

## Xong khi

- `npx vitest run src/mobile` và `cd mobile && npx jest` qua.
- Thử thật: khách nhắn Zalo, điện thoại nhận thông báo trong 1 phút, mở ra thấy nháp, bấm Gửi, khách nhận được tin.

## Ghi chú

- Các màn dashboard và Dream 100 chưa có trên điện thoại ở bản này.
- Gọi trợ lý bằng giọng nói trên điện thoại chờ kết quả T26.
