import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { Role, Task, TaskState, type Message } from "#/a2a";
import { normalizeBase, randomId, textPart } from "#/client/peer";
import { describeTask, messageText, summarizeTask } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { confirmArg, peerUrlArg, taskIdArg, wrap } from "#/tools/util";

/**
 * Everything that changes state somewhere. Registered ONLY when
 * `A2A_ALLOW_WRITES` is on — so with the flag off these tools are not refused,
 * they are absent from `tools/list` and cannot be called at all.
 *
 * The difference matters. A refusal still lets a model try, retry, and reason
 * about how to get around it; a tool that does not exist ends the conversation.
 */
export const registerWriteTools = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "a2a_send_message",
    {
      title: "A2A: Send Message",
      description:
        "Delegate work to another agent over A2A, and record the resulting task locally so " +
        "a2a_list_tasks can track it. Call a2a_discover_agent first for a peer you have not " +
        "used — its skill list is what says whether it can do the thing, and its card is what " +
        "says which binding to speak. Returns as soon as the peer has acknowledged the task, " +
        "WITHOUT waiting for an answer: a peer on this mesh queues work for a " +
        "human-supervised agent, so a blocking send would block for as long as a person takes. " +
        "Poll with `a2a_get_task(refresh: true)`, or park on a2a_wait_for_task. Pass `task_id` " +
        "to add a turn to a task that already exists rather than starting a new one.",
      inputSchema: {
        url: peerUrlArg,
        text: z
          .string()
          .min(1)
          .max(32_000)
          .describe(
            "What you are asking the other agent to do, in plain prose. Be specific about " +
              "absolute paths and repositories — the peer is a different agent with a " +
              'different working directory, e.g. "Run the tests in ~/Projects/example and ' +
              'report which fail". Put bulk content in a file and name the path rather than ' +
              "pasting it: the daemon caps a request body at 1 MB.",
          ),
        task_id: z
          .string()
          .max(128)
          .optional()
          .describe(
            "Continue an existing task by id, instead of creating a new one. Use this to " +
              "answer a peer that moved its task to `input_required`.",
          ),
        context_id: z
          .string()
          .max(128)
          .optional()
          .describe(
            "Group this message with an existing conversation by context id. Omit to let the " +
              "peer assign one.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ url, text, task_id, context_id }) =>
      wrap(async () => {
        const peer = normalizeBase(url);
        const { result, sent } = await ctx.peers.sendMessage(peer, {
          text,
          ...(task_id ? { taskId: task_id } : {}),
          ...(context_id ? { contextId: context_id } : {}),
        });

        // A peer may answer with a bare Message instead of a Task — legal in A2A
        // for something it handled without creating one. There is nothing to
        // mirror in that case, and pretending otherwise would put a task id in
        // the store that no peer knows.
        if (!("id" in result)) {
          return {
            peer,
            replied_with: "message",
            text: messageText(result as Message),
            note: "The peer answered directly without creating a task, so nothing was recorded.",
          };
        }

        const task = result as Task;
        // The peer's acknowledgement usually arrives with an empty history — see
        // `PeerClient.sendMessage`. Our own request is the one thing we know for
        // certain, so it goes into the mirror rather than being lost.
        const mirrored: Task = task.history.length === 0 ? { ...task, history: [sent] } : task;
        const record = ctx.store.put(mirrored, { direction: "outbound", peer });
        return {
          peer,
          replied_with: "task",
          task: summarizeTask(record),
          note:
            "Recorded locally as an outbound task. Read the answer later with " +
            "a2a_get_task(refresh: true) — the local copy is a mirror and does not update itself.",
        };
      }),
  );

  server.registerTool(
    "a2a_respond_to_task",
    {
      title: "A2A: Respond To Task",
      description:
        "Answer an inbound task — the deliberate act of acting on a proposal. NOTHING about an " +
        "arriving task commits you to this: read it with a2a_get_task, decide whether it is " +
        'appropriate, then either answer it or reject it. Set `state: "completed"` with the ' +
        "result in `text`; `input_required` to ask the sender something back; `rejected` when " +
        "you will not do it; `failed` when you tried and could not. The text is written into " +
        "the task as an artifact and a message, which is what the sending agent reads.",
      inputSchema: {
        task_id: taskIdArg,
        state: z
          .enum(["completed", "input_required", "rejected", "failed", "working"])
          .default("completed")
          .describe(
            "How this turn leaves the task. `completed` — done, the answer is in `text`. " +
              "`input_required` — you need something from the sender. `rejected` — you will " +
              "not do it (say why in `text`). `failed` — you tried and could not. `working` — " +
              "you have started and will answer later. Defaults to completed.",
          ),
        text: z
          .string()
          .min(1)
          .max(32_000)
          .describe(
            "Your answer, in plain prose — the result, the question, or the reason for " +
              "refusing. This is the whole of what the other agent sees, so make it stand " +
              "alone: they cannot see your session.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ task_id, state, text }) =>
      wrap(async () => {
        const record = ctx.store.require(task_id);
        const message: Message = {
          messageId: randomId("msg"),
          contextId: typeof record.task.contextId === "string" ? record.task.contextId : "",
          taskId: task_id,
          // ROLE_AGENT: this is the served side answering. The sender's own turns
          // are ROLE_USER, whoever composed them.
          role: Role.ROLE_AGENT,
          parts: [textPart(text)],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        };
        const updated = ctx.store.applyResponse(task_id, {
          state: RESPONSE_STATES[state],
          message,
          artifactText: text,
          artifactName: "response",
        });
        return {
          task: describeTask(updated, { historyLength: 5 }),
          note:
            record.direction === "inbound"
              ? "Written to the shared store. The peer sees it on its next GetTask."
              : "This is an OUTBOUND task, so you have annotated your own mirror rather than " +
                "answering anyone. To reply to a peer's question use a2a_send_message with " +
                "task_id.",
        };
      }),
  );

  server.registerTool(
    "a2a_cancel_task",
    {
      title: "A2A: Cancel Task",
      description:
        "Withdraw a task. For an outbound task this asks the peer to cancel it, which the peer " +
        "may refuse if it has already finished. For an inbound one it records the cancellation " +
        "locally. Not reversible — a canceled task cannot be resumed, and the id cannot be " +
        "reused; send a new message instead.",
      inputSchema: { task_id: taskIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ task_id }) =>
      wrap(async () => {
        const record = ctx.store.require(task_id);
        if (record.direction === "outbound") {
          const task = await ctx.peers.cancelTask(record.peer, task_id);
          const updated = ctx.store.put(task, { direction: "outbound", peer: record.peer });
          return { canceled: true, at: "peer", task: summarizeTask(updated) };
        }
        const updated = ctx.store.applyResponse(task_id, {
          state: TaskState.TASK_STATE_CANCELED,
        });
        return { canceled: true, at: "local", task: summarizeTask(updated) };
      }),
  );

  server.registerTool(
    "a2a_set_push_notification_config",
    {
      title: "A2A: Set Push Notification Config",
      description:
        "Ask a PEER to POST task updates to a webhook instead of making you poll. Only works " +
        "against a peer whose card advertises `push_notifications: true` — check with " +
        "a2a_discover_agent first, and note that this machine's own daemon advertises FALSE, " +
        "so pointing this at yourself will be refused. When in doubt, poll: " +
        "a2a_get_task(refresh: true) needs no webhook and no reachable listener.",
      inputSchema: {
        url: peerUrlArg,
        task_id: taskIdArg,
        config_id: z
          .string()
          .min(1)
          .max(128)
          .describe('An id of your choosing for this config, e.g. "primary". Reuse it to replace.'),
        webhook_url: z
          .string()
          .url()
          .describe(
            "Where the peer should POST updates, e.g. `http://127.0.0.1:9000/a2a-hook`. It must " +
              "be reachable FROM THE PEER, which on this loopback mesh means a 127.0.0.1 " +
              "address is fine and a private LAN address usually is not.",
          ),
        webhook_token: z
          .string()
          .max(512)
          .optional()
          .describe(
            "A token the peer will send back with each notification so you can tell a real " +
              "one from a forgery. Strongly recommended: the webhook is an unauthenticated " +
              "POST endpoint otherwise.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ url, task_id, config_id, webhook_url, webhook_token }) =>
      wrap(async () => ({
        peer: normalizeBase(url),
        config: await ctx.peers.setPushNotificationConfig(url, {
          taskId: task_id,
          id: config_id,
          url: webhook_url,
          ...(webhook_token ? { token: webhook_token } : {}),
        }),
      })),
  );

  server.registerTool(
    "a2a_delete_push_notification_config",
    {
      title: "A2A: Delete Push Notification Config",
      description:
        "Remove a push notification config from a peer's task, so it stops POSTing updates. " +
        "Irreversible — the peer forgets the webhook and the token, and re-creating it needs " +
        "the token again.",
      inputSchema: {
        url: peerUrlArg,
        task_id: taskIdArg,
        config_id: z
          .string()
          .min(1)
          .max(128)
          .describe('The config id given when it was created, e.g. "primary".'),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ url, task_id, config_id }) =>
      wrap(async () => {
        await ctx.peers.deletePushNotificationConfig(url, { taskId: task_id, id: config_id });
        return { deleted: true, peer: normalizeBase(url), task_id, config_id };
      }),
  );
};

/** The subset of `TaskState` a local agent may put a task into, by short name. */
const RESPONSE_STATES = {
  completed: TaskState.TASK_STATE_COMPLETED,
  input_required: TaskState.TASK_STATE_INPUT_REQUIRED,
  rejected: TaskState.TASK_STATE_REJECTED,
  failed: TaskState.TASK_STATE_FAILED,
  working: TaskState.TASK_STATE_WORKING,
} as const;
