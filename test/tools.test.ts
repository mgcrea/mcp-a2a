import { describe, expect, it, vi } from "vitest";

import { connect, type Harness } from "#test/helpers";

/** The RPC names the escape hatch offers, which narrow with the write gate. */
const requestMethods = async (harness: Harness): Promise<string[]> => {
  const tool = await harness.tool("a2a_request");
  const props = (tool?.inputSchema.properties ?? {}) as Record<
    string,
    { enum?: string[] } | undefined
  >;
  return (props.method?.enum ?? []).toSorted();
};

const withWrites = async (): Promise<Harness> => await connect({ A2A_ALLOW_WRITES: "1" });

/** Every tool this server can register, in the order `toolNames()` returns them. */
const READ_TOOLS = [
  "a2a_auth_status",
  "a2a_discover_agent",
  "a2a_get_task",
  "a2a_list_agents",
  "a2a_list_tasks",
  "a2a_request",
  "a2a_wait_for_task",
];

const WRITE_TOOLS = [
  "a2a_cancel_task",
  "a2a_delete_push_notification_config",
  "a2a_respond_to_task",
  "a2a_send_message",
  "a2a_set_push_notification_config",
];

describe("tool registration matrix", () => {
  /**
   * `toEqual` on the exact set, not `toContain`, so adding a tool is always a
   * deliberate act with a visible diff.
   */
  it("registers exactly the read tools with nothing configured", async () => {
    const harness = await connect({});
    try {
      expect(await harness.toolNames()).toEqual(READ_TOOLS);
    } finally {
      await harness.close();
    }
  });

  it("registers no write tools until A2A_ALLOW_WRITES is on", async () => {
    const harness = await connect({ A2A_TOKEN: "t", A2A_PEERS: "http://127.0.0.1:41999" });
    try {
      const names = await harness.toolNames();
      // The negative half is the test for rule 1: a write tool registered outside
      // its `if (allowWrites)` block is otherwise invisible.
      for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
      expect(names).toEqual(READ_TOOLS);
    } finally {
      await harness.close();
    }
  });

  it("adds — and only adds — the write tools when the flag is on", async () => {
    const harness = await connect({ A2A_ALLOW_WRITES: "1" });
    try {
      expect(await harness.toolNames()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].toSorted());
    } finally {
      await harness.close();
    }
  });

  it("treats an empty A2A_ALLOW_WRITES as unset rather than as false-y truth", async () => {
    const harness = await connect({ A2A_ALLOW_WRITES: "" });
    try {
      expect(await harness.toolNames()).toEqual(READ_TOOLS);
    } finally {
      await harness.close();
    }
  });

  it("does not offer the write RPCs through the escape hatch when writes are off", async () => {
    const off = await connect({});
    const on = await connect({ A2A_ALLOW_WRITES: "1" });
    try {
      expect(await requestMethods(off)).not.toContain("SendMessage");
      expect(await requestMethods(on)).toContain("SendMessage");
    } finally {
      await off.close();
      await on.close();
    }
  });
});

describe("with nothing configured at all", () => {
  /**
   * The regression that produces "MCP error -32000: Connection closed": a server
   * that exits on startup takes its credential-free tools with it and leaves no
   * way to discover what to configure.
   *
   * This server has a second reason to stay up. Its read tools need no
   * credentials — the store is a local directory and discovery is an
   * unauthenticated GET — so an unconfigured server is not merely honest about
   * being unconfigured, it is genuinely useful.
   */
  it("still connects, and answers a2a_auth_status as a setup guide", async () => {
    const harness = await connect({});
    try {
      const res = await harness.call("a2a_auth_status");
      expect(res.isToolError).not.toBe(true);
      expect(res.token).toContain("not set");
      expect(res.writes).toBe("disabled");
      expect((res.setup as string[]).join(" ")).toContain("A2A_TOKEN");
    } finally {
      await harness.close();
    }
  });

  it("reports an unreachable daemon as data, never as a thrown error", async () => {
    // The whole point of this tool: "the daemon is not running" is the most
    // common state it will ever be called in, and an exception would leave the
    // caller with no setup steps and no idea which of three things is wrong.
    const refuse = vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:41241"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    const harness = await connect({}, refuse);
    try {
      const res = await harness.call("a2a_auth_status");
      expect(res.isToolError).not.toBe(true);
      const daemon = res.daemon as Record<string, unknown>;
      expect(daemon.reachable).toBe(false);
      expect(String(daemon.error)).toContain("ECONNREFUSED");
      expect((res.setup as string[]).join(" ")).toContain("a2a-serve");
    } finally {
      await harness.close();
    }
  });

  it("lists tasks and agents without a daemon or a network", async () => {
    const harness = await connect({});
    try {
      expect((await harness.call("a2a_list_tasks")).tasks).toEqual([]);
      const agents = (await harness.call("a2a_list_agents")).agents as Record<string, unknown>[];
      // Our own daemon is always listed, discovered or not — that it is unknown is
      // the useful half of the answer.
      expect(agents).toHaveLength(1);
      expect(agents[0]?.self).toBe(true);
      expect(harness.callCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

/**
 * The contract every tool owes the model, enforced mechanically. All three are
 * invisible in review and at runtime, and simply make the model guess.
 */
describe("tool contract", () => {
  it("gives every tool a service-prefixed title", async () => {
    // `title` is what a host renders in its permission dialog, so a bare "Cancel
    // Task" re-creates the cross-server collision the name prefix prevents.
    const harness = await withWrites();
    try {
      const tools = (await harness.client.listTools()).tools;
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.title, tool.name).toBeDefined();
        expect(tool.title, tool.name).toMatch(/^A2A: /);
      }
    } finally {
      await harness.close();
    }
  });

  it("describes every input field, since that is all a model reads before choosing", async () => {
    const harness = await withWrites();
    try {
      for (const tool of (await harness.client.listTools()).tools) {
        const props = (tool.inputSchema.properties ?? {}) as Record<
          string,
          { description?: string }
        >;
        for (const [field, schema] of Object.entries(props)) {
          expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
        }
      }
    } finally {
      await harness.close();
    }
  });

  it("annotates every tool, and marks the destructive ones", async () => {
    const harness = await withWrites();
    try {
      const tools = (await harness.client.listTools()).tools;
      for (const tool of tools) expect(tool.annotations, tool.name).toBeDefined();
      const destructive = tools
        .filter((tool) => tool.annotations?.destructiveHint === true)
        .map((tool) => tool.name)
        .toSorted();
      // `a2a_request` is destructive only because writes are on here — its
      // annotation follows the gate, which is the documented idiom for an escape
      // hatch.
      expect(destructive).toEqual([
        "a2a_cancel_task",
        "a2a_delete_push_notification_config",
        "a2a_request",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("requires confirm on the irreversible tools", async () => {
    const harness = await withWrites();
    try {
      for (const name of ["a2a_cancel_task", "a2a_delete_push_notification_config"]) {
        const tool = await harness.tool(name);
        expect((tool?.inputSchema.required as string[]) ?? [], name).toContain("confirm");
      }
      // And the SDK enforces it at the protocol layer, before the handler runs.
      const rejected = await harness.call("a2a_cancel_task", { task_id: "whatever" });
      expect(rejected.isToolError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
