import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledModules, enabledWebModules, moduleInfos, navItems, refreshModules, routes, useProvides, widgets } from './host';
import { WidgetSlot } from './WidgetSlot';

function info(id: string, enabled: boolean) {
  return {
    manifest: { id, name: id, description: '', version: '0.1.0', category: 'other', tables: [] },
    state: { id, enabled, version: '0.1.0', installedAt: null, settings: {} },
    requirements: [], ready: true, hasServer: true, hasWeb: true, agentTemplates: [],
  };
}

function serve(items: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items }), { status: 200 }))));
}

describe('module host', () => {
  beforeEach(() => {
    moduleInfos.value = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('bundles the _template module found by import.meta.glob', () => {
    expect(bundledModules._template).toBeDefined();
  });

  it('shows nothing until a module is enabled', async () => {
    serve([info('_template', false)]);
    await refreshModules();
    expect(enabledWebModules.value).toHaveLength(0);
    expect(navItems.value).toHaveLength(0);
    expect(routes.value).toHaveLength(0);
    expect(widgets.value).toHaveLength(0);
  });

  it('registers nav, routes and widgets for an enabled module, and drops them when removed', async () => {
    serve([info('_template', true)]);
    await refreshModules();
    expect(enabledWebModules.value.map((m) => m.id)).toEqual(['_template']);
    expect(navItems.value.length).toBeGreaterThan(0);
    expect(navItems.value[0]!.moduleId).toBe('_template');
    expect(navItems.value[0]!.path.startsWith('/m/_template')).toBe(true);
    expect(routes.value.length).toBeGreaterThan(0);
    serve([info('_template', false)]);
    await refreshModules();
    expect(navItems.value).toHaveLength(0);
  });

  it('ignores enabled ids that have no bundled web entry', async () => {
    serve([info('ghost', true)]);
    await refreshModules();
    expect(enabledWebModules.value).toHaveLength(0);
  });

  it('useProvides returns values only from enabled modules', async () => {
    bundledModules.fake = { id: 'fake', provides: { 'care.channelPanel': 'PANEL' } };
    const seen: unknown[][] = [];
    function Probe() {
      seen.push(useProvides('care.channelPanel'));
      return null;
    }
    const el = document.createElement('div');
    serve([info('fake', false)]);
    await refreshModules();
    await act(() => render(<Probe />, el));
    expect(seen.at(-1)).toEqual([]);
    serve([info('fake', true)]);
    await act(async () => {
      await refreshModules();
    });
    expect(seen.at(-1)).toEqual(['PANEL']);
    delete bundledModules.fake;
  });

  it('WidgetSlot renders nothing without widgets', async () => {
    serve([]);
    await refreshModules();
    const el = document.createElement('div');
    await act(() => render(<WidgetSlot slot="dashboard" />, el));
    expect(el.innerHTML).toBe('');
  });
});
