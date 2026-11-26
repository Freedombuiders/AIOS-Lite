# T24 · App Expo 1: khung, đăng nhập Google, kho dữ liệu, ghép máy

> Nhánh Mobile · 3 ngày · Phụ thuộc: T20, T23 · Giả định G4 trong README

## Mục tiêu

Một app điện thoại: đăng nhập bằng Google, xem kho dữ liệu, ghép với máy ở nhà, và ra lệnh cho máy cài một gói.

## Quyết định kỹ thuật

| Mục | Chọn |
|---|---|
| Khung | Expo (bản SDK ổn định mới nhất lúc làm), `expo-router`, TypeScript |
| Đăng nhập | `@react-native-google-signin/google-signin`, cần bản dựng riêng (`expo-dev-client`) |
| Lưu mã | `expo-secure-store` |
| Gọi mạng | `fetch` bọc trong một lớp nhỏ có kiểu; bộ nhớ đệm bằng TanStack Query |
| Ngôn ngữ | Tiếng Việt mặc định, có tiếng Anh |

Kiểu dữ liệu của API dùng chung với `cloud/` và cổng di động qua một gói `packages/api-types/` (chỉ có kiểu, không có code chạy).

## Cấu trúc

```
mobile/
  app.config.ts  eas.json  package.json
  app/
    _layout.tsx
    (auth)/sign-in.tsx
    (tabs)/_layout.tsx
    (tabs)/index.tsx          Cần bạn (T25)
    (tabs)/inbox.tsx          Hộp thư (T25)
    (tabs)/store.tsx          Kho dữ liệu
    (tabs)/settings.tsx
    store/[id].tsx
    pair.tsx
  src/api/cloud.ts  src/api/machine.ts  src/auth/  src/theme/  src/i18n/
```

## Các bước

- [ ] Dựng dự án, chủ đề tối theo màu của web (`web/src/styles/main.css`, khối `@theme`), phông đóng gói sẵn.
- [ ] Đăng nhập: lấy ID token từ Google, gửi `POST /auth/google` với `kind: 'mobile'`, lưu phiên vào kho an toàn.
- [ ] Phiên hết hạn hoặc bị thu hồi (401): xoá mã, về màn đăng nhập, giữ lại màn đang xem để quay lại.
- [ ] Màn Kho dữ liệu: danh sách theo module, tìm, chi tiết gói (mô tả, danh sách file, giấy phép, kích thước).
- [ ] Ghép máy: chọn máy từ `GET /machines`, xin vé ghép, gọi `POST /mobile/pair` tới địa chỉ đường hầm, lưu mã thiết bị và địa chỉ. Một người có thể có nhiều máy; app nhớ máy đang chọn.
- [ ] Địa chỉ đường hầm đổi: khi gọi máy thất bại vì mạng, hỏi lại cloud địa chỉ mới một lần rồi thử lại.
- [ ] Nút "Cài xuống máy" ở chi tiết gói: gọi `POST /mobile/packs/install` trên máy với `{ packId, version }`. Máy tự tải từ cloud và nhập (T22). Điện thoại không tải gói. Thêm đường này vào cổng di động, phạm vi `approve`.
- [ ] Chưa ghép máy: nút cài hiện lời nhắc ghép máy trước.
- [ ] Màn Cài đặt: tài khoản, máy đã ghép, đăng xuất, xoá tài khoản (`DELETE /me`, có bước xác nhận).
- [ ] Trạng thái mạng: máy tắt hoặc mất mạng thì hiện rõ "máy ở nhà đang không trực tuyến", không quay vòng mãi.
- [ ] Không lưu tin nhắn hay dữ liệu khách trên điện thoại ngoài bộ nhớ đệm trong phiên.

## Test

- Test đơn vị cho lớp gọi API: 401 dẫn tới đăng xuất; lỗi mạng với máy dẫn tới hỏi lại địa chỉ đúng một lần.
- Test thành phần cho màn kho và màn ghép máy với API giả.
- Một luồng Maestro (thư mục `.maestro/`): mở app, đăng nhập bằng tài khoản thử, mở kho, xem một gói.

## Xong khi

- `cd mobile && npx tsc --noEmit && npx jest` qua.
- Bản dựng thử chạy trên một máy Android và một máy iOS (hoặc trình giả lập): đăng nhập, ghép máy, bấm cài gói mẫu, trên máy tính thấy gói đã vào brain.

## Ghi chú

- Đăng nhập Google trên iOS và Android cần client id riêng cho từng nền tảng. Ghi cách tạo vào `mobile/README.md`.
- GenBot đã có một app Expo (`genbot/mobile`). Xem cách họ tổ chức để tham khảo; không chép code.
- Cửa hàng ứng dụng của Apple đòi có thêm một cách đăng nhập tương đương khi app chỉ có đăng nhập bên thứ ba. Kiểm chính sách hiện hành trước khi nộp; nếu cần thì thêm "Đăng nhập với Apple" thành một task riêng.
