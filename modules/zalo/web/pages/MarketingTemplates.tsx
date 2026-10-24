import { useEffect, useRef, useState } from 'preact/hooks';
import { FileText, Paperclip, Pencil, Plus, RefreshCw, Sparkles, Trash2, Wand2, X } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { CampaignTabs } from '../components/CampaignTabs';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { RichTextEditor, RichTextPreview } from '@/components/RichTextEditor';
import { apiDelete, apiPost, apiPut, tokenizedSseUrl } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { useDebouncedValue } from '@/lib/useDebounce';
import { pushToast } from '@/lib/toasts';
import {
  attachmentSummary,
  errorMessage,
  formatVnRelative,
  MAX_TEMPLATE_FILES,
  MAX_TEMPLATE_IMAGES,
  MAX_TEMPLATE_TEXT,
  mediaUrl,
  type MarketingAttachment,
  type MarketingTemplate,
  type TemplateVariable,
} from '@/lib/marketing';
import { addToSpintax, type ZaloStyle } from '@/lib/richText';

const INPUT = 'w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)]';
const BTN = 'toolbar-control control-button inline-flex items-center gap-1.5 px-3 rounded-md text-[13px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';
const BTN_PRIMARY = 'toolbar-control control-button control-accent inline-flex items-center gap-1.5 px-3 rounded-md text-[13px] disabled:opacity-40';
const LABEL = 'block text-[13px] font-medium text-[var(--color-text-muted)] mb-1.5';

interface RichText { text: string; styles: ZaloStyle[] }
interface AgentOption { id: string; name: string }
interface VariantsResponse { variants: string[]; rich: RichText[] }
interface RenderResponse extends RichText { warnings: string[] }

export function MarketingTemplates() {
  const templates = useFetch<{ templates: MarketingTemplate[] }>('/api/m/zalo/templates');
  const [editing, setEditing] = useState<MarketingTemplate | 'new' | null>(null);
  const [removing, setRemoving] = useState<MarketingTemplate | null>(null);
  const list = templates.data?.templates ?? [];

  async function remove(t: MarketingTemplate) {
    try {
      await apiDelete(`/api/m/zalo/templates/${t.id}`);
      pushToast({ tone: 'success', title: 'Đã xoá mẫu tin' });
      templates.refresh();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không xoá được', description: errorMessage(err) });
    }
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        compact
        title="Mẫu tin"
        actions={<button type="button" class={BTN} onClick={() => setEditing('new')}><Plus size={13} /> Tạo mẫu tin</button>}
      />
      <CampaignTabs current="templates" />
      <div class="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
        <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)] w-full min-w-0">
          Mẫu tin là nội dung dùng lại cho các chiến dịch gửi nhóm, gửi danh sách và chúc mừng sinh nhật. Dùng biến như <code>{'{name}'}</code>,{' '}
          <code>{'{sale}'}</code> để cá nhân hoá, và <code>{'{Chào|Xin chào|Hi}'}</code> để mỗi người nhận một cách viết khác nhau, giúp nick ít bị Zalo coi là tin hàng loạt.
        </div>

        {templates.loading && list.length === 0 && <PageState loading />}
        {templates.error && list.length === 0 && <PageState error={templates.error} />}
        {!templates.loading && !templates.error && list.length === 0 && (
          <PageState empty emptyTitle="Chưa có mẫu tin" emptyDescription="Bấm “Tạo mẫu tin” để soạn nội dung đầu tiên." />
        )}

        <div class="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 w-full min-w-0">
          {list.map((t) => (
            <div key={t.id} class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3 flex flex-col gap-2 min-w-0">
              <div class="flex items-start gap-2">
                <button type="button" class="min-w-0 flex-1 text-left" onClick={() => setEditing(t)}>
                  <div class="text-[13px] font-semibold text-[var(--color-text)] truncate">{t.name}</div>
                  <div class="text-[12px] text-[var(--color-text-faint)]">Cập nhật {formatVnRelative(t.updatedAt)}</div>
                </button>
                <button type="button" class="inline-flex items-center justify-center min-w-[32px] min-h-[32px] p-1.5 rounded hover:bg-[var(--color-control-hover)] touch-manipulation" aria-label="Sửa" onClick={() => setEditing(t)}><Pencil size={13} aria-hidden="true" /></button>
                <button type="button" class="inline-flex items-center justify-center min-w-[32px] min-h-[32px] p-1.5 rounded hover:bg-[var(--color-control-hover)] text-[var(--color-status-failed)] touch-manipulation" aria-label="Xoá" onClick={() => setRemoving(t)}><Trash2 size={13} aria-hidden="true" /></button>
              </div>
              <button type="button" class="text-left" onClick={() => setEditing(t)}>
                <div class="relative max-h-[7.5rem] overflow-hidden rounded bg-[var(--color-bg)] border border-[var(--color-border)] px-2.5 py-2">
                  {t.text ? <RichTextPreview text={t.text} styles={t.styles} /> : <span class="text-[13px] text-[var(--color-text-faint)]">(chỉ có tệp đính kèm)</span>}
                </div>
              </button>
              {t.attachments.length > 0 && (
                <div class="flex items-center gap-1.5">
                  <Pill tone="neutral"><Paperclip size={10} /> {attachmentSummary(t.attachments)}</Pill>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); templates.refresh(); }}
        />
      )}
      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) void remove(removing); setRemoving(null); }}
        title="Xoá mẫu tin?"
        body={removing ? `Mẫu “${removing.name}” và các tệp đính kèm sẽ bị xoá.` : undefined}
        detail="Chiến dịch đang dùng mẫu này sẽ không gửi được cho đến khi bạn chọn mẫu khác."
        confirmLabel="Xoá"
        cancelLabel="Huỷ"
        destructive
      />
    </div>
  );
}

