#!/usr/bin/env node
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { serve } from "@hono/node-server";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { A2A_RPC_PATH } from "#/card";
import { loadConfig } from "#/config";
import { createDaemonApp } from "#/daemon";
import { FileTaskStore } from "#/store/tasks";

/**
 * The A2A peer daemon: process concerns only, the way `cli.ts` is for the stdio
 * server. Everything with behaviour worth testing is in `#/daemon`, which starts
 * no listener and reads no environment.
 *
 * It is a second process rather than part of the stdio server because an inbound
 * listener has to outlive any one client. A Bastion-supervised child cannot: it
 * is stopped after 30 idle minutes and dies with the app. Neither can a
 * client-spawned stdio server, which comes and goes with the editor window.
 */
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.A2A_DEBUG) console.error("[a2a-serve]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[a2a-serve]", ...args),
  error: (...args: unknown[]) => console.error("[a2a-serve]", ...args),
};

/** Nothing served here is slow, so a request that takes this long is not a real one. */
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

/** Show a config mistake as its field messages, not 40 frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const url = new URL(config.daemonUrl);
  const port = Number(url.port || 80);

  /**
   * The bind host comes from the configured URL, and `loadConfig` has already
   * refused anything but loopback. Passing it explicitly is the load-bearing
   * part: `listen(port)` with no host binds 0.0.0.0 — every interface — no matter
   * what the log line says, which is how two sibling servers in this directory
   * once put a logged-in session on the LAN.
   */
  const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;

  const store = new FileTaskStore({
    stateDir: config.stateDir,
    defaultDirection: "inbound",
    defaultPeer: "unknown",
    logger: stderrLogger,
  });

  const app = createDaemonApp({ config, store, logger: stderrLogger });

  const server = serve({ fetch: app.fetch, hostname, port }, () => {
    stderrLogger.warn(
      `a2a-serve listening on http://${hostname}:${port} ` +
        `(auth=${config.token ? "bearer" : "NONE"}, store=${config.stateDir})`,
    );
    stderrLogger.warn(`  agent card:   http://${hostname}:${port}/${AGENT_CARD_PATH}`);
    stderrLogger.warn(`  A2A JSON-RPC: http://${hostname}:${port}${A2A_RPC_PATH}`);
    if (!config.token) {
      stderrLogger.warn(
        `  ⚠ A2A_TOKEN is unset: any process on this machine can queue a task proposal. ` +
          `Nothing runs without an agent answering one deliberately, but set a token.`,
      );
    }
  });

  // The other half of the body cap: without these, one slow POST holds a socket
  // and its buffer for as long as it likes. `serve()` is typed as a union that
  // includes an http2 server, which has neither property — narrowing rather than
  // casting means this quietly does nothing if the adapter ever changes, instead
  // of throwing at startup.
  if ("requestTimeout" in server) server.requestTimeout = REQUEST_TIMEOUT_MS;
  if ("headersTimeout" in server) server.headersTimeout = HEADERS_TIMEOUT_MS;

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[a2a-serve] fatal: ${describeFatal(err)}`);
  process.exit(1);
});
