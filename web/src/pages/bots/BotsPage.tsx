// Đội AI · Bot: every agent is a GenBot bot. Connection to GenBot at the top, one card per bot, add a bot from a template
// (with a probe before saving), and the agents left on an old runtime with "Chuyển sang GenBot".
// Drawing: docs/dev/design-mockups/Bots.dc.html.
import { BookOpen, KeyRound, Pause, Pencil, Play, Plus, RefreshCw, Stethoscope, Trash2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Field, Markdown } from '@/components/ui';
import { errorText } from '@/lib/api';
import type { DoctorCheck } from '@/lib/api-types';
import { formatRelativeTime } from '@/lib/format';
import { botState, genbotApi, initials, keyLabel, type GenbotBot, type GenbotOverview, type GenbotProbeResult, type GenbotTemplate, type GenbotTemplateId } from '@/lib/genbot';
import { RUNTIME_LABEL } from '@/lib/labels';
import { renderMarkdown } from '@/lib/markdown';
import { pushToast } from '@/lib/toasts';
import type { RuntimeId } from '@core/types';

const ONE_BOT_PER_COMPANY = 'Mỗi công ty nên dùng một bot GenBot riêng: bộ nhớ đã lưu và chỉ dẫn thường trực của bot GenBot nằm ngoài quyền brain của AIOS.';

const HOW_TO = [
  'Mở app GenBot, chọn bot.',
  'Mở cài đặt của bot (bánh răng), vào Nâng cao › Truy cập.',
  'Bật Bot API ("Let apps talk to this bot").',
  'Chép khoá hiện ra (chỉ hiện một lần) và mã bot, dán vào "Thêm bot GenBot" bên dưới.',
];

const TINTS = ['rgba(70,194,138,0.18)', 'rgba(199,155,255,0.18)', 'rgba(109,141,255,0.18)', 'rgba(255,180,84,0.18)'];
const INKS = ['#46c28a', '#c79bff', '#a9bbff', '#ffb454'];

