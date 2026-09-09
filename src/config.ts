import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/** The daemon's default address. Loopback only — see `DaemonUrlSchema`. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:41241";

/**
 * The longest a long-poll may block. 240s rather than 300s because Codex hard-
 * caps a tool call at exactly 300 seconds, and a call killed by the client is
 * indistinguishable from a broken server. Under Bastion the ceiling is lower
 * still — its `callTimeout` is 180s (`Supervisor.swift:384`) — and Bastion
 * injects no variable a child could recognise it by, so that case is a knob
 * (`A2A_MAX_WAIT_SECONDS=150` in the profile) rather than a sniff.
 */
export const DEFAULT_MAX_WAIT_SECONDS = 240;

/**
 * Loopback only, and enforced here rather than at the bind so a bad value fails
 * once, early, and in the same place for both processes. v1 is deliberately not
 * reachable by remote peers: a laptop behind NAT is not addressable anyway, and
 * exposing this listener needs a tunnel plus real per-peer auth. The goal that
 * remains — cross-vendor agents *on this machine* coordinating — needs none of
 * that. See the README's "Known boundaries".
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const DaemonUrlSchema = z
  .url()
  .default(DEFAULT_DAEMON_URL)
  .refine(
    (value) => {
      try {
        return LOOPBACK_HOSTS.has(new URL(value).hostname);
      } catch {
        return false;
      }
    },
    {
      message:
        "A2A_DAEMON_URL must be a loopback address (127.0.0.1, localhost or ::1). " +
        "v1 does not serve remote peers — see the README's Known boundaries.",
    },
  );

const ConfigSchema = z
  .object({
    /** Where the A2A peer daemon listens, and where the stdio tools reach it. */
    daemonUrl: DaemonUrlSchema,
    /** How this machine introduces itself in its agent card. */
    agentName: z.string().min(1).default(`${hostname()} agents`),
    agentDescription: z
      .string()
      .min(1)
      .default(
        "Local coding agents on this machine (Claude Code, Codex, Cursor, LM Studio). " +
          "Inbound tasks are queued as proposals for a human-supervised agent to pick up; " +
          "nothing is executed automatically.",
      ),
    /**
     * Shared bearer token for this machine's loopback A2A mesh: the daemon
     * requires it on every A2A request and the stdio tools send it. Optional,
     * because a server that refuses to start has no way to say why — when it is
     * unset the daemon runs unauthenticated and says so loudly.
     */
    token: z.string().min(1).optional(),
    /** Peer base URLs to offer to `a2a_list_agents` without a discovery call first. */
    peers: z.array(z.url()).default([]),
    /** Root of the shared task store. Both processes must resolve the SAME path. */
    stateDir: z.string().min(1),
    allowWrites: z.boolean().default(false),
    maxWaitSeconds: z.number().int().min(1).max(240).default(DEFAULT_MAX_WAIT_SECONDS),
    /**
     * Emit `notifications/claude/channel` for arriving inbound tasks. A true
     * push into an interactive Claude Code session, and a no-op everywhere
     * else — so long-poll (`a2a_wait_for_task`) has to work standalone and
     * this only ever removes the parking.
     */
    channel: z.boolean().default(true),
    /** How often the store is re-scanned while polling, in milliseconds. */
    pollIntervalMs: z.number().int().min(100).max(60_000).default(1_000),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
  })
  .strict()
  .superRefine((_cfg, _ctx) => {
    // Deliberately NOT an error when the token is unset or the daemon is down.
    // An MCP server that exits on startup shows up in the client as a bare
    // "MCP error -32000: Connection closed", with stderr swallowed — so the one
    // message that would have explained the problem never reaches anyone.
    // Everything configurable is reported by `a2a_auth_status` as data instead.
  });

export type Config = z.output<typeof ConfigSchema>;

/**
 * The config file's own schema, `.strict()` on purpose — a typo'd key must be an
 * error. Silently ignoring an unknown key looks exactly like "that setting had
 * no effect", which is the worst possible way to learn that your values came
 * from somewhere else.
 */
const ConfigFileSchema = z
  .object({
    daemonUrl: z.string().optional(),
    agentName: z.string().optional(),
    agentDescription: z.string().optional(),
    token: z.string().optional(),
    peers: z.array(z.string()).optional(),
    stateDir: z.string().optional(),
    allowWrites: z.boolean().optional(),
    maxWaitSeconds: z.number().optional(),
    channel: z.boolean().optional(),
    pollIntervalMs: z.number().optional(),
    maxRetries: z.number().optional(),
  })
  .strict();

type ConfigFile = z.output<typeof ConfigFileSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/** Comma- or whitespace-separated list, empty entries dropped. */
const parseList = (value: string | undefined): string[] | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return t
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.A2A_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "mcp-a2a", "config.json");
};

