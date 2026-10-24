/** Sign once at the provider boundary; the Care timeline retains the original draft. */
export function signedEmailBody(text: string, signature: string, sanitize: (text: string) => string): string {
  const clean = sanitize(text);
  const sign = sanitize(signature).trim();
  return sign ? `${clean}\n\n${sign}` : clean;
}
