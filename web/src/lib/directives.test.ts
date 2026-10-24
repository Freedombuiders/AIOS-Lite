import { describe, expect, it } from 'vitest';
import { splitDirectives, stripDirectives } from './directives';

describe('splitDirectives', () => {
  it('turns complete tags into chips', () => {
    const s = splitDirectives('Xong.<aios-task to="writer" title="x">viết bài</aios-task><aios-memory scope="team">a</aios-memory><aios-status>review</aios-status>');
    expect(s.map((x) => (x.kind === 'chip' ? x.label : x.text))).toEqual(['Xong.', 'Giao việc cho writer', 'Ghi nhớ cho cả nhóm', 'Xin duyệt']);
  });
  it('hides a tag still streaming in', () => {
    expect(stripDirectives('Ok <aios-task to="a">đang viế')).toBe('Ok');
    expect(stripDirectives('Ok <aios-ta')).toBe('Ok');
  });
  it('labels actions', () => {
    const s = splitDirectives('<aios-action module="marketing" name="post">{}</aios-action>');
    expect(s[0]).toEqual({ kind: 'chip', label: 'Hành động marketing.post' });
  });
});
