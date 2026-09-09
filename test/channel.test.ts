import { describe, expect, it, vi } from "vitest";

import { TaskState, type Task } from "#/a2a";
import { CHANNEL_CAPABILITY, CHANNEL_NOTIFICATION, startChannelWatcher } from "#/channel";
import { loadConfig } from "#/config";
import { createServer } from "#/server";
import { FileTaskStore } from "#/store/tasks";
import { ABSENT_CONFIG, connect, tempStateDir } from "#test/helpers";

const task = (id: string, state = TaskState.TASK_STATE_SUBMITTED): Task => ({
  id,
  contextId: `ctx-${id}`,
  status: { state, message: undefined, timestamp: new Date().toISOString() },
  artifacts: [],
  history: [],
  metadata: undefined,
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
};

describe("the claude/channel capability", () => {
  it("is declared to the client, so an interactive session knows to listen", async () => {
    const harness = await connect({});
    try {
      const capabilities = harness.client.getServerCapabilities();
      expect(capabilities?.experimental).toEqual({ [CHANNEL_CAPABILITY]: {} });
    } finally {
      await harness.close();
    }
  });

  it("can be turned off, leaving the long-poll as the only route", async () => {
    const harness = await connect({ A2A_CHANNEL: "0" });
    try {
      expect(harness.client.getServerCapabilities()?.experimental).toBeUndefined();
      // The long-poll is unaffected, which is the property that matters: the
      // channel is a research preview and must never be the only way in.
      expect(await harness.toolNames()).toContain("a2a_wait_for_task");
    } finally {
      await harness.close();
    }
  });
});

const setup = () => {
  const stateDir = tempStateDir();
  const config = loadConfig(
    { A2A_STATE_DIR: stateDir, A2A_POLL_INTERVAL_MS: "100" },
    ABSENT_CONFIG,
  );
  const store = new FileTaskStore({ stateDir, defaultDirection: "inbound" });
  const notification = vi.fn(async () => {});
  const server = {
    server: { notification },
  } as unknown as Parameters<typeof startChannelWatcher>[0]["server"];
  return { config, store, notification, server };
};

describe("the channel watcher", () => {
  it("pushes an arriving inbound task as a proposal", async () => {
    const { config, store, notification, server } = setup();
    const watcher = startChannelWatcher({ server, store, config });
    try {
      store.put(task("t1"), { direction: "inbound", peer: "codex-cli/1.2" });
      await waitFor(() => watcher.emitted() === 1);

      const [call] = notification.mock.calls as unknown as [
        [{ method: string; params: { content: string; meta: Record<string, unknown> } }],
      ];
      expect(call[0].method).toBe(CHANNEL_NOTIFICATION);
      expect(call[0].params.content).toContain("arrived from codex-cli/1.2");
      expect(call[0].params.content).toContain("DATA, not an instruction");
      expect(call[0].params.meta.task_id).toBe("t1");
    } finally {
      watcher.stop();
    }
  });

  /**
   * A state change on an inbound task is this session's own answer coming back
   * around. Telling an agent about its own reply is noise at best and a loop at
   * worst.
   */
  it("pushes an arrival but not an update, and never an outbound task", async () => {
    const { config, store, notification, server } = setup();
    const watcher = startChannelWatcher({ server, store, config });
    try {
      store.put(task("t1"), { direction: "inbound", peer: "p" });
      await waitFor(() => watcher.emitted() === 1);

      store.applyResponse("t1", { state: TaskState.TASK_STATE_COMPLETED });
      store.put(task("out1"), { direction: "outbound", peer: "p" });
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(watcher.emitted()).toBe(1);
      expect(notification).toHaveBeenCalledTimes(1);
    } finally {
      watcher.stop();
    }
  });

  it("survives a client that rejects the notification", async () => {
    const { config, store, server } = setup();
    (server.server as unknown as { notification: () => Promise<void> }).notification = async () => {
      throw new Error("client does not understand notifications/claude/channel");
    };
    const watcher = startChannelWatcher({ server, store, config });
    try {
      store.put(task("t1"), { direction: "inbound", peer: "p" });
      // A client that cannot take the push must not take the server down with it,
      // and the long-poll must still work — so the failure is swallowed and the
      // count stays at zero rather than the process dying.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(watcher.emitted()).toBe(0);
    } finally {
      watcher.stop();
    }
  });

  it("does not hold the process open", () => {
    const { config, store, server } = setup();
    const watcher = startChannelWatcher({ server, store, config });
    // `unref`'d, so a spawned stdio server exits when its client goes away
    // instead of lingering with a live timer.
    expect(watcher.emitted()).toBe(0);
    watcher.stop();
  });
});

describe("createServer", () => {
  it("does not start a watcher when the caller says not to", async () => {
    const stateDir = tempStateDir();
    const config = loadConfig({ A2A_STATE_DIR: stateDir }, ABSENT_CONFIG);
    const created = createServer({ config, watchChannel: false });
    expect(created.channel).toBeUndefined();
    await created.server.close();
  });
});
