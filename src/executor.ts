import {
  AgentEvent,
  ServerCallContext,
  Task,
  TaskState,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "#/a2a";
import type { Logger } from "#/client/auth";
import { nowIso } from "#/store/paths";
import type { FileTaskStore } from "#/store/tasks";

/**
 * What the daemon does with an inbound task: park it, and tell the caller it is
 * parked.
 *
 * This is the whole inbound design in one class, and the reason it looks so
 * unlike a normal `AgentExecutor` — it runs no agent. An inbound A2A task is a
 * PROPOSAL for a human-supervised agent on this machine, so the executor's only
 * job is to record it in `SUBMITTED` and return. Acting on it is a separate,
 * deliberate act by the receiving agent (`a2a_respond_to_task`), for two
 * reasons that point the same way:
 *
 *   * measured — content that reaches an agent through a channel arrives as
 *     untrusted data, and the receiving agent correctly refused to act on an
 *     instruction inside it. A design where arrival triggers execution would be
 *     both a prompt-injection surface and one the agent rightly ignores;
 *   * a daemon that executed inbound work would be a remote-code-execution
 *     endpoint on loopback, gated by nothing but a shared token.
 *
 * `SUBMITTED` is the right resting state and not merely a convenient one: the
 * spec defines it as "successfully submitted and acknowledged", which is exactly
 * what has happened. It is also neither terminal nor interrupted, so
 * `DefaultRequestHandler` does not hold the caller open waiting for it —
 * publishing it and returning settles the bus, and the caller gets its task
 * straight back.
 */
export class ProposalExecutor implements AgentExecutor {
  private readonly store: FileTaskStore;
  private readonly logger: Logger | undefined;

  constructor(opts: { store: FileTaskStore; logger?: Logger }) {
    this.store = opts.store;
    this.logger = opts.logger;
  }

  execute = async (requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> => {
    const peer = peerFromContext(requestContext.context);
    const existing = requestContext.task;

    // A follow-up turn on a task that is already here. The first event still has
    // to be a `task` or a `message` — the server rejects a stream that opens
    // with a status update — so the existing task is republished before the
    // state is moved back to SUBMITTED for another look.
    const task: Task = existing
      ? { ...existing, status: submitted() }
      : {
          id: requestContext.taskId,
          contextId: requestContext.contextId,
          status: submitted(),
          artifacts: [],
          // Left empty on purpose: `ResultManager` prepends the user's own
          // message, deduplicated by `messageId`, so filling it here would put
          // the request in the history twice.
          history: [],
          metadata: undefined,
        };

    // Written before the event is published so the record carries who it came
    // from. Every later save goes through `FileTaskStore.save`, which preserves
    // an existing record's `direction` and `peer` — the store has no other way
    // to learn either, because the SDK's `TaskStore` interface has no room for
    // them.
    this.store.put(task, { direction: "inbound", peer });
    this.logger?.warn?.(`inbound task ${task.id} from ${peer} — parked as a proposal in SUBMITTED`);

    eventBus.publish(AgentEvent.task(task));
  };

  /**
   * A peer withdrawing a request. Honoured unconditionally: nothing was running,
   * so there is nothing that can refuse to stop.
   */
  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    const record = this.store.get(taskId);
    const contextId =
      record && typeof record.task.contextId === "string" ? record.task.contextId : "";
    this.logger?.warn?.(`inbound task ${taskId} canceled by the peer`);
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: nowIso() },
        metadata: undefined,
      }),
    );
  };
}

const submitted = () => ({
  state: TaskState.TASK_STATE_SUBMITTED,
  message: undefined,
  timestamp: nowIso(),
});

/**
 * Who sent this. There is no field for it in A2A — the protocol has no notion of
 * a caller identity beyond whatever the security scheme establishes — so it is
 * read from the request headers the default context builder stashes in
 * `context.state`, preferring an explicit `X-A2A-From` over the `User-Agent`
 * every HTTP client sends anyway.
 *
 * It is attribution, not authentication: anything that can reach the daemon can
 * claim any name. The thing that actually gates access is the bearer token, and
 * the thing that limits the damage is that nothing here executes.
 */
export const peerFromContext = (context: ServerCallContext | undefined): string => {
  const headers = context?.state.get("headers");
  if (typeof headers === "object" && headers !== null) {
    const bag = headers as Record<string, string | string[] | undefined>;
    const from = first(bag["x-a2a-from"]) ?? first(bag["user-agent"]);
    if (from) return from.slice(0, 200);
  }
  return "unknown";
};

const first = (value: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
};
