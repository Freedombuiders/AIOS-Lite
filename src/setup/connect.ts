// Step f: connecting the three default bots (teams/agenticos-doi-mac-dinh) to GenBot.
//
// Can it be done without the GenBot screen? No, for the packaged desktop app (checked 27/11 against GenBot 1.0.4's
// documented interfaces and source, read-only):
// - The desktop harness gives a private capability to its own window; every mutating request on loopback that does
//   not carry it is refused with 403 "this change must come from the desktop app or a paired device"
//   (server/request-auth.ts, `loopbackMutationToken`). Creating a bot, switching its Bot API on and minting a key are
//   all mutations (POST /api/bots…, POST /api/bots/:id/bot-api).
// - A paired session would pass, but GenBot turns device pairing off (`devicePairing: false`: `genbot pair`, `access`
//   and POST /api/auth/pair answer 410), and its sign-in is a GenBot account in the browser.
// - The stdio MCP server needs a paired session for anything that creates or changes (docs/mcp-server.md), and has
//   no tool for the Bot API or keys. `genbot team apply` goes through the same refused requests.
// So setup sends GenBot nothing but GET /api/health, prints the exact clicks, and opens Đội AI · Bot where the owner
// pastes each key (stored encrypted by src/integrations/genbot-keys.ts; setup never sees a key).

export const HEADLESS_CONNECT_POSSIBLE = false;

export const DEFAULT_BOTS = [
  { aiosId: 'bot-cskh', name: 'Bot CSKH', template: 'CSKH Zalo' },
  { aiosId: 'bot-noi-dung', name: 'Bot Nội dung', template: 'Nội dung' },
  { aiosId: 'bot-tro-ly', name: 'Bot Trợ lý', template: 'Trợ lý' },
] as const;

/** GenBot's own words (its vi.json): Bot mới, Cài đặt, Nâng cao, Quyền truy cập, Bot API, Cho ứng dụng trò chuyện với bot này, Sao chép, Khóa mới. */
export function connectSteps(webUrl: string): string[] {
  const names = DEFAULT_BOTS.map((b) => `"${b.name}"`).join(', ');
  return [
    `Trong app GenBot, bấm "Bot mới" ba lần để tạo ${names}. Với mỗi bot, chọn AI chạy được ở chế độ nhốt (Claude, Codex hoặc AI dùng khoá API).`,
    'Mở một bot, bấm bánh răng "Cài đặt" › "Nâng cao" › "Quyền truy cập" › "Bot API", bật "Cho ứng dụng trò chuyện với bot này".',
    'Thẻ Bot API hiện một lệnh mẫu có khoá. Bấm "Sao chép" ngay: khoá chỉ hiện một lần (mất thì bấm "Khóa mới"). Mã bot là phần nằm giữa /hooks/api/bots/ và /messages trong lệnh đó.',
    `Mở Open AgenticOS ở ${webUrl} (trình cài sẽ tự mở màn "Đội AI · Bot"). Bấm "Thêm bot GenBot", chọn mẫu (${DEFAULT_BOTS.map((b) => b.template).join(', ')}), điền "Mã bot GenBot", dán khoá, bấm "Kiểm tra rồi lưu". Bot đã có thẻ (cài từ gói Đội AgenticOS mặc định) thì bấm "Sửa" để điền mã bot và "Đổi khoá" để dán khoá.`,
    'Lặp lại bước 2 đến 4 cho hai bot còn lại.',
    'Khoá chỉ dán vào Open AgenticOS: app lưu mã hoá, chỉ hiện 4 ký tự cuối. Đừng dán khoá vào .env, agent.yaml hay gửi cho ai.',
  ];
}
