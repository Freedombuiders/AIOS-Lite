import { useEffect, useRef } from 'preact/hooks';
import { useLocation } from 'wouter-preact';

/**
 * Renders a server-built Radar document in a same-origin srcdoc iframe.
 * Clicks on `a[data-radar-nav]` navigate the SPA; `syncHash` mirrors the
 * document's #B/#C/#D hash into the page URL.
 */
export function ReportFrame({ html, title, syncHash }: { html: string; title: string; syncHash?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [, navigate] = useLocation();
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  function onLoad() {
    cleanup.current?.();
    const frame = ref.current;
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!win || !doc) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[data-radar-nav]') as HTMLAnchorElement | null;
      const href = a?.getAttribute('href');
      if (!a || !href) return;
      e.preventDefault();
      navigate(href);
    };
    doc.addEventListener('click', onClick);
    let onHash: (() => void) | null = null;
    if (syncHash) {
      const initial = window.location.hash;
      if (initial && initial !== win.location.hash) win.location.hash = initial;
      onHash = () => {
        const h = win.location.hash;
        if (h !== window.location.hash) {
          window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + h);
        }
      };
      win.addEventListener('hashchange', onHash);
    }
    // A link to another tab of the same report changes only the page hash: pass it on to the document.
    const onPageHash = () => {
      const h = window.location.hash;
      if (syncHash && h && h !== win.location.hash) win.location.hash = h;
    };
    window.addEventListener('hashchange', onPageHash);
    cleanup.current = () => {
      window.removeEventListener('hashchange', onPageHash);
      try {
        doc.removeEventListener('click', onClick);
        if (onHash) win.removeEventListener('hashchange', onHash);
      } catch { /* frame already gone */ }
    };
  }

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={html}
      onLoad={onLoad}
      class="flex-1 w-full min-h-0 border-0 bg-[var(--color-bg)]"
      data-testid="radar-frame"
    />
  );
}
