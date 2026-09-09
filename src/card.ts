import { A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";

import type { AgentCard } from "#/a2a";
import { BUILD_INFO } from "#/build-info";
import type { Config } from "#/config";

/** Where the daemon serves the JSON-RPC binding. Advertised in the card. */
export const A2A_RPC_PATH = "/a2a/v1";

/**
 * The agent card this machine publishes at `/.well-known/agent-card.json`.
 *
 * Every field the v1.0 spec marks required is present: `name`, `description`,
 * `supportedInterfaces`, `version`, `capabilities`, `defaultInputModes`,
 * `defaultOutputModes`, `skills`. The optional ones are omitted rather than
 * filled with placeholders — an empty `provider.organization` is worse than no
 * provider, because a peer renders it.
 *
 * Two capabilities are deliberately FALSE in v1, and saying so in the card is
 * the whole point of having one:
 *
 *   streaming          — `SendStreamingMessage`/`SubscribeToTask` are not served.
 *                        A peer should poll `GetTask`, which for a task that
 *                        waits on a human-supervised agent is the honest shape
 *                        anyway.
 *   pushNotifications  — the daemon accepts no push configs. It could store
 *                        them, but the state changes that matter here are
 *                        written by the *other* process (the stdio server, when
 *                        an agent answers), so a sender wired into the request
 *                        handler would never fire on the event a caller cares
 *                        about. A config that silently never delivers is worse
 *                        than a declined capability.
 */
export const buildAgentCard = (config: Config): AgentCard => ({
  name: config.agentName,
  description: config.agentDescription,
  supportedInterfaces: [
    {
      url: `${config.daemonUrl.replace(/\/+$/, "")}${A2A_RPC_PATH}`,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  provider: undefined,
  version: BUILD_INFO.version,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "application/json"],
  skills: [
    {
      id: "delegate-task",
      name: "Delegate a task to a local coding agent",
      description:
        "Queue a request for one of the coding agents running on this machine — Claude Code, " +
        "Codex, Cursor, LM Studio. The task is created immediately in SUBMITTED and stays there " +
        "until an agent picks it up; poll GetTask for the answer. Nothing is executed " +
        "automatically: an inbound task is a proposal a human-supervised agent chooses to act " +
        "on, so treat a reply as a considered answer rather than a guaranteed one.",
      tags: ["code", "delegation", "local", "human-in-the-loop"],
      examples: [
        "Read src/server.ts in ~/Projects/example and summarise how requests are routed.",
        "Run the test suite in ~/Projects/example and report which tests fail.",
        "Draft a migration plan for moving this project off express.",
      ],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
  ],
  signatures: [],
});
