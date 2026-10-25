# AI Video Studio (`video`)

Dựng video quay sẵn, dựng nhanh theo mẫu edit, viết kịch bản và sản xuất video cùng KOL, tạo cảnh bằng Google Flow. Việc nặng (chép lời, cắt, ghép, phụ đề, nhạc, xuất MP4) chạy bằng ffmpeg ngay trên máy bạn; agent chỉ đọc chữ và vài khung hình rồi quyết định.

Nhóm menu: **AI Studio** › AI Video Studio (`/m/video`). Có bốn tab:

| Tab | Làm gì |
|---|---|
| Studio | Video sản xuất từ ý tưởng: Đạo diễn AI viết kịch bản và phân cảnh cùng các KOL (gọi bằng `@`), xin duyệt chi phí một lần rồi tạo từng cảnh (HeyGen, Veo, fal, Pexels, RocketFlow) và ghép lại. Cũng có chế độ tạo cảnh bằng Google Flow. |
| Video quay sẵn | Tải video thô lên, máy chép lời tiếng Việt, soi chỗ lặng và vấp, Đạo diễn AI lập EditPlan (cắt, hook, phụ đề, hiệu ứng chữ, B-roll, nhạc, bìa). Bạn duyệt rồi máy xuất. |
| Dựng nhanh | Tải video quay thô, chọn một mẫu edit, bấm **AI edit**: máy cắt chỗ vấp, AI thêm chữ theo nhịp nói, cảnh minh hoạ, cảnh trám và nhạc theo mẫu. Bạn chỉnh tay trong editor rồi bấm Xuất. Xem mục [Dựng nhanh](#dựng-nhanh). |
| Kết nối | Công cụ đã sẵn sàng chưa, giọng HeyGen cho từng KOL, bộ nhận diện thương hiệu, RocketFlow. |

## Cần có trên máy

- **ffmpeg và ffprobe** (bắt buộc). macOS: `brew install ffmpeg`. Module tự tìm ở PATH và `/opt/homebrew/bin`; thiếu thì đầu trang Video Studio hiện hướng dẫn cài. Có thể đặt `VIDEO_EDIT_FFMPEG` / `VIDEO_EDIT_FFPROBE` tới đường dẫn đầy đủ.
- Chép lời (video quay sẵn): `brew install whisper-cpp` và tải model `ggml-large-v3-turbo-q5_0.bin` vào `~/.cache/whisper-cpp`.
- Xuất video và hiệu ứng (HyperFrames): Node.js, Google Chrome. Module chạy `npx -y hyperframes@0.8.156`; lần xuất đầu tự tải bản này (cần mạng), hoặc tải sẵn bằng `npx -y hyperframes@0.8.156 --version`.
- Video HDR của iPhone: ffmpeg cần có zimg (bản Homebrew có sẵn) để chuyển sang màu thường. Thiếu thì video HDR giữ nguyên màu, có thể bị gắt.
- Mở trang **Kết nối › Doctor** (biểu tượng kiểm tra trong Studio) để xem từng mục còn thiếu: ffmpeg, zimg, whisper, HyperFrames, Chrome, Pexels. Mục bắt buộc thiếu thì báo đỏ; mục tuỳ chọn (zimg, HyperFrames chưa tải, Pexels chưa có key) chỉ báo vàng.

## Dựng nhanh

Tab **Dựng nhanh** đi qua bốn màn: Trang đầu, Thiết lập, Đang dựng và editor.

1. **Trang đầu**: kéo thả video quay thô. Máy tạo việc dựng và tải lên ngay, rồi chuẩn hoá (video HDR của iPhone sang màu thường), chép lời và soi chỗ lặng, từ đệm trong lúc bạn thiết lập. Bên dưới là thư viện mẫu edit, lọc theo nhãn hoặc tìm theo tên.
2. **Thiết lập**: tự cắt (mức nhẹ, vừa, sát, hoặc tắt để giữ nguyên video), mẫu edit, tư liệu (ảnh, video kèm một dòng mô tả cho từng file), nhạc (AI chọn, chọn bài trong kho, hoặc không nhạc; giảm nhạc khi đang nói), có tìm thêm cảnh trám trên Pexels không, và ghi chú cho AI.
3. **AI edit**: Đạo diễn AI đọc lời chép, luật của mẫu, tư liệu kèm mô tả và kho gợi ý, rồi lập kế hoạch dựng bằng các block của mẫu. Chỗ cần cảnh trám mà không có tư liệu hợp thì máy tự tìm và tải về kho. **Bỏ qua — tự chỉnh tay** thì không gọi AI: máy chỉ cắt và đặt phụ đề theo mẫu.
4. **Đang dựng**: các bước kèm bằng chứng từng bước. Bấm Dừng bất cứ lúc nào; phần đã làm vẫn giữ.
5. **Editor**: xem trước, sửa chữ, hiệu ứng vào, âm thanh, cỡ, vị trí; đổi cảnh trám, đổi nhạc; thêm phần tử; Nhờ AI sửa.
6. **Xuất video**: chỉ lúc này máy mới dựng MP4 1080p và 3 ảnh bìa.

AI edit dựng thẳng tới editor: không dừng chờ duyệt kế hoạch, không tạo thẻ "Cần tôi", và chế độ tự duyệt của hồ sơ kênh không áp cho Dựng nhanh. Bản dựng MP4 chỉ được tạo khi bạn bấm Xuất.

### Mẫu edit

- Một mẫu là bộ block HyperFrames làm sẵn (chữ theo nhịp, cảnh minh hoạ, khung cảnh trám, logo cuối) cùng luật dùng chúng cho đạo diễn. AI không viết HTML: nó chỉ chọn block, điền chữ và neo vào từ trong lời chép.
- Có sẵn **Talking head vàng** (`th-vang`): chữ Anton vàng theo nhịp nói, cảnh các bước và trước–sau trên nền đen, cảnh trám dạng toàn khung, thẻ hoặc vòng tròn trên đầu, tiếng động nhẹ. Kèm 21 mẫu cơ bản bọc các phong cách cũ (`style:<id>`), bấm Cài trong thư viện mẫu để dùng.
- Thêm mẫu: chép thư mục mẫu vào `data/modules/video/video-edit/templates/<id>/` với cùng cấu trúc như `modules/video/templates/th-vang/` (`template.json`, `rules.md`, `components/*.html`, tuỳ chọn `poster.webp` và `preview.mp4`), mở lại tab Dựng nhanh rồi bấm Cài. Manifest hỏng thì thư viện mẫu báo lỗi và không hiện mẫu đó. Cách viết block: `modules/video/templates/README.md`.

### Tư liệu, kho và nguồn

- Cảnh trám lấy theo thứ tự: tư liệu bạn gửi cho video này → Kho của tôi → video Pexels → ảnh Pexels. AI nhìn ảnh nhỏ của từng ứng viên và chấm 1–5 theo câu đang nói, chỉ lấy cảnh từ 3 điểm, không để hai chỗ liền nhau cùng một cảnh. Không có cảnh đạt thì máy bỏ chỗ trám đó và ghi lý do ở bước Đạo diễn.
- File mới vào kho được AI xem vài khung để viết mô tả tiếng Việt và chấm chất lượng; nhạc được đo BPM, nhịp mạnh và gắn mood, thể loại, có lời hay không. Nhờ vậy đạo diễn chỉ chọn trong file có thật.
- Cảnh Pexels tải về kho kèm giấy phép, tên tác giả và link gốc. Nhạc lấy từ Kho của tôi và nhạc CC0 có sẵn, không lấy nhạc trên web.
- Chưa có **Pexels key** thì máy bỏ qua Pexels, chỉ tìm trong tư liệu của bạn và Kho của tôi; Doctor báo vàng, không chặn việc dựng. Tắt "Tìm thêm cảnh trám khi thiếu" cũng chỉ tìm trong hai nguồn đó.

### Sửa tay không bị AI ghi đè

- Mọi chỉnh trong editor (chữ, vị trí, cỡ, hiệu ứng vào, âm thanh, thời điểm, đổi file cảnh trám, đổi nhạc, ẩn phần tử) lưu ở `overrides.json` cạnh dự án, tách khỏi kế hoạch của AI. AI không bao giờ ghi file này; mỗi bản kế hoạch mới đều được áp lại chỉnh tay theo id phần tử.
- Phần tử bạn tự thêm hoặc đã khôi phục luôn được giữ khi Nhờ AI sửa, kể cả khi bản AI mới bỏ quên nó.
- Bản AI mới bỏ mất một phần tử bạn đã sửa thì editor báo và cho khôi phục, chỉnh tay vẫn còn nguyên.

## Dữ liệu và kết nối

- Dự án, kho tài nguyên, job và media nằm trong `data/modules/video/` (không có bảng SQL). Remove giữ nguyên dữ liệu. Dựng nhanh thêm `overrides.json` trong thư mục từng dự án và mẫu cài thêm ở `video-edit/templates/`.
- **HeyGen** là integration của module, hiện ở Kết nối › Integrations khi module được Add. Dán API key rồi chọn giọng cho từng KOL trong Video Studio › Kết nối.
- **Pexels** (video và ảnh stock miễn phí, cho Studio và cảnh trám của Dựng nhanh) dùng integration Pexels của hệ thống: lấy API key miễn phí ở pexels.com/api rồi dán vào Kết nối › Integrations › Pexels.
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

`npx vitest run modules/video`. Không gọi dịch vụ thật (HeyGen, Veo, fal, Flow, Pexels đều bằng fake); test ghép MP4 thật chỉ chạy khi có ffmpeg. `server/edit/quick.integration.test.ts` chạy cả chuỗi Dựng nhanh qua API (tải lên, AI edit, tìm cảnh trám, sửa tay, Nhờ AI sửa, khôi phục, Xuất) bằng công cụ và agent giả.
