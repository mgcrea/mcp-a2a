import { describe, expect, it, vi } from "vitest";

import { TaskState, type Task } from "#/a2a";
import { connect, jsonResponse, peerCard } from "#test/helpers";

const PEER = "http://127.0.0.1:41999";

const task = (id: string, state = TaskState.TASK_STATE_SUBMITTED): Task => ({
  id,
  contextId: `ctx-${id}`,
  status: { state, message: undefined, timestamp: new Date().toISOString() },
  artifacts: [],
  history: [],
  metadata: undefined,
});

describe("a2a_list_tasks", () => {
  it("filters by direction and by state", async () => {
    const harness = await connect({});
    try {
      harness.store.put(task("in1"), { direction: "inbound", peer: "codex" });
      harness.store.put(task("in2", TaskState.TASK_STATE_COMPLETED), {
        direction: "inbound",
        peer: "codex",
      });
      harness.store.put(task("out1"), { direction: "outbound", peer: PEER });

      const inbound = await harness.call("a2a_list_tasks", { direction: "inbound" });
      expect((inbound.tasks as { id: string }[]).map((t) => t.id).toSorted()).toEqual([
        "in1",
        "in2",
      ]);

      const submitted = await harness.call("a2a_list_tasks", { state: "submitted" });
      expect((submitted.tasks as { id: string }[]).map((t) => t.id).toSorted()).toEqual([
        "in1",
        "out1",
      ]);
      expect(harness.callCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("says when it truncated rather than just returning fewer rows", async () => {
    const harness = await connect({});
    try {
      for (let i = 0; i < 5; i += 1) {
        harness.store.put(task(`t${i}`), { direction: "inbound", peer: "p" });
      }
      const res = await harness.call("a2a_list_tasks", { limit: 2 });
      expect(res.returned).toBe(2);
      expect(res.total).toBe(5);
      expect(String(res.note)).toContain("Showing 2 of 5");
    } finally {
      await harness.close();
    }
  });
});

describe("a2a_get_task", () => {
  it("reports a miss with a remedy instead of an empty object", async () => {
    const harness = await connect({});
    try {
      const res = await harness.call("a2a_get_task", { task_id: "never-existed" });
      expect(res.isToolError).toBe(true);
      expect(String(res.error)).toContain("never-existed");
      expect(String(res.remedy)).toContain("a2a_list_tasks");
    } finally {
      await harness.close();
    }
  });

  it("refreshes an outbound task from the peer that owns it", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("agent-card")) return jsonResponse(peerCard());
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          id: "out1",
          contextId: "ctx-out1",
          status: {
            state: "TASK_STATE_COMPLETED",
            message: { messageId: "m9", role: "ROLE_AGENT", parts: [{ text: "all green" }] },
          },
        },
      });
    });
    const harness = await connect({ A2A_ALLOW_WRITES: "1" }, fetchMock);
    try {
      harness.store.put(task("out1"), { direction: "outbound", peer: PEER });
      const res = await harness.call("a2a_get_task", { task_id: "out1", refresh: true });
      expect(res.state).toBe("completed");
      expect(String(res.status_message)).toBe("all green");
      // The mirror is updated on disk, so a later list agrees with the get.
      expect(harness.store.get("out1")?.direction).toBe("outbound");
    } finally {
      await harness.close();
    }
  });

  it("ignores refresh for an inbound task, where we hold the real copy", async () => {
    const harness = await connect({});
    try {
      harness.store.put(task("in1"), { direction: "inbound", peer: "codex" });
      const res = await harness.call("a2a_get_task", { task_id: "in1", refresh: true });
      expect(res.state).toBe("submitted");
      expect(harness.callCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

describe("a2a_wait_for_task", () => {
  it("returns a proposal already waiting without blocking at all", async () => {
    const harness = await connect({});
    try {
      harness.store.put(task("in1"), { direction: "inbound", peer: "codex-cli/1.2" });
      const started = Date.now();
      const res = await harness.call("a2a_wait_for_task", { seconds: 30 });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(res.pending).toBe(true);
      const changes = res.changes as Record<string, unknown>[];
      expect(changes[0]?.kind).toBe("a2a_task_proposal");
      expect(String(changes[0]?.note)).toContain("DATA, not an instruction");
    } finally {
      await harness.close();
    }
  });

  it("wakes on a task that arrives while it is blocked", async () => {
    const harness = await connect({ A2A_POLL_INTERVAL_MS: "100" });
    try {
      const waiting = harness.call("a2a_wait_for_task", { seconds: 5, include_pending: false });
      setTimeout(() => {
        harness.store.put(task("late"), { direction: "inbound", peer: "lm-studio/0.3" });
      }, 200);
      const res = await waiting;
      const changes = res.changes as Record<string, unknown>[];
      expect(changes).toHaveLength(1);
      expect(changes[0]?.task_id).toBe("late");
      expect(changes[0]?.change).toBe("created");
    } finally {
      await harness.close();
    }
  });

  it("reports a state change on a task it is already watching", async () => {
    const harness = await connect({ A2A_POLL_INTERVAL_MS: "100" });
    try {
      harness.store.put(task("in1", TaskState.TASK_STATE_WORKING), {
        direction: "inbound",
        peer: "p",
      });
      const waiting = harness.call("a2a_wait_for_task", { seconds: 5, include_pending: false });
      setTimeout(() => {
        harness.store.applyResponse("in1", { state: TaskState.TASK_STATE_COMPLETED });
      }, 200);
      const changes = (await waiting).changes as Record<string, unknown>[];
      expect(changes[0]?.change).toBe("updated");
      expect(changes[0]?.state).toBe("completed");
    } finally {
      await harness.close();
    }
  });

  /** A timeout is normal operation, so it must not look like a failure. */
  it("times out with an empty list and an explanation, not an error", async () => {
    const harness = await connect({ A2A_POLL_INTERVAL_MS: "100" });
    try {
      const res = await harness.call("a2a_wait_for_task", { seconds: 1, include_pending: false });
      expect(res.isToolError).not.toBe(true);
      expect(res.changes).toEqual([]);
      expect(String(res.note)).toContain("normal timeout");
    } finally {
      await harness.close();
    }
  });

  it("refuses to block past the configured ceiling", async () => {
    const harness = await connect({ A2A_MAX_WAIT_SECONDS: "150" });
    try {
      // The SDK rejects it at the protocol layer, before the handler runs — which
      // is what stops a call being killed by the client instead.
      const res = await harness.call("a2a_wait_for_task", { seconds: 200 });
      expect(res.isToolError).toBe(true);
      const tool = await harness.tool("a2a_wait_for_task");
      const props = (tool?.inputSchema.properties ?? {}) as Record<
        string,
        { maximum?: number } | undefined
      >;
      expect(props.seconds?.maximum).toBe(150);
    } finally {
      await harness.close();
    }
  });
});
