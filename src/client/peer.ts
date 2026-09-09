import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  Message,
  RestTransportFactory,
  Role,
  Task,
  type A2APeerClient,
  type AgentCard,
} from "#/a2a";
import type { Logger } from "#/client/auth";
import {
  A2AApiError,
  classifyPeerError,
  PeerUnreachableError,
  remedyForStatus,
} from "#/client/errors";
import { createA2AFetch } from "#/client/fetch";
import { PeerCache } from "#/store/peers";

export type PeerClientOptions = {
  stateDir: string;
  /** Peers named in the configuration, offered before anything is discovered. */
  configuredPeers: string[];
  /** Our own daemon's base URL — peer zero, reachable by the same code path. */
  daemonUrl: string;
  token: string | undefined;
  maxRetries: number;
  userAgent: string;
  fetch?: typeof fetch;
  logger?: Logger;
};

export type PeerSummary = {
  url: string;
  name: string;
  description: string;
  /** Whether this is our own daemon rather than somebody else's agent. */
  self: boolean;
  configured: boolean;
  cachedAt: string | undefined;
};

/**
 * Everything the stdio tools do to somebody else's agent.
 *
 * Discovery, the card cache, and one A2A client per peer. The SDK's
 * `ClientFactory` picks a transport by reading the peer's own card, which is why
 * a card is fetched before a message is ever sent: `supportedInterfaces` is what
 * says whether this peer speaks JSON-RPC, HTTP+JSON or gRPC, and at which URL.
 */
export class PeerClient {
  private readonly cache: PeerCache;
  private readonly resolver: DefaultAgentCardResolver;
  private readonly factory: ClientFactory;
  private readonly opts: PeerClientOptions;
  /** One client per peer URL. Cheap to build, but it also caches the card. */
  private readonly clients = new Map<string, A2APeerClient>();
  /** The same authenticating, retrying fetch the SDK transports get. */
  private readonly rpcFetch: typeof fetch;

