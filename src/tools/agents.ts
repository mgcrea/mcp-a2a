import type { McpServer } from "@modelcontextprotocol/server";

import { summarizeCard } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { peerUrlArg, wrap } from "#/tools/util";

/** Peer discovery. Needs no credentials, so both tools are always registered. */
export const registerAgentTools = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "a2a_list_agents",
    {
      title: "A2A: List Agents",
      description:
        "List the A2A peers this machine knows about: the configured ones (A2A_PEERS), this " +
        "machine's own daemon, and anything a2a_discover_agent has fetched. Reads the local " +
        "card cache and makes NO network calls, so a peer that is down is still listed — " +
        "`cached_at` is absent for one whose card has never been read. Prefer this over " +
        "discovering peers one at a time when you only need to know who is out there.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => ({
        agents: ctx.peers.peers().map((peer) => ({
          url: peer.url,
          name: peer.name,
          ...(peer.description ? { description: peer.description } : {}),
          ...(peer.self ? { self: true } : {}),
          configured: peer.configured,
          ...(peer.cachedAt ? { cached_at: peer.cachedAt } : {}),
        })),
        note:
          'A name of "(not discovered)" means no card has been fetched yet — call ' +
          "a2a_discover_agent with that url to learn its skills.",
      })),
  );

  server.registerTool(
    "a2a_discover_agent",
    {
      title: "A2A: Discover Agent",
      description:
        "Fetch a peer's agent card from /.well-known/agent-card.json, cache it locally, and " +
        "return its skills and transports. Always refetches, so it is also how you check " +
        "whether a peer is up and what it can do NOW — a cached card goes stale the moment the " +
        "peer restarts. Do this before a2a_send_message to a peer you have not used: the card " +
        "is what says which A2A binding and URL to speak, and its skill list is what says " +
        "whether the peer can do the thing at all.",
      inputSchema: { url: peerUrlArg },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) =>
      wrap(async () => ({
        url,
        card: summarizeCard(await ctx.peers.discover(url)),
      })),
  );
};
