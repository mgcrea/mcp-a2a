import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_DAEMON_URL, loadConfig, resolveStateDir } from "#/config";
import { ABSENT_CONFIG } from "#test/helpers";

const withFile = (contents: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-a2a-cfg-"));
  const path = join(dir, "config.json");
  // 0o600 so the "readable by other users" warning — a real feature — does not
  // scribble over the suite's output on every run.
  writeFileSync(path, JSON.stringify(contents), { mode: 0o600 });
  return path;
};

describe("loadConfig", () => {
  it("defaults to a loopback daemon and no writes", () => {
    const config = loadConfig({}, ABSENT_CONFIG);
    expect(config.daemonUrl).toBe(DEFAULT_DAEMON_URL);
    expect(config.allowWrites).toBe(false);
    expect(config.maxWaitSeconds).toBe(240);
    expect(config.peers).toEqual([]);
  });

  /**
   * Per field, not whole-source. Docker, launchd and CI inject the environment
   * and must keep working untouched, while a one-off `A2A_ALLOW_WRITES=0` still
   * has to beat a file that says true.
   */
  it("takes the environment over the file, field by field", () => {
    const path = withFile({
      daemonUrl: "http://127.0.0.1:5000",
      allowWrites: true,
      agentName: "from the file",
    });
    const config = loadConfig({ A2A_ALLOW_WRITES: "0" }, path);
    expect(config.allowWrites).toBe(false);
    // The other two fields still come from the file — the override is not
    // whole-source.
    expect(config.daemonUrl).toBe("http://127.0.0.1:5000");
    expect(config.agentName).toBe("from the file");
  });

  it("reads booleans the way Bastion writes them", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE"]) {
      expect(loadConfig({ A2A_ALLOW_WRITES: value }, ABSENT_CONFIG).allowWrites).toBe(true);
    }
    for (const value of ["0", "false", "no", "off"]) {
      expect(loadConfig({ A2A_ALLOW_WRITES: value }, ABSENT_CONFIG).allowWrites).toBe(false);
    }
    // "" is unset, not false — which is what makes an empty variable in a client
    // config mean "leave the default alone".
    expect(loadConfig({ A2A_ALLOW_WRITES: "" }, withFile({ allowWrites: true })).allowWrites).toBe(
      true,
    );
  });

  it("splits A2A_PEERS on commas or whitespace and drops the empties", () => {
    const config = loadConfig(
      { A2A_PEERS: " http://127.0.0.1:1 , http://127.0.0.1:2 ,, http://127.0.0.1:3 " },
      ABSENT_CONFIG,
    );
    expect(config.peers).toEqual([
      "http://127.0.0.1:1",
      "http://127.0.0.1:2",
      "http://127.0.0.1:3",
    ]);
  });

  /**
   * The v1 boundary, enforced in one place. A non-loopback daemon URL is refused
   * rather than quietly bound, because the failure it prevents — a listener that
   * accepts task proposals from the whole LAN — is invisible from the log line.
   */
  it("refuses a daemon URL that is not loopback", () => {
    expect(() => loadConfig({ A2A_DAEMON_URL: "http://0.0.0.0:41241" }, ABSENT_CONFIG)).toThrow(
      /loopback/,
    );
    expect(() =>
      loadConfig({ A2A_DAEMON_URL: "https://agents.example.com" }, ABSENT_CONFIG),
    ).toThrow(/loopback/);
    for (const url of ["http://127.0.0.1:41241", "http://localhost:8080", "http://[::1]:9000"]) {
      expect(loadConfig({ A2A_DAEMON_URL: url }, ABSENT_CONFIG).daemonUrl).toBe(url);
    }
  });

  /**
   * `.strict()` on purpose: silently ignoring an unknown key looks exactly like
   * "that setting had no effect", which is the worst way to learn your values
   * came from somewhere else.
   */
  it("rejects an unknown key in the config file rather than ignoring it", () => {
    expect(() => loadConfig({}, withFile({ deamonUrl: "http://127.0.0.1:1" }))).toThrow();
  });

  it("caps maxWaitSeconds at the client's own ceiling", () => {
    expect(loadConfig({ A2A_MAX_WAIT_SECONDS: "150" }, ABSENT_CONFIG).maxWaitSeconds).toBe(150);
    // 300 is Codex's hard cap, so a value at or past it is refused rather than
    // clamped: a call killed by the client looks exactly like a broken server.
    expect(() => loadConfig({ A2A_MAX_WAIT_SECONDS: "300" }, ABSENT_CONFIG)).toThrow();
  });
});

describe("resolveStateDir", () => {
  it("honours A2A_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state", () => {
    expect(resolveStateDir({ A2A_STATE_DIR: "/tmp/explicit" })).toBe("/tmp/explicit");
    expect(resolveStateDir({ XDG_STATE_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/mcp-a2a");
    expect(resolveStateDir({ HOME: "/tmp/home" })).toMatch(/\.local\/state\/mcp-a2a$/);
  });

  it("expands a leading tilde, so a config file can be written by hand", () => {
    expect(resolveStateDir({ A2A_STATE_DIR: "~/a2a" })).not.toContain("~");
  });
});
