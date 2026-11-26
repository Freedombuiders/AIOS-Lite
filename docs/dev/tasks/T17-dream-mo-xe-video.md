# T17 · Dream 100 phần 2: tải và đo video

> Nhánh Marketing · 2 ngày · Phụ thuộc: T16 · Kế hoạch mục 5.7.5

## Mục tiêu

Với mỗi video nổi bật: biết nó mở đầu thế nào, cấu trúc ra sao, cắt nhanh hay chậm. Không giữ lại nội dung của người khác.

## File đụng tới

| File | Loại |
|---|---|
| `modules/_lib/media-tools/` | MỚI: tìm `yt-dlp`, `ffmpeg`, `ffprobe`; phần kiểm chuyển từ `modules/video/server/edit/doctor.ts` |
| `modules/dream/server/analyze.ts`, `measure.ts`, `label.ts` | MỚI |
| `modules/video/server/edit/doctor.ts` | SỬA: gọi thư viện chung |

## Các bước

- [ ] `media-tools`: trả đường dẫn công cụ (tôn trọng `VIDEO_EDIT_FFMPEG`, `VIDEO_EDIT_FFPROBE`) và báo cái nào thiếu kèm lệnh cài.
- [ ] `measure.ts`, mỗi bước là một hàm nhận thư mục làm việc:
  1. Tải: `yt-dlp --no-playlist --max-filesize 200M -f "bv*[height<=720]+ba/b[height<=720]" --write-info-json --write-auto-subs --sub-langs "vi.*,en"`.
  2. Độ dài: `ffprobe`.
  3. Mốc đổi cảnh: `ffmpeg -vf "select='gt(scene,0.3)',showinfo"`. Tính số lần cắt mỗi phút, số cắt trong 3 giây đầu, cảnh dài nhất.
  4. Bốn khung hình của 3 giây đầu, rộng 540.
- [ ] Mọi lệnh chạy bằng `execFile` với mảng tham số, có giới hạn thời gian (5 phút cho tải, 2 phút cho mỗi lệnh `ffmpeg`), không qua shell. Link video là dữ liệu từ mạng: không nối vào chuỗi lệnh.
- [ ] Thư mục làm việc là `data/modules/dream/tmp/<id>/`. Bọc cả quy trình trong `try / finally` xoá thư mục. Lúc module khởi động, xoá mọi thứ còn sót trong `tmp/`.
- [ ] `label.ts`: một lượt `lean` nhận phụ đề (bọc `untrusted`, cắt còn 3.000 ký tự), các số đo, và khung hình nếu `ctx.agents.attachments(agentId).images` là thật. Đòi `{ mo_dau, cau_truc, keu_goi, giay_keu_goi }`, giá trị trong danh sách cho phép.
- [ ] Ghi `dream-100/video/<ngày>-<kênh>-<id>.md` (`loai: video-dream`). Thân ghi chú: bảng số đo, mô tả cấu trúc bằng lời của bot. **Không** lưu phụ đề, khung hình, hay file video.
- [ ] Cài đặt chọn agent phân tích. Ghi rõ trong giao diện: agent chạy trên GenBot không nhận ảnh, nên chỉ phân tích bằng phụ đề.
- [ ] Thiếu `yt-dlp`: bỏ qua bước này, ghi chú video vẫn được tạo với số đo công khai và dòng "chưa mổ xẻ được vì thiếu yt-dlp".
- [ ] Video riêng tư, cần đăng nhập, hoặc quá 200 MB: ghi lý do, không thử cách khác.
- [ ] Trang Video nổi bật hiện phần mổ xẻ.

## Test

Dùng bản giả của các lệnh (script trong `test-fixtures/`), không tải gì thật.

- Quy trình đủ ghi đúng ghi chú và thư mục tạm trống.
- Lệnh `ffmpeg` giả trả lỗi: thư mục tạm vẫn trống, ghi chú có lý do.
- Lệnh giả treo: bị ngắt sau giới hạn thời gian.
- Link chứa ký tự của shell không gây chạy lệnh (kiểm tham số nhận được ở lệnh giả).
- Thiếu `yt-dlp`: không lỗi.
- Tìm trong ghi chú ra: không có nội dung phụ đề.

## Xong khi

- `npx vitest run modules/dream modules/video` qua.
- Với một video công khai thật: có ghi chú với số lần cắt mỗi phút, và `data/modules/dream/tmp/` trống.

## Ghi chú

Ngưỡng đổi cảnh 0,3 bỏ sót chuyển cảnh mềm và đếm thừa khi có hiệu ứng chớp. Ghi số cắt là "khoảng", trong ghi chú và trên màn.
