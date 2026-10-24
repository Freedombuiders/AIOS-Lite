import { Link } from 'wouter-preact';
import { Paperclip } from 'lucide-preact';
import { RichTextPreview } from '@/components/RichTextEditor';
import { Pill } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { attachmentSummary, type MarketingTemplate } from '@/lib/marketing';

interface Props {
  value: number | null;
  onChange: (templateId: number | null) => void;
  disabled?: boolean;
}

/** Select a message template (Zalo › Mẫu tin) with a small preview of the choice. */
export function TemplatePicker({ value, onChange, disabled }: Props) {
  const templates = useFetch<{ templates: MarketingTemplate[] }>('/api/m/zalo/templates');
  const list = templates.data?.templates ?? [];
  const chosen = value === null ? undefined : list.find((t) => t.id === value);

  return (
    <div class="flex flex-col gap-2">
      <select
        class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] disabled:opacity-50"
        disabled={disabled}
        value={value ?? ''}
        aria-label="Mẫu tin"
        onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          onChange(Number.isInteger(v) && v > 0 ? v : null);
        }}
      >
        <option value="">{templates.loading && list.length === 0 ? 'Đang tải…' : '— Chọn mẫu tin —'}</option>
        {/* A template deleted after being chosen stays visible so the form does not silently change. */}
        {value !== null && !chosen && !templates.loading && <option value={value}>Mẫu #{value} (không còn tồn tại)</option>}
        {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {!templates.loading && list.length === 0 && (
        <div class="text-[11.5px] text-[var(--color-text-faint)]">Chưa có mẫu tin nào. Tạo ở <Link href="/m/zalo/templates" class="underline hover:text-[var(--color-text)]">Zalo › Mẫu tin</Link>.</div>
      )}
      {chosen && (
        <div class="rounded border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 max-h-36 overflow-y-auto">
          {chosen.text ? <RichTextPreview text={chosen.text} styles={chosen.styles} /> : <span class="text-[12px] text-[var(--color-text-faint)]">(chỉ có tệp đính kèm)</span>}
          {chosen.attachments.length > 0 && (
            <div class="mt-1.5"><Pill tone="neutral"><Paperclip size={10} /> {attachmentSummary(chosen.attachments)}</Pill></div>
          )}
        </div>
      )}
    </div>
  );
}