  constructor(opts: PeerClientOptions) {
    this.opts = opts;
    this.cache = new PeerCache({
      stateDir: opts.stateDir,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    const fetchImpl = createA2AFetch({
      maxRetries: opts.maxRetries,
      userAgent: opts.userAgent,
      token: opts.token,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    this.rpcFetch = fetchImpl;
    this.resolver = new DefaultAgentCardResolver({ fetchImpl });
    this.factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        // Both HTTP bindings, in card-preference order. gRPC is deliberately
        // absent: it needs @grpc/grpc-js and @bufbuild/protobuf, two more
        // runtime dependencies on a process holding this machine's shared token,
        // and no local agent runtime speaks it today.
        transports: [
          new JsonRpcTransportFactory({ fetchImpl }),
          new RestTransportFactory({ fetchImpl }),
        ],
        clientConfig: {
          // Return whatever state the task is in rather than blocking until it
          // is terminal. An A2A task on this mesh is a PROPOSAL and may sit in
          // SUBMITTED for as long as it takes a human-supervised agent to look
          // at it, so a blocking send would always be the wrong default.
          polling: true,
          acceptedOutputModes: ["text/plain", "application/json"],
        },
        cardResolver: this.resolver,
      }),
    );
  }

  /** Fetch a peer's card, cache it, and return it. Always refetches. */
  async discover(url: string): Promise<AgentCard> {
    const base = normalizeBase(url);
    try {
      const card = await this.resolver.resolve(base);
      this.cache.put(base, card);
      this.clients.delete(base);
      return card;
    } catch (err) {
      throw new PeerUnreachableError(base, err);
    }
  }

  /** The card from cache, or a fresh fetch when nothing is cached yet. */
  async card(url: string): Promise<AgentCard> {
    const base = normalizeBase(url);
    const cached = this.cache.get(base);
    if (cached) {
      try {
        return this.resolver.normalizeAgentCard(cached.card);
      } catch {
        /* a cached card this build cannot read is worth refetching */
      }
    }
    return await this.discover(base);
  }

  /**
   * Known peers without touching the network: the configured list, our own
   * daemon, and everything discovered so far. A peer with no cached card is
   * still listed — that it is unknown is the useful part of the answer.
   */
  peers(): PeerSummary[] {
    const configured = new Set(this.opts.configuredPeers.map(normalizeBase));
    const daemon = normalizeBase(this.opts.daemonUrl);
    const urls = new Set<string>([daemon, ...configured]);
    for (const record of this.cache.all()) urls.add(normalizeBase(record.url));

    return [...urls].toSorted().map((url) => {
      const cached = this.cache.get(url);
      const card = cached?.card;
      return {
        url,
        name: readString(card, "name") ?? "(not discovered)",
        description: readString(card, "description") ?? "",
        self: url === daemon,
        configured: configured.has(url) || url === daemon,
        cachedAt: cached?.fetchedAt,
      };
    });
  }

  /**
   * Send a message to a peer, returning both what it answered with and the
   * message we sent.
   *
   * The sent message is handed back because the answer often does not contain it.
   * Measured against this implementation: with `polling: true` the client sets
   * `returnImmediately`, and the acknowledgement is then the executor's first
   * snapshot — published before the store merged the request into the task's
   * history — so `task.history` comes back EMPTY. A mirror built from that alone
   * would record a task with no record of what was asked, which is most of what a
   * mirror is for.
   */
  async sendMessage(
    url: string,
    args: { text: string; taskId?: string; contextId?: string; metadata?: Record<string, unknown> },
  ): Promise<{ result: Task | Message; sent: Message }> {
    const client = await this.clientFor(url);
    const message: Message = {
      messageId: randomId("msg"),
      contextId: args.contextId ?? "",
      taskId: args.taskId ?? "",
      // ROLE_USER means "from the client to the server" in A2A, regardless of
      // whether a human or an agent composed it. Sending ROLE_AGENT here is the
      // easy mistake and some peers reject it.
      role: Role.ROLE_USER,
      parts: [textPart(args.text)],
      metadata: args.metadata,
      extensions: [],
      referenceTaskIds: [],
    };
    const result = await this.call(
      url,
      async () =>
        await client.sendMessage({
          tenant: "",
          message,
          configuration: undefined,
          metadata: undefined,
        }),
    );
    return { result, sent: message };
  }

  async getTask(url: string, taskId: string, historyLength?: number): Promise<Task> {
    const client = await this.clientFor(url);
    return await this.call(
      url,
      async () =>
        await client.getTask({
          tenant: "",
          id: taskId,
          ...(historyLength === undefined ? {} : { historyLength }),
        }),
    );
  }

  async cancelTask(url: string, taskId: string): Promise<Task> {
    const client = await this.clientFor(url);
    return await this.call(
      url,
      async () => await client.cancelTask({ tenant: "", id: taskId, metadata: undefined }),
    );
  }

  async setPushNotificationConfig(
    url: string,
    args: { taskId: string; id: string; url: string; token?: string },
  ): Promise<unknown> {
    const client = await this.clientFor(url);
    return await this.call(
      url,
      async () =>
        await client.createTaskPushNotificationConfig({
          tenant: "",
          id: args.id,
          taskId: args.taskId,
          url: args.url,
          token: args.token ?? "",
          authentication: undefined,
        }),
    );
  }

  async deletePushNotificationConfig(
    url: string,
    args: { taskId: string; id: string },
  ): Promise<void> {
    const client = await this.clientFor(url);
    await this.call(url, async () => {
      await client.deleteTaskPushNotificationConfig({
        tenant: "",
        taskId: args.taskId,
        id: args.id,
      });
      return undefined;
    });
  }

  /**
   * One raw A2A JSON-RPC call, for the escape hatch: an RPC nobody wrapped stays
   * reachable without a code change.
   *
   * It goes through the same authenticating `fetch` as everything else, and the
   * URL comes from the peer's own card rather than being composed — a peer is
   * free to serve the binding at any path, and guessing `/a2a/v1` would work
   * against this implementation and quietly fail against others.
   */
  async rawRpc(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const card = await this.card(url);
    const iface = card.supportedInterfaces.find(
      (candidate) => candidate.protocolBinding === "JSONRPC",
    );
    if (!iface) {
      throw new A2AApiError(`${normalizeBase(url)} advertises no JSON-RPC interface.`, {
        status: 0,
        remedy:
          "Its card lists " +
          (card.supportedInterfaces.map((i) => i.protocolBinding).join(", ") || "nothing") +
          ". The escape hatch speaks JSON-RPC only; use the typed tools for the other bindings.",
      });
    }
    const res = await this.rpcFetch(iface.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomId("rpc"), method, params }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new A2AApiError(`${iface.url} answered HTTP ${res.status}: ${text.slice(0, 400)}`, {
        status: res.status,
        ...(remedyForStatus(res.status, this.opts.token !== undefined)
          ? { remedy: remedyForStatus(res.status, this.opts.token !== undefined) as string }
          : {}),
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new A2AApiError(`${iface.url} answered with something that is not JSON.`, {
        status: res.status,
        errors: text.slice(0, 400),
      });
    }
  }

  /**
   * Is a peer answering at all? Used by `a2a_auth_status` against our own
   * daemon, where "is it running" is the first question and an exception is the
   * wrong way to answer it.
   */
  async probe(url: string): Promise<{ reachable: boolean; card?: AgentCard; error?: string }> {
    try {
      return { reachable: true, card: await this.discover(url) };
    } catch (err) {
      return { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async clientFor(url: string): Promise<A2APeerClient> {
    const base = normalizeBase(url);
    const existing = this.clients.get(base);
    if (existing) return existing;
    const client = await this.factory.createFromAgentCard(await this.card(base));
    this.clients.set(base, client);
    return client;
  }

  /**
   * One place where a thrown SDK error becomes an `A2AApiError` carrying a
   * remedy. Without it every tool would surface the SDK's own message, which
   * says what the transport saw and nothing about what to do.
   */
  private async call<T>(url: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw (
        classifyPeerError(err, normalizeBase(url), this.opts.token !== undefined) ??
        new PeerUnreachableError(url, err)
      );
    }
  }
}

/** A trailing slash makes two spellings of one peer, and two cache entries. */
export const normalizeBase = (url: string): string => url.replace(/\/+$/, "");

export const textPart = (text: string) => ({
  content: { $case: "text" as const, value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

export const randomId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const readString = (card: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = card?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};
