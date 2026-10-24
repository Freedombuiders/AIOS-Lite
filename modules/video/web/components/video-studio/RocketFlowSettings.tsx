import { useState } from 'preact/hooks';
import { apiGet, apiPost, ApiError } from '@/lib/api';
const input = 'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]';
const button = 'control-button min-h-11 px-4 rounded-md border border-[var(--color-border)] disabled:opacity-50 inline-flex items-center justify-center gap-2';
const card = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4 sm:p-5';
function message(e: unknown) { return e instanceof ApiError && e.body && typeof e.body === 'object' && 'error' in e.body ? String(e.body.error) : e instanceof Error ? e.message : String(e); }
export function RocketFlowSettings() {
 const [busy,setBusy]=useState(''); const [error,setError]=useState('');
 const [status,setStatus]=useState('RocketFlow tự kết nối khi Chrome và app chạy cùng máy; không cần mã.');
 const [grants,setGrants]=useState<Record<string,string>>({});
 const [grantAgent,setGrantAgent]=useState('video-editor'); const [grantAccess,setGrantAccess]=useState('write');
 async function run(label:string, action:()=>Promise<void>) { if(busy)return;setBusy(label);setError('');try{await action();}catch(e){setError(message(e));}finally{setBusy('');} }
 return <details class="shrink-0 px-4 py-2 border-b border-[var(--color-border)]"><summary class="cursor-pointer py-2">Kết nối & quyền dùng chung</summary><div class="max-h-80 overflow-auto">
 <button class={button} disabled={!!busy} onClick={()=>run('Đang kiểm tra…',async()=>setStatus((await apiPost<{output:string}>('/api/m/video/studio/status')).output))}>Kiểm tra kết nối</button>
      <section class={card} aria-label="Kết nối RocketFlow"><h2 class="font-semibold mb-2">Google Flow qua RocketFlow</h2><p class="text-sm whitespace-pre-wrap break-words">{status}</p><p class="text-sm text-[var(--color-text-muted)] mt-2">FreedomOS và Chrome cần chạy cùng máy. Kết quả tải về thư mục Downloads/RocketFlow; lịch sử job được lưu trên máy chủ.</p><details class="mt-3"><summary class="cursor-pointer py-2">Kết nối và quyền agent</summary>
        <p class="text-sm my-2">AIOS-Lite quản lý kết nối dùng chung cho Studio, Claude và Codex. Mở Chrome trên cùng máy; bật MCP trong RocketFlow. RocketFlow tự kết nối trên máy này; không cần nhập mã.</p>
        <button class={button} disabled={!!busy} onClick={() => run('Đang đọc kết nối…', async () => { const r = await apiGet<{ grants: Record<string, string> }>('/api/m/video/studio/connection'); setGrants(r.grants); })}>Xem quyền agent</button>
        <div class="space-y-2 mt-3"><label class="block text-sm">Agent ID<input class={input} value={grantAgent} onInput={e => setGrantAgent(e.currentTarget.value)} /></label>
        <label class="block text-sm">Quyền<select class={input} value={grantAccess} onChange={e => setGrantAccess(e.currentTarget.value)}><option value="off">Tắt</option><option value="read">Đọc trạng thái và job của mình</option><option value="write">Tạo, đọc và huỷ job của mình (dùng tín dụng)</option></select></label>
        <button class={button} disabled={!!busy} onClick={() => run('Đang lưu quyền…', async () => setGrants((await apiPost<{ grants: Record<string, string> }>('/api/m/video/studio/grants', { agentId: grantAgent, access: grantAccess })).grants))}>Lưu quyền agent</button>
        <p class="text-sm break-words">{Object.entries(grants).map(([id, access]) => `${id}: ${access}`).join(' · ') || 'Chưa hiển thị quyền. Mặc định agent không có quyền.'}</p></div>
      </details></section><p role="status">{busy}</p>{error && <p role="alert">{error}</p>}<p class="text-sm">Agent tạo mới cần skill video-create được bật trong Agents → Skills.</p></div></details>;
}
