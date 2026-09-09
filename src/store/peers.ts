import { createHash } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { AgentCard } from "#/a2a";
import type { Logger } from "#/client/auth";
import { ensureDir, nowIso, peersDir, readJsonFile, writeFileAtomic } from "#/store/paths";

export type PeerRecord = {
  version: 1;
  /** Base URL the card was fetched from — the key a client is created against. */
  url: string;
  fetchedAt: string;
  /** The `AgentCard`, in its wire (JSON) form. */
  card: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A URL is not a filename, so the cache is keyed by a hash of it with a readable
 * prefix kept for the benefit of anyone reading the directory. Encoding the URL
 * instead would produce names that differ only past the filesystem's length
 * limit, which is a collision you find late.
 */
const slugFor = (url: string): string => {
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 12);
  const readable = url
    .replace(/^https?:\/\//, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${readable || "peer"}-${digest}`;
};

/**
 * The discovered-peer cache: one file per peer base URL, holding the last agent
 * card we read from it.
 *
 * It is a cache and nothing more. A card can go stale — a peer restarts with new
 * skills — so `a2a_discover_agent` always refetches, and this only spares
 * `a2a_list_agents` from making one HTTP call per peer just to name them.
 */
export class PeerCache {
  private readonly dir: string;
  private readonly logger: Logger | undefined;

  constructor(opts: { stateDir: string; logger?: Logger }) {
    this.dir = peersDir(opts.stateDir);
    this.logger = opts.logger;
    // Created on the first write, not here — see `FileTaskStore`.
  }

  put(url: string, card: AgentCard): PeerRecord {
    const record: PeerRecord = {
      version: 1,
      url,
      fetchedAt: nowIso(),
      card: cardToJson(card),
    };
    ensureDir(this.dir);
    writeFileAtomic(join(this.dir, `${slugFor(url)}.json`), JSON.stringify(record));
    return record;
  }

  get(url: string): PeerRecord | undefined {
    return this.read(`${slugFor(url)}.json`);
  }

  all(): PeerRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => this.read(name))
      .filter((record): record is PeerRecord => record !== undefined)
      .toSorted((a, b) => a.url.localeCompare(b.url));
  }

  forget(url: string): boolean {
    try {
      unlinkSync(join(this.dir, `${slugFor(url)}.json`));
      return true;
    } catch {
      return false;
    }
  }

  private read(name: string): PeerRecord | undefined {
    const parsed = readJsonFile(join(this.dir, name));
    if (!isRecord(parsed) || parsed.version !== 1) return undefined;
    const { url, fetchedAt, card } = parsed;
    if (typeof url !== "string" || !isRecord(card)) {
      this.logger?.debug?.(`ignoring unreadable peer record ${name}`);
      return undefined;
    }
    return {
      version: 1,
      url,
      fetchedAt: typeof fetchedAt === "string" ? fetchedAt : nowIso(),
      card,
    };
  }
}

/**
 * The card as JSON. `AgentCard` is a protobuf-generated interface, so it is
 * already plain data — but going through a cast in one named place is what stops
 * a `Buffer` or an enum leaking into a file that is meant to hold wire JSON.
 */
const cardToJson = (card: AgentCard): Record<string, unknown> =>
  JSON.parse(JSON.stringify(card)) as Record<string, unknown>;