function Checks({ checks }: { checks: DoctorCheck[] }) {
  return (
    <ul class="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
      {checks.map((c, i) => (
        <li key={i} class="flex items-start gap-2">
          <Pill tone={c.level === 'error' ? 'error' : c.level === 'warn' ? 'warn' : 'success'}>{c.level === 'error' ? 'Lỗi' : c.level === 'warn' ? 'Lưu ý' : 'Được'}</Pill>
          <span>{c.message}{c.hint ? <span class="hint"> {c.hint}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

function Guide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [md, setMd] = useState<string | null>(null);
  useEffect(() => {
    if (!open || md !== null) return;
    genbotApi.guide().then((r) => setMd(r.markdown), (e) => setMd(`Không tải được hướng dẫn: ${errorText(e)}`));
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Hướng dẫn nối GenBot" width={760}>
      {md === null ? <p class="hint">Đang tải…</p> : <Markdown html={renderMarkdown(md)} />}
      <p class="hint mt-3 mb-0">Tệp gốc: <span class="mono">docs/huong-dan-noi-genbot.md</span></p>
    </Modal>
  );
}

// ---------------------------------------------------------------- connection

function ConnectionPanel({ data, onSaved, onGuide }: { data: GenbotOverview; onSaved: () => void; onGuide: () => void }) {
  const [url, setUrl] = useState(data.baseUrl);
  const [applyAll, setApplyAll] = useState(false);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; checks: DoctorCheck[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setUrl(data.baseUrl), [data.baseUrl]);

  const check = async () => {
    setBusy('check');
    setError(null);
    try {
      setResult(await genbotApi.checkConnection(url.trim()));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const r = await genbotApi.saveConnection(url.trim(), applyAll);
      pushToast({ tone: 'success', title: applyAll ? `Đã lưu địa chỉ GenBot cho ${r.updated} bot` : 'Đã lưu địa chỉ GenBot' });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section class="card card-pad flex flex-col gap-3" aria-labelledby="genbot-conn">
      <div class="flex flex-wrap items-center gap-2">
        <h2 id="genbot-conn" class="m-0 text-[15px] font-semibold">Kết nối GenBot</h2>
        {result && <Pill tone={result.ok ? 'success' : 'error'}>{result.ok ? 'GenBot đang chạy' : 'Chưa thấy GenBot'}</Pill>}
      </div>
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
          <span class="label">Địa chỉ GenBot</span>
          <input class="field mono" value={url} placeholder={data.defaultBaseUrl} aria-label="Địa chỉ GenBot" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        </label>
        <button type="button" class="control-button" disabled={busy !== null} onClick={() => void check()}>
          <Stethoscope size={13} /> {busy === 'check' ? 'Đang kiểm tra…' : 'Kiểm tra'}
        </button>
        <button type="button" class="control-button control-accent" disabled={busy !== null || !url.trim() || (url.trim() === data.baseUrl && !applyAll)} onClick={() => void save()}>
          {busy === 'save' ? 'Đang lưu…' : 'Lưu'}
        </button>
      </div>
      <label class="flex items-center gap-2 text-[12px]">
        <input type="checkbox" checked={applyAll} onChange={() => setApplyAll(!applyAll)} /> Áp dụng địa chỉ này cho mọi bot
      </label>
      <p class="hint m-0">http:// chỉ dùng cho GenBot trên máy này (127.0.0.1); GenBot ở máy khác phải là https://.</p>
      {error && <div class="text-[12px] text-[var(--color-status-failed)]" role="alert">{error}</div>}
      {result && <Checks checks={result.checks} />}
      <details class="text-[13px]">
        <summary class="cursor-pointer font-medium">Lấy khoá Bot API trong GenBot</summary>
        <ol class="mt-2 mb-1 flex flex-col gap-1 pl-5">
          {HOW_TO.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <button type="button" class="control-button control-sm mt-1" onClick={onGuide}><BookOpen size={12} /> Xem hướng dẫn đầy đủ</button>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------- one bot

function Row({ label, children, mono }: { label: string; children: preact.ComponentChildren; mono?: boolean }) {
  return (
    <>
      <dt class="text-[var(--color-text-muted)]">{label}</dt>
      <dd class={`m-0 min-w-0 break-words ${mono ? 'mono text-[12px]' : ''}`}>{children}</dd>
    </>
  );
}

function BotCard({ b, i, busy, onCheck, onEdit, onKey, onPause, onDelete }: {
  b: GenbotBot; i: number; busy: boolean;
  onCheck: () => void; onEdit: () => void; onKey: () => void; onPause: () => void; onDelete: () => void;
}) {
  const st = botState(b);
  const reads = b.brain.flatMap((g) => g.read.map((r) => `${g.folder}/${r}`));
  const writes = b.brain.flatMap((g) => g.write.map((w) => `${g.folder}/${w}`));
  const scopes = Object.entries(b.modules).flatMap(([m, s]) => s.map((x) => `${m}: ${x}`));
  return (
    <section class="card flex flex-col gap-3 p-4" data-bot={b.id} aria-label={`Bot ${b.name}`}>
      <div class="flex items-center gap-3">
        <span aria-hidden="true" class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl font-bold" style={{ background: TINTS[i % TINTS.length], color: INKS[i % INKS.length] }}>{initials(b.name)}</span>
        <div class="flex min-w-0 flex-1 flex-col">
          <h2 class="m-0 truncate text-[16px] font-semibold">{b.name}</h2>
          <span class="truncate text-[13px] text-[var(--color-text-muted)]">{b.role || b.id}</span>
        </div>
        <Pill tone={st.tone}>{st.label}</Pill>
      </div>
      <dl class="m-0 grid gap-x-3 gap-y-2 text-[13px]" style={{ gridTemplateColumns: '108px minmax(0,1fr)' }}>
        <Row label="Mã bot GenBot" mono>{b.botId || <span class="text-[var(--color-status-review)]">chưa điền</span>}</Row>
        <Row label="Khoá"><span data-testid="key-status">{keyLabel(b.key)}</span></Row>
        <Row label="Kiểm tra">
          {b.lastCheck ? (
            <span><Pill tone={b.lastCheck.ok ? 'success' : 'error'}>{b.lastCheck.ok ? 'Được' : 'Lỗi'}</Pill> {b.lastCheck.message} <span class="hint">· {formatRelativeTime(b.lastCheck.at)}</span></span>
          ) : <span class="text-[var(--color-text-muted)]">Chưa kiểm tra</span>}
        </Row>
        <Row label="Hôm nay">{b.maxRunsDay > 0 ? `${b.runsToday} / ${b.maxRunsDay} lượt` : `${b.runsToday} lượt (không giới hạn)`}</Row>
        <Row label="Dùng ở">{b.usedBy.length ? b.usedBy.join(' · ') : <span class="text-[var(--color-text-muted)]">Chưa module nào dùng</span>}</Row>
        <Row label="Đọc brain" mono>{reads.length ? reads.join('  ') : '—'}</Row>
        <Row label="Được ghi" mono>{writes.length ? writes.join('  ') : '—'}</Row>
        <Row label="Quyền module" mono>{scopes.length ? scopes.join('  ') : '—'}</Row>
      </dl>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="control-button control-accent" disabled={busy || !b.connected} title={b.connected ? 'Gửi "ping" thật tới bot (tính vào 10 lượt mỗi phút)' : 'Điền mã bot và khoá trước'} onClick={onCheck}>
          <Stethoscope size={13} /> {busy ? 'Đang kiểm tra…' : 'Kiểm tra'}
        </button>
        <button type="button" class="control-button" onClick={onEdit}><Pencil size={13} /> Sửa</button>
        <button type="button" class="control-button" onClick={onKey}><KeyRound size={13} /> Đổi khoá</button>
        <button type="button" class="control-button" onClick={onPause}>{b.enabled ? <><Pause size={13} /> Tạm dừng</> : <><Play size={13} /> Tiếp tục</>}</button>
        <button type="button" class="control-button control-danger" onClick={onDelete}><Trash2 size={13} /> Xoá</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- add a bot

function TemplateAccess({ t, folder }: { t: GenbotTemplate; folder: string }) {
  const scopes = Object.entries(t.modules).flatMap(([m, s]) => s.map((x) => `${m}: ${x}`));
  const at = (p: string) => (folder ? `${folder}/${p}` : p);
  return (
    <dl class="m-0 grid gap-x-3 gap-y-1 text-[12px]" style={{ gridTemplateColumns: '96px minmax(0,1fr)' }}>
      <Row label="Đọc brain" mono>{t.brain.read.map(at).join('  ') || '—'}</Row>
      <Row label="Được ghi" mono>{t.brain.write.map(at).join('  ') || '—'}</Row>
      <Row label="Quyền module" mono>{scopes.join('  ') || '—'}</Row>
      <Row label="Ngữ cảnh">{t.context === 'lean' ? 'Gọn (lean)' : 'Đầy đủ (standard)'}</Row>
    </dl>
  );
}

function AddBotDialog({ open, data, onClose, onCreated }: { open: boolean; data: GenbotOverview; onClose: () => void; onCreated: (b: GenbotBot) => void }) {
  const [template, setTemplate] = useState<GenbotTemplateId>('cskh');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [botId, setBotId] = useState('');
  const [key, setKey] = useState('');
  const [folder, setFolder] = useState(data.brainFolders[0]?.id ?? '');
  const [busy, setBusy] = useState<'probe' | 'save' | null>(null);
  const [probe, setProbe] = useState<GenbotProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tpl = data.templates.find((t) => t.id === template);

  useEffect(() => {
    if (!open) return;
    const first = data.templates.find((t) => t.id === 'cskh') ?? data.templates[0];
    setTemplate(first?.id ?? 'cskh'); setName(first ? `Bot ${first.label}` : ''); setRole(first?.hint ?? ''); setBotId(''); setKey(''); setProbe(null); setError(null);
    setFolder(data.brainFolders[0]?.id ?? '');
  }, [open]);

  const pick = (t: GenbotTemplate) => {
    setTemplate(t.id);
    if (!name.trim() || data.templates.some((x) => `Bot ${x.label}` === name)) setName(`Bot ${t.label}`);
    if (!role.trim() || data.templates.some((x) => x.hint === role)) setRole(t.hint);
  };
  const canProbe = !!botId.trim() && !!key.trim();

  const runProbe = async (): Promise<GenbotProbeResult | null> => {
    setBusy('probe');
    setError(null);
    try {
      const r = await genbotApi.probe({ botId: botId.trim(), key: key.trim(), baseUrl: data.baseUrl });
      setProbe(r);
      return r;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const save = async (force = false) => {
    if (!name.trim()) return setError('Hãy đặt tên cho bot.');
    // probe before saving: the owner sees GenBot's reply first
    if (canProbe && !force && !probe?.summary.ok) {
      const r = await runProbe();
      if (!r?.summary.ok) return;
    }
    setBusy('save');
    setError(null);
    try {
      const b = await genbotApi.create({ name: name.trim(), role: role.trim(), botId: botId.trim(), ...(key.trim() ? { key: key.trim() } : {}), baseUrl: data.baseUrl, template, ...(folder ? { brainFolder: folder } : {}) });
      setKey('');
      onCreated(b);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const probeFailed = !!probe && !probe.summary.ok;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Thêm bot GenBot"
      width={620}
      closeDisabled={busy !== null}
      footer={
        <>
          {error && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]" role="alert">{error}</span>}
          <button type="button" class="control-button" disabled={busy !== null} onClick={onClose}>Huỷ</button>
          <button type="button" class="control-button" disabled={busy !== null || !canProbe} onClick={() => void runProbe()}>{busy === 'probe' ? 'Đang kiểm tra…' : 'Kiểm tra'}</button>
          {probeFailed
            ? <button type="button" class="control-button control-accent" disabled={busy !== null} onClick={() => void save(true)}>Vẫn lưu</button>
            : <button type="button" class="control-button control-accent" disabled={busy !== null} onClick={() => void save()}>{busy === 'save' ? 'Đang lưu…' : canProbe ? 'Kiểm tra rồi lưu' : 'Lưu bot'}</button>}
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <div>
          <span class="label">Mẫu</span>
          <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Mẫu bot">
            {data.templates.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={template === t.id} class={`control-button ${template === t.id ? 'control-accent' : ''}`} onClick={() => pick(t)}>{t.label}</button>
            ))}
          </div>
          {tpl && <p class="hint mt-1 mb-2">{tpl.hint}</p>}
          {tpl && <TemplateAccess t={tpl} folder={folder} />}
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label="Tên bot"><input class="field" aria-label="Tên bot" value={name} placeholder="Bot CSKH" onInput={(e) => setName((e.target as HTMLInputElement).value)} /></Field>
          <Field label="Thư mục brain" hint="Bot được đọc, ghi theo mẫu trong thư mục này.">
            <select class="field" aria-label="Thư mục brain" value={folder} onChange={(e) => setFolder((e.target as HTMLSelectElement).value)}>
              {data.brainFolders.length === 0 && <option value="">Chưa có thư mục brain</option>}
              {data.brainFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Vai trò"><input class="field" aria-label="Vai trò" value={role} placeholder="Trực hộp thư Zalo, trả lời khách theo brain" onInput={(e) => setRole((e.target as HTMLInputElement).value)} /></Field>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label="Mã bot GenBot" hint="Trên thẻ Bot API của bot trong GenBot.">
            <input class="field mono" aria-label="Mã bot GenBot" value={botId} placeholder="bot_abc123" onInput={(e) => { setBotId((e.target as HTMLInputElement).value); setProbe(null); }} />
          </Field>
          <Field label="Khoá Bot API" hint="Lưu mã hoá trong AIOS, không ghi vào .env hay agent.yaml.">
            <input class="field mono" type="password" autocomplete="off" aria-label="Khoá Bot API" value={key} placeholder="Dán khoá" onInput={(e) => { setKey((e.target as HTMLInputElement).value); setProbe(null); }} />
          </Field>
        </div>
        {!canProbe && <p class="hint m-0">Chưa có mã bot hoặc khoá thì bot được lưu ở trạng thái "Chưa nối GenBot"; điền sau bằng Sửa và Đổi khoá.</p>}
        {probe && (
          <div class="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3" data-testid="probe-result">
            <div class="flex items-center gap-2 text-[13px]">
              <Pill tone={probe.summary.ok ? 'success' : 'error'}>{probe.summary.ok ? 'GenBot trả lời' : 'Chưa được'}</Pill>
              <span>{probe.summary.message}</span>
            </div>
            <Checks checks={probe.checks} />
          </div>
        )}
        <p class="hint m-0">{ONE_BOT_PER_COMPANY}</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- edit, key

function EditBotDialog({ bot, onClose, onSaved }: { bot: GenbotBot | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ name: '', role: '', botId: '', baseUrl: '', maxRunsDay: '500' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (bot) setV({ name: bot.name, role: bot.role, botId: bot.botId, baseUrl: bot.baseUrl, maxRunsDay: String(bot.maxRunsDay) });
    setError(null);
  }, [bot?.id]);
  if (!bot) return null;
  const save = async () => {
    const max = Number(v.maxRunsDay);
    if (!Number.isInteger(max) || max < 0) return setError('Trần lượt mỗi ngày phải là số nguyên không âm (0 = không giới hạn).');
    setBusy(true);
    setError(null);
    try {
      await genbotApi.update(bot.id, { name: v.name.trim(), role: v.role.trim(), botId: v.botId.trim(), baseUrl: v.baseUrl.trim(), maxRunsDay: max });
      pushToast({ tone: 'success', title: `Đã lưu ${v.name.trim()}` });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof v) => (e: Event) => setV({ ...v, [k]: (e.target as HTMLInputElement).value });
  return (
    <Modal open onClose={onClose} title={`Sửa ${bot.name}`} width={560} closeDisabled={busy}
      footer={<>
        {error && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]" role="alert">{error}</span>}
        <button type="button" class="control-button" disabled={busy} onClick={onClose}>Huỷ</button>
        <button type="button" class="control-button control-accent" disabled={busy || !v.name.trim()} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
      </>}
    >
      <div class="flex flex-col gap-3">
        <Field label="Tên bot"><input class="field" aria-label="Tên bot" value={v.name} onInput={set('name')} /></Field>
        <Field label="Vai trò"><input class="field" aria-label="Vai trò" value={v.role} onInput={set('role')} /></Field>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label="Mã bot GenBot"><input class="field mono" aria-label="Mã bot GenBot" value={v.botId} onInput={set('botId')} /></Field>
          <Field label="Trần lượt mỗi ngày" hint="0 = không giới hạn."><input class="field" type="number" min={0} aria-label="Trần lượt mỗi ngày" value={v.maxRunsDay} onInput={set('maxRunsDay')} /></Field>
        </div>
        <Field label="Địa chỉ GenBot"><input class="field mono" aria-label="Địa chỉ GenBot của bot" value={v.baseUrl} onInput={set('baseUrl')} /></Field>
      </div>
    </Modal>
  );
}

function KeyDialog({ bot, onClose, onSaved }: { bot: GenbotBot | null; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setKey(''); setError(null); }, [bot?.id]);
  if (!bot) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await genbotApi.setKey(bot.id, key.trim());
      setKey('');
      pushToast({ tone: 'success', title: `Đã lưu khoá mới cho ${bot.name}` });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Đổi khoá · ${bot.name}`} width={480} closeDisabled={busy}
      footer={<>
        {error && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]" role="alert">{error}</span>}
        <button type="button" class="control-button" disabled={busy} onClick={onClose}>Huỷ</button>
        <button type="button" class="control-button control-accent" disabled={busy || !key.trim()} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu khoá'}</button>
      </>}
    >
      <div class="flex flex-col gap-2">
        <p class="m-0 text-[13px]">Hiện tại: <strong>{keyLabel(bot.key)}</strong></p>
        <Field label="Khoá Bot API mới" hint="Trong GenBot, thẻ Bot API của bot: New key. Khoá cũ ngừng dùng được ngay.">
          <input class="field mono" type="password" autocomplete="off" aria-label="Khoá Bot API mới" value={key} placeholder="Dán khoá" onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
        </Field>
        <p class="hint m-0">AIOS lưu khoá mã hoá, chỉ hiện 4 ký tự cuối, không ghi vào agent.yaml, nhật ký hay .env.</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- page

export default function BotsPage() {
  const [data, setData] = useState<GenbotOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<GenbotBot | null>(null);
  const [keying, setKeying] = useState<GenbotBot | null>(null);
  const [deleting, setDeleting] = useState<GenbotBot | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setData(await genbotApi.overview());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const check = async (b: GenbotBot) => {
    setChecking(b.id);
    try {
      const r = await genbotApi.check(b.id);
      pushToast({ tone: r.summary.ok ? 'success' : 'error', title: r.summary.ok ? `${b.name}: GenBot trả lời` : `${b.name}: chưa được`, description: r.summary.message });
      await load();
    } catch (e) {
      pushToast({ tone: 'error', title: `Không kiểm tra được ${b.name}`, description: errorText(e) });
    } finally {
      setChecking(null);
    }
  };
  const pause = async (b: GenbotBot) => {
    try {
      await genbotApi.pause(b.id, b.enabled);
      pushToast({ tone: 'success', title: b.enabled ? `Đã tạm dừng ${b.name}` : `${b.name} đã chạy lại` });
      await load();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không đổi được trạng thái', description: errorText(e) });
    }
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await genbotApi.remove(deleting.id);
      pushToast({ tone: 'success', title: `Đã xoá ${deleting.name}` });
      setDeleting(null);
      await load();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không xoá được bot', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const convert = async (id: string, name: string) => {
    try {
      await genbotApi.convert(id);
      pushToast({ tone: 'success', title: `${name} đã chuyển sang GenBot`, description: 'Điền mã bot và khoá trên thẻ của bot.' });
      await load();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không chuyển được', description: errorText(e) });
    }
  };

  const empty = !!data && data.bots.length === 0;
  return (
    <div class="page">
      <PageHeader
        title="Bot"
        actions={<>
          <button type="button" class="control-button" onClick={() => void load()} aria-label="Tải lại"><RefreshCw size={12} /></button>
          <button type="button" class="control-button control-accent" disabled={!data} onClick={() => setAdding(true)}><Plus size={12} /> Thêm bot GenBot</button>
        </>}
      />
      <p class="m-0 mb-3 text-[13px] text-[var(--color-text-muted)]">Mọi bot chạy trong GenBot. Ở đây bạn nối từng bot với GenBot, cấp brain và quyền module cho nó.</p>
      <PageState loading={loading && !data} error={error} />
      {data && (
        <div class="flex flex-col gap-4">
          <ConnectionPanel data={data} onSaved={() => void load()} onGuide={() => setGuide(true)} />
          <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]" data-testid="one-bot-per-company">{ONE_BOT_PER_COMPANY}</p>

          {empty ? (
            <section class="card card-pad flex flex-col gap-3" data-testid="bots-empty">
              <h2 class="m-0 text-[16px] font-semibold">Chưa có bot GenBot nào</h2>
              <ol class="m-0 flex flex-col gap-1 pl-5 text-[13px]">{HOW_TO.map((s) => <li key={s}>{s}</li>)}</ol>
              <div class="flex flex-wrap gap-2">
                <button type="button" class="control-button control-accent" onClick={() => setAdding(true)}><Plus size={12} /> Thêm bot GenBot</button>
                <button type="button" class="control-button" onClick={() => setGuide(true)}><BookOpen size={12} /> Xem hướng dẫn</button>
              </div>
            </section>
          ) : (
            <div class="grid items-start gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))' }}>
              {data.bots.map((b, i) => (
                <BotCard key={b.id} b={b} i={i} busy={checking === b.id}
                  onCheck={() => void check(b)} onEdit={() => setEditing(b)} onKey={() => setKeying(b)} onPause={() => void pause(b)} onDelete={() => setDeleting(b)} />
              ))}
            </div>
          )}

          {!empty && (
            <section class="flex flex-wrap items-center gap-4 rounded-2xl border border-dashed border-[var(--color-border-strong)] p-4">
              <div class="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
                <h2 class="m-0 text-[15px] font-semibold">Thêm bot GenBot</h2>
                <span class="text-[13px] text-[var(--color-text-muted)]">Chọn mẫu CSKH Zalo, Nội dung hoặc Trợ lý: quyền brain và quyền module được điền sẵn theo Đội AgenticOS mặc định.</span>
              </div>
              <button type="button" class="control-button" onClick={() => setAdding(true)}><Plus size={12} /> Thêm bot GenBot</button>
            </section>
          )}

          {data.legacy.length > 0 && (
            <section class="card card-pad flex flex-col gap-2" data-testid="legacy-agents">
              <h2 class="m-0 text-[15px] font-semibold">Agent dùng runtime cũ</h2>
              <p class="hint m-0">Open AgenticOS chỉ chạy agent bằng GenBot. Các agent này không chạy cho tới khi bạn chuyển sang GenBot; AIOS không tự sửa agent.yaml của bạn.</p>
              <ul class="m-0 flex list-none flex-col gap-2 p-0">
                {data.legacy.map((a) => (
                  <li key={a.id} class="flex flex-wrap items-center gap-2 text-[13px]">
                    <strong>{a.name}</strong>
                    <Pill tone="warn">{RUNTIME_LABEL[a.runtime as RuntimeId] ?? a.runtime}</Pill>
                    <button type="button" class="control-button control-sm ml-auto" onClick={() => void convert(a.id, a.name)}>Chuyển sang GenBot</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {data && <AddBotDialog open={adding} data={data} onClose={() => setAdding(false)} onCreated={(b) => { setAdding(false); pushToast({ tone: 'success', title: `Đã thêm ${b.name}` }); void load(); }} />}
      <EditBotDialog bot={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      <KeyDialog bot={keying} onClose={() => setKeying(null)} onSaved={() => { setKeying(null); void load(); }} />
      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={deleting ? `Xoá ${deleting.name}?` : 'Xoá bot?'}
        body="Agent được chuyển vào agents/_archive và khoá Bot API lưu trong AIOS bị xoá. Bot trong app GenBot không bị đụng tới."
        confirmLabel="Xoá bot"
        destructive
        loading={busy}
      />
      <Guide open={guide} onClose={() => setGuide(false)} />
    </div>
  );
}
