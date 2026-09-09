import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { InvalidTaskIdError, StoreUnwritableError } from "#/client/errors";

export const tasksDir = (stateDir: string): string => join(stateDir, "tasks");
export const peersDir = (stateDir: string): string => join(stateDir, "peers");

/**
 * Ids arrive from a peer over the network and are used as filenames, so they are
 * validated before they touch the filesystem. Without this, a task id of
 * `../../../../.ssh/authorized_keys` is a write primitive.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const assertSafeId = (id: string): string => {
  if (!SAFE_ID.test(id) || id === "." || id === "..") throw new InvalidTaskIdError(id);
  return id;
};

/** True for an id we would accept, without throwing — for filtering a listing. */
export const isSafeId = (id: string): boolean => SAFE_ID.test(id) && id !== "." && id !== "..";

/**
 * Replace a file in one step. Two processes share this directory, so a reader
 * must never see a half-written record: `rename` within a directory is atomic,
 * a truncate-then-write is not.
 *
 * Mode 0o600 because a task body carries whatever one agent asked another to do,
 * which on this machine is as sensitive as the code it is about.
 */
export const writeFileAtomic = (path: string, body: string): void => {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    throw new StoreUnwritableError(dirname(path), err);
  }
};

/**
 * Create a directory, but only when something is about to be written into it.
 *
 * Never call this from a constructor. An unwritable state directory used to take
 * the whole server down at startup, and a server that exits shows in the client
 * as a bare "Connection closed" with stderr swallowed — so the one message that
 * would have explained it never reaches anyone.
 */
export const ensureDir = (path: string): void => {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new StoreUnwritableError(path, err);
  }
};

/** Can this directory be written, without writing anything? For diagnostics. */
export const probeDir = (path: string): { writable: boolean; error?: string } => {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    accessSync(path, constants.W_OK);
    return { writable: true };
  } catch (err) {
    return { writable: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/** Read and parse, or undefined when the file is missing or unreadable JSON. */
export const readJsonFile = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

export const nowIso = (): string => new Date().toISOString();
