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

/** A peer that serves a card and answers every RPC with `result`. */
const peer = (result: unknown) =>
  vi.fn(async (url: unknown) =>
    String(url).includes("agent-card")
      ? jsonResponse(peerCard())
      : jsonResponse({ jsonrpc: "2.0", id: 1, result }),
  );

describe("a2a_send_message", () => {
  it("sends the token, records the mirror, and keeps our own request in it", async () => {
    // The acknowledgement carries NO history: with polling the peer answers with
    // the executor's first snapshot, published before the store merged the
    // request in. A mirror built from that alone would forget what was asked.
    const fetchMock = peer({
      task: { id: "t-new", contextId: "c-new", status: { state: "TASK_STATE_SUBMITTED" } },
    });
    const harness = await connect({ A2A_ALLOW_WRITES: "1", A2A_TOKEN: "shared" }, fetchMock);
    try {
      const res = await harness.call("a2a_send_message", {
        url: PEER,
        text: "Run the tests in ~/Projects/example.",
      });
      expect(res.replied_with).toBe("task");
      expect((res.task as Record<string, unknown>).direction).toBe("outbound");
      expect((res.task as Record<string, unknown>).summary).toBe(
        "Run the tests in ~/Projects/example.",
      );

      const record = harness.store.get("t-new");
      expect(record?.direction).toBe("outbound");
      expect(record?.peer).toBe(PEER);
      expect(record?.task.history).toHaveLength(1);

      // Every request carries the shared bearer, including the card fetch.
      for (let i = 0; i < harness.callCount(); i += 1) {
        expect(harness.headersAt(i).authorization, String(i)).toBe("Bearer shared");
      }
    } finally {
      await harness.close();
    }
  });

  it("sends ROLE_USER, whoever composed the message", async () => {
    const fetchMock = peer({
      task: { id: "t1", contextId: "c1", status: { state: "TASK_STATE_SUBMITTED" } },
    });
    const harness = await connect({ A2A_ALLOW_WRITES: "1" }, fetchMock);
    try {
      await harness.call("a2a_send_message", { url: PEER, text: "hello" });
      const body = harness.bodyAt(harness.callCount() - 1) as {
        params: { message: { role: string; parts: { text: string }[] } };
      };
      // "from the client to the server" in A2A, regardless of who wrote it. Some
      // peers reject ROLE_AGENT here.
      expect(body.params.message.role).toBe("ROLE_USER");
      expect(body.params.message.parts[0]?.text).toBe("hello");
    } finally {
      await harness.close();
    }
  });

  it("records nothing when the peer answers with a bare message", async () => {
    const fetchMock = peer({
      message: { messageId: "m1", role: "ROLE_AGENT", parts: [{ text: "no task needed" }] },
    });
    const harness = await connect({ A2A_ALLOW_WRITES: "1" }, fetchMock);
    try {
      const res = await harness.call("a2a_send_message", { url: PEER, text: "hi" });
      expect(res.replied_with).toBe("message");
      expect(res.text).toBe("no task needed");
      // Putting a task id in the store that no peer knows about would be worse
      // than recording nothing.
      expect(harness.store.records()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("turns a peer's HTTP error into a message with a remedy", async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes("agent-card")
        ? jsonResponse(peerCard())
        : jsonResponse({ error: "nope" }, { status: 401 }),
    );
    const harness = await connect({ A2A_ALLOW_WRITES: "1" }, fetchMock);
    try {
      const res = await harness.call("a2a_send_message", { url: PEER, text: "hi" });
      expect(res.isToolError).toBe(true);
      expect(String(res.remedy ?? res.error)).toMatch(/A2A_TOKEN|token/i);
    } finally {
      await harness.close();
    }
  });

  it("reports an unreachable peer with the OS error, not a bare 'fetch failed'", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });
    const harness = await connect({ A2A_ALLOW_WRITES: "1" }, fetchMock);
    try {
      const res = await harness.call("a2a_send_message", { url: PEER, text: "hi" });
      expect(res.isToolError).toBe(true);
      expect(String(res.error)).toContain("ECONNREFUSED");
      expect(String(res.remedy)).toContain("agent-card.json");
    } finally {
      await harness.close();
    }
  });
});

