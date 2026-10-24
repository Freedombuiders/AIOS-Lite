import { useState } from 'preact/hooks';
import { Plus, Trash2 } from 'lucide-preact';
import { FolderBrowser } from '@/components/FolderBrowser';
import { Modal } from '@/components/Modal';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Card, Field } from '@/components/ui';
import { apiDelete, apiPost, errorText } from '@/lib/api';
import type { SkillRootSuggestion, SkillRootView } from '@/lib/api-types';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';

const KIND_LABEL: Record<SkillRootView['kind'], string> = { env: 'Cấu hình hệ thống', user: 'Bạn thêm', module: 'Module' };

export function SkillSources({ onChanged }: { onChanged: () => void }) {
  const f = useFetch<{ items: SkillRootView[]; suggestions: SkillRootSuggestion[] }>('/skills/roots');
  const [adding, setAdding] = useState<{ path: string; label: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function add(path: string, label?: string) {
    setBusy(path);
    try {
      await apiPost('/skills/roots', { path, ...(label?.trim() ? { label: label.trim() } : {}) });
      pushToast({ tone: 'success', title: 'Đã thêm nguồn skill' });
      setAdding(null);
      invalidateFetchCache('/skills');
      f.refresh();
      onChanged();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không thêm được nguồn skill', description: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: SkillRootView) {
    setBusy(r.path);
    try {
      await apiDelete('/skills/roots', { path: r.path });
      pushToast({ tone: 'success', title: 'Đã gỡ nguồn skill', description: 'Thư mục trên máy không bị xoá.' });
      invalidateFetchCache('/skills');
      f.refresh();
      onChanged();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không gỡ được', description: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const items = f.data?.items ?? [];
  const suggestions = f.data?.suggestions ?? [];

  return (
    <div class="flex flex-col gap-3">
      <p class="hint m-0">Skill là thư mục có file SKILL.md. AIOS đọc skill từ các nguồn dưới đây; khi hai nguồn có cùng mã skill thì nguồn đứng trước được dùng.</p>
      <PageState loading={f.loading && !f.data} error={f.error} />

      <Card title="Nguồn đang dùng" actions={<button type="button" class="control-button control-sm control-accent" onClick={() => setAdding({ path: '', label: '' })}><Plus size={11} /> Thêm nguồn</button>}>
        <div class="flex flex-col gap-2">
          {items.map((r, i) => (
            <div key={r.path} class="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-2">
              <span class="hint w-5 text-center">{i + 1}</span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">
                  {r.label}
                  <Pill tone={r.kind === 'user' ? 'accent' : 'neutral'}>{KIND_LABEL[r.kind]}</Pill>
                  {r.readOnly && <Pill>Chỉ đọc</Pill>}
                  {!r.exists && <Pill tone="warn">Thiếu thư mục</Pill>}
                </div>
                <div class="hint mono break-all">{r.path}</div>
                {r.clashes.length > 0 && <div class="mt-0.5 text-[11.5px] text-[var(--color-status-review)]">Trùng mã với nguồn đứng trước (bị bỏ qua): {r.clashes.join(', ')}</div>}
              </div>
              <span class="text-[12px]"><b>{r.skills}</b> <span class="hint">skill</span></span>
              {!r.readOnly && <button type="button" class="control-button control-sm control-danger" disabled={busy === r.path} onClick={() => void remove(r)}><Trash2 size={11} /> Gỡ</button>}
            </div>
          ))}
        </div>
      </Card>

      {suggestions.length > 0 && (
        <Card title="Gợi ý trên máy bạn">
          <div class="flex flex-col gap-2">
            {suggestions.map((s) => (
              <div key={s.path} class="flex flex-wrap items-center gap-2">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-medium">{s.label}</div>
                  <div class="hint mono break-all">{s.path}</div>
                </div>
                <span class="text-[12px]"><b>{s.skills}</b> <span class="hint">skill</span></span>
                <button type="button" class="control-button control-sm" disabled={busy === s.path} onClick={() => void add(s.path, s.label)}><Plus size={11} /> Thêm</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal
        open={!!adding}
        onClose={() => setAdding(null)}
        title="Thêm nguồn skill"
        width={620}
        footer={
          <>
            <button type="button" class="control-button" onClick={() => setAdding(null)}>Huỷ</button>
            <button type="button" class="control-button control-accent" disabled={!adding?.path.trim() || busy !== null} onClick={() => adding && void add(adding.path, adding.label)}>Thêm</button>
          </>
        }
      >
        {adding && (
          <div class="flex flex-col gap-3">
            <Field label="Tên hiển thị (không bắt buộc)"><input class="field" value={adding.label} placeholder="Ví dụ: Skill công ty A" onInput={(e) => setAdding({ ...adding, label: (e.target as HTMLInputElement).value })} /></Field>
            <Field label="Thư mục chứa các skill" hint="Chọn thư mục mà bên trong có các thư mục con dạng <mã-skill>/SKILL.md.">
              <input class="field mono" value={adding.path} placeholder="~/.claude/skills" onInput={(e) => setAdding({ ...adding, path: (e.target as HTMLInputElement).value })} />
            </Field>
            <FolderBrowser path={adding.path} onPathChange={(path) => setAdding({ ...adding, path })} />
          </div>
        )}
      </Modal>
    </div>
  );
}
