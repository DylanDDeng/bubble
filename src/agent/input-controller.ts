import type { AgentInputController, AgentRunInput } from "../types.js";

export class AgentRunInputQueue implements AgentInputController {
  private pending: AgentRunInput[] = [];
  private nextInputId = 0;

  constructor(private readonly idPrefix = "input") {}

  enqueue(content: string): AgentRunInput {
    const input: AgentRunInput = {
      id: `${this.idPrefix}-${++this.nextInputId}`,
      content,
      submittedAt: Date.now(),
    };
    this.pending.push(input);
    return input;
  }

  drainPendingInputs(): AgentRunInput[] {
    if (this.pending.length === 0) return [];
    const inputs = this.pending;
    this.pending = [];
    return inputs;
  }

  pendingInputCount(): number {
    return this.pending.length;
  }

  clear(): AgentRunInput[] {
    return this.drainPendingInputs();
  }
}
