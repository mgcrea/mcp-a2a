/**
 * The A2A protocol surface this server depends on, gathered in one module.
 *
 * Three reasons this is a barrel rather than direct imports everywhere:
 *
 * 1. It names exactly which half of `@a2a-js/sdk` is in play. The package also
 *    ships express and gRPC bindings and a v0.3 compatibility layer; none of
 *    those are used, and a reader should not have to grep to find that out.
 * 2. The v1.0 types are **protobuf-generated**, so their shapes surprise: a
 *    `Part` is a `$case` oneof wrapper rather than a discriminated `{type}`
 *    object, `TaskState` is a NUMERIC enum whose wire form is the string
 *    `"TASK_STATE_SUBMITTED"`, and every type carries `fromJSON`/`toJSON` that
 *    are the only correct way to cross the wire boundary. Those notes belong in
 *    one place.
 * 3. `TaskState` and the message codecs are imported as VALUES, not types. The
 *    fleet is erasable-syntax-only, so this file may re-export the SDK's enum
 *    but must never declare one of its own.
 */

export {
  Artifact,
  ListTasksResponse,
  Message,
  Part,
  Role,
  Task,
  TaskState,
  TaskStatus,
  roleToJSON,
  taskStateFromJSON,
  taskStateToJSON,
} from "@a2a-js/sdk";
export type {
  AgentCard,
  AgentInterface,
  AgentSkill,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  SendMessageRequest,
  TaskPushNotificationConfig,
} from "@a2a-js/sdk";

export {
  AgentEvent,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
} from "@a2a-js/sdk/server";
export type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
  TaskStore,
} from "@a2a-js/sdk/server";

export {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
export type { Client as A2APeerClient } from "@a2a-js/sdk/client";
