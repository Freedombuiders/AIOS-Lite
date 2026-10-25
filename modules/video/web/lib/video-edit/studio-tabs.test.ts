import { expect, it } from 'vitest';
import { quickRoute, studioTab, studioTabUrl } from './studio-tabs';

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

it('keeps the Dựng nhanh screen and project in the URL', () => {
  expect(studioTab('?tab=quick')).toBe('quick');
  expect(studioTab('?tab=quick&project=p1&view=progress')).toBe('quick');
  expect(quickRoute('?tab=quick')).toEqual({ view: 'home', projectId: null });
  expect(quickRoute('?tab=quick&project=p1&view=setup')).toEqual({ view: 'setup', projectId: 'p1' });
  expect(quickRoute('?tab=quick&project=p1&view=progress')).toEqual({ view: 'progress', projectId: 'p1' });
  expect(quickRoute('?tab=quick&view=setup')).toEqual({ view: 'home', projectId: null });
  expect(quickRoute('?tab=quick&project=p1&view=editor')).toEqual({ view: 'editor', projectId: 'p1' });

  const setup = new URL(studioTabUrl('http://localhost/video-studio?token=owner&p=prod-1', 'quick', 'p1', 'setup'));
  expect(setup.searchParams.get('tab')).toBe('quick');
  expect(setup.searchParams.get('project')).toBe('p1');
  expect(setup.searchParams.get('view')).toBe('setup');
  expect(setup.searchParams.get('token')).toBe('owner');
  expect(setup.searchParams.has('p')).toBe(false);

  const home = new URL(studioTabUrl(setup.href, 'quick'));
  expect(home.searchParams.has('project')).toBe(false);
  expect(home.searchParams.has('view')).toBe(false);
  // An editor link does not become a Dựng nhanh screen, and a Dựng nhanh screen does not leak into the editor tab.
  expect(new URL(studioTabUrl('http://localhost/video-studio?tab=edit&project=x&view=editor', 'quick')).searchParams.has('project')).toBe(false);
  const edit = new URL(studioTabUrl(setup.href, 'edit'));
  expect(edit.searchParams.has('project')).toBe(false);
  expect(edit.searchParams.has('view')).toBe(false);
  const editor = new URL(studioTabUrl(setup.href, 'edit', 'p1'));
  expect(editor.searchParams.get('view')).toBe('editor');
  expect(new URL(studioTabUrl('http://localhost/video-studio?tab=edit&project=x&view=editor', 'connect')).searchParams.get('project')).toBe('x');
});

it('opens Editor v2 on Dựng nhanh and keeps it off the Video quay sẵn tab', () => {
  const editor = new URL(studioTabUrl('http://localhost/video-studio?tab=quick&token=owner&project=p1&view=progress', 'quick', 'p1', 'editor'));
  expect(editor.searchParams.get('tab')).toBe('quick');
  expect(editor.searchParams.get('project')).toBe('p1');
  expect(editor.searchParams.get('view')).toBe('editor');
  expect(editor.searchParams.get('token')).toBe('owner');
  // Back to Đang dựng, to Trang đầu, and to the other tab, which must not open its own editor.
  expect(new URL(studioTabUrl(editor.href, 'quick', 'p1', 'progress')).searchParams.get('view')).toBe('progress');
  expect(new URL(studioTabUrl(editor.href, 'quick')).searchParams.has('project')).toBe(false);
  const edit = new URL(studioTabUrl(editor.href, 'edit'));
  expect(edit.searchParams.has('project')).toBe(false);
  expect(edit.searchParams.has('view')).toBe(false);
});
