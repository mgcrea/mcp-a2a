import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Role, Task, TaskState, type Message } from "#/a2a";
import { InvalidTaskIdError, StoreUnwritableError, TaskNotFoundError } from "#/client/errors";
import { FileTaskStore, readState } from "#/store/tasks";
import { tempStateDir } from "#test/helpers";

/** A gap between writes, because ISO timestamps only resolve to the millisecond. */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

const store = (): FileTaskStore =>
  new FileTaskStore({ stateDir: tempStateDir(), defaultDirection: "inbound" });

const task = (id: string, state: TaskState = TaskState.TASK_STATE_SUBMITTED): Task => ({
  id,
  contextId: `ctx-${id}`,
  status: { state, message: undefined, timestamp: "2026-09-09T00:00:00.000Z" },
  artifacts: [],
  history: [],
  metadata: undefined,
});

const message = (text: string): Message => ({
  messageId: `m-${text.length}`,
  contextId: "",
  taskId: "",
  role: Role.ROLE_AGENT,
  parts: [
    { content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "" },
  ],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

describe("FileTaskStore construction", () => {
  /**
   * The regression that produced a bare "MCP error -32000: Connection closed":
   * the constructor used to create its directory, so an unwritable HOME — a
   * read-only or sandboxed home, an A2A_STATE_DIR whose parent does not exist —
   * killed the server during startup with stderr swallowed.
   */
  it("constructs against an unwritable directory without throwing", () => {
    const s = new FileTaskStore({
      stateDir: "/nonexistent/mcp-a2a",
      defaultDirection: "inbound",
    });
    // Reads answer empty rather than failing: there is nothing there to read.
    expect(s.records()).toEqual([]);
    expect(s.get("anything")).toBeUndefined();
    expect(s.snapshot().size).toBe(0);
    // And it says so, which is what `a2a_auth_status` surfaces.
    const diagnosis = s.diagnose();
    expect(diagnosis.writable).toBe(false);
    expect(String(diagnosis.error)).toContain("ENOENT");
  });

  it("fails a WRITE with a remedy naming the variable to change", () => {
    const s = new FileTaskStore({
      stateDir: "/nonexistent/mcp-a2a",
      defaultDirection: "inbound",
    });
    try {
      s.put(task("t1"), { direction: "inbound", peer: "p" });
      expect.unreachable("a write to an unwritable store must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreUnwritableError);
      expect((err as StoreUnwritableError).remedy).toContain("A2A_STATE_DIR");
    }
  });

  it("creates the directory on the first write", () => {
    const dir = join(tempStateDir(), "not", "yet", "there");
    const s = new FileTaskStore({ stateDir: dir, defaultDirection: "inbound" });
    expect(s.diagnose().writable).toBe(true);
    s.put(task("t1"), { direction: "inbound", peer: "p" });
    expect(s.get("t1")?.task.id).toBe("t1");
  });
});

describe("FileTaskStore", () => {
  it("round-trips a task through the wire format", async () => {
    const s = store();
    s.put(task("t1"), { direction: "inbound", peer: "codex" });
    const loaded = await s.load("t1");
    expect(loaded?.id).toBe("t1");
    expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    // On disk it is protobuf JSON — the string form, not the enum — so a record
    // written by one build is readable by any A2A implementation.
    const record = s.get("t1");
    expect((record?.task.status as Record<string, unknown> | undefined)?.state).toBe(
      "TASK_STATE_SUBMITTED",
    );
    expect(record?.peer).toBe("codex");
  });

  /**
   * A task id arrives from a peer over the network and is used as a filename, so
   * `../../.ssh/authorized_keys` is a write primitive if it is not checked.
   */
  it("refuses a task id that would escape the store directory", () => {
    const s = store();
    for (const id of ["../escape", "a/b", "..", ".", "", "with space", "x".repeat(129)]) {
      expect(() => s.put(task(id), { direction: "inbound", peer: "p" }), id).toThrow(
        InvalidTaskIdError,
      );
      // The read path never throws on a hostile id — a lookup miss is a miss.
      expect(s.get(id), id).toBeUndefined();
    }
  });

  it("writes each record atomically, leaving no temp files behind", () => {
    const dir = tempStateDir();
    const s = new FileTaskStore({ stateDir: dir, defaultDirection: "inbound" });
    s.put(task("t1"), { direction: "inbound", peer: "p" });
    s.put(task("t1", TaskState.TASK_STATE_WORKING), { direction: "inbound", peer: "p" });
    const names = readdirSync(join(dir, "tasks"));
    expect(names).toEqual(["t1.json"]);
    // And the replacement is a whole document, never an append.
    expect(() => JSON.parse(readFileSync(join(dir, "tasks", "t1.json"), "utf8"))).not.toThrow();
  });

  it("preserves direction and peer across a save that cannot know them", async () => {
    const s = store();
    s.put(task("t1"), { direction: "outbound", peer: "http://127.0.0.1:41999" });
    // This is the path `ResultManager` takes: the SDK's `TaskStore` interface has
    // no room for either field, so an existing record's must survive.
    await s.save(task("t1", TaskState.TASK_STATE_COMPLETED));
    const record = s.get("t1");
    expect(record?.direction).toBe("outbound");
    expect(record?.peer).toBe("http://127.0.0.1:41999");
    expect(readState(record!)).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("stamps its default direction on a task it has never seen", async () => {
    const s = store();
    await s.save(task("fresh"));
    expect(s.get("fresh")?.direction).toBe("inbound");
  });

  it("filters and orders records, newest change first", async () => {
    const s = store();
    s.put(task("in1"), { direction: "inbound", peer: "a" });
    await tick();
    s.put(task("out1"), { direction: "outbound", peer: "b" });
    await tick();
    s.put(task("in2"), { direction: "inbound", peer: "c" });
    expect(s.records().map((r) => r.task.id)).toEqual(["in2", "out1", "in1"]);
    expect(s.records({ direction: "inbound" }).map((r) => r.task.id)).toEqual(["in2", "in1"]);
  });

  /**
   * Timestamps collide — a peer sending a batch, or both processes writing at
   * once — and an unstable sort makes a paged listing return one row twice and
   * skip another.
   */
  it("orders records deterministically when their timestamps are identical", () => {
    const dir = tempStateDir();
    const s = new FileTaskStore({ stateDir: dir, defaultDirection: "inbound" });
    // Written by hand so the timestamps genuinely tie — `put` stamps `Date.now()`
    // and would usually separate them by a millisecond or two.
    const at = "2026-09-09T12:00:00.000Z";
    // The store creates `tasks/` on its first write, not at construction, so a
    // test that writes by hand has to make it.
    mkdirSync(join(dir, "tasks"), { recursive: true });
    for (const id of ["c", "a", "b"]) {
      writeFileSync(
        join(dir, "tasks", `${id}.json`),
        JSON.stringify({
          version: 1,
          direction: "inbound",
          peer: "p",
          createdAt: at,
          updatedAt: at,
          task: { id, contextId: "x", status: { state: "TASK_STATE_SUBMITTED" } },
        }),
      );
    }
    const ids = s.records().map((r) => r.task.id);
    expect(ids).toEqual(["a", "b", "c"]);
    // And the same on every read, which is the property a paged listing needs.
    expect(s.records().map((r) => r.task.id)).toEqual(ids);
  });

  it("applies a response as a status, a history entry and an artifact", () => {
    const s = store();
    s.put(task("t1"), { direction: "inbound", peer: "codex" });
    const updated = s.applyResponse("t1", {
      state: TaskState.TASK_STATE_COMPLETED,
      message: message("done, two tests fail"),
      artifactText: "done, two tests fail",
      artifactName: "response",
    });
    expect(readState(updated)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect((updated.task.history as unknown[]).length).toBe(1);
    expect((updated.task.artifacts as unknown[]).length).toBe(1);
    // The response must not silently create a task that no peer knows about.
    expect(() => s.applyResponse("never-existed", { state: TaskState.TASK_STATE_FAILED })).toThrow(
      TaskNotFoundError,
    );
  });

  it("reports what changed against a snapshot, and distinguishes created from updated", () => {
    const s = store();
    const empty = s.snapshot();
    s.put(task("t1"), { direction: "inbound", peer: "a" });
    const created = s.changesSince(empty);
    expect(created.map((c) => [c.taskId, c.kind])).toEqual([["t1", "created"]]);

    const afterCreate = s.snapshot();
    s.applyResponse("t1", { state: TaskState.TASK_STATE_COMPLETED });
    const updated = s.changesSince(afterCreate);
    expect(updated.map((c) => [c.taskId, c.kind])).toEqual([["t1", "updated"]]);

    // A snapshot taken after the change reports nothing, which is what stops a
    // long-poll from returning the same event twice.
    expect(s.changesSince(s.snapshot())).toEqual([]);
  });

  it("ignores a record it cannot read instead of failing the whole listing", () => {
    const dir = tempStateDir();
    const s = new FileTaskStore({ stateDir: dir, defaultDirection: "inbound" });
    s.put(task("good"), { direction: "inbound", peer: "a" });
    // Something else's file, or a half-migrated record from an older version.
    writeFileSync(join(dir, "tasks", "junk.json"), "{not json");
    writeFileSync(join(dir, "tasks", "v99.json"), '{"version":99}');
    expect(s.records().map((r) => r.task.id)).toEqual(["good"]);
  });

  it("paginates ListTasks for a peer, and hides artifacts unless asked", async () => {
    const s = store();
    for (const id of ["a", "b", "c"]) s.put(task(id), { direction: "inbound", peer: "p" });
    s.applyResponse("a", { state: TaskState.TASK_STATE_COMPLETED, artifactText: "result" });

    const page1 = await s.list({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageSize: 2,
      pageToken: "",
      statusTimestampAfter: undefined,
    });
    expect(page1.tasks).toHaveLength(2);
    expect(page1.totalSize).toBe(3);
    expect(page1.nextPageToken).toBe("2");

    const page2 = await s.list({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageSize: 2,
      pageToken: page1.nextPageToken,
      statusTimestampAfter: undefined,
    });
    expect(page2.tasks).toHaveLength(1);
    expect(page2.nextPageToken).toBe("");

    // Artifacts default to omitted — `ListTasks` is the call most likely to be
    // made without thinking about size.
    const completed = await s.list({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_COMPLETED,
      pageToken: "",
      statusTimestampAfter: undefined,
    });
    expect(completed.tasks).toHaveLength(1);
    expect(completed.tasks[0]?.artifacts).toEqual([]);

    const withArtifacts = await s.list({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_COMPLETED,
      pageToken: "",
      statusTimestampAfter: undefined,
      includeArtifacts: true,
    });
    expect(withArtifacts.tasks[0]?.artifacts).toHaveLength(1);
  });
});
