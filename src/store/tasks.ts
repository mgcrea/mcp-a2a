import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  ListTasksResponse,
  Task,
  TaskState,
  taskStateFromJSON,
  type ListTasksRequest,
  type Message,
  type ServerCallContext,
  type TaskStore,
} from "#/a2a";
import type { Logger } from "#/client/auth";
import { TaskNotFoundError } from "#/client/errors";
import {
  assertSafeId,
  ensureDir,
  isSafeId,
  nowIso,
  probeDir,
  readJsonFile,
  tasksDir,
  writeFileAtomic,
} from "#/store/paths";

/**
 * Which way the task is going, from this machine's point of view.
 *
 * `inbound`  — a peer asked us to do something. Arrives through the daemon and
 *              is a PROPOSAL: a local agent may choose to act on it.
 * `outbound` — we asked a peer to do something. Recorded by `a2a_send_message`
 *              as a local mirror of the peer's own task, so `a2a_list_tasks`
 *              can answer "what did I delegate" without polling every peer.
 */
export type Direction = "inbound" | "outbound";

/** The record format. `version` so the layout can change without guessing. */
export type TaskRecord = {
  version: 1;
  direction: Direction;
  /** Base URL of the other side: who sent it (inbound) or who we sent it to. */
  peer: string;
  createdAt: string;
  updatedAt: string;
  /** The A2A `Task`, in its wire (JSON) form — never our own dialect. */
  task: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asTaskRecord = (value: unknown): TaskRecord | undefined => {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const { direction, peer, createdAt, updatedAt, task } = value;
  if (direction !== "inbound" && direction !== "outbound") return undefined;
  if (typeof peer !== "string" || !isRecord(task)) return undefined;
  return {
    version: 1,
    direction,
    peer,
    createdAt: typeof createdAt === "string" ? createdAt : nowIso(),
    updatedAt: typeof updatedAt === "string" ? updatedAt : nowIso(),
    task,
  };
};

/** `taskId -> mtimeMs`, the cheap change token the long-poll compares. */
export type StoreSnapshot = Map<string, number>;

export type StoreChange = {
  taskId: string;
  kind: "created" | "updated";
  record: TaskRecord;
};

export type FileTaskStoreOptions = {
  stateDir: string;
  /**
   * The direction stamped on a task this store creates and has never seen
   * before. The daemon's store is `inbound` — everything it is asked to create
   * came from a peer. The stdio server records outbound tasks explicitly.
   */
  defaultDirection: Direction;
  /** The peer stamped on a newly created record when the caller names none. */
  defaultPeer?: string;
  logger?: Logger;
};

/**
 * A `TaskStore` on disk, one JSON file per task, shared by both processes.
 *
 * Deliberately not SQLite: `node:sqlite` is still experimental on Node 22, a
 * second copy of the data would need migrating, and the volumes here are a
 * handful of tasks. What the filesystem gives for free is the part that matters
 * — an atomic `rename` is a publish, so a reader in the other process never
 * sees a partial record.
 *
 * ⚠ The one thing it does not give is a cross-process lock. The SDK's
 * `ResultManager` serialises writes within a process, and the two processes here
 * touch a task at different points in its life (the daemon creates it, the stdio
 * server answers it), so the read-modify-write window is narrow rather than
 * closed. A genuinely concurrent write to the same task can lose the earlier of
 * the two. That is a known limitation, written down rather than papered over.
 *
 * `ServerCallContext` is accepted because the interface requires it and ignored
 * because this store has one tenant and one owner by construction: it is a
 * single user's machine, reachable only over loopback. A multi-user deployment
 * would need `context.user` folded into the path, which is exactly the change
 * that also needs real per-peer auth.
 */
export class FileTaskStore implements TaskStore {
  private readonly dir: string;
  private readonly defaultDirection: Direction;
  private readonly defaultPeer: string;
  private readonly logger: Logger | undefined;

  constructor(opts: FileTaskStoreOptions) {
    this.dir = tasksDir(opts.stateDir);
    this.defaultDirection = opts.defaultDirection;
    this.defaultPeer = opts.defaultPeer ?? "unknown";
    this.logger = opts.logger;
    // Deliberately NOT `ensureDir` here. A constructor that can fail on an
    // unwritable HOME takes the server down at startup, which the client reports
    // as a bare "Connection closed". The directory is created on the first write.
  }

  /** Whether this store can be written, for `a2a_auth_status` to report. */
  diagnose(): { dir: string; writable: boolean; error?: string } {
    return { dir: this.dir, ...probeDir(this.dir) };
  }

  private pathFor(taskId: string): string {
    return join(this.dir, `${assertSafeId(taskId)}.json`);
  }

  // ---------------------------------------------------------- TaskStore ----

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    const existing = this.readRecord(task.id);
    this.writeRecord(task.id, {
      version: 1,
      direction: existing?.direction ?? this.defaultDirection,
      peer: existing?.peer ?? this.defaultPeer,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      task: Task.toJSON(task) as Record<string, unknown>,
    });
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    if (!isSafeId(taskId)) return undefined;
    const record = this.readRecord(taskId);
    return record ? Task.fromJSON(record.task) : undefined;
  }

  /**
   * The SDK's listing, for a peer calling `ListTasks` against us. Offset
   * pagination through an opaque `pageToken`: the store is a directory scan
   * either way, so a cursor would buy nothing but a way to be wrong.
   */
  async list(params: ListTasksRequest, _context?: ServerCallContext): Promise<ListTasksResponse> {
    let records = this.records();
    if (params.contextId) {
      records = records.filter((r) => readContextId(r) === params.contextId);
    }
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      records = records.filter((r) => readState(r) === params.status);
    }
    if (params.statusTimestampAfter) {
      const after = params.statusTimestampAfter;
      records = records.filter((r) => r.updatedAt >= after);
    }
    const totalSize = records.length;
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);
    const offset = Number.parseInt(params.pageToken || "0", 10);
    const from = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const page = records.slice(from, from + pageSize);
    const tasks = page.map((r) => {
      const task = Task.fromJSON(r.task);
      return applyReadOptions(task, params);
    });
    return ListTasksResponse.fromJSON({
      tasks: tasks.map((t) => Task.toJSON(t)),
      nextPageToken: from + pageSize < totalSize ? String(from + pageSize) : "",
      pageSize,
      totalSize,
    });
  }

  // ------------------------------------------------------------ our own ----

  /** Create or replace a record, stamping direction and peer explicitly. */
  put(task: Task, meta: { direction: Direction; peer: string }): TaskRecord {
    const existing = this.readRecord(task.id);
    const record: TaskRecord = {
      version: 1,
      direction: meta.direction,
      peer: meta.peer,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      task: Task.toJSON(task) as Record<string, unknown>,
    };
    this.writeRecord(task.id, record);
    return record;
  }

  /** One record, or undefined. Never throws on a hostile id. */
  get(taskId: string): TaskRecord | undefined {
    return isSafeId(taskId) ? this.readRecord(taskId) : undefined;
  }

  /** One record or a typed 404 — for a tool that must report a miss. */
  require(taskId: string): TaskRecord {
    const record = this.get(taskId);
    if (!record) throw new TaskNotFoundError(taskId);
    return record;
  }

  /**
   * Append a status change, and optionally a message and an artifact, to a task
   * that already exists. This is the write `a2a_respond_to_task` performs: the
   * deliberate, separate act of answering a proposal.
   */
  applyResponse(
    taskId: string,
    update: { state: TaskState; message?: Message; artifactText?: string; artifactName?: string },
  ): TaskRecord {
    const record = this.require(taskId);
    const task = Task.fromJSON(record.task);
    task.status = {
      state: update.state,
      message: update.message,
      timestamp: nowIso(),
    };
    if (update.message) task.history = [...task.history, update.message];
    if (update.artifactText !== undefined) {
      task.artifacts = [
        ...task.artifacts,
        {
          artifactId: `artifact-${task.artifacts.length + 1}`,
          name: update.artifactName ?? "response",
          description: "",
          parts: [
            {
              content: { $case: "text", value: update.artifactText },
              metadata: undefined,
              filename: "",
              mediaType: "text/plain",
            },
          ],
          metadata: undefined,
          extensions: [],
        },
      ];
    }
    return this.put(task, { direction: record.direction, peer: record.peer });
  }

  /** Every record, newest change first. Bounded, so a runaway directory cannot hang a tool. */
  records(filter: { direction?: Direction } = {}): TaskRecord[] {
    const out: TaskRecord[] = [];
    for (const id of this.ids()) {
      const record = this.readRecord(id);
      if (!record) continue;
      if (filter.direction && record.direction !== filter.direction) continue;
      out.push(record);
    }
    // A TOTAL order, not just "newest first". ISO timestamps have millisecond
    // resolution and several records can share one — a peer sending a batch, or
    // the daemon and this process writing at once — and an unstable sort there
    // makes a paged listing return the same row twice and skip another.
    return out.toSorted(
      (a, b) =>
        compareDesc(a.updatedAt, b.updatedAt) ||
        compareDesc(a.createdAt, b.createdAt) ||
        String(a.task.id).localeCompare(String(b.task.id)),
    );
  }

  /** `taskId -> mtimeMs`. The change token: one `stat` per task, no parsing. */
  snapshot(): StoreSnapshot {
    const snapshot: StoreSnapshot = new Map();
    for (const id of this.ids()) {
      try {
        snapshot.set(id, statSync(join(this.dir, `${id}.json`)).mtimeMs);
      } catch {
        /* vanished between readdir and stat — treat as absent */
      }
    }
    return snapshot;
  }

  /** What changed against a baseline snapshot, with the records attached. */
  changesSince(baseline: StoreSnapshot, filter: { direction?: Direction } = {}): StoreChange[] {
    return this.changesBetween(baseline, this.snapshot(), filter);
  }

  /**
   * The same, between two snapshots the caller already holds.
   *
   * This exists because a poller that advances its baseline needs the SAME
   * snapshot it compared against to become the next baseline. Taking a fresh one
   * afterwards loses any write that landed in between — a lost wakeup, whose
   * symptom is a task sitting unanswered while an agent waits out its full
   * timeout, and which is invisible in a test because the window is microseconds.
   */
  changesBetween(
    baseline: StoreSnapshot,
    current: StoreSnapshot,
    filter: { direction?: Direction } = {},
  ): StoreChange[] {
    const changes: StoreChange[] = [];
    for (const [taskId, mtime] of current) {
      const before = baseline.get(taskId);
      if (before !== undefined && before >= mtime) continue;
      const record = this.readRecord(taskId);
      if (!record) continue;
      if (filter.direction && record.direction !== filter.direction) continue;
      changes.push({ taskId, kind: before === undefined ? "created" : "updated", record });
    }
    return changes;
  }

  delete(taskId: string): boolean {
    try {
      unlinkSync(this.pathFor(taskId));
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ private ----

  private ids(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .filter(isSafeId)
        .slice(0, MAX_TASKS_SCANNED);
    } catch {
      return [];
    }
  }

  private readRecord(taskId: string): TaskRecord | undefined {
    if (!isSafeId(taskId)) return undefined;
    const parsed = readJsonFile(join(this.dir, `${taskId}.json`));
    if (parsed === undefined) return undefined;
    const record = asTaskRecord(parsed);
    if (!record) {
      this.logger?.warn?.(`ignoring unreadable task record ${taskId}.json`);
      return undefined;
    }
    return record;
  }

  private writeRecord(taskId: string, record: TaskRecord): void {
    const path = this.pathFor(taskId);
    ensureDir(this.dir);
    writeFileAtomic(path, JSON.stringify(record));
  }
}

