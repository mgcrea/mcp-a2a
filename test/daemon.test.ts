import { describe, expect, it } from "vitest";

import { TaskState } from "#/a2a";
import { A2A_RPC_PATH } from "#/card";
import { loadConfig, type Config } from "#/config";
import { createDaemonApp, MAX_BODY_BYTES } from "#/daemon";
import { FileTaskStore, readState } from "#/store/tasks";
import { ABSENT_CONFIG, tempStateDir } from "#test/helpers";

const BASE = "http://127.0.0.1:41999";
/**
 * `new Request(url)` sets no `Host` header — a real client's is added by the
 * transport — and the loopback validation middleware rejects a request without
 * one, which is correct for HTTP/1.1 and would otherwise make every test here a
 * 403. So the harness sends it, and the spoofing test overrides it.
 */
const HOST = { host: "127.0.0.1:41999" };

const daemon = (env: Record<string, string> = {}) => {
  const config: Config = loadConfig(
    { A2A_STATE_DIR: tempStateDir(), A2A_DAEMON_URL: BASE, ...env },
    ABSENT_CONFIG,
  );
  const store = new FileTaskStore({ stateDir: config.stateDir, defaultDirection: "inbound" });
  const app = createDaemonApp({ config, store });
  const rpc = async (
    body: unknown,
    init: { token?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> =>
    await app.fetch(
      new Request(`${BASE}${A2A_RPC_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...HOST,
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...init.headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  return { config, store, app, rpc };
};

const sendMessage = (text: string, messageId = "m-1") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "SendMessage",
  params: { message: { messageId, role: "ROLE_USER", parts: [{ text }] } },
});

describe("the agent card", () => {
  /**
   * Served WITHOUT the bearer check, deliberately: it holds no secret, and
   * discovery has to work before a peer has been given a credential or the card
   * cannot do the one job it exists for.
   */
  it("is public, and declares every field v1.0 requires", async () => {
    const { app } = daemon({ A2A_TOKEN: "secret" });
    const res = await app.fetch(
      new Request(`${BASE}/.well-known/agent-card.json`, { headers: HOST }),
    );
    expect(res.status).toBe(200);
    const card = (await res.json()) as Record<string, unknown>;
    for (const field of [
      "name",
      "description",
      "supportedInterfaces",
      "version",
      "capabilities",
      "defaultInputModes",
      "defaultOutputModes",
      "skills",
    ]) {
      expect(card[field], field).toBeDefined();
    }
    expect(card.supportedInterfaces).toEqual([
      {
        url: `${BASE}${A2A_RPC_PATH}`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
    ]);
    // Both are false in v1, and saying so in the card is the point of having one.
    expect(card.capabilities).toMatchObject({ streaming: false, pushNotifications: false });
  });
});

describe("the bearer token", () => {
  it("rejects a missing or wrong token with 401, not 500", async () => {
    const { rpc } = daemon({ A2A_TOKEN: "secret" });
    for (const token of [undefined, "", "wrong", "secre"]) {
      const res = await rpc(sendMessage("x"), token === undefined ? {} : { token });
      expect(res.status, String(token)).toBe(401);
      const body = (await res.json()) as { error: { code: number } };
      // A JSON-RPC error envelope, so a client parses the rejection rather than
      // seeing HTML or an empty body.
      expect(body.error.code).toBe(-32001);
    }
  });

  it("accepts the right token", async () => {
    const { rpc } = daemon({ A2A_TOKEN: "secret" });
    expect((await rpc(sendMessage("x"), { token: "secret" })).status).toBe(200);
  });

  /**
   * Unset means unauthenticated, on purpose: a daemon that refuses to start has
   * no way to say why. The loud stderr warning and `a2a_auth_status` are what
   * carry the risk instead.
   */
  it("runs unauthenticated when no token is configured", async () => {
    const { rpc } = daemon();
    expect((await rpc(sendMessage("x"))).status).toBe(200);
  });
});

describe("an inbound task", () => {
  it("is parked in SUBMITTED and acknowledged immediately", async () => {
    const { rpc, store } = daemon();
    const res = await rpc(sendMessage("Run the tests in ~/Projects/example."));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { task: { id: string; status: { state: string } } };
    };
    expect(body.result.task.status.state).toBe("TASK_STATE_SUBMITTED");

    const record = store.get(body.result.task.id);
    expect(record?.direction).toBe("inbound");
    expect(readState(record!)).toBe(TaskState.TASK_STATE_SUBMITTED);
    // Nothing ran. That is the whole design: an inbound task is a proposal.
    expect(record?.task.artifacts).toBeUndefined();
  });

  it("is attributed to whoever sent it, from X-A2A-From then User-Agent", async () => {
    const { rpc, store } = daemon();
    await rpc(sendMessage("a", "m-a"), { headers: { "x-a2a-from": "codex-cli/1.2" } });
    await rpc(sendMessage("b", "m-b"), { headers: { "user-agent": "lm-studio/0.3" } });
    const peers = store
      .records()
      .map((r) => r.peer)
      .toSorted();
    expect(peers).toEqual(["codex-cli/1.2", "lm-studio/0.3"]);
  });

  it("shows a locally written answer to the peer's next GetTask", async () => {
    const { rpc, store } = daemon();
    const created = (await (await rpc(sendMessage("do a thing"))).json()) as {
      result: { task: { id: string } };
    };
    const id = created.result.task.id;

    // What `a2a_respond_to_task` does, in the OTHER process. The two share only
    // this directory, which is the whole architecture in one assertion.
    store.applyResponse(id, {
      state: TaskState.TASK_STATE_COMPLETED,
      artifactText: "two tests fail",
      artifactName: "response",
    });

    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id } });
    const body = (await res.json()) as {
      result: { status: { state: string }; artifacts: { parts: { text: string }[] }[] };
    };
    expect(body.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(body.result.artifacts[0]?.parts[0]?.text).toBe("two tests fail");
  });
});

describe("hardening", () => {
  it("rejects an oversized body before anything parses it", async () => {
    const { app } = daemon();
    const res = await app.fetch(
      new Request(`${BASE}${A2A_RPC_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...HOST,
          "content-length": String(MAX_BODY_BYTES + 1),
        },
        body: JSON.stringify(sendMessage("x")),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("rejects a spoofed Host and a foreign Origin", async () => {
    const { app } = daemon();
    const spoofedHost = await app.fetch(
      new Request(`${BASE}${A2A_RPC_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "evil.example.com" },
        body: JSON.stringify(sendMessage("x")),
      }),
    );
    expect(spoofedHost.status).toBe(403);

    const foreignOrigin = await app.fetch(
      new Request(`${BASE}${A2A_RPC_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...HOST,
          origin: "https://evil.example.com",
        },
        body: JSON.stringify(sendMessage("x")),
      }),
    );
    expect(foreignOrigin.status).toBe(403);
  });

  it("answers a non-JSON body with a JSON-RPC parse error", async () => {
    const { rpc } = daemon();
    const res = await rpc("{not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  /** Streaming is not advertised, so asking for it must be a clean refusal. */
  it("refuses the streaming methods rather than hanging", async () => {
    const { rpc } = daemon();
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "SendStreamingMessage",
      params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "x" }] } },
    });
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error).toBeDefined();
    expect(body.error?.message).toMatch(/streaming/i);
  });
});

describe("/health", () => {
  it("answers without a token and reports what is configured", async () => {
    const { app, store } = daemon({ A2A_TOKEN: "secret" });
    store.put(
      {
        id: "t1",
        contextId: "c",
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: "x" },
        artifacts: [],
        history: [],
        metadata: undefined,
      },
      { direction: "inbound", peer: "p" },
    );
    const body = (await (
      await app.fetch(new Request(`${BASE}/health`, { headers: HOST }))
    ).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.authenticated).toBe(true);
    expect(body.tasks).toBe(1);
  });
});
