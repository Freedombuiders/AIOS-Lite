/**
 * Tổng quan: the owner's home layout (hd-* classes from home-dashboard.css) fed by the AIOS-Lite API.
 * Blocks: header + status line, "Cần bạn", quick assign, KPI tiles, agents + 14-day activity, upcoming schedules,
 * team board, cost per agent and the module widget slot. A missing source shows an empty state, never a made-up number.
 */
import { AlarmClock, ArrowUpRight, Bot, CalendarClock, CircleCheck, Clock3, Coins, RefreshCw, TriangleAlert, Wallet } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { AttentionItem, BoardEntry, Run, Schedule, TaskStatus } from '@core/types';
import { AgentAvatar } from '@/components/AgentAvatar';
import { QuickAssign } from '@/components/QuickAssign';
import { apiPost, errorText } from '@/lib/api';
import type { StatsOverview } from '@/lib/api-types';
import { useAgents } from '@/lib/agents';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { resolveAgentName } from '@/lib/format';
import { activityTotals, fmtInt, fmtLongDate, fmtRelative, fmtTime, fmtUsd, greeting, groupByDay, HOME_POLL_MS, localParts, statusLine, upcomingItems } from '@/lib/home-dashboard';
import type { UpcomingItem } from '@/lib/home-dashboard';
import { STATUS_LABEL } from '@/lib/labels';
import { useEvents } from '@/lib/sse';
import { pushToast } from '@/lib/toasts';
import { WidgetSlot } from '@/module-host/WidgetSlot';

