import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ToolContext } from "#/tools/index";
import { peerUrlArg, wrap } from "#/tools/util";

/**
 * The A2A RPCs that only read. The method enum narrows to these when writes are
 * off, so the escape hatch cannot become a way around the gate.
 */
const READ_METHODS = [
  "GetTask",
  "ListTasks",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "GetExtendedAgentCard",
] as const;

const WRITE_METHODS = [
  "SendMessage",
  "CancelTask",
  "CreateTaskPushNotificationConfig",
  "DeleteTaskPushNotificationConfig",
] as const;

/**
 * The escape hatch: any A2A JSON-RPC method against any peer, so an RPC nobody
 * wrapped stays reachable without a code change.
 *
 * Two things constrain it. The method list is an enum rather than a free string,
 * and it narrows to the read-only half when `A2A_ALLOW_WRITES` is off — belt and
 * braces on top of the write tools simply not existing. And the endpoint comes
 * from the peer's own agent card, never from an argument, so this cannot be
 * pointed at an arbitrary URL: it is an A2A client, not a fetch primitive.
 */
export const registerRequestTool = (server: McpServer, ctx: ToolContext): void => {
  const methods = ctx.allowWrites ? ([...READ_METHODS, ...WRITE_METHODS] as const) : READ_METHODS;

  server.registerTool(
    "a2a_request",
    {
      title: "A2A: Request",
      description:
        "Escape hatch: call an A2A JSON-RPC method directly on a peer and return its raw " +
        "reply, unshaped. Use this only for something the typed tools do not cover — they " +
        "shape their responses, and a raw A2A reply is protobuf JSON, so a `Part` arrives as " +
        '`{"text":"…"}` and a state as `"TASK_STATE_SUBMITTED"`. The endpoint always comes ' +
        "from the peer's own agent card, so this cannot be aimed at an arbitrary URL. " +
        (ctx.allowWrites
          ? "Writes are ENABLED, so the mutating methods are permitted — there is no " +
            "confirmation step, so check the method and params before you call it."
          : "Writes are DISABLED: only the read-only methods are offered. Set " +
            "A2A_ALLOW_WRITES=1 to allow the mutating ones."),
      inputSchema: {
        url: peerUrlArg,
        method: z
          .enum(methods)
          .describe(
            "The A2A v1.0 RPC name, PascalCase — `GetTask`, `ListTasks`, `SendMessage`. NOT " +
              "the 0.x names (`tasks/get`, `message/send`): v1.0 renamed all of them, and an " +
              "0.x name comes back as -32601 method not found." +
              (ctx.allowWrites ? "" : " Only the read-only methods are available right now."),
          ),
        params: z
          .record(z.string(), z.unknown())
          .default({})
          .describe(
            'The method\'s params object, e.g. `{"id": "task-abc"}` for GetTask or ' +
              '`{"pageSize": 10}` for ListTasks. Field names are camelCase (`historyLength`, ' +
              "`pageToken`) because the wire format is protobuf JSON.",
          ),
      },
      // Read-only exactly when the gate is off, which is what the enum enforces.
      annotations: { readOnlyHint: !ctx.allowWrites, destructiveHint: ctx.allowWrites },
    },
    async ({ url, method, params }) =>
      wrap(async () => await ctx.peers.rawRpc(url, method, params)),
  );
};
