import { timingSafeEqual } from "node:crypto";

import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/hono";
import { Hono } from "hono";

import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
} from "#/a2a";
import { BUILD_INFO } from "#/build-info";
import { A2A_RPC_PATH, buildAgentCard } from "#/card";
import type { Logger } from "#/client/auth";
import type { Config } from "#/config";
import { ProposalExecutor } from "#/executor";
import type { FileTaskStore } from "#/store/tasks";

/** Cap the body: an unbounded reader plus an open port is a one-request OOM. */
export const MAX_BODY_BYTES = 1 * 1024 * 1024;

const jsonRpcError = (code: number, message: string, status: number): Response =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });

/**
 * Constant-time comparison, so a wrong token cannot be recovered byte by byte
 * from response timing. Lengths are compared first because `timingSafeEqual`
 * throws on a mismatch — which is itself a length oracle, and an unavoidable one.
 */
const tokensMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const createDaemonApp = (opts: {
  config: Config;
  store: FileTaskStore;
  logger?: Logger;
}): Hono => {
  const { config, store } = opts;
  const logger = opts.logger;
  const card = buildAgentCard(config);

  const requestHandler = new DefaultRequestHandler(
    card,
    store,
    new ProposalExecutor({ store, ...(logger ? { logger } : {}) }),
  );
  const rpc = new JsonRpcTransportHandler(requestHandler);

  const app = new Hono();

  /** Reject an oversized body before anything reads, buffers or parses it. */
  app.use(async (c, next) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      return Response.json({ error: "payload_too_large", limit: MAX_BODY_BYTES }, { status: 413 });
    }
    return await next();
  });

  // DNS-rebinding and cross-site defence for a loopback bind. Their rejection is
  // already a JSON-RPC error envelope, which is the right shape for this server
  // too: the A2A binding served here is JSON-RPC.
  app.use(localhostHostValidation());
  app.use(localhostOriginValidation());

  /**
   * The agent card is served WITHOUT the bearer check, deliberately. It holds no
   * secret — a name, a description, one URL and a skill list — and discovery has
   * to work before a peer has been given a credential, or the card cannot do the
   * one job it exists for. The A2A spec treats the well-known card as public and
   * puts the credential requirement in `securitySchemes`.
   */
  app.get(`/${AGENT_CARD_PATH}`, (c) => c.json(card));

  /** For launchd, and for answering "is it up" without speaking A2A. */
  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: BUILD_INFO.name,
      version: BUILD_INFO.version,
      git_commit: BUILD_INFO.gitCommit,
      agent: card.name,
      authenticated: Boolean(config.token),
      tasks: store.records().length,
    }),
  );

  app.post(A2A_RPC_PATH, async (c) => {
    if (config.token) {
      const header = c.req.header("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (!tokensMatch(presented, config.token)) {
        logger?.warn?.("rejected an A2A request with a missing or wrong bearer token");
        return jsonRpcError(-32001, "Unauthorized: a valid bearer token is required.", 401);
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonRpcError(-32700, "Parse error: the body is not JSON.", 400);
    }

    const context = new ServerCallContext({
      user: new UnauthenticatedUser(),
      requestedVersion: c.req.header("a2a-version") ?? "1.0",
      // The executor reads `x-a2a-from` / `user-agent` off this to attribute the
      // task to a peer. `Map` rather than the raw Headers object because that is
      // the shape the SDK's own default context builder uses.
      state: new Map<string, unknown>([["headers", Object.fromEntries(c.req.raw.headers)]]),
    });

    try {
      const result = await rpc.handle(body as Record<string, unknown>, context);
      if (isAsyncGenerator(result)) {
        // Unreachable while the card says `streaming: false` — the SDK refuses
        // the streaming methods before it gets here. Guarded rather than cast,
        // because the day streaming is added this is where SSE belongs and a
        // silent `[object AsyncGenerator]` body would be a miserable way to
        // find that out.
        return jsonRpcError(
          -32004,
          "Streaming is not served by this agent. Poll GetTask instead.",
          501,
        );
      }
      return c.json(result);
    } catch (err) {
      logger?.error?.("A2A request failed", err);
      return jsonRpcError(-32603, "Internal error.", 500);
    }
  });

  return app;
};

const isAsyncGenerator = (value: unknown): value is AsyncGenerator<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;