/**
 * The task store, which is machine state shared by two processes rather than
 * one process's private directory. `XDG_STATE_HOME` is the right home for it:
 * it survives a reboot, it is not a cache, and it is not configuration.
 *
 * ⚠ Both halves must resolve the same path or they hold two disjoint stores and
 * no task ever crosses. That is why `A2A_STATE_DIR` is deliberately NOT
 * declared as `stateEnv` in the Bastion catalog — Bastion redirects `stateEnv`
 * into each profile's own directory, which is right for a token file and wrong
 * for this.
 */
export const resolveStateDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.A2A_STATE_DIR);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_STATE_HOME) ?? join(homedir(), ".local", "state");
  return join(expandTilde(base), "mcp-a2a");
};

/** Warn on a credentials file other users can read. Mode bits mean nothing on Windows. */
const warnIfGroupReadable = (path: string): void => {
  if (process.platform === "win32") return;
  try {
    if (statSync(path).mode & 0o077) {
      process.stderr.write(`[a2a] ${path} is readable by other users. Run: chmod 600 ${path}\n`);
    }
  } catch {
    /* a missing file is fine */
  }
};

const readConfigFile = (path: string): ConfigFile => {
  if (!existsSync(path)) return {};
  warnIfGroupReadable(path);
  return ConfigFileSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 * Docker, launchd and CI inject the environment and must keep working
 * untouched, while a one-off `A2A_ALLOW_WRITES=0` still has to beat a file that
 * says `true`. Merging field by field is the only rule that gives both.
 *
 * `loadConfig(env, path)` takes both as parameters so precedence is testable
 * without touching `process.env` — and so the suite can be pointed at a path
 * that cannot exist, rather than at the developer's own credentials.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  return ConfigSchema.parse({
    daemonUrl: trimmed(env.A2A_DAEMON_URL) ?? file.daemonUrl,
    agentName: trimmed(env.A2A_AGENT_NAME) ?? file.agentName,
    agentDescription: trimmed(env.A2A_AGENT_DESCRIPTION) ?? file.agentDescription,
    token: trimmed(env.A2A_TOKEN) ?? file.token,
    peers: parseList(env.A2A_PEERS) ?? file.peers,
    stateDir: trimmed(env.A2A_STATE_DIR) ?? file.stateDir ?? resolveStateDir(env),
    allowWrites: parseBool(env.A2A_ALLOW_WRITES) ?? file.allowWrites,
    maxWaitSeconds: parseIntOpt(env.A2A_MAX_WAIT_SECONDS) ?? file.maxWaitSeconds,
    channel: parseBool(env.A2A_CHANNEL) ?? file.channel,
    pollIntervalMs: parseIntOpt(env.A2A_POLL_INTERVAL_MS) ?? file.pollIntervalMs,
    maxRetries: parseIntOpt(env.A2A_MAX_RETRIES) ?? file.maxRetries,
  });
};

/**
 * The setup guide, as data. Returned by `a2a_auth_status` and printed to stderr
 * at startup, because the alternative — exiting with a message the client
 * swallows — is the most expensive mistake available in an MCP server.
 */
export const setupInstructions = (
  config: Config,
  /**
   * What the caller has already established. `a2a_auth_status` probes the daemon
   * before calling this, and a list that tells you to start something already
   * running makes every other step in it less believable.
   */
  known: { daemonReachable?: boolean } = {},
): string[] => {
  const steps: string[] = [];
  if (!config.token) {
    steps.push(
      "A2A_TOKEN is not set, so the daemon accepts A2A requests from any process on this " +
        "machine. Generate one (`openssl rand -hex 32`) and set it identically for the daemon " +
        "and every client.",
    );
  }
  if (known.daemonReachable !== true) {
    // Phrased so it is true when the caller has NOT probed — the startup banner
    // cannot, and would otherwise tell you to start something already running.
    steps.push(
      `The daemon must be running and reachable at ${config.daemonUrl} for inbound tasks to ` +
        `arrive at all. Start it with \`a2a-serve\`, or load the LaunchAgent — see the README.`,
    );
  }
  if (config.peers.length === 0) {
    steps.push(
      "No peers configured. Set A2A_PEERS to a comma-separated list of peer base URLs, or " +
        "call a2a_discover_agent with a URL to fetch and cache one peer's card.",
    );
  }
  if (!config.allowWrites) {
    steps.push(
      "Writes are disabled, so a2a_send_message and a2a_respond_to_task are not registered. " +
        "Set A2A_ALLOW_WRITES=1 to delegate work and to answer inbound tasks.",
    );
  }
  return steps;
};
