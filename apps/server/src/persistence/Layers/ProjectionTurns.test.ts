import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionTurnRepository", (it) => {
  it.effect("finds the turn a message started, but not while it only waits to start", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTurnRepository;
      const threadId = ThreadId.make("thread-pending-message-turn");
      const messageId = MessageId.make("message-pending-message-turn");
      const requestedAt = "2026-03-01T00:00:00.000Z";

      yield* repository.replacePendingTurnStart({
        threadId,
        messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt,
      });
      assert.isTrue(
        Option.isNone(yield* repository.getByPendingMessageId({ threadId, messageId })),
      );

      yield* repository.upsertByTurnId({
        threadId,
        turnId: TurnId.make("turn-pending-message"),
        pendingMessageId: messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt,
        startedAt: requestedAt,
        completedAt: requestedAt,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      const found = yield* repository.getByPendingMessageId({ threadId, messageId });
      assert.deepStrictEqual(
        Option.map(found, (turn) => [turn.turnId, turn.state]),
        Option.some([TurnId.make("turn-pending-message"), "completed"]),
      );
      assert.isTrue(
        Option.isNone(
          yield* repository.getByPendingMessageId({
            threadId,
            messageId: MessageId.make("message-pending-message-other"),
          }),
        ),
      );
    }),
  );
});
