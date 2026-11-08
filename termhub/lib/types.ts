// Types shared by termhub's TypeScript modules (plan 4.1). Types only: no module requires
// this file at run time; each names what it needs with a type query,
// `type Json = import('./types.ts').Json;`, which erases to nothing (docs/native/JARVISD.md).

/**
 * JSON or an object read or built key by key: a request body, a session record, a
 * probe's answer. Loose on purpose while its producers are JavaScript.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;
