#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { loadConfig, setupInstructions } from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray log
// line there corrupts the JSON-RPC stream — the client's next parse then fails,
// usually far from the cause.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.A2A_DEBUG) console.error("[a2a-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[a2a-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[a2a-mcp]", ...args),
};

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
  // The banner prints before anything can fail, and it is the only place the
  // resolved capability state is visible. `writes=ENABLED` scrolling past is the
  // last chance anyone has to notice before an agent commits this session to
  // another agent's request.
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const { server, channel } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderrLogger.warn(
    `a2a-mcp connected (daemon=${config.daemonUrl}, token=${config.token ? "set" : "NONE"}, ` +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
      `channel=${config.channel ? "declared" : "off"}, store=${config.stateDir})`,
  );
  for (const line of setupInstructions(config)) stderrLogger.warn(`  · ${line}`);

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    channel?.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[a2a-mcp] fatal: ${describeFatal(err)}`);
  process.exit(1);
});
