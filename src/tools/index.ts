import type { McpServer } from "@modelcontextprotocol/server";

import type { Logger } from "#/client/auth";
import type { PeerClient } from "#/client/peer";
import type { Config } from "#/config";
import type { FileTaskStore } from "#/store/tasks";
import { registerAgentTools } from "#/tools/agents";
import { registerAuthTools } from "#/tools/auth";
import { registerRequestTool } from "#/tools/request";
import { registerTaskTools } from "#/tools/tasks";
import { registerWriteTools } from "#/tools/writes";

export type ToolContext = {
  config: Config;
  store: FileTaskStore;
  peers: PeerClient;
  /** Register the mutating tools too. Off by default — see A2A_ALLOW_WRITES. */
  allowWrites: boolean;
  logger?: Logger;
};

/**
 * All the capability decisions, in one readable place, so "why can't I call X" is
 * answered by one file.
 *
 * Two things about this server's gating are deliberately unlike the rest of the
 * fleet, and both follow from what it is:
 *
 * 1. **There is no `hasCredentials` gate on the reads.** Elsewhere a server with
 *    no API key can do nothing but explain itself. Here every read tool works
 *    with nothing configured at all — the task store is a local directory and
 *    peer discovery is an unauthenticated GET — and gating them would hide
 *    exactly the tools that diagnose a broken setup. `a2a_auth_status` reports
 *    what is missing; it does not decide what exists.
 *
 * 2. **Answering an inbound task is a WRITE.** `a2a_respond_to_task` only touches
 *    a local file, so by the usual test it is not one. It is gated anyway,
 *    because what it really does is commit this agent to another agent's request,
 *    and that is the act the whole inbound design exists to keep deliberate.
 */
export const registerTools = (server: McpServer, ctx: ToolContext): void => {
  // First and unconditionally: an unconfigured server must still be able to say
  // what it needs, rather than being a connection that closes.
  registerAuthTools(server, ctx);
  registerAgentTools(server, ctx);
  registerTaskTools(server, ctx);
  registerRequestTool(server, ctx);

  if (ctx.allowWrites) registerWriteTools(server, ctx);
};
