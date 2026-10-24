// Sandboxed rendering of untrusted email HTML. Defence in depth, each layer enough on its own to
// stop the usual attacks:
//   1. DOMPurify strips scripts, forms, embeds, event handlers (config below),
//   2. the iframe is sandboxed WITHOUT allow-scripts / allow-same-origin / allow-forms,
//   3. a CSP inside the document blocks every fetch (`default-src 'none'`) and only lets images
//      through as data:/cid: until the operator explicitly loads remote ones for that message.

export const EMAIL_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

export const FORBID_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base', 'frame', 'frameset',
  'applet', 'audio', 'video', 'source', 'track', 'svg', 'math', 'input', 'button', 'textarea', 'select',
];

export const FORBID_ATTR = [
  'onclick', 'onerror', 'onload', 'onmouseover', 'onmouseout', 'onfocus', 'onblur', 'onsubmit', 'onchange',
  'oninput', 'onkeydown', 'onkeyup', 'onanimationstart', 'ontoggle', 'formaction', 'srcset', 'ping',
];

export const SANITIZE_CONFIG = { FORBID_TAGS, FORBID_ATTR, ALLOW_DATA_ATTR: false } as const;

export function emailCsp(allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? 'data: cid: https: http:' : 'data: cid:';
  return `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`;
}

/** Cosmetic count for the "N images blocked" notice; the CSP is what actually blocks them. */
export function countRemoteImages(html: string): number {
  const re = /<img\b[^>]*?\bsrc\s*=\s*(?:"\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*'|(?:https?:)?\/\/[^\s>]+)/gi;
  return (html.match(re) ?? []).length;
}

export function buildEmailDocument(sanitizedInner: string, allowRemoteImages: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${emailCsp(allowRemoteImages)}">`
    + `<meta name="referrer" content="no-referrer">`
    + `<style>html,body{margin:0}body{padding:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;background:#fff;overflow-wrap:anywhere}`
    + `img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}blockquote{margin:8px 0;padding-left:10px;border-left:3px solid #ddd;color:#555}pre{white-space:pre-wrap}</style>`
    + `</head><body>${sanitizedInner}</body></html>`;
}

/** Plain-text fallback: HTML-free body, then the provider snippet. Rendered as text, never markup. */
export function plainTextFallback(text: string, snippet: string): string {
  return (text.trim() || snippet.trim() || '');
}

/** Frame height estimate: the sandbox hides the document, so size it from the text length. */
export function estimateFrameHeight(textLength: number, imageCount: number, viewportHeight: number, expanded: boolean): number {
  if (expanded) return Math.round(viewportHeight * 0.8);
  const estimate = 60 + Math.ceil(textLength / 80) * 22 + Math.min(imageCount, 4) * 120;
  return Math.max(160, Math.min(estimate, Math.round(viewportHeight * 0.7)));
}
