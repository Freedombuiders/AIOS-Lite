export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string, public code = 'internal') {
    super(message);
    this.name = 'ApiError';
  }
}
