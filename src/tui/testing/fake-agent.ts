/**
 * Scripted fake agent: replays a fixed AgentEvent[] per run so controller
 * tests drive full sessions deterministically (no provider, no network).
 */
import type { AgentRunOptions } from "../../agent.js";
import type { Message } from "../../types.js";
import type { AgentEvent } from "../../types.js";

export interface FakeAgentRunScript {
  events: AgentEvent[];
  /** Throw this error at the end of the script instead of completing. */
  failWith?: Error;
}

export class FakeAgent {
  messages: Message[] = [];
  scripts: FakeAgentRunScript[] = [];
  runCalls: Array<{ input: unknown; options?: AgentRunOptions }> = [];
  sessionIds: string[] = [];

  setSessionID(file: string): void {
    this.sessionIds.push(file);
  }

  enqueueScript(script: FakeAgentRunScript): void {
    this.scripts.push(script);
  }

  async *run(userInput: unknown, _cwd: string, options?: AgentRunOptions): AsyncIterable<AgentEvent> {
    this.runCalls.push({ input: userInput, options });
    const script = this.scripts.shift() ?? { events: [{ type: "turn_end" } as AgentEvent] };
    for (const event of script.events) {
      yield event;
    }
    if (script.failWith) {
      throw script.failWith;
    }
  }
}
