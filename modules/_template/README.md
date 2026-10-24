# Module mẫu

Thư mục này là khuôn để làm module mới. Tạo một module từ khuôn bằng lệnh:

```bash
npm run aios -- module new ten-module
```

Lệnh sẽ chép khuôn sang `modules/ten-module/`, đổi id, tiền tố bảng (`ten_module_`) và tên agent/skill. Sau đó:

```bash
npm run aios -- module add ten-module     # hoặc nút Thêm ở trang Module
```

Không cần khởi động lại: Add chạy migration, chép agent mẫu, thêm skill và mở route `/api/m/ten-module/...`. Remove tắt module nhưng giữ dữ liệu; Purge mới xoá bảng.

## Một module gồm những gì

| Đường dẫn | Việc của nó |
|---|---|
| `module.json` | Khai báo: id, tên, nhóm menu, quyền (`scopes`), **mọi bảng** module tạo (`tables`), cài đặt, điều kiện (`requires`). |
| `migrations/*.sql` | Chạy theo thứ tự tên khi Add. Chỉ được tạo bảng đã khai báo trong `tables`, nếu không Add bị từ chối. |
| `server/index.ts` | `defineModule({...})`: route, `start/stop`, `onTaskFinished`, `contextFor`, `provides`, `migrate`. |
| `web/index.tsx` | `defineWebModule({...})`: mục menu, trang, widget Tổng quan. |
| `agents/<tên>/` | Agent mẫu (`agent.yaml` + `persona.md`), được chép vào `agents/` nếu bật "cài agent mẫu". |
| `skills/<tên>/SKILL.md` | Skill, có trong thư viện khi module đang bật. |

## Từng bước làm module

1. **Khai báo bảng.** Sửa `migrations/001_init.sql` và liệt kê đúng các bảng đó trong `tables` của `module.json`.
2. **Viết route.** Trong `routes(app, ctx)` dùng `ctx.db` để đọc ghi bảng của bạn. Đừng đụng bảng của lõi.
3. **Gọi agent.** `ctx.agents.runLean({...})` tạo một việc nhẹ (không công cụ), đi qua Engine nên vẫn được phân quyền, ghi lượt chạy và tính chi phí. Dùng `ctx.access.can(agentId, 'scope')` để kiểm tra quyền trước khi đưa dữ liệu cho agent.
4. **Làm sạch trước khi gửi ra ngoài.** `ctx.outbound.sanitize(text)` loại khoá bí mật, đường dẫn máy, mã màu terminal và thẻ chỉ thị.
5. **Việc định kỳ.** `ctx.schedule.every(tên, 60_000 | '0 8 * * *', fn)`; timer tự dừng khi Remove.
6. **Cài đặt.** Khai báo trong `settings` của `module.json`; đọc bằng `ctx.settings.get`. Kiểu `secret` được mã hoá khi lưu.
7. **Giao diện.** `web/index.tsx` thêm mục menu, trang và widget. Gọi API của module ở `/api/m/<id>/...`.
8. **Thử.** Add module, mở trang, bấm thử; xem Nhật ký và trang Module nếu có lỗi khi khởi động.

## Quy tắc

- Chỉ dùng những gì SDK đưa qua `ctx`; không import trực tiếp phần bên trong của lõi.
- Mọi bảng phải được khai báo; Purge chỉ xoá đúng các bảng đó.
- Không ghi khoá bí mật vào prompt hay log.
