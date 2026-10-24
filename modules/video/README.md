# AI Video Studio (`video`)

Dựng video quay sẵn, viết kịch bản và sản xuất video cùng KOL, tạo cảnh bằng Google Flow. Việc nặng (chép lời, cắt, ghép, phụ đề, nhạc, xuất MP4) chạy bằng ffmpeg ngay trên máy bạn; agent chỉ đọc chữ và vài khung hình rồi quyết định.

Nhóm menu: **AI Studio** › AI Video Studio (`/m/video`). Có ba tab:

| Tab | Làm gì |
|---|---|
| Studio | Video sản xuất từ ý tưởng: Đạo diễn AI viết kịch bản và phân cảnh cùng các KOL (gọi bằng `@`), xin duyệt chi phí một lần rồi tạo từng cảnh (HeyGen, Veo, fal, Pexels, RocketFlow) và ghép lại. Cũng có chế độ tạo cảnh bằng Google Flow. |
| Video quay sẵn | Tải video thô lên, máy chép lời tiếng Việt, soi chỗ lặng và vấp, Đạo diễn AI lập EditPlan (cắt, hook, phụ đề, hiệu ứng chữ, B-roll, nhạc, bìa). Bạn duyệt rồi máy xuất. |
| Kết nối | Công cụ đã sẵn sàng chưa, giọng HeyGen cho từng KOL, bộ nhận diện thương hiệu, RocketFlow. |

## Cần có trên máy

- **ffmpeg và ffprobe** (bắt buộc). macOS: `brew install ffmpeg`. Module tự tìm ở PATH và `/opt/homebrew/bin`; thiếu thì đầu trang Video Studio hiện hướng dẫn cài. Có thể đặt `VIDEO_EDIT_FFMPEG` / `VIDEO_EDIT_FFPROBE` tới đường dẫn đầy đủ.
- Chép lời (video quay sẵn): `brew install whisper-cpp` và tải model `ggml-large-v3-turbo-q5_0.bin` vào `~/.cache/whisper-cpp`.
- Hiệu ứng HyperFrames và xuất có hiệu ứng: Node.js, Google Chrome, `npx hyperframes`.
- Mở trang **Kết nối › Doctor** (biểu tượng kiểm tra trong Studio) để xem từng mục còn thiếu.

## Dữ liệu và kết nối

- Dự án, kho tài nguyên, job và media nằm trong `data/modules/video/` (không có bảng SQL). Remove giữ nguyên dữ liệu.
- **HeyGen** là integration của module, hiện ở Kết nối › Integrations khi module được Add. Dán API key rồi chọn giọng cho từng KOL trong Video Studio › Kết nối.
- **Pexels** (video stock miễn phí) dùng integration Pexels của hệ thống.
- **KOL**: nhân vật, tạo video AI (Veo/fal), chi phí và đăng bài đến từ module `kol`. Chưa Add `kol` thì các bước đó báo "Cần bật module KOL"; dựng video quay sẵn vẫn chạy bình thường.
- **RocketFlow** (Google Flow qua tiện ích Chrome) là tuỳ chọn: đặt `ROCKETFLOW_MCP_SERVER` tới `rocketflow/mcp-server/index.mjs`.

## Agent và quyền

Agent mẫu `video-editor` (Đạo diễn video) được cài khi Add với `studio.read` và `studio.write`. Agent nào làm đạo diễn phải giữ `studio.write`, vì lượt tạo/sản xuất trả lời bằng khối `<aios-action module="video">`. Đạo diễn mặc định: cài đặt `director_agent`, rồi `video-editor`, rồi agent đầu tiên có `studio.write`, rồi `main`.

Hành động agent gọi được:

| Hành động | Quyền | Việc |
|---|---|---|
| `job.create` | studio.write | Tạo video mới (mode `produce` cần KOL, hoặc `create` bằng Flow) |
| `job.status` | studio.read | Trạng thái và tiến độ một việc dựng |
| `job.cancel` | studio.write | Dừng lượt đạo diễn và job nền |
| `create.call`, `produce.call` | studio.write | Công cụ của đạo diễn (brief, kế hoạch, sửa cảnh, xin duyệt chi phí) |

Không công cụ nào tự tốn tiền: mọi khoản chi (Veo, fal, HeyGen, Flow) tạo ra thẻ duyệt trong chat Studio và mục "Cần tôi".

## Job nền

Xuất video, cắt, chép lời, soi cảnh chạy trong hàng đợi của module (lưu ở `data/modules/video/video-edit/jobs.json`, nối lại sau khi khởi động). Tiến độ bắn qua sự kiện `video:job` và `video:step`; nút Dừng trong Studio (hoặc `job.cancel`) huỷ job đang chạy. Video tạo bằng Flow được module tự theo dõi mỗi 10 giây sau khi chủ kênh cho phép tạo (cài đặt `auto_advance_create`).

## Cho module khác

`ctx.modules.get('video')` trả về `{ ffmpegReady(), jobs(projectId) }`.

## Kiểm thử

`npx vitest run modules/video`. Không gọi dịch vụ thật (HeyGen, Veo, fal, Flow, Pexels đều bằng fake); test ghép MP4 thật chỉ chạy khi có ffmpeg.
