import type { CheckpointRestoreResult } from "./checkpoints.js";
import type { SessionManager, UserTurn } from "./session.js";
import type { Message } from "./types.js";

export type RewindScope = "all" | "chat" | "code";

export interface RewindAgentState {
  messages: Message[];
  resetContextUsageAnchor(): void;
}

export interface RewindExecutionResult {
  target: UserTurn;
  scope: RewindScope;
  files: CheckpointRestoreResult;
  removedEntries: number;
}

const EMPTY_FILE_RESULT: CheckpointRestoreResult = {
  restored: [],
  deleted: [],
  failed: [],
};

/**
 * Apply the persistent rewind exactly once. Renderers layer their own visual
 * transaction around this function, but the session log and Agent transcript
 * always move together here.
 */
export async function executeRewind(
  session: SessionManager,
  agent: RewindAgentState,
  targetId: string,
  scope: RewindScope,
): Promise<RewindExecutionResult> {
  const target = session.listUserTurns().find((turn) => turn.id === targetId);
  if (!target) throw new Error("The selected rewind point is no longer available.");

  const files = scope === "chat"
    ? { ...EMPTY_FILE_RESULT, restored: [], deleted: [], failed: [] }
    : await session.getCheckpoints().restoreTo(target.id);

  let removedEntries = 0;
  if (scope !== "code") {
    const rewound = session.rewindToEntry(target.id);
    if (!rewound) throw new Error("The selected rewind point is no longer available.");
    removedEntries = rewound.removedEntries;
    const head = agent.messages.filter((message) => message.role === "system" || message.role === "meta");
    agent.messages = [...head, ...session.getMessages()];
    agent.resetContextUsageAnchor();
  }

  return { target, scope, files, removedEntries };
}
