// Type-only re-export of the Care API contract. The server file is pure data (no Node, DB or
// provider imports) and `export type *` is erased at build time, so nothing from src/ reaches
// the browser bundle. Keep this file free of runtime exports.
export type * from '@modules/care/server/api/dto';
export type * from '@modules/care/server/api/dto-inbox';
