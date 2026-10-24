# Gmail

Kênh Gmail cho hộp thư chung Care. Module yêu cầu `care` và kết nối `composio`; manifest để host kiểm tra điều kiện Add. Mọi thay đổi trong đợt port nằm trong `modules/gmail/**`.

## Sử dụng

1. Thêm Composio API key ở Kết nối, thêm Care rồi Add Gmail.
2. Mở `/m/gmail`, chọn **Kết nối Gmail**, hoàn thành OAuth rồi **Làm mới tài khoản**.
3. Bật từng hộp thư, điền chữ ký rồi bật đồng bộ Gmail.
4. Gán agent, duyệt nháp và trả lời trong Care. Gmail không có luồng AI hoặc trang gán agent riêng.

Đồng bộ mỗi **120.000 ms**, không đọc thư trước mốc bật; lưu mốc chính xác theo mili giây và giữ cursor truy vấn theo giây. Bật lại tạo mốc mới. Bỏ thư tự động/bản tin theo bộ nhận diện đã port. Không tải hoặc gửi tệp đính kèm. Trả lời giữ thread Gmail và tự thêm chữ ký; giới hạn gửi áp dụng trên 24 giờ gần nhất, tính cả lần gửi chưa xác định kết quả.

Mặc định module tắt đồng bộ. Các tài khoản mới phát hiện cũng tắt. Remove dừng lịch, đóng connector, giữ dữ liệu. Bật lại không xoá nhật ký gửi: một yêu cầu mất ACK không được tự gửi thêm lần nữa.

## Hợp đồng cần coordinator nối với Care

`server/sync.ts` khai báo `CareProvides`, chỉ truy cập Care qua `ctx.modules.get('care')`:

```ts
careChannels: {
  register(connector: CareConnector): void;
  unregister(kind: string): void;
  ingest(event: NormalizedEvent): unknown | Promise<unknown>;
  getActiveEpoch(accountId: string): number;
}
```

Ba thao tác đầu theo DECISIONS §5. `getActiveEpoch` là yêu cầu bổ sung chưa được quyết định trong tài liệu chung: connector bắt buộc dùng epoch hiện hành từ Care, không tự tạo epoch mặc định. Coordinator cần cung cấp hàm này hoặc thống nhất API thay thế và cập nhật bridge Gmail.

Care cần tạo/ánh xạ tài khoản email với **cùng `email_accounts.id`** (UUID do Gmail cấp), `channel: 'email'`, `connectorKind: 'gmail-composio'`, địa chỉ `email_address`. Hiện module chưa tự tạo tài khoản Care vì SDK/DECISIONS chưa công bố thao tác đó. Nếu Care dùng ID khác, cần chốt ánh xạ trước tích hợp. Khi chưa có tài khoản/epoch, Gmail từ chối xử lý và phát mục chú ý; không giả vờ đồng bộ thành công.

`ingest` phải trả về sau khi lưu bền vững; ném lỗi hoặc `{outcome:'failed'}` khi không lưu được. Bridge chỉ commit coverage cho các trang đã lưu đủ sự kiện, thử lại trang lỗi. Care cần khử trùng theo `eventId`. Registry phải chuyển lệnh gửi qua connector đã đăng ký; Gmail không chạy agent riêng. Chủ đề/chữ ký không chứa khóa kết nối.

Web cung cấp `care.channelPanel` và `care.composerExtras`; props hỗ trợ `channel?: string`, giá trị kênh là `email`. Coordinator cần thống nhất props với host Care. Hai extension chỉ hiển thị hướng dẫn và liên kết quản lý tài khoản.

## Lưu trữ và kiểm thử

Migration khai báo đủ 12 bảng `email_*`, trong đó ba bảng `email_connector_*` dành riêng cho cursor, cooldown và nhật ký transport. Các bảng legacy email được giữ để bảo toàn store/test; tin mới đi vào Care qua registry. Không tạo hoặc truy cập bảng integration/MCP hay bảng Care.

- `npx vitest run modules/gmail`: 12 file, 144 test xanh, dùng SQLite bộ nhớ và transport/Composio/Care giả.
- `npx tsc -p tsconfig.json --noEmit`
- `npx tsc -p web/tsconfig.json --noEmit`
- `node scripts/check-provenance.mjs`

Typecheck toàn repo có thể còn lỗi từ các worker khác; lỗi Gmail phải bằng 0. Chưa kiểm thử UI bằng trình duyệt và chưa gọi Gmail/Composio thật theo quy định P2.
