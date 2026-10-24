import { describe, expect, it } from 'vitest';
import {
  authorLabel, blockerCandidates, blockedByOpen, buildThread, formatRunDuration, priorityLabel, priorityTone,
  progressPercent, progressSummary, shouldCollapsePrompt, statusLabel, statusTone, taskLabel, timeAgoVi,
  type MissionComment, type MissionRun,
} from './mission-detail';

const comment = (id: number, at: number, kind: MissionComment['author_kind'] = 'owner'): MissionComment => (
  { id, task_id: 't', author_kind: kind, author_id: kind === 'agent' ? 'amos' : null, body: `c${id}`, created_at: at });
const run = (over: Partial<MissionRun> = {}): MissionRun => (
  { status: 'completed', agent: 'main', startedAt: 100, completedAt: 200, result: 'ok', error: null, ...over });

describe('labels', () => {
  it('names a blocked queued task "Bị chặn" and keeps other statuses', () => {
    expect(statusLabel('queued', true)).toBe('Bị chặn');
    expect(statusLabel('queued')).toBe('Đang chờ');
    expect(statusLabel('running', true)).toBe('Đang chạy');
    expect(statusTone('queued', true)).toBe('medium');
    expect(statusTone('failed')).toBe('failed');
  });

  it('shows #seq or a short id, and priority bands', () => {
    expect(taskLabel({ id: 'abcdef12', seq: 42 })).toBe('#42');
    expect(taskLabel({ id: 'abcdef12' })).toBe('abcdef');
    expect(taskLabel({ id: 'abcdef12', seq: null })).toBe('abcdef');
    expect([priorityLabel(0), priorityLabel(2), priorityLabel(5), priorityLabel(9)]).toEqual(['Không đặt', 'Thấp', 'Trung bình', 'Cao']);
    expect(priorityTone(8)).toBe('high');
  });
});

describe('sub-task progress', () => {
  it('computes percent and the summary line', () => {
    const p = { total: 4, done: 1, running: 1, blocked: 1, failed: 1 };
    expect(progressPercent(p)).toBe(25);
    expect(progressPercent({ total: 0, done: 0, running: 0, blocked: 0, failed: 0 })).toBe(0);
    expect(progressSummary(p)).toBe('1/4 xong · 1 đang chạy · 1 bị chặn · 1 lỗi/hủy');
    expect(progressSummary({ total: 3, done: 3, running: 0, blocked: 0, failed: 0 })).toBe('3/3 xong · 0 đang chạy · 0 bị chặn');
  });
});

describe('buildThread', () => {
  it('merges comments and finished runs in time order, skipping unfinished runs', () => {
    const thread = buildThread(
      [comment(2, 300), comment(1, 50, 'system')],
      [run(), run({ status: 'running', completedAt: null })],
    );
    expect(thread.map((e) => (e.kind === 'comment' ? `c${e.comment.id}` : 'run'))).toEqual(['c1', 'run', 'c2']);
  });

  it('keeps insertion order for equal timestamps', () => {
    const thread = buildThread([comment(1, 10), comment(2, 10)], []);
    expect(thread.map((e) => e.key)).toEqual(['c1', 'c2']);
  });
});

describe('blockerCandidates', () => {
  it('excludes itself, existing blockers, tasks it blocks, and cancelled', () => {
    const all = [
      { id: 'self', status: 'queued' }, { id: 'b1', status: 'queued' }, { id: 'x', status: 'running' },
      { id: 'blk', status: 'queued' }, { id: 'dead', status: 'cancelled' }, { id: 'ok', status: 'completed' },
    ];
    expect(blockerCandidates(all, 'self', [{ id: 'b1' }], [{ id: 'blk' }]).map((t) => t.id)).toEqual(['x', 'ok']);
  });

  it('blockedByOpen keeps only unfinished blockers', () => {
    const refs = [
      { id: 'a', status: 'completed' as const, title: '', assigned_agent: null },
      { id: 'b', status: 'failed' as const, title: '', assigned_agent: null },
    ];
    expect(blockedByOpen(refs).map((r) => r.id)).toEqual(['b']);
  });
});

describe('time formatting', () => {
  it('reads relative time in Vietnamese', () => {
    expect(timeAgoVi(1000, 1010)).toBe('vừa xong');
    expect(timeAgoVi(1000, 1000 + 5 * 60)).toBe('5 phút trước');
    expect(timeAgoVi(1000, 1000 + 3 * 3600)).toBe('3 giờ trước');
    expect(timeAgoVi(1000, 1000 + 2 * 86400)).toBe('2 ngày trước');
  });

  it('formats run duration', () => {
    expect(formatRunDuration(100, 145)).toBe('45 giây');
    expect(formatRunDuration(0, 3725)).toBeNull();
    expect(formatRunDuration(10, 10 + 125)).toBe('2 phút 5 giây');
    expect(formatRunDuration(10, 10 + 3600 + 600)).toBe('1 giờ 10 phút');
    expect(formatRunDuration(null, 5)).toBeNull();
  });

  it('labels authors', () => {
    const name = (id: string) => id.toUpperCase();
    expect(authorLabel(comment(1, 1, 'owner'), name)).toBe('Bạn');
    expect(authorLabel(comment(1, 1, 'system'), name)).toBe('Hệ thống');
    expect(authorLabel(comment(1, 1, 'agent'), name)).toBe('AMOS');
  });

  it('collapses a long prompt only', () => {
    expect(shouldCollapsePrompt('x'.repeat(100))).toBe(false);
    expect(shouldCollapsePrompt('x'.repeat(701))).toBe(true);
  });
});