const compareDesc = (a: string, b: string): number => (a === b ? 0 : a < b ? 1 : -1);

/**
 * A directory this large is a bug somewhere else, and reading all of it would
 * turn every tool call into a stall. Bounded rather than paginated because the
 * expected population is single digits.
 */
const MAX_TASKS_SCANNED = 5_000;

const readContextId = (record: TaskRecord): string | undefined => {
  const value = record.task.contextId;
  return typeof value === "string" ? value : undefined;
};

/** The state as the numeric enum, read from the record's wire form. */
export const readState = (record: TaskRecord): TaskState => {
  const status = record.task.status;
  if (!isRecord(status)) return TaskState.TASK_STATE_UNSPECIFIED;
  const state = status.state;
  // The wire form is the string ("TASK_STATE_SUBMITTED"); the SDK's enum is
  // numeric. `taskStateFromJSON` maps either, and yields UNRECOGNIZED — not a
  // throw — for a value from a newer peer than this build knows about.
  if (typeof state === "string" || typeof state === "number") return taskStateFromJSON(state);
  return TaskState.TASK_STATE_UNSPECIFIED;
};

/**
 * `historyLength` and `includeArtifacts`, applied for a peer's read. Both
 * default to the smaller answer: a task's history is unbounded in principle and
 * `ListTasks` is the call most likely to be made without thinking.
 */
const applyReadOptions = (task: Task, params: ListTasksRequest): Task => {
  const history =
    params.historyLength === undefined
      ? task.history
      : params.historyLength <= 0
        ? []
        : task.history.slice(-params.historyLength);
  return {
    ...task,
    history,
    artifacts: params.includeArtifacts ? task.artifacts : [],
  };
};
