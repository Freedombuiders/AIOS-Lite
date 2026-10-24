import { useEffect, useState } from 'preact/hooks';
import { Search } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { apiGet, apiPatch } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import type { ZaloThreadSummary } from '../../lib/zalo';
import { BTN, INPUT, LABEL, errMsg, formatBirthDate } from './BirthdayShared';

/** Set or clear one customer's birth date by hand (for people whose Zalo profile hides it). */
export function BirthdayBirthDateDialog({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ZaloThreadSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<ZaloThreadSummary | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [yearUnknown, setYearUnknown] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery(''); setResults([]); setPicked(null); setCurrent(null); setDate(''); setYearUnknown(false);
    }
  }, [open]);

  // Debounced search over 1-1 threads by name.
  useEffect(() => {
    const q = query.trim();
    if (!open || picked || q.length === 0) { setResults([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      apiGet<{ threads: ZaloThreadSummary[] }>(`/api/m/zalo/threads?type=user&limit=20&search=${encodeURIComponent(q)}`)
        .then((r) => { if (!cancelled) setResults(r.threads); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, open, picked]);

  async function pick(t: ZaloThreadSummary) {
    setPicked(t);
    setCurrent(null);
    setDate('');
    setYearUnknown(false);
    try {
      const r = await apiGet<{ birthDate: string | null }>(`/api/m/zalo/threads/${t.id}/birth-date`);
      setCurrent(r.birthDate);
      if (r.birthDate) {
        const unknown = r.birthDate.startsWith('0000');
        setYearUnknown(unknown);
        // <input type=date> needs a year; 2000 is a leap year, so 29/02 stays valid.
        setDate(unknown ? `2000${r.birthDate.slice(4)}` : r.birthDate);
      }
    } catch { /* leave blank */ }
  }

  async function save(birthDate: string | null) {
    if (!picked) return;
    setSaving(true);
    try {
      await apiPatch(`/api/m/zalo/threads/${picked.id}/birth-date`, { birthDate });
      pushToast({ tone: 'success', title: birthDate ? 'Đã lưu ngày sinh' : 'Đã xoá ngày sinh', description: picked.name });
      onSaved();
      onClose();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  const value = date ? (yearUnknown ? date.slice(5) : date) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Đặt ngày sinh cho khách"
      width={460}
      footer={picked ? (
        <>
          {current && (
            <button type="button" class={`${BTN} text-[var(--color-status-failed)]`} disabled={saving} onClick={() => void save(null)}>Xoá ngày sinh</button>
          )}
          <button type="button" class={`${BTN} ml-auto`} disabled={saving} onClick={onClose}>Huỷ</button>
          <button type="button" class={`${BTN} control-accent`} disabled={saving || !value} onClick={() => void save(value)}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </>
      ) : undefined}
    >
      {!picked ? (
        <div class="flex flex-col gap-3">
          <div>
            <label class={LABEL} for="bd-search">Tìm khách (chat 1-1) theo tên</label>
            <div class="relative">
              <Search size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
              <input
                id="bd-search" class={`${INPUT} !pl-8`} autofocus placeholder="Gõ tên khách…"
                value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          {searching && <div class="text-[12px] text-[var(--color-text-faint)]">Đang tìm…</div>}
          {!searching && query.trim() && results.length === 0 && (
            <div class="text-[12px] text-[var(--color-text-faint)]">Không thấy khách nào.</div>
          )}
          <ul class="flex flex-col max-h-[280px] overflow-y-auto">
            {results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  class="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--color-control-hover)] text-[12.5px] text-[var(--color-text)]"
                  onClick={() => void pick(t)}
                >
                  {t.name || t.externalId}
                  <span class="ml-2 text-[11px] text-[var(--color-text-faint)]">{t.accountLabel}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div class="flex flex-col gap-3">
          <div class="text-[12.5px] text-[var(--color-text)]">
            <b>{picked.name || picked.externalId}</b>
            <span class="ml-2 text-[11px] text-[var(--color-text-faint)]">{picked.accountLabel}</span>
            <button type="button" class="ml-3 text-[11.5px] text-[var(--color-accent)] hover:underline" onClick={() => setPicked(null)}>Chọn khách khác</button>
          </div>
          <div class="text-[11.5px] text-[var(--color-text-muted)]">
            Ngày sinh hiện có: {current ? formatBirthDate(current) : 'chưa có'}
          </div>
          <div>
            <label class={LABEL} for="bd-date">Ngày sinh</label>
            <input
              id="bd-date" type="date" class={INPUT} value={date}
              min="1900-01-01" max={new Date().toISOString().slice(0, 10)}
              onInput={(e) => setDate((e.target as HTMLInputElement).value)}
            />
          </div>
          <label class="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text)]">
            <input type="checkbox" checked={yearUnknown} onChange={() => setYearUnknown(!yearUnknown)} />
            Chỉ biết ngày và tháng (không biết năm sinh)
          </label>
        </div>
      )}
    </Modal>
  );
}
