import { z } from "zod";

import { A2AApiError, WritesDisabledError } from "#/client/errors";
import { SHORT_STATES } from "#/client/shape";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. Measured across the fleet, `null, 2` adds 19-41%
 * to every response — worst on wide lists of short-keyed objects, which are
 * exactly the replies already big enough to hurt.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * Return text as-is. `ok()` JSON-stringifies, which turns a readable block into
 * one escaped "A2A task…\n\n…" line that no one can read.
 */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

/**
 * `extra` is spread at the TOP level, not nested under `details`, so a `remedy`
 * lands beside the error rather than three levels inside an envelope. That
 * matters: the remedy is the half the model should act on, and a nested one gets
 * skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/** Render a thrown value as a tool error, preserving upstream detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof A2AApiError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      ...(err.status ? { status: err.status } : {}),
      ...(err.errors !== undefined ? { details: err.errors } : {}),
    });
  }
  if (err instanceof WritesDisabledError) return fail(err.message);
  if (err instanceof Error) {
    const details = (err as Error & { details?: Record<string, unknown> }).details;
    return fail(err.message, details);
  }
  return fail("Unknown error", { details: err });
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Like `wrap`, but the body chooses its own result shape (e.g. raw text). */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

// ── Arg atoms ───────────────────────────────────────────────────────────────
// Defined once and reused, because an arg description is read at exactly the
// moment it is relevant — which makes it the right place for the traps.

export const peerUrlArg = z
  .string()
  .url("A peer is named by its BASE url, e.g. http://127.0.0.1:41241 — not the card path.")
  .describe(
    "The peer's BASE url, e.g. `http://127.0.0.1:41241`. Not the card path: the client " +
      "appends /.well-known/agent-card.json itself. Get the list from a2a_list_agents.",
  );

export const optionalPeerUrlArg = peerUrlArg
  .optional()
  .describe(
    "The peer's BASE url, e.g. `http://127.0.0.1:41241`. Defaults to this machine's own " +
      "daemon, which is the peer that holds inbound tasks. Get the list from a2a_list_agents.",
  );

export const taskIdArg = z
  .string()
  .min(1)
  .max(128)
  .describe(
    'A task id as it appears in a2a_list_tasks, e.g. "task-mfk2j1-8ac31b". Ids are generated ' +
      "by whichever side created the task — never composed by hand.",
  );

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)
  .describe("Maximum number of results to return (1-100). Defaults to 25.");

export const stateArg = z
  .enum(SHORT_STATES)
  .optional()
  .describe(
    "Only tasks in this state. `submitted` is where an inbound task waits for an agent to " +
      "pick it up, which is almost always the filter you want; `input_required` means the " +
      "other side is waiting on you.",
  );

export const directionArg = z
  .enum(["inbound", "outbound"])
  .optional()
  .describe(
    "`inbound` — a peer asked US to do something (a proposal awaiting an answer). " +
      "`outbound` — WE asked a peer, and this is the local mirror of their task. " +
      "Omit for both.",
  );

export const historyLengthArg = z
  .number()
  .int()
  .min(0)
  .max(100)
  .default(10)
  .describe(
    "How many of the most recent messages to include (0-100). Defaults to 10; a long " +
      "conversation is trimmed and the response says by how much. 0 omits the history.",
  );

/** Destructive tools require this, so an agent can never mutate something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this destructively changes state.");

/** Drop undefined values so we never send `{"filter": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
