import DOMPurify from 'dompurify';
import { Renderer, marked } from 'marked';
import { brainNoteUrl, resolveBrainLink } from './brain-links';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → sanitized HTML. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text ?? '', { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** Markdown for brain notes: relative .md links and [[wikilinks]] resolve to /brain?note=…, others lose their href. */
export function renderBrainMarkdown(text: string, source: string, ids: ReadonlySet<string>): string {
  const withWiki = (text ?? '').replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, target: string, heading: string | undefined, label: string | undefined) => {
    const id = resolveBrainLink(target.trim(), source, ids, true);
    const shown = label ?? target;
    return id ? `[${shown}](${brainNoteUrl(id, heading ?? '')})` : shown;
  });
  const renderer = new Renderer();
  const base = renderer.link.bind(renderer);
  renderer.link = (token) => {
    const href = token.href;
    if (href.startsWith('/brain?')) return base(token);
    const id = resolveBrainLink(href, source, ids);
    return id ? base({ ...token, href: brainNoteUrl(id) }) : token.text;
  };
  const html = marked.parse(withWiki, { async: false, renderer }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
