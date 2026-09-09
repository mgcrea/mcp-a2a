import type { Logger } from "#/client/auth";

/** Exponential, capped. Attempt 0 waits 1s, attempt 3 and beyond waits 8s. */
export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type A2AFetchOptions = {
  fetch?: typeof fetch;
  /** Shared bearer for this machine's loopback mesh. Omitted when unset. */
  token?: string | undefined;
  maxRetries: number;
  userAgent: string;
  logger?: Logger;
};

/**
 * The one `fetch` every outbound A2A call goes through, injected into the SDK's
 * transports as `fetchImpl`.
 *
 * It exists rather than being handed the global `fetch` for three reasons: the
 * bearer token belongs on every request and nowhere in the SDK's call surface;
 * retry policy is ours to own; and it is the seam the test suite replaces, which
 * is what lets tools be driven end to end through the real SDK with no network.
 *
 * A 401 is deliberately NOT retried. Unlike an OAuth deployment there is no
 * token to remint — the shared secret is static — so retrying only turns one
 * clear failure into three slow ones.
 */
export const createA2AFetch = (opts: A2AFetchOptions): typeof fetch => {
  const impl = opts.fetch ?? globalThis.fetch;
  // `Parameters<typeof fetch>[0]` rather than `RequestInfo`: the DOM lib is not
  // loaded here, so the global name does not exist even though `fetch` does.
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
    if (!headers.has("User-Agent")) headers.set("User-Agent", opts.userAgent);

    let attempt = 0;
    for (;;) {
      opts.logger?.debug?.(
        `A2A ${init?.method ?? "GET"} ${String(input)} (attempt ${attempt + 1})`,
      );
      const res = await impl(input, { ...init, headers });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= opts.maxRetries) return res;
      const delay = retryAfterMs(res) ?? backoffMs(attempt);
      opts.logger?.warn?.(`HTTP ${res.status} from ${String(input)} — retrying in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
    }
  };
};
