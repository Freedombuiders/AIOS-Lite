import { describe, expect, it } from 'vitest';
import { EMAIL_SANDBOX, FORBID_ATTR, FORBID_TAGS, SANITIZE_CONFIG, buildEmailDocument, countRemoteImages, emailCsp, estimateFrameHeight, plainTextFallback } from './emailFrame';

describe('email iframe hardening', () => {
  it('sandbox grants no scripts, no same-origin, no forms, no top navigation', () => {
    const tokens = EMAIL_SANDBOX.split(/\s+/);
    for (const bad of ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-top-navigation', 'allow-modals', 'allow-downloads']) {
      expect(tokens).not.toContain(bad);
    }
  });

  it('CSP denies everything by default and blocks remote images until asked', () => {
    const blocked = emailCsp(false);
    expect(blocked).toContain("default-src 'none'");
    expect(blocked).toMatch(/img-src data: cid:(;|$)/);
    expect(blocked).not.toMatch(/https?:/);
    expect(blocked).not.toContain('script-src');
    expect(blocked).toContain("form-action 'none'");
    expect(blocked).toContain("base-uri 'none'");
    expect(emailCsp(true)).toMatch(/img-src data: cid: https: http:/);
  });

  it('the document carries the CSP of the chosen mode and the sanitised body only', () => {
    const doc = buildEmailDocument('<p>xin chào</p>', false);
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("img-src data: cid:;");
    expect(doc).toContain('<p>xin chào</p>');
    expect(buildEmailDocument('<p>x</p>', true)).toContain('https: http:');
  });

  it('sanitiser config forbids active content and tracking vectors', () => {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'meta', 'base', 'link', 'style', 'svg', 'video', 'audio']) expect(FORBID_TAGS).toContain(tag);
    for (const attr of ['onclick', 'onerror', 'onload', 'formaction', 'srcset', 'ping']) expect(FORBID_ATTR).toContain(attr);
    expect(SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
  });

  it('counts remote images but not inline ones', () => {
    const html = '<img src="https://t.example.test/pixel.gif"><img src=\'//cdn.example.test/a.png\'><img src="data:image/png;base64,AAAA"><img src="cid:logo"><img alt="x" src=http://x.test/y.jpg>';
    expect(countRemoteImages(html)).toBe(3);
    expect(countRemoteImages('<p>no images</p>')).toBe(0);
  });

  it('plain-text fallback prefers the body, then the snippet, never markup', () => {
    expect(plainTextFallback('  body ', 'snip')).toBe('body');
    expect(plainTextFallback('  ', ' snip ')).toBe('snip');
    expect(plainTextFallback('', '')).toBe('');
  });

  it('frame height is bounded by the viewport', () => {
    expect(estimateFrameHeight(10, 0, 800, false)).toBe(160);
    expect(estimateFrameHeight(100000, 9, 800, false)).toBe(560);
    expect(estimateFrameHeight(10, 0, 800, true)).toBe(640);
  });
});