function TemplateEditor({ template, onClose, onSaved }: {
  template: MarketingTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const variables = useFetch<{ variables: TemplateVariable[] }>('/api/m/zalo/templates/variables');
  const agents = useFetch<{ agents: AgentOption[] }>('/api/agents', 60_000);

  const [name, setName] = useState(template?.name ?? '');
  const [text, setText] = useState(template?.text ?? '');
  const [styles, setStyles] = useState<ZaloStyle[]>(template?.styles ?? []);
  const [attachments, setAttachments] = useState<MarketingAttachment[]>(template?.attachments ?? []);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Live preview rendered by the server so it matches what is sent.
  const [seed, setSeed] = useState(1);
  const [preview, setPreview] = useState<RenderResponse | null>(null);
  const dText = useDebouncedValue(text, 350);
  const dStyles = useDebouncedValue(styles, 350);
  useEffect(() => {
    if (!dText) { setPreview(null); return; }
    let cancelled = false;
    apiPost<RenderResponse>('/api/m/zalo/templates/render', { text: dText, styles: dStyles, seed })
      .then((r) => { if (!cancelled) setPreview(r); })
      .catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [dText, dStyles, seed]);

  // Agent-written variants.
  const [agentId, setAgentId] = useState('');
  const [count, setCount] = useState(3);
  const [writing, setWriting] = useState(false);
  const [variantList, setVariantList] = useState<RichText[]>([]);
  const agentList = agents.data?.agents ?? [];
  const effectiveAgent = agentId || agentList[0]?.id || 'main';

  async function writeVariants() {
    setWriting(true);
    try {
      const res = await apiPost<VariantsResponse>('/api/m/zalo/templates/variants', { text, count, agentId: effectiveAgent });
      setVariantList(res.rich?.length ? res.rich : res.variants.map((v) => ({ text: v, styles: [] })));
    } catch (err) {
      pushToast({ tone: 'error', title: 'Agent chưa viết được biến thể', description: errorMessage(err) });
    } finally {
      setWriting(false);
    }
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    let next = attachments;
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(tokenizedSseUrl('/api/m/zalo/media'), { method: 'POST', body: form });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          pushToast({ tone: 'error', title: `Không tải được ${file.name}`, description: (body as { error?: string }).error });
          continue;
        }
        const m = (body as { media: { id: number; name: string; kind: MarketingAttachment['kind'] } }).media;
        const added: MarketingAttachment = { mediaId: m.id, name: m.name, kind: m.kind };
        const images = [...next, added].filter((a) => a.kind === 'image').length;
        const others = next.length + 1 - images;
        if (images > MAX_TEMPLATE_IMAGES || others > MAX_TEMPLATE_FILES) {
          pushToast({ tone: 'error', title: 'Vượt giới hạn đính kèm', description: `Tối đa ${MAX_TEMPLATE_IMAGES} ảnh và ${MAX_TEMPLATE_FILES} tệp khác.` });
          continue;
        }
        next = [...next, added];
        setAttachments(next);
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function save() {
    setSaving(true);
    try {
      const payload = { name, text, styles, attachmentIds: attachments.map((a) => a.mediaId) };
      const res = template
        ? await apiPut<{ warnings?: string[] }>(`/api/m/zalo/templates/${template.id}`, payload)
        : await apiPost<{ warnings?: string[] }>('/api/m/zalo/templates', payload);
      pushToast({ tone: 'success', title: 'Đã lưu mẫu tin', description: res.warnings?.[0] });
      onSaved();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const canSave = name.trim().length > 0 && (text.trim().length > 0 || attachments.length > 0) && !saving && !uploading;

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      title={template ? 'Sửa mẫu tin' : 'Tạo mẫu tin'}
      width={980}
      footer={
        <>
          <button type="button" class={BTN} onClick={onClose} disabled={saving}>Huỷ</button>
          <button type="button" class={`${BTN_PRIMARY} ml-auto`} onClick={() => void save()} disabled={!canSave}>
            {saving ? 'Đang lưu…' : 'Lưu mẫu tin'}
          </button>
        </>
      }
    >
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div class="flex flex-col gap-4 min-w-0">
          <div>
            <label class={LABEL} for="tpl-name">Tên mẫu</label>
            <input id="tpl-name" class={INPUT} value={name} maxLength={120} placeholder="Ví dụ: Chào khách mới" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </div>
          <div>
            <label class={LABEL}>Nội dung</label>
            <RichTextEditor
              value={text}
              styles={styles}
              variables={variables.data?.variables}
              maxLength={MAX_TEMPLATE_TEXT}
              rows={9}
              placeholder={'{Chào|Xin chào} {gender} {name}, em là {sale}…'}
              onChange={(t, s) => { setText(t); setStyles(s); }}
            />
          </div>

          <div>
            <div class="flex items-center gap-2 mb-1.5">
              <span class="text-[13px] font-medium text-[var(--color-text-muted)]">Tệp đính kèm</span>
              <span class="text-[12px] text-[var(--color-text-faint)]">tối đa {MAX_TEMPLATE_IMAGES} ảnh + {MAX_TEMPLATE_FILES} tệp, mỗi tệp ≤ 25 MB</span>
              <button type="button" class={`${BTN} ml-auto`} disabled={uploading} onClick={() => fileInput.current?.click()}>
                <Paperclip size={12} /> {uploading ? 'Đang tải…' : 'Thêm tệp'}
              </button>
              <input ref={fileInput} type="file" multiple class="hidden" onChange={(e) => void upload((e.target as HTMLInputElement).files)} />
            </div>
            {attachments.length === 0 ? (
              <div class="text-[13px] text-[var(--color-text-faint)]">Chưa có tệp nào. Ảnh được gửi sau phần chữ.</div>
            ) : (
              <div class="flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div key={a.mediaId} class="relative w-[72px] h-[72px] rounded border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden flex items-center justify-center" title={a.name}>
                    {a.kind === 'image' ? (
                      <img src={mediaUrl(a.mediaId)} alt={a.name} class="w-full h-full object-cover" />
                    ) : (
                      <div class="flex flex-col items-center gap-1 px-1 text-[var(--color-text-muted)]">
                        <FileText size={20} />
                        <span class="text-[9.5px] leading-tight line-clamp-2 break-all text-center">{a.name}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      aria-label={`Bỏ ${a.name}`}
                      class="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/60 text-white hover:bg-black/80"
                      onClick={() => setAttachments(attachments.filter((x) => x.mediaId !== a.mediaId))}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div class="flex flex-col gap-4 min-w-0">
          <div>
            <div class="flex items-center gap-2 mb-1.5">
              <span class="text-[13px] font-medium text-[var(--color-text-muted)]">Xem trước tin gửi đi</span>
              <button type="button" class={`${BTN} ml-auto`} disabled={!text} onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
                <RefreshCw size={12} /> Đổi biến thể
              </button>
            </div>
            <div class="rounded border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 min-h-[88px]">
              {preview && preview.text ? (
                <RichTextPreview text={preview.text} styles={preview.styles} />
              ) : (
                <span class="text-[13px] text-[var(--color-text-faint)]">Nhập nội dung để xem trước. Biến được điền bằng dữ liệu mẫu (khách “Nguyễn Thị Lan”).</span>
              )}
            </div>
            {preview?.warnings.map((w) => (
              <div key={w} class="mt-1.5 text-[11.5px] text-[var(--color-priority-medium)]">{w}</div>
            ))}
          </div>

          <div class="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2.5">
            <div class="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-text)]">
              <Sparkles size={13} /> Agent viết biến thể
            </div>
            <div class="text-[11.5px] text-[var(--color-text-muted)]">
              Nhờ một agent viết lại nội dung thành vài cách diễn đạt khác nhau (giữ nguyên biến và ý). Chọn bản ưng ý hoặc gộp vào dạng <code>{'{a|b}'}</code>.
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <select class={`${INPUT} !w-auto`} value={effectiveAgent} onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)} aria-label="Agent">
                {agentList.length === 0 && <option value="main">main</option>}
                {agentList.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
              </select>
              <select class={`${INPUT} !w-auto`} value={count} onChange={(e) => setCount(Number((e.target as HTMLSelectElement).value))} aria-label="Số biến thể">
                {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} biến thể</option>)}
              </select>
              <button type="button" class={BTN} disabled={writing || !text.trim()} onClick={() => void writeVariants()}>
                <Wand2 size={12} /> {writing ? 'Agent đang viết…' : 'Viết biến thể'}
              </button>
            </div>
            {variantList.map((v, i) => (
              <div key={i} class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 flex flex-col gap-2">
                <RichTextPreview text={v.text} styles={v.styles} />
                <div class="flex flex-wrap gap-2">
                  <button type="button" class={BTN} onClick={() => { setText(v.text); setStyles(v.styles); }}>Dùng bản này</button>
                  <button
                    type="button"
                    class={BTN}
                    onClick={() => {
                      const merged = addToSpintax({ text, styles }, v);
                      setText(merged.text);
                      setStyles(merged.styles);
                    }}
                  >
                    Gộp thành spintax
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
