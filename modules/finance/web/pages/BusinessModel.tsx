import { useRef, useState } from 'preact/hooks';
import { Download, Upload, Save, ArrowRight, BookOpen, Layers, Network } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { InfiniteCanvas } from '../components/InfiniteCanvas';
import { pushToast } from '@/lib/toasts';
import { BUSINESS_DRAFT_KEY, CANVAS_BLOCKS, PARAMS, PARAM_LABELS, SKILL_WORKFLOWS, emptyDraft, modelMarkdown, parseDraft } from '../lib/business-model';
import type { BusinessModelDraft } from '../lib/business-model';

const PANEL = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5';
const INPUT = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]';
const BUTTON = 'inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-[13px] hover:bg-[var(--color-control-hover)]';

function loadDraft(): { draft: BusinessModelDraft; error: string } {
  try {
    const saved = localStorage.getItem(BUSINESS_DRAFT_KEY);
    return { draft: saved ? parseDraft(saved) : emptyDraft(), error: '' };
  } catch {
    return { draft: emptyDraft(), error: 'Không đọc được bản nháp đã lưu. Dữ liệu cũ vẫn được giữ; xuất bản nháp hiện tại trước khi lưu thay thế.' };
  }
}

function download(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BusinessModel() {
  const [initial] = useState(loadDraft);
  const [draft, setDraft] = useState(initial.draft);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState(initial.error);
  const [tab, setTab] = useState('canvas');
  const fileInput = useRef<HTMLInputElement>(null);
  const filled = CANVAS_BLOCKS.filter(b => draft.canvas[b.id].trim()).length;
  const days = Number(draft.parameters.salesCycleDays);
  const validDays = draft.parameters.salesCycleDays.trim() !== '' && Number.isFinite(days) && days > 0;

  function update(next: BusinessModelDraft) { setDraft(next); setDirty(true); }
  function save() {
    try {
      parseDraft(JSON.stringify(draft));
      localStorage.setItem(BUSINESS_DRAFT_KEY, JSON.stringify(draft));
      setDirty(false);
      setMessage('Đã lưu bản nháp trong trình duyệt này.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không lưu được. Hãy xuất JSON để giữ bản nháp.');
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 300000) throw new Error('Hồ sơ quá lớn (tối đa 300 KB).');
      const next = parseDraft(await file.text());
      update(next);
      setMessage('Đã mở hồ sơ JSON. Bấm Lưu bản nháp để thay thế bản lưu trong trình duyệt.');
    } catch (error) {
      pushToast({ tone: 'error', title: error instanceof Error ? error.message : 'Không nhập được hồ sơ.' });
    }
  }

  return (
    <div class="flex h-full flex-col overflow-hidden select-text">
      <PageHeader title="Mô hình kinh doanh" breadcrumb="Workspace" actions={<>
        <input ref={fileInput} type="file" accept=".json,application/json" class="hidden" aria-label="Chọn hồ sơ JSON" onChange={e => { void importFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
        <button type="button" class={BUTTON} onClick={() => fileInput.current?.click()}><Upload size={14} />Nhập JSON</button>
        <button type="button" class={BUTTON} onClick={() => download(JSON.stringify(draft, null, 2), 'mo-hinh-kinh-doanh.json', 'application/json')}><Download size={14} />Xuất JSON</button>
        <button type="button" class={BUTTON} onClick={() => download(modelMarkdown(draft), 'Mo-hinh-kinh-doanh-ban-nhap.md', 'text/markdown')}><Download size={14} />Xuất Markdown</button>
        <button type="button" class={`${BUTTON} control-accent`} onClick={save}><Save size={14} />Lưu bản nháp</button>
      </>} tabs={<>
        <Tab label="Canvas & tham số" active={tab === 'canvas'} onClick={() => setTab('canvas')} />
        <Tab label="Áp dụng skills" active={tab === 'skills'} onClick={() => setTab('skills')} />
        <Tab label="Second brain" active={tab === 'brain'} onClick={() => setTab('brain')} />
      </>} />

      <InfiniteCanvas key={tab}>
      <div class="p-8 space-y-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div><p class="text-[12px] uppercase tracking-widest text-[var(--color-accent)]">Nền tảng cho Sale & Marketing</p>
            <h2 class="text-2xl font-semibold mt-2">Hiểu doanh nghiệp trước khi giao việc cho AI</h2>
            <p class="mt-2 text-[13px] text-[var(--color-text-muted)]">Một hồ sơ nối khách hàng, giá trị, vận hành và tri thức tích lũy.</p>
          </div>
          <div class="rounded-lg border border-[var(--color-border)] px-4 py-3 text-[13px]">
            <span class="text-xl font-semibold">{filled}/9</span> ô đã điền
            <p class="mt-1 text-[var(--color-text-muted)]">{dirty ? 'Có thay đổi chưa lưu' : 'Bản nháp tại trình duyệt'}</p>
          </div>
        </div>
        <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] text-[var(--color-text-muted)]">
          <p>Bản nháp chỉ lưu trong trình duyệt. Hồ sơ chính thức cần được duyệt và lưu tại <strong>00. Business Context/</strong> trong second brain của đúng doanh nghiệp.</p>
          {message && <p role="status" class="mt-2 text-[var(--color-text)]">{message}</p>}
        </div>

        {tab === 'canvas' && <>
          <section class={`${PANEL} grid gap-4 grid-cols-2`} aria-label="Thông tin doanh nghiệp">
            <label class="text-[13px] space-y-2"><span class="block font-medium">Tên doanh nghiệp</span><input class={INPUT} value={draft.company} maxLength={20000} placeholder="Doanh nghiệp mà hệ thống đang phục vụ" onInput={e => update({ ...draft, company: e.currentTarget.value })} /></label>
            <label class="text-[13px] space-y-2"><span class="block font-medium">Nguồn hồ sơ</span><input class={INPUT} value={draft.source} maxLength={20000} placeholder="Tên note hoặc đường dẫn hồ sơ trong vault" onInput={e => update({ ...draft, source: e.currentTarget.value })} /></label>
            <label class="text-[13px] space-y-2 col-span-2"><span class="block font-medium">Doanh nghiệp bán gì, cho ai?</span><textarea class={INPUT} rows={2} value={draft.summary} maxLength={20000} placeholder="Ghi dữ kiện thật; đánh dấu phần còn là giả định." onInput={e => update({ ...draft, summary: e.currentTarget.value })} /></label>
          </section>
          <section aria-label="Business Model Canvas" class="grid grid-cols-5 gap-3">
            {CANVAS_BLOCKS.map(block => <article key={block.id} class={`${PANEL} !p-4 flex flex-col ${block.area}`}>
              <label for={`canvas-${block.id}`} class="font-semibold text-[13px]">{block.title}</label>
              <p class="text-[12px] text-[var(--color-text-muted)] my-2">{block.hint}</p>
              <textarea id={`canvas-${block.id}`} class={`${INPUT} flex-1 min-h-28 resize-y`} rows={4} value={draft.canvas[block.id]} maxLength={20000} placeholder="Chưa có dữ liệu" onInput={e => update({ ...draft, canvas: { ...draft.canvas, [block.id]: e.currentTarget.value } })} />
              <p class="text-[11px] text-[var(--color-text-faint)] mt-3 break-words">Skill: {block.skills}</p>
            </article>)}
          </section>
          <section class={PANEL} aria-label="Tham số vận hành">
            <h3 class="font-semibold">Sáu tham số điều khiển hệ thống</h3>
            <p class="text-[13px] text-[var(--color-text-muted)] mt-1">Theo cấu trúc hồ sơ trong mkt-automation. Đây là dữ liệu nháp; các lịch và agent chưa sử dụng các giá trị này.</p>
            <div class="grid gap-4 grid-cols-3 mt-4">
              <label class="text-[13px] space-y-2"><span class="block">Chu kỳ bán (ngày)</span><input type="number" min="0.01" step="any" class={INPUT} value={draft.parameters.salesCycleDays} onInput={e => update({ ...draft, parameters: { ...draft.parameters, salesCycleDays: e.currentTarget.value } })} placeholder="Chưa xác định" /></label>
              {PARAMS.map(p => <label key={p.id} class="text-[13px] space-y-2"><span class="block">{p.title}</span><select class={INPUT} value={draft.parameters[p.id]} onChange={e => update({ ...draft, parameters: { ...draft.parameters, [p.id]: e.currentTarget.value } })}><option value="">Chưa xác định</option>{p.options.map(o => <option key={o} value={o}>{p.id === 'touchpointOwnership' && o === 'co' ? 'Sở hữu điểm chạm' : PARAM_LABELS[o]}</option>)}</select></label>)}
            </div>
            <div class="mt-4 rounded-lg bg-[var(--color-bg)] p-4 text-[13px]">
              {validDays ? <>
                <p>Nhịp đọc số đề xuất: <strong>{days < 30 ? 'Hằng tuần' : days <= 90 ? 'Hai tuần' : 'Hằng tháng'}</strong> · Chạm lead nóng: <strong>{days < 30 ? '15 phút' : '4 giờ'}</strong></p>
                <p class="mt-2">Giữ lead tối đa: {(days * 1.5).toLocaleString('vi-VN')} ngày · Nhắc sau báo giá: {[.05, .15, .3].map(n => (days * n).toLocaleString('vi-VN', { maximumFractionDigits: 3 })).join(' / ')} ngày.</p>
                <p class="mt-2 text-[var(--color-text-muted)]">Quy tắc tham khảo từ skill; cần duyệt khả năng áp dụng. Không nhắc sau báo giá cho giao dịch bán lẻ đã hoàn tất.</p>
              </> : <p>Điền chu kỳ bán lớn hơn 0 để xem nhịp vận hành. Chưa có dữ liệu thì chưa đặt ngưỡng.</p>}
            </div>
          </section>
        </>}

        {tab === 'skills' && <section class="space-y-4" aria-label="Bản đồ áp dụng skills">
          <p class="text-[13px] text-[var(--color-text-muted)]">Các chuỗi dưới đây là đề xuất tích hợp từ thư viện mkt-automation, chưa được cài hoặc kích hoạt bởi page này.</p>
          <div class="grid gap-4 grid-cols-2">{SKILL_WORKFLOWS.map(flow => <article key={flow.title} class={PANEL}>
            <h3 class="font-semibold">{flow.title}</h3><p class="text-[13px] text-[var(--color-accent)] mt-1">{flow.owner}</p>
            <p class="font-mono text-[12px] leading-6 mt-3 break-words">{flow.chain}</p>
            <dl class="text-[13px] grid grid-cols-[70px_1fr] gap-x-3 gap-y-2 mt-4"><dt class="text-[var(--color-text-muted)]">Đầu vào</dt><dd>{flow.input}</dd><dt class="text-[var(--color-text-muted)]">Lưu ở</dt><dd>{flow.output}</dd><dt class="text-[var(--color-text-muted)]">Trong OS</dt><dd>{flow.surface}</dd><dt class="text-[var(--color-text-muted)]">Người duyệt</dt><dd>{flow.review}</dd></dl>
          </article>)}</div>
          <div class={PANEL}><h3 class="font-semibold">Bắt đầu từ một vòng làm việc hoàn chỉnh</h3><p class="text-[13px] mt-2">Hồ sơ đã duyệt → brief → bản nháp nội dung → duyệt → xuất bản → đo kết quả → lưu bài học có nguồn → dùng lại trong brief kế tiếp.</p><Link href="/mission" class="inline-flex items-center gap-2 mt-4 text-[13px] text-[var(--color-accent)]">Mở Mission Control <ArrowRight size={14} /></Link></div>
        </section>}

        {tab === 'brain' && <section class="space-y-4" aria-label="Kiến trúc second brain">
          <div class="grid gap-4 grid-cols-3">
            {[
              { icon: Layers, title: 'FreedomOS · thực thi', text: 'Chat, agent, Mission Control, lịch chạy, Zalo và Facebook. SQLite giữ trạng thái tác vụ, hội thoại, kết quả kênh và lịch sử thực thi.' },
              { icon: BookOpen, title: 'Second brain · tri thức', text: 'Vault Obsidian giữ mô hình kinh doanh đã duyệt, SOP, nghiên cứu, quyết định, bằng chứng và bài học. Mỗi note có nguồn, chủ sở hữu và phạm vi sử dụng.' },
              { icon: Network, title: 'Context bridge · kết nối', text: 'Đọc ngữ cảnh đúng doanh nghiệp trước khi chạy skill. Sau tác vụ, tạo note nháp có nguồn; người duyệt trước khi cập nhật tri thức dùng chung.' },
            ].map(layer => <article class={PANEL} key={layer.title}><layer.icon size={24} class="text-[var(--color-accent)]" /><h3 class="font-semibold mt-4">{layer.title}</h3><p class="text-[13px] leading-6 mt-2 text-[var(--color-text-muted)]">{layer.text}</p></article>)}
          </div>
          <div class={PANEL}><h3 class="font-semibold">Dùng vault đang có, gắn đúng phạm vi</h3><p class="text-[13px] leading-6 mt-2">mkt-automation đã có cấu trúc PARA và hồ sơ Café Ông Bầu. Chỉ nối vault đó khi agent đang phục vụ đúng doanh nghiệp. Tony Brain là nguồn tri thức cá nhân riêng; cần chọn note được phép sử dụng trước khi đưa vào ngữ cảnh kinh doanh.</p>
            <ol class="list-decimal pl-5 text-[13px] leading-7 mt-3"><li>Trong Settings, cấu hình vault local với đường dẫn tuyệt đối và tắt Git sync nếu dùng thư mục hiện có.</li><li>Cho agent đọc Business Context; giới hạn thư mục ghi theo nhiệm vụ.</li><li>Bắt đầu bằng một workflow nội dung hoặc ghi cuộc gặp. Lưu nguồn và bài học vào note liên kết.</li><li>Thêm đọc hồ sơ trực tiếp, tìm kiếm tri thức và duyệt phiên bản vào dashboard ở bước tích hợp tiếp theo.</li></ol>
            <Link href="/settings" class="inline-flex items-center gap-2 mt-4 text-[13px] text-[var(--color-accent)]">Mở Cài đặt <ArrowRight size={14} /></Link>
          </div>
          <div class={PANEL}><h3 class="font-semibold">Vòng tri thức cần xây</h3><div class="flex flex-wrap items-center gap-2 text-[13px] mt-4">{['Thu thập', 'Gắn nguồn', 'Tạo nháp', 'Người duyệt', 'Lưu vào vault', 'Truy xuất cho lần sau'].map((step, i) => <span key={step} class="inline-flex items-center gap-2"><span class="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2">{step}</span>{i < 5 && <ArrowRight size={14} />}</span>)}</div><p class="text-[13px] text-[var(--color-text-muted)] mt-4">Memories hỗ trợ nhớ hội thoại; Hive Mind hiển thị hoạt động. Tri thức chính thức cần note có nguồn và phiên bản trong vault.</p></div>
        </section>}
      </div>
      </InfiniteCanvas>
    </div>
  );
}
