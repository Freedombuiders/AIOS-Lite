/** A failure the dashboard and the CLI can show verbatim: `status` is the HTTP code, `message` is Vietnamese. */
export class FbError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409 | 422 | 500 | 502 | 503, message: string) {
    super(message);
    this.name = 'FbError';
  }
}
