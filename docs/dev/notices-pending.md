Paperclip (MIT) — nguồn đã dùng. Mỗi dòng: file nguồn → file đích.

- packages/adapters/grok-local/src/shared/turn-boundary.ts → src/runtimes/grok.ts (hàm `applyTurnBoundary`, viết lại gần nguyên logic)
- Chỉ lấy ý tưởng, không chép mã: packages/adapter-utils/src/server-utils.ts (`runChildProcess`) → src/runtimes/process.ts; packages/adapters/{claude,codex,grok}-local/src/server/parse.ts → src/runtimes/{claude,codex,grok}.ts (cách đọc sự kiện, nhận lỗi nối phiên); packages/adapter-utils/src/command-redaction.ts → src/runtimes/jsonl.ts (`describeCommand`)

GỐC (owner-authored, không phải upstream):
- modules/_lib/composio.ts ← GỐC src/fbstudio/composio.ts (class B; import thay bằng configureComposio)
- modules/_lib/care-kit/{types,errors,checkpoint,validation,contract}.ts ← GỐC src/customer-care/{domain/*,connectors/contract}.ts (owner-authored, class A)
