/*
 * Shared IPC contract between the Electron main process and the renderer.
 * Imported by both sides; all types are erased at runtime.
 *
 * The agent-event and approval shapes mirror the Bubble core
 * (@bubblebrain-ai/bubble) so the renderer stays decoupled from the core's
 * compiled .d.ts. The bridge in main.ts casts the real core types onto these.
 */

export const IPC_CLIENT_CHANNEL = 'client-event';
export const IPC_SERVER_CHANNEL = 'server-event';

// ---- Agent events (subset the renderer reduces over) -------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

export interface ToolResultDTO {
  content: string;
  isError?: boolean;
  status?: string;
}

export type AgentEventDTO =
  | { type: 'turn_start' }
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; result: ToolResultDTO }
  | { type: 'todos_updated'; todos: TodoDTO[] }
  | { type: 'turn_end'; usage?: TokenUsage; willContinue?: boolean }
  | { type: 'agent_end' }
  // catch-all for events the renderer doesn't specifically handle yet
  | { type: string; [k: string]: unknown };

export interface TodoDTO {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

// ---- Approval (tool permission) ---------------------------------------------

export type ApprovalRequestDTO =
  | { type: 'edit'; path: string; diff: string; fileExists: boolean }
  | { type: 'write'; path: string; content: string; diff?: string; fileExists: boolean }
  | {
      type: 'patch';
      path: string;
      paths: string[];
      files: Array<{ path: string; kind: 'add' | 'update' | 'delete' }>;
      diff: string;
    }
  | { type: 'bash'; command: string; cwd: string }
  | { type: 'lsp'; path: string; operation: string }
  | { type: 'agent_profile'; name: string; path: string; contentHash: string; promptPreview: string };

export type ApprovalAction = 'approve' | 'reject' | 'always';

// ---- Session summaries -------------------------------------------------------

export interface SessionSummaryDTO {
  id: string; // session file name
  title: string;
  preview: string;
  messageCount: number;
  mtime: number;
}

// ---- Renderer -> Main --------------------------------------------------------

export type ClientEvent =
  | { type: 'session.list' }
  | { type: 'session.start'; payload: { cwd?: string; prompt: string } }
  | { type: 'session.continue'; payload: { sessionId: string; prompt: string } }
  | { type: 'session.open'; payload: { sessionId: string } }
  | { type: 'session.stop'; payload: { sessionId: string } }
  | {
      type: 'permission.response';
      payload: { requestId: string; action: ApprovalAction; feedback?: string };
    };

// ---- Main -> Renderer --------------------------------------------------------

export type ServerEvent =
  | { type: 'session.list'; payload: { sessions: SessionSummaryDTO[] } }
  | { type: 'session.started'; payload: { sessionId: string; cwd: string; title: string } }
  | { type: 'session.status'; payload: { sessionId: string; status: 'running' | 'idle' | 'error' } }
  | { type: 'agent.event'; payload: { sessionId: string; event: AgentEventDTO } }
  | {
      type: 'permission.request';
      payload: { sessionId: string; requestId: string; request: ApprovalRequestDTO };
    }
  | { type: 'runner.error'; payload: { sessionId: string; message: string } };

// ---- Preload bridge surface --------------------------------------------------

export interface BubbleBridge {
  sendClientEvent: (event: ClientEvent) => void;
  onServerEvent: (cb: (event: ServerEvent) => void) => () => void;
  getAppVersion: () => Promise<string>;
}

declare global {
  interface Window {
    bubble: BubbleBridge;
  }
}
