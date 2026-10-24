import { expect, it } from 'vitest';
import { studioTab, studioTabUrl } from './studio-tabs';

it('opens production by default, keeps old create/Flow and editor links working', () => {
  expect(studioTab('')).toBe('produce');
  expect(studioTab('?tab=flow&token=owner')).toBe('produce');
  expect(studioTab('?tab=create')).toBe('produce');
  expect(studioTab('?project=abc&view=editor')).toBe('edit');
  expect(studioTab('?tab=edit')).toBe('edit');
  expect(studioTab('?tab=connect')).toBe('connect');
});

it('switches tabs without losing the token or the fragment', () => {
  const edit = new URL(studioTabUrl('http://localhost/video-studio?token=owner&p=prod-1#section', 'edit'));
  expect(edit.searchParams.get('tab')).toBe('edit');
  expect(edit.searchParams.get('token')).toBe('owner');
  expect(edit.searchParams.has('p')).toBe(false);
  expect(edit.hash).toBe('#section');
  const footage = new URL(studioTabUrl('http://localhost/video-studio?p=prod-1&v=board', 'edit', 'proj-9'));
  expect(footage.searchParams.get('project')).toBe('proj-9');
  expect(footage.searchParams.get('view')).toBe('editor');
  expect(footage.searchParams.has('v')).toBe(false);
  const produce = new URL(studioTabUrl('http://localhost/video-studio?tab=edit&token=owner&project=x&view=editor', 'produce'));
  expect(produce.searchParams.has('tab')).toBe(false);
  expect(produce.searchParams.has('project')).toBe(false);
  expect(produce.searchParams.get('token')).toBe('owner');
});
