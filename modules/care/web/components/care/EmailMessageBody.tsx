import { useMemo, useState } from 'preact/hooks';
import DOMPurify from 'dompurify';
import { ImageIcon } from 'lucide-preact';
import { ct } from '@modules/care/web/lib/care/i18n';
import { EMAIL_SANDBOX, SANITIZE_CONFIG, buildEmailDocument, countRemoteImages, estimateFrameHeight, plainTextFallback } from '@modules/care/web/lib/care/emailFrame';

interface Prepared { html: string; textLength: number; images: number }

function prepare(html: string): Prepared | null {
  try {
    const body = DOMPurify.sanitize(html, { ...SANITIZE_CONFIG, FORBID_TAGS: [...SANITIZE_CONFIG.FORBID_TAGS], FORBID_ATTR: [...SANITIZE_CONFIG.FORBID_ATTR], RETURN_DOM: true }) as HTMLElement;
    for (const a of Array.from(body.querySelectorAll('a'))) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
    return { html: body.innerHTML, textLength: (body.textContent || '').length, images: body.querySelectorAll('img').length };
  } catch {
    return null; // sanitiser failure -> plain text, never raw HTML
  }
}

/**
 * Email body: sanitised HTML in a script-less sandboxed iframe whose CSP blocks remote images until
 * the operator loads them for THIS message. Falls back to plain text when there is no (safe) HTML.
 */
export function EmailMessageBody({ html, text, snippet }: { html: string; text: string; snippet: string }) {
  const [allowImages, setAllowImages] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [forcePlain, setForcePlain] = useState(false);
  const prepared = useMemo(() => (html.trim() ? prepare(html) : null), [html]);
  const doc = useMemo(() => (prepared ? buildEmailDocument(prepared.html, allowImages) : ''), [prepared, allowImages]);
  const plain = plainTextFallback(text, snippet);
  const remote = useMemo(() => (prepared ? countRemoteImages(prepared.html) : 0), [prepared]);

  if (!prepared || forcePlain) {
    return (
      <div class="care-email-plain">
        {plain ? <div class="care-text">{plain}</div> : <div class="care-placeholder">{ct('msg.empty')}</div>}
        {prepared && <button type="button" class="care-link-button" onClick={() => setForcePlain(false)}>{ct('email.html')}</button>}
      </div>
    );
  }

  const viewport = typeof window !== 'undefined' ? window.innerHeight : 800;
  const height = estimateFrameHeight(prepared.textLength, prepared.images, viewport, expanded);
  return (
    <div class="care-email-body" data-testid="care-email-body">
      {remote > 0 && (
        <div class="care-image-bar" data-testid="care-image-bar">
          <ImageIcon size={12} aria-hidden="true" />
          {allowImages ? (
            <>
              <span>{ct('email.imagesLoaded')}</span>
              <button type="button" class="care-link-button" onClick={() => setAllowImages(false)}>{ct('email.hideImages')}</button>
            </>
          ) : (
            <>
              <span>{ct('email.imagesBlocked', { n: remote })}</span>
              <button type="button" class="care-link-button" onClick={() => setAllowImages(true)} data-testid="care-load-images">{ct('email.loadImages')}</button>
            </>
          )}
        </div>
      )}
      <iframe
        title={ct('email.frameTitle')}
        sandbox={EMAIL_SANDBOX}
        referrerpolicy="no-referrer"
        srcdoc={doc}
        style={{ height: `${height}px` }}
        class="care-email-frame"
        data-testid="care-email-frame"
      />
      <div class="care-email-tools">
        <button type="button" class="care-link-button" onClick={() => setExpanded(!expanded)}>{expanded ? ct('email.collapse') : ct('email.expand')}</button>
        {plain && <button type="button" class="care-link-button" onClick={() => setForcePlain(true)}>{ct('email.plain')}</button>}
        <span class="care-faint">{ct('email.sandboxNote')}</span>
      </div>
    </div>
  );
}
