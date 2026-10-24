# Việc ghép nối cho cổng P1 (coordinator)

- [ ] `main.ts`: lập chỉ mục brain khi khởi động, rồi chạy timer 15 phút (`brain.reindex()`). Theo báo cáo của B.
- [ ] `createAccessPolicy({ isModuleEnabled })` lấy từ module manager. Hai bên phụ thuộc vòng: tạo policy với một closure trỏ tới manager được gán sau.
- [ ] Contract: thêm `exists?: boolean` vào `BrainFolder`. B có `folderInfos()`.
- [ ] Engine gọi `agents.ensureWorkspace(id)` (B có hàm này, nằm ngoài contract), hoặc tự `mkdir`.
- [ ] `bootstrap` đăng ký nghe event `task` để gọi `team.onTaskFinished` (C đã làm). Kiểm tra lại cùng các hook của module.
- [ ] Tìm kiếm: `ftsQuery` của B mở rộng d/đ. Engine và API dùng chung hàm này.
- [ ] Hook của module không chạy với task cha kiểu team (C ghi chú). Chấp nhận được vì module không tạo task team.
- [x] Contract web: `WebNavItem.icon` đổi thành `ComponentType<any>` để icon lucide qua typecheck (D báo). Gỡ cast trong `_template` khi ghép.
- [ ] Compat `resolveAgentClaudeMd` đang trả đường dẫn `persona.md`. Cần kiểm lại chỗ gọi trong module `care` sau khi copy.
- [ ] Compat `saveTokenUsage` chỉ cộng dồn trong bộ nhớ. Không cần sửa, vì engine đã ghi token vào `runs`.
- [ ] Kiểm lại: header `X-AIOS-Source: api` được ghi thành `source='api'`.
- [ ] Mock runtime khớp câu trigger (`TRIGGER_TEXT` trong `src/shared/context.ts`) bằng chuỗi cố định. Khi gom lại: export hằng số dùng chung, để mock và context không lệch nhau.
- [x] Hermes: lỗi chưa đăng nhập giờ hiện rõ (family `auth`, có gợi ý `hermes model`); doctor cũng báo lỗi này.
- [ ] Gmail ↔ care: sửa bridge của gmail (`server/sync.ts`, `CareProvides`) cho khớp API `careChannels` đã chốt (`ensureAccount`, `getActiveEpoch`, `ingest` trả `{outcome}`) sau khi care xong. Props panel và composer đã chốt: `{channel, accountId?}` và `{channel, threadId}`.
- [ ] Toast của lõi chưa có nút hành động ("Hoàn tác"). Marketing đã bỏ nút undo khi xoá lịch; thêm lại khi toast hỗ trợ `action`.
- [x] Lõi: chỉ thị `<aios-action>` (`hooks.moduleActions`) và `agentContext` (`hooks.agentContext`) đã thêm, có test trong `src/work/actions.test.ts`.
- [ ] Care: kiểm tra care hỗ trợ cả hai kiểu nhận tin. Zalo để care gọi `connector.sync()` theo chu kỳ (kéo); Gmail đẩy tin qua `careChannels.ingest()`. Kiểm khi ghép ở cổng P2.
