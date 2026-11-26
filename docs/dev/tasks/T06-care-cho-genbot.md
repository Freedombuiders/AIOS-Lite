# T06 · Care chạy trên GenBot

> Nhánh Chăm khách · 3 ngày · Phụ thuộc: T03 · Kế hoạch mục 5.2

## Mục tiêu

Bot GenBot chăm được Zalo qua đường sẵn có của `care`, an toàn hơn hiện tại ở hai chỗ: không vượt trần 20.000 ký tự, và dừng thật khi khách đòi gặp người.

## Đọc trước

`modules/care/server/application/agent-turn.ts` (thứ tự chạy ở dòng 11-15), `agent-context.ts`, `agent-output.ts`, `policy/eligibility.ts`, `policy/policy-ext.ts`, `application/ingest.ts:445-500`.

## File đụng tới

| File | Việc |
|---|---|
| `care/server/application/agent-context.ts:32-36` | Thêm trần ký tự |
| `care/server/policy/text-heuristics.ts`, `eligibility.ts` | Luật cứng đòi gặp người |
| `care/module.json` | Cài đặt `handoffKeywords`, `handoffPauseMinutes` |
| `care/server/api/routes-workflow.ts` | API tạm dừng |
| `care/server/application/outbox-service.ts:46-67` | Cho gửi ảnh, file khi tự nhắn |
| `care/server/connectors/zalo/zca-transport.ts:191` | Bỏ `sendMedia: []` cho tin thủ công |
| `care/server/module-runtime.ts:156-159` | Xem lại việc `autoDelaySeconds` ghi đè khoảng chờ 3–12 giây |

## Các bước

**Cắt ngữ cảnh**

- [ ] `buildAgentContext` nhận thêm `maxChars`. Hiện trần là 30 tin, mỗi tin 2.000 ký tự, tức có thể tới 60.000.
- [ ] Khi runtime của agent là `genbot`, đặt `maxChars = 12000`. Cắt từ tin cũ nhất. Tin mới nhất của khách không bao giờ bị cắt; nếu riêng nó dài hơn trần thì cắt phần đuôi và thêm dấu hiệu "[đã lược]".
- [ ] Sau khi dựng xong prompt, nếu tổng vẫn vượt 20.000 thì bỏ lượt với `skip_reason = 'prompt_too_long'` và nêu mục cần chú ý. Không gửi đi để nhận lỗi từ GenBot.

**Luật cứng đòi gặp người**

- [ ] Cài đặt `handoffKeywords` (mặc định: "gặp nhân viên", "gặp người thật", "khiếu nại") và `handoffPauseMinutes` (mặc định 60).
- [ ] So khớp không phân biệt hoa thường và bỏ dấu, dùng cùng cách chuẩn hoá với các cụm từ chối nhận tin ở `text-heuristics.ts:58-59`.
- [ ] Kiểm trong `eligibility.ts`, **trước** khi xếp việc `inbound_turn`. Khớp thì: không gọi agent, đặt `paused_until`, ghi `care_agent_runs` với `status='skipped'`, `skip_reason='handoff_keyword'`, và `ctx.attention.raise`.
- [ ] Hiện tại "handoff" chỉ là lời dặn trong prompt (`agent-turn.ts:153-155`). Giữ lời dặn đó làm lớp thứ hai.

**Tạm dừng**

- [ ] Kiểm xem đã có API đặt `is_paused`, `paused_until` chưa. Chưa thì thêm `PUT /conversations/:id/pause` với thân `{ minutes: 30 | 120 | null }`; `null` là tới khi bật lại.
- [ ] `eligibility.ts` tôn trọng `paused_until` (kiểm lại; cửa sổ nhường 30 phút khi người nhắn đã có ở `policy-ext.ts:62`).

**Gửi ảnh, file khi tự nhắn**

- [ ] Mở rộng payload của `care_delivery_intents` cho `actor='manual'`: danh sách tệp đính kèm đã tải lên qua `modules/zalo/server/media.ts`.
- [ ] `zca-transport.ts` gửi qua đường album sẵn có của `zalo/server/sender.ts:364`.
- [ ] Với `actor='auto'` và `'approved'`: vẫn chỉ chữ. Có test khẳng định điều này.

## Hợp đồng

Lược đồ trả lời của bot không đổi (`agent-output.ts:7-9`):

```json
{"action":"reply","replies":[{"ref":"m3","text":"..."}],"needsReview":false,"reason":"..."}
```

Thừa một khoá là cả câu trả lời bị từ chối. Khi thử với GenBot thật, nếu bot hay trả thừa khoá thì sửa chỉ dẫn của bot, không nới lược đồ.

## Test

- Ngữ cảnh 30 tin, mỗi tin 2.000 ký tự, agent `genbot`: prompt dưới 20.000 và còn nguyên tin mới nhất.
- Tin "cho tôi gặp nhân viên" và "CHO TOI GAP NHAN VIEN": không có lượt `runLean` nào; cuộc chat tạm dừng 60 phút; có một mục cần chú ý.
- Tạm dừng 30 phút rồi khách nhắn: không có lượt chạy. Sau 31 phút: có.
- Tin thủ công kèm ảnh tới được connector giả; tin `auto` kèm ảnh bị từ chối.

## Xong khi

- `npx vitest run modules/care` qua.
- Với GenBot thật: khách nhắn câu có trong brain, nháp xuất hiện, duyệt xong khách nhận được.

## Ghi chú

- Trần 30 câu trả lời mỗi khách mỗi ngày và 500 lượt agent mỗi ngày đã có (`policy-ext.ts:61`, `agent-turn.ts:72`). Không viết lại.
- Trần gửi của cả nick (`eligibility.ts:284`, `care-guard.ts:62-80`) có trường nhưng chưa được nối ở bước gửi. Ghi lại thành một việc riêng nếu T05 chưa xử lý.
