// The one error type the API throws on purpose.
// The error handler in app.ts turns it into this response body:
//   { "error": { "code": "...", "message": "...", "details": { } } }
//
// `code` is the stable value a client switches on. The HTTP status follows
// three rules:
//   400  the request itself is malformed
//   404  something the request names does not exist
//   409  the request is valid, but the current state refuses it
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
