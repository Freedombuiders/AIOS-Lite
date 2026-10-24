import type { ComponentChildren } from 'preact';
import { Component } from 'preact';
import { widgets } from './host';
import type { WebWidget } from './contracts';

class Boundary extends Component<{ id: string; children: ComponentChildren }, { err: string | null }> {
  state = { err: null as string | null };
  componentDidCatch(e: unknown) {
    this.setState({ err: e instanceof Error ? e.message : String(e) });
  }
  render() {
    if (this.state.err) {
      return <div class="card card-pad hint">Widget “{this.props.id}” lỗi: {this.state.err}</div>;
    }
    return this.props.children;
  }
}

/** Renders every enabled module's widgets for the slot; renders nothing when there are none. */
export function WidgetSlot({ slot }: { slot: WebWidget['slot'] }) {
  const list = widgets.value.filter((w) => w.slot === slot);
  if (!list.length) return null;
  return (
    <div class="grid gap-3 md:grid-cols-2" data-widget-slot={slot}>
      {list.map((w) => {
        const C = w.component;
        return (
          <section key={w.id} class="card card-pad min-w-0">
            {w.title && <div class="section-title mb-2">{w.title}</div>}
            <Boundary id={w.id}>
              <C />
            </Boundary>
          </section>
        );
      })}
    </div>
  );
}
