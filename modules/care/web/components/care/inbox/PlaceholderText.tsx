import { splitByPlaceholders } from '@modules/care/web/lib/care/placeholders';

/** Plain text with every `[BLANK]` marked, so nothing the AI left empty slips through unnoticed. */
export function PlaceholderText({ text }: { text: string }) {
  return (
    <>
      {splitByPlaceholders(text).map((p, i) => (p.placeholder ? <mark key={i} class="care-blank">{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}
