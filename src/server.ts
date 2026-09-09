import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { declareChannelCapability, startChannelWatcher, type ChannelWatcher } from "#/channel";
import type { Logger } from "#/client/auth";
import { PeerClient } from "#/client/peer";
import type { Config } from "#/config";
import { FileTaskStore } from "#/store/tasks";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-a2a-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  /** The one seam the suite replaces: real tools, real SDK, no network. */
  fetch?: typeof fetch;
  logger?: Logger;
  /**
   * Skip the background channel watcher. On by default in production and off in
   * tests, where a timer that outlives the test is a flake generator.
   */
  watchChannel?: boolean;
};

export type CreatedServer = {
  server: McpServer;
  store: FileTaskStore;
  peers: PeerClient;
  /** undefined when the channel is disabled or `watchChannel` is false. */
  channel: ChannelWatcher | undefined;
};

/**
 * A pure factory: it reads no environment, opens no socket, and starts nothing
 * but the channel watcher the caller asks for. Everything below `config.ts`
 * receives its dependencies, which is what lets the test harness drive real
 * tools through the real SDK against a mocked `fetch`.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Before `connect`: `registerCapabilities` refuses to run once a transport is
  // attached, because capabilities are part of the `initialize` result.
  if (config.channel) declareChannelCapability(server);

  const store = new FileTaskStore({
    stateDir: config.stateDir,
    // The stdio server creates outbound tasks; anything it finds that it did not
    // create came from the daemon and is inbound.
    defaultDirection: "inbound",
    defaultPeer: "unknown",
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const peers = new PeerClient({
    stateDir: config.stateDir,
    configuredPeers: config.peers,
    daemonUrl: config.daemonUrl,
    token: config.token,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  registerTools(server, {
    config,
    store,
    peers,
    allowWrites: config.allowWrites,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const channel =
    config.channel && opts.watchChannel !== false
      ? startChannelWatcher({
          server,
          store,
          config,
          ...(opts.logger ? { logger: opts.logger } : {}),
        })
      : undefined;

  return { server, store, peers, channel };
};
