import type { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { summarizeCard } from "#/client/shape";
import { setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/**
 * Registered first and unconditionally, before any check of anything. An
 * unconfigured server has to be a server that can explain itself — the
 * alternative surfaces in the client as a bare "MCP error -32000: Connection
 * closed" with stderr swallowed, so the one message that would have said what to
 * set never reaches anyone.
 */
export const registerAuthTools = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "a2a_auth_status",
    {
      title: "A2A: Auth Status",
      description:
        "Report whether this machine can take part in A2A at all: is the daemon running and " +
        "reachable, is a card published, is a shared token set, which peers are configured, " +
        "and are writes enabled. Call this FIRST whenever a tool is missing or a send fails — " +
        "it makes one HTTP call to the local daemon and returns the setup steps as data " +
        "rather than making you guess.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const probe = await ctx.peers.probe(ctx.config.daemonUrl);
        return {
          version: `${BUILD_INFO.name}@${BUILD_INFO.version}`,
          daemon: {
            url: ctx.config.daemonUrl,
            reachable: probe.reachable,
            ...(probe.error ? { error: probe.error } : {}),
            ...(probe.card ? { card: summarizeCard(probe.card) } : {}),
          },
          token: ctx.config.token ? "set" : "not set (the daemon accepts any local caller)",
          /**
           * Reported rather than assumed. An unwritable store is a real state —
           * a read-only home, a sandbox, an A2A_STATE_DIR whose parent does not
           * exist — and the server deliberately stays up in it, so this is the
           * only place it becomes visible.
           */
          store: ctx.store.diagnose(),
          tasks: {
            inbound: ctx.store.records({ direction: "inbound" }).length,
            outbound: ctx.store.records({ direction: "outbound" }).length,
          },
          peers: ctx.peers.peers().map((peer) => peer.url),
          writes: ctx.allowWrites ? "enabled" : "disabled",
          /**
           * Named explicitly, because "the tool I want is not in the list" is the
           * question this tool exists to answer, and a list of what IS available
           * answers it faster than a description of the gate.
           */
          channel_push: ctx.config.channel
            ? "declared (delivered only to an interactive Claude Code session that opted in)"
            : "off — use a2a_wait_for_task",
          max_wait_seconds: ctx.config.maxWaitSeconds,
          setup: setupInstructions(ctx.config, { daemonReachable: probe.reachable }),
        };
      }),
  );
};
