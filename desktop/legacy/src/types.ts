export interface Session {
  name: string;
  cwd?: string;
  cwdLabel: string;
  title: string;
  preview: string;
  mtime: number;
  active: boolean;
  messageCount: number;
}
export interface Model {
  id: string;
  name: string;
  provider: string;
  reasoningLevels: string[];
  defaultReasoningLevel?: string;
}
export interface Row {
  kind: string;
  text?: string;
  id?: string;
  name?: string;
  input?: string;
  output?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: string;
  final?: boolean;
  update?: Record<string, any>;
}
export interface Interaction {
  id: string;
  sessionId: string;
  kind: "approval" | "question" | "plan";
  payload: any;
}
export interface View {
  rows: Row[];
  active: boolean;
  interactions: Interaction[];
  error?: string;
  usage?: string;
}
export interface Preferences {
  projects: string[];
  theme: string;
  home: string;
  version: string;
}
export interface Bootstrap {
  sessions: Session[];
  models: Model[];
  config: {
    defaultModel: string;
    defaultProviderId: string;
    providers: { id: string; hasApiKey: boolean }[];
  };
}
declare global {
  interface Window {
    bubble: {
      call: <T = any>(
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<T>;
      subscribe: (fn: (event: any) => void) => () => void;
    };
  }
}
