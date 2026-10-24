import { describe, expect, it } from 'vitest';
import mod from './index';

describe('marketing web module', () => {
  it('registers the six pages under /m/marketing and a dashboard widget', () => {
    expect(mod.id).toBe('marketing');
    expect(mod.nav?.map((n) => n.label)).toEqual(['Pages', 'Kho nội dung', 'Lịch đăng', 'Phân tích', 'Bình luận AI', 'Quy tắc bình luận']);
    expect(mod.nav?.every((n) => n.group === 'marketing' && n.path.startsWith('/m/marketing'))).toBe(true);
    expect(mod.routes?.map((r) => r.path)).toEqual(mod.nav?.map((n) => n.path));
    expect(mod.widgets).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: 'dashboard', id: 'marketing-scheduled' }),
      expect.objectContaining({ slot: 'overview', id: 'marketing-overview', order: 20, title: 'Hiệu quả nội dung', href: '/m/marketing/analytics' }),
    ]));
    expect(mod.agentAccess?.map((a) => a.scope)).toEqual(['content.write', 'publish', 'comments.reply', 'analytics.read']);
  });
});