const ACTIVITY_DAYS = 14;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function Tile({ href, tint, alert, icon: I, label, value, sub, meter }: { href: string; tint: string; alert?: boolean; icon: LucideIcon; label: string; value: ComponentChildren; sub: string; meter?: number | null }) {
  return (
    <Link href={href} class={`hd-kpi os-tint-${tint}${alert ? ' is-alert' : ''}`}>
      <span class="hd-kpi-label"><I size={15} /> {label}</span>
      <strong class="hd-kpi-value">{value}</strong>
      {typeof meter === 'number' ? <span class="hd-kpi-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(2, meter))}%` }} /></span> : null}
      <span class="hd-kpi-sub">{sub}</span>
    </Link>
  );
}

function severityClass(a: AttentionItem): string {
  return a.severity === 'error' ? 'is-urgent' : a.severity === 'warn' ? 'is-normal' : 'is-info';
}

function NeedsYou({ items, loaded, error, onChanged }: { items: AttentionItem[]; loaded: boolean; error: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function resolve(key: string) {
    setBusy(key);
    try {
      await apiPost(`/attention/${encodeURIComponent(key)}/resolve`);
      onChanged();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không đánh dấu được', description: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  if (loaded && items.length === 0 && !error) {
    return (
      <section class="hd-needs-slim" aria-labelledby="hd-needs" aria-live="polite">
        <CircleCheck size={17} />
        <h2 id="hd-needs">Cần bạn</h2>
        <span>Không có việc nào chờ duyệt hay bị lỗi</span>
        <Link href="/tasks">Mọi công việc <ArrowUpRight size={12} /></Link>
      </section>
    );
  }
  const urgent = items.filter((i) => i.severity === 'error').length;
  const normal = items.filter((i) => i.severity === 'warn').length;
  return (
    <section class="hd-card" aria-labelledby="hd-needs">
      <div class="hd-card-head">
        <h2 id="hd-needs">Cần bạn <small>{loaded ? `${items.length} việc` : 'đang tải…'}</small></h2>
        <Link href="/tasks">Mọi công việc <ArrowUpRight size={12} /></Link>
      </div>
      <div class="hd-attn">
        <div>
          {error && !loaded ? <p class="hd-error">Không tải được danh sách: {error}</p> : null}
          <ul class="hd-attn-list">
            {items.map((a) => (
              <li key={a.key} class={`hd-attn-item ${severityClass(a)}`}>
                <i aria-hidden="true" />
                <span class="hd-attn-icon">{a.kind === 'budget' ? <Coins size={15} /> : a.kind === 'review' ? <Clock3 size={15} /> : <TriangleAlert size={15} />}</span>
                <div class="hd-attn-text">
                  {a.link ? <Link href={a.link}>{a.title}</Link> : <span>{a.title}</span>}
                  {a.detail && <p title={a.detail}>{a.detail}</p>}
                </div>
                <div class="hd-attn-actions">
                  <button type="button" class="hd-icon-btn" title="Đã xử lý" aria-label="Đã xử lý" disabled={busy === a.key} onClick={() => void resolve(a.key)}>
                    <CircleCheck size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div class="hd-attn-side" aria-label="Đếm theo mức độ">
          <div class={`hd-attn-count ${urgent ? 'is-hot' : ''}`}><strong>{urgent}</strong><span>Lỗi</span></div>
          <div class="hd-attn-count"><strong>{normal}</strong><span>Chờ duyệt</span></div>
          <div class="hd-attn-count"><strong>{items.length - urgent - normal}</strong><span>Để ý khi rảnh</span></div>
        </div>
      </div>
    </section>
  );
}

function dayKey(iso: string, now: number): string {
  void now;
  return localParts(Date.parse(iso)).key;
}

export default function HomeDashboard() {
  const now = useNow(HOME_POLL_MS);
  const { agents } = useAgents();
  const stats = useFetch<StatsOverview>('/stats', HOME_POLL_MS);
  const attention = useFetch<{ items: AttentionItem[] }>('/attention', HOME_POLL_MS);
  const board = useFetch<{ items: BoardEntry[] }>('/board?limit=8', HOME_POLL_MS);
  const schedules = useFetch<{ items: Schedule[] }>('/schedules', 60_000);
  const runs = useFetch<{ items: Run[] }>('/runs?limit=300', 60_000);

  const refresh = useCallback(() => {
    stats.refresh();
    attention.refresh();
    board.refresh();
    runs.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.refresh, attention.refresh, board.refresh, runs.refresh]);
  useEvents(['task', 'run', 'attention', 'board'], refresh);

  const s = stats.data;
  const names = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.name])), [agents]);
  const upcoming = useMemo(() => upcomingItems({ schedules: schedules.data?.items ?? [], agentNames: names, nowMs: now, limit: 500 }), [schedules.data, names, now]);
  const todayKey = localParts(now).key;
  const upcomingToday = upcoming.filter((u) => localParts(u.at * 1000).key === todayKey).length;

  const days = useMemo(() => {
    const out: { day: string; succeeded: number; failed: number }[] = [];
    for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) out.push({ day: localParts(now - i * 86_400_000).key, succeeded: 0, failed: 0 });
    for (const r of runs.data?.items ?? []) {
      const d = out.find((x) => x.day === dayKey(r.startedAt, now));
      if (!d) continue;
      if (r.status === 'done') d.succeeded++;
      else if (r.status === 'failed') d.failed++;
    }
    return out;
  }, [runs.data, now]);
  const totals = activityTotals(days);
  const max = Math.max(1, ...days.map((d) => d.succeeded + d.failed));
  const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

  const items = attention.data?.items ?? [];
  const status = statusLine({ needsYou: attention.data ? items.length : null, careWaiting: null, upcomingToday, agentsRunning: s?.agents.running ?? null, agentsTotal: s?.agents.enabled ?? null, tasksRunning: s?.tasks.running ?? null });
  const taskChips: TaskStatus[] = ['queued', 'running', 'waiting', 'review', 'failed', 'done'];
  const groups = groupByDay(upcoming.slice(0, 8), now);
  const maxCost = Math.max(0.0001, ...(s?.costByAgent ?? []).map((c) => c.costUsd));

  return (
    <div class="os-scroll">
      <div class="hd">
        <header class="hd-head">
          <div>
            <p class="hd-eyebrow">{fmtLongDate(now)} · {fmtTime(now)}</p>
            <h1>{greeting(localParts(now).h)}<span>.</span></h1>
            <p class="hd-status" aria-live="polite">
              {status.map((t, i) => <span key={i} class={i === 0 && items.length ? 'hd-warn' : i === 0 && attention.data ? 'hd-ok' : undefined}>{t}</span>)}
            </p>
          </div>
          <nav class="hd-head-actions" aria-label="Lối tắt">
            <Link href="/tasks" class="hd-btn"><Clock3 size={15} /> Công việc</Link>
            <Link href="/schedules" class="hd-btn"><CalendarClock size={15} /> Lịch định kỳ</Link>
            <Link href="/chat" class="hd-btn hd-btn-primary"><Bot size={15} /> Trò chuyện với agent</Link>
          </nav>
        </header>

        <NeedsYou items={items} loaded={!!attention.data} error={attention.error} onChanged={attention.refresh} />

        <section class="hd-card" aria-labelledby="hd-assign">
          <div class="hd-card-head"><h2 id="hd-assign">Giao việc cho agent</h2><Link href="/tasks">Xem công việc <ArrowUpRight size={12} /></Link></div>
          <QuickAssign agents={agents} />
        </section>

        <p class="hd-section-label">Vận hành</p>
        <section class="hd-kpis" aria-label="Vận hành">
          <Tile href="/agents" tint="lavender" icon={Bot} label="Agent đang chạy" value={s ? <>{s.agents.running}<small>/{s.agents.enabled}</small></> : '—'}
            sub={s ? `${s.agents.total} agent tổng cộng` : 'Đang tải…'} />
          <Tile href="/tasks" tint="peach" alert={!!s && s.tasks.failed > 0} icon={AlarmClock} label="Công việc chờ / đang chạy" value={s ? fmtInt(s.tasks.queued + s.tasks.running) : '—'}
            sub={s ? `${s.tasks.review} chờ duyệt · ${s.tasks.failed} lỗi` : 'Đang tải…'} />
          <Tile href="/schedules" tint="blue" icon={CalendarClock} label="Lịch 7 ngày tới" value={schedules.data ? fmtInt(upcoming.length) : '—'}
            sub={!schedules.data ? 'Đang tải…' : upcoming.length ? `${upcoming.length} lần chạy theo lịch` : 'Chưa có lịch nào sắp chạy'} />
          <Tile href="/agents" tint="sand" icon={Wallet} label="Chi phí tháng này" value={s ? fmtUsd(s.costMonthUsd) : '—'}
            sub={s ? `${fmtInt(s.runsToday)} lượt chạy hôm nay (chỉ tính lượt có báo giá)` : 'Đang tải…'} />
        </section>

        <div class="hd-grid-2">
          <section class="hd-card" aria-labelledby="hd-agents">
            <div class="hd-card-head"><h2 id="hd-agents">Agents & công việc</h2><Link href="/agents">Mở Agents <ArrowUpRight size={12} /></Link></div>
            {agents.length === 0 && stats.data ? (
              <div class="hd-empty"><strong>Chưa có agent nào</strong><p>Tạo agent đầu tiên để giao việc.</p><Link href="/agents" class="hd-btn">Tạo agent</Link></div>
            ) : null}
            <div class="hd-agents">
              {agents.filter((a) => a.enabled).map((a) => (
                <Link key={a.id} href={`/agents/${a.id}`} class="hd-agent">
                  <AgentAvatar agentId={a.id} name={a.name} size={34} running={a.stats.running > 0} />
                  <div class="min-w-0">
                    <div class="hd-agent-name">{a.name}</div>
                    <div class="hd-agent-task">{a.stats.running ? `${a.stats.running} việc đang chạy` : a.stats.lastRunAt ? `Chạy gần nhất ${fmtRelative(Math.floor(Date.parse(a.stats.lastRunAt) / 1000), now)}` : 'Chưa chạy lần nào'}</div>
                  </div>
                  <span class={`hd-pill ${a.stats.running ? 'is-busy' : a.stats.queued ? 'is-on' : ''}`}>{a.stats.running ? 'Đang làm' : a.stats.queued ? 'Có việc chờ' : 'Rảnh'}</span>
                </Link>
              ))}
            </div>
            <div class="hd-divider" />
            {runs.data && totals.total === 0 ? <p class="hd-muted text-xs">Chưa có lượt chạy nào trong {ACTIVITY_DAYS} ngày qua. Giao việc ở ô phía trên để bắt đầu.</p> : null}
            {totals.total > 0 ? (
              <>
                <div class="hd-activity-head">
                  <strong>Lượt chạy · {ACTIVITY_DAYS} ngày</strong>
                  <span class="hd-legend"><span><i style={{ background: 'var(--color-status-done)' }} />Xong</span><span><i style={{ background: 'var(--color-status-failed)' }} />Lỗi</span></span>
                </div>
                <div class="hd-bars" role="img" aria-label={`${totals.succeeded} xong, ${totals.failed} lỗi trong ${ACTIVITY_DAYS} ngày`}>
                  {days.map((d) => {
                    const n = d.succeeded + d.failed;
                    return (
                      <div key={d.day} class={`hd-bar${n ? '' : ' is-empty'}`} title={`${ddmm(d.day)}: ${d.succeeded} xong, ${d.failed} lỗi`}>
                        {d.failed ? <i class="fail" style={{ height: `${(d.failed / max) * 100}%` }} /> : null}
                        {d.succeeded ? <i class="ok" style={{ height: `${(d.succeeded / max) * 100}%` }} /> : null}
                      </div>
                    );
                  })}
                </div>
                <div class="hd-axis"><span>{ddmm(days[0]!.day)}</span><span>Hôm nay</span></div>
                <div class="hd-stats">
                  <div class="hd-stat"><span>Hoàn thành</span><strong>{fmtInt(totals.succeeded)}</strong></div>
                  <div class="hd-stat"><span>Lỗi</span><strong>{fmtInt(totals.failed)}</strong></div>
                  <div class="hd-stat"><span>Tỉ lệ thành công</span><strong>{totals.rate === null ? '—' : `${totals.rate}%`}</strong></div>
                </div>
              </>
            ) : null}
          </section>

          <section class="hd-card" aria-labelledby="hd-upcoming">
            <div class="hd-card-head"><h2 id="hd-upcoming">Sắp tới <small>7 ngày</small></h2><Link href="/schedules">Lịch đầy đủ <ArrowUpRight size={12} /></Link></div>
            {groups.length === 0 ? (
              <div class="hd-empty"><strong>Lịch 7 ngày tới đang trống</strong><p>Đặt lịch định kỳ để agent tự làm việc, ví dụ báo cáo mỗi sáng.</p><Link href="/schedules" class="hd-btn">Tạo lịch</Link></div>
            ) : (
              <div class="hd-timeline">
                {groups.map((g) => (
                  <div key={g.label} class="hd-day">
                    <h3>{g.label}</h3>
                    <ul>
                      {g.items.map((it: UpcomingItem) => (
                        <li key={it.key}>
                          <Link href={it.href} class="hd-event">
                            <time>{fmtTime(it.at * 1000)}</time>
                            <span class="hd-event-icon"><Clock3 size={14} /></span>
                            <span class="min-w-0"><b>{it.title}</b><small>{it.sub}</small></span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div class="hd-grid-2">
          <section class="hd-card" aria-labelledby="hd-board">
            <div class="hd-card-head"><h2 id="hd-board">Hoạt động của đội</h2></div>
            {board.data && board.data.items.length === 0 ? <p class="hd-muted text-xs">Chưa có hoạt động nào.</p> : null}
            <div class="hd-agents">
              {(board.data?.items ?? []).map((b) => (
                <Link key={b.id} href={b.taskId ? `/tasks/${b.taskId}` : '/tasks'} class="hd-agent">
                  {b.agentId ? <AgentAvatar agentId={b.agentId} name={resolveAgentName(b.agentId)} size={28} /> : <span />}
                  <div class="min-w-0"><div class="hd-agent-name">{b.text}</div><div class="hd-agent-task">{b.agentId ? resolveAgentName(b.agentId) : 'Hệ thống'} · {fmtRelative(Math.floor(Date.parse(b.createdAt) / 1000), now)}</div></div>
                  <span class="hd-pill">{b.kind}</span>
                </Link>
              ))}
            </div>
          </section>
          <section class="hd-card" aria-labelledby="hd-spend">
            <div class="hd-card-head"><h2 id="hd-spend">Chi phí theo agent <small>tháng này</small></h2></div>
            {s && s.costByAgent.length === 0 ? <p class="hd-muted text-xs">Chưa có lượt chạy nào báo chi phí trong tháng.</p> : null}
            <ul class="hd-agents-spend">
              {(s?.costByAgent ?? []).map((c) => (
                <li key={c.agentId}>
                  <span>{resolveAgentName(c.agentId)}</span><b>{fmtUsd(c.costUsd)}</b>
                  <i><i style={{ width: `${Math.max(3, (c.costUsd / maxCost) * 100)}%` }} /></i>
                </li>
              ))}
            </ul>
            <p class="hd-source">Chỉ tính lượt chạy mà runtime báo chi phí; “—” nghĩa là chưa biết, không phải bằng 0. Trạng thái việc: {taskChips.map((t) => `${STATUS_LABEL[t]} ${s?.tasks[t] ?? '—'}`).join(' · ')}.</p>
          </section>
        </div>

        <WidgetSlot slot="dashboard" />

        <footer class="hd-foot">
          <span>Số liệu đọc từ cơ sở dữ liệu của AIOS-Lite, tự làm mới mỗi 30 giây · cập nhật {fmtTime(now)}</span>
          <button type="button" onClick={() => { invalidateFetchCache(); refresh(); }} class="inline-flex items-center gap-1"><RefreshCw size={12} /> Làm mới ngay</button>
        </footer>
      </div>
    </div>
  );
}
