/**
 * The real orchestration V2 runtime over in-memory SQLite, for tests of services built on it.
 * Provider work never starts: the effect worker is not run, and opening a session dies.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const testModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: testModelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: testModelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("tests on this runtime never start a provider session"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

/**
 * The orchestrator, thread management (with the V1 transcript importer), event sink, project
 * store and effect outbox, sharing one database that the test can also reach.
 */
export const makeOrchestrationV2TestLayer = (prefix: string) => {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix });
  return Layer.mergeAll(
    OrchestrationV2LayerLive,
    OrchestrationV2EventSinkLayerLive,
    ProjectStore.layer,
    EffectOutbox.layer,
    ThreadCommandExecutor.layer,
  ).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(
      CheckpointStore.layer.pipe(
        Layer.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(ServerConfigLayer),
            Layer.provide(PlatformTestLayer),
          ),
        ),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
        listInstances: Effect.succeed([providerInstance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees: () => Effect.void }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(PlatformTestLayer),
  );
};

/** Seeds a project the way a committed `project.created` event folds into the project store. */
export const seedProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-09-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Test project",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    }),
  );
