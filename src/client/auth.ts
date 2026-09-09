/**
 * The logger every layer takes, and deliberately nothing else.
 *
 * Elsewhere in the fleet this module also holds a `TokenProvider`: a seam for
 * minting and reminting a short-lived credential, with `invalidate()` for the one
 * retryable auth failure (a 401 after expiry). There is nothing to mint here —
 * `A2A_TOKEN` is a static shared secret for this machine's loopback mesh — so a
 * provider would be indirection over a constant, and a 401 is a configuration
 * error rather than something to retry. `createA2AFetch` attaches the header.
 *
 * All methods are optional so a caller can pass `{}`; call sites use
 * `logger?.debug?.(…)`. It is threaded through `createServer` rather than being a
 * module singleton, because a singleton cannot be silenced in a test.
 */
export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};
