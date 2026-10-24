import type { ComponentChildren } from 'preact';
import { Component } from 'preact';
import { widgets } from './host';
import { ArrowUpRight } from 'lucide-preact';
import { Link } from 'wouter-preact';
import type { OverviewRange, WebWidget } from './contracts';

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

/** Enabled modules' widgets for a slot, in order. */
export function slotWidgets(slot: WebWidget['slot']): WebWidget[] {
  return widgets.value.filter((w) => w.slot === slot);
}

/**
 * 'overview': one full-width section per widget (title, source line, "Xem chi tiết"), each given the picked period.
 * 'dashboard': small cards in a two-column grid. Renders nothing when the slot is empty.
 */
export function WidgetSlot({ slot, range }: { slot: WebWidget['slot']; range?: OverviewRange }) {
  const list = slotWidgets(slot);
  if (!list.length) return null;
  if (slot === 'overview') {
    return (
      <div class="hd-ov-list" data-widget-slot={slot}>
        {list.map((w) => {
          const C = w.component;
          return (
            <section key={w.id} class="hd-card hd-ov" aria-labelledby={`ov-${w.id}`} data-widget={w.id}>
              <div class="hd-card-head">
                <h2 id={`ov-${w.id}`}>{w.title}{w.subtitle && <small>{w.subtitle}</small>}</h2>
                {w.href && <Link href={w.href}>Xem chi tiết <ArrowUpRight size={12} /></Link>}
              </div>
              <Boundary id={w.id}>
                <C range={range} />
              </Boundary>
            </section>
          );
        })}
      </div>
    );
  }
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
