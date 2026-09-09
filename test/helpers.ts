import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

/**
 * A config path that cannot exist, passed on every `loadConfig` call in the
 * suite. Without it a developer's own `~/.config/mcp-a2a/config.json` leaks into
 * the run: it passes on the machine that has one and fails in CI, or — worse —
 * the reverse.
 */
export const ABSENT_CONFIG = "/nonexistent/mcp-a2a/config.json";

/**
 * A fresh state directory per harness, for the same reason. The store is a real
 * directory on disk, and a suite that wrote into `~/.local/state/mcp-a2a` would
 * both pollute the developer's own tasks and read them back as fixtures.
 */
export const tempStateDir = (): string => mkdtempSync(join(tmpdir(), "mcp-a2a-test-"));

export const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

/** The card a mocked peer serves, minimal but structurally valid for v1.0. */
export const peerCard = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Test Peer",
  description: "A peer that exists only in this test.",
  version: "1.0.0",
  supportedInterfaces: [
    { url: "http://127.0.0.1:41999/a2a/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "test-skill",
      name: "Test skill",
      description: "Does nothing, in a test.",
      tags: ["test"],
      examples: [],
    },
  ],
  ...overrides,
});

export type Harness = Awaited<ReturnType<typeof connect>>;

/**
 * An in-memory end-to-end run through the real SDK client/server pair, so the
 * tool schemas, the SDK's own validation and the handlers are all exercised.
 */
export const connect = async (
  env: Record<string, string> = {},
  fetchImpl?: ReturnType<typeof vi.fn>,
  opts: { stateDir?: string; watchChannel?: boolean } = {},
) => {
  const stateDir = opts.stateDir ?? tempStateDir();
  const config: Config = loadConfig({ A2A_STATE_DIR: stateDir, ...env }, ABSENT_CONFIG);
  const fetchMock = fetchImpl ?? vi.fn(async () => jsonResponse(peerCard()));
  const created = createServer({
    config,
    fetch: fetchMock as unknown as typeof fetch,
    // A background timer that outlives a test is a flake generator, so the
    // channel watcher is off unless a test asks for it.
    watchChannel: opts.watchChannel ?? false,
  });

  // Both halves of a linked pair must come from the SAME package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    config,
    stateDir,
    store: created.store,
    peers: created.peers,
    /**
     * Primitives, never the mock itself. A vitest mock's type reaches into
     * @vitest/spy internals, and once `connect()` is shared rather than inlined
     * its inferred return type has to be nameable — `tsc --noEmit` otherwise
     * fails with TS2883 ("cannot be named without a reference to 'Procedure'").
     */
    callCount: (): number => fetchMock.mock.calls.length,
    urls: (): string[] => fetchMock.mock.calls.map((c) => String(c[0])),
    bodyAt: (index: number): unknown => {
      const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
      return typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    },
    headersAt: (index: number): Record<string, string> => {
      const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
      return Object.fromEntries(new Headers(init.headers));
    },
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and never
      // reaches the tool body — which is the behaviour we want, so the harness
      // reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
    close: async (): Promise<void> => {
      created.channel?.stop();
      await client.close();
      await created.server.close();
      if (opts.stateDir === undefined) rmSync(stateDir, { recursive: true, force: true });
    },
  };
};