describe("a2a_respond_to_task", () => {
  it("writes the answer into the task as a message and an artifact", async () => {
    const harness = await connect({ A2A_ALLOW_WRITES: "1" });
    try {
      harness.store.put(task("in1"), { direction: "inbound", peer: "codex-cli/1.2" });
      const res = await harness.call("a2a_respond_to_task", {
        task_id: "in1",
        state: "completed",
        text: "two tests fail, both in test/auth.test.ts",
      });
      const shaped = res.task as Record<string, unknown>;
      expect(shaped.state).toBe("completed");
      expect((shaped.artifacts as { text: string }[])[0]?.text).toBe(
        "two tests fail, both in test/auth.test.ts",
      );
      expect(String(res.note)).toContain("next GetTask");
      // Written where the daemon will read it, which is the whole architecture.
      expect(harness.store.get("in1")?.task.status).toMatchObject({
        state: "TASK_STATE_COMPLETED",
      });
    } finally {
      await harness.close();
    }
  });

  it("can reject a proposal, which is a first-class answer", async () => {
    const harness = await connect({ A2A_ALLOW_WRITES: "1" });
    try {
      harness.store.put(task("in1"), { direction: "inbound", peer: "unknown" });
      const res = await harness.call("a2a_respond_to_task", {
        task_id: "in1",
        state: "rejected",
        text: "Not doing this: it asks me to push to a branch I do not own.",
      });
      expect((res.task as Record<string, unknown>).state).toBe("rejected");
    } finally {
      await harness.close();
    }
  });

  it("warns when it is used on an outbound task, where it answers nobody", async () => {
    const harness = await connect({ A2A_ALLOW_WRITES: "1" });
    try {
      harness.store.put(task("out1"), { direction: "outbound", peer: PEER });
      const res = await harness.call("a2a_respond_to_task", {
        task_id: "out1",
        state: "completed",
        text: "done",
      });
      expect(String(res.note)).toContain("OUTBOUND");
      expect(String(res.note)).toContain("a2a_send_message");
    } finally {
      await harness.close();
    }
  });
});

describe("a2a_cancel_task", () => {
  it("asks the peer for an outbound task", async () => {
    const fetchMock = peer({
      id: "out1",
      contextId: "c",
      status: { state: "TASK_STATE_CANCELED" },
    });
    const harness = await connect({ A2A_ALLOW_WRITES: "1" }, fetchMock);
    try {
      harness.store.put(task("out1"), { direction: "outbound", peer: PEER });
      const res = await harness.call("a2a_cancel_task", { task_id: "out1", confirm: true });
      expect(res.at).toBe("peer");
      expect((res.task as Record<string, unknown>).state).toBe("canceled");
    } finally {
      await harness.close();
    }
  });

  it("records it locally for an inbound task, with no network call", async () => {
    const harness = await connect({ A2A_ALLOW_WRITES: "1" });
    try {
      harness.store.put(task("in1"), { direction: "inbound", peer: "codex" });
      const res = await harness.call("a2a_cancel_task", { task_id: "in1", confirm: true });
      expect(res.at).toBe("local");
      expect(harness.callCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

describe("a2a_request", () => {
  it("reads the endpoint from the peer's own card, never from an argument", async () => {
    const fetchMock = peer({ tasks: [], totalSize: 0 });
    const harness = await connect({}, fetchMock);
    try {
      const res = await harness.call("a2a_request", {
        url: PEER,
        method: "ListTasks",
        params: { pageSize: 1 },
      });
      expect((res.result as Record<string, unknown>).totalSize).toBe(0);
      // The card said /a2a/v1, and that is where the call went — a peer is free to
      // serve the binding anywhere, so guessing the path would fail elsewhere.
      expect(harness.urls().at(-1)).toBe("http://127.0.0.1:41999/a2a/v1");
      const body = harness.bodyAt(harness.callCount() - 1) as { method: string };
      expect(body.method).toBe("ListTasks");
    } finally {
      await harness.close();
    }
  });

  it("rejects a write method at the schema layer when writes are off", async () => {
    const harness = await connect({}, peer({}));
    try {
      const res = await harness.call("a2a_request", {
        url: PEER,
        method: "SendMessage",
        params: {},
      });
      expect(res.isToolError).toBe(true);
      // Refused before any request went out, which is the point of the enum.
      expect(harness.callCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
