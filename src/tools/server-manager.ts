/**
 * Compatibility shim: the managed-server runtime moved into the unified
 * process manager (src/tasks/manager.ts, background-tasks design §2.2).
 * Existing imports — server tools, agent.ts, tests — keep working unchanged.
 */

export {
  getManagedServer,
  getManagedServerLogs,
  listManagedServers,
  startManagedServer,
  stopAutoServersForSession,
  stopManagedServer,
  type ManagedServerInfo,
  type ManagedServerLifecycle,
  type ManagedServerPurpose,
  type ManagedServerStatus,
  type StartManagedServerInput,
} from "../tasks/manager.js";
