import type { McpServer } from "@modelcontextprotocol/server";

import type { Logger } from "#/client/auth";
import { proposalFor } from "#/client/shape";
import type { Config } from "#/config";
import type { FileTaskStore, StoreSnapshot } from "#/store/tasks";

/**
 * The experimental capability an interactive Claude Code session looks for, and
 * the notification it delivers.
 *
 * This is the one measured path that reaches a WAITING agent without parking a
 * tool call: a generic `notifications/message` is swallowed by both Claude Code
 * and Codex, and the MCP `instructions` field is ignored when no tool is needed.
 * `claude/channel` is a true push, verified end to end.
 *
 * ⚠ It is a research preview, Claude Code only, and needs Anthropic auth (not
 * Bedrock, Vertex or Foundry). So it is an ENHANCEMENT over `a2a_wait_for_task`
 * and never the only route — the long-poll has to work standalone, and does.
 *
 * ⚠ Delivery also needs the session to have opted in:
 *     claude --dangerously-load-development-channels server:a2a
 *   and confirm the dialog. Do NOT also pass `--channels` for the same entry —
 *   the bypass is per-entry and the `--channels` copy is refused as not on the
 *   allowlist. In `-p` mode the debug log reads `pollChannel=false
 *   nonInteractive=true` and nothing is delivered, so a non-interactive test
 *   looks like a bug that isn't one.
 */
export const CHANNEL_CAPABILITY = "claude/channel";
export const CHANNEL_NOTIFICATION = "notifications/claude/channel";

/**
 * Declared before the transport is connected, because `registerCapabilities`
 * refuses to run afterwards — it has to be part of the `initialize` result.
 */
export const declareChannelCapability = (server: McpServer): void => {
  server.server.registerCapabilities({ experimental: { [CHANNEL_CAPABILITY]: {} } });
};

export type ChannelWatcher = {
  /** Stop polling. Called on shutdown; also what the tests use. */
  stop(): void;
  /** How many notifications have been emitted — the assertion a test can make. */
  emitted(): number;
};

/**
 * Watch the store and push each newly arrived inbound task into the session.
 *
 * The poll is a `readdir` plus one `stat` per task, deliberately rather than
 * `fs.watch`: on macOS `fs.watch` is FSEvents-backed, it coalesces, and it does
 * not reliably report a `rename` over an existing name — which is exactly how
 * every record here is written, because an atomic replace is what keeps the other
 * process from reading a half-written file. Stat polling sees the mtime change no
 * matter how the file got there. At a one-second interval over a handful of files
 * the cost is not measurable, and the timer is `unref`'d so it never holds the
 * process open.
 */
export const startChannelWatcher = (opts: {
  server: McpServer;
  store: FileTaskStore;
  config: Config;
  logger?: Logger;
}): ChannelWatcher => {
  const { server, store, config, logger } = opts;
  let baseline: StoreSnapshot = store.snapshot();
  let emitted = 0;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    // One pass at a time: a slow notification must not stack up ticks and send
    // the same proposal twice.
    if (inFlight) return;
    inFlight = true;
    try {
      // One snapshot, used both to find the changes and as the next baseline.
      // Taking a fresh baseline afterwards would swallow anything written in
      // between, and a swallowed arrival is a push that never happens.
      const current = store.snapshot();
      const changes = store.changesBetween(baseline, current, { direction: "inbound" });
      baseline = current;
      for (const change of changes) {
        // Only an arrival is pushed. A state change on an inbound task is this
        // session's own answer coming back around, and telling an agent about
        // its own reply is noise at best and a loop at worst.
        if (change.kind !== "created") continue;
        const proposal = proposalFor(change.record);
        await server.server.notification({
          method: CHANNEL_NOTIFICATION,
          params: {
            content:
              `A2A task ${String(proposal.task_id)} arrived from ${String(proposal.from_peer)}.\n\n` +
              `Request: ${String(proposal.request)}\n\n` +
              `${String(proposal.note)}`,
            meta: proposal,
          },
        });
        emitted += 1;
        logger?.debug?.(`pushed ${CHANNEL_NOTIFICATION} for task ${change.taskId}`);
      }
    } catch (err) {
      // A client that does not understand the notification, or a transport that
      // has gone away, must not take the server down with it.
      logger?.debug?.("channel push failed", err);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, config.pollIntervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
    emitted: () => emitted,
  };
};
