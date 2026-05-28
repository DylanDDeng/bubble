/**
 * `bubble serve --feishu` entry. Wires every layer of the host together.
 */

import chalk from "chalk";
import { homedir } from "node:os";
import { configExists, loadConfig, resolveAppSecret } from "./config.js";
import { runWizard } from "./wizard.js";
import { ScopeRegistry } from "./scope/scope-registry.js";
import { SessionStore } from "./scope/session-store.js";
import { SessionBinder } from "./scope/session-binder.js";
import { PendingQueue, combineQueuedMessages } from "./runtime/pending-queue.js";
import { ActiveRuns } from "./runtime/active-runs.js";
import { ProcessPool } from "./runtime/process-pool.js";
import { createBubbleChannel, type BubbleChannel } from "./channel/channel.js";
import { FeishuApprovalUI } from "./agent-host/approval-ui.js";
import { RunDriver } from "./agent-host/run-driver.js";
import { EventRouter } from "./router/event-router.js";
import { FeishuLogger } from "./logger.js";
import { ProcessRegistry } from "./process-registry.js";
import { parseScopeKey } from "./types.js";
import type { FeishuRuntimeDeps } from "./agent-host/runtime-deps.js";

// Re-use existing process-level building blocks.
import { UserConfig } from "../config.js";
import { ProviderRegistry } from "../provider-registry.js";
import { createProviderInstance } from "../provider.js";
import { SettingsManager } from "../permissions/settings.js";
import { SkillRegistry } from "../skills/registry.js";
import { loadMcpConfig } from "../mcp/config.js";
import { McpManager } from "../mcp/manager.js";
import { BashAllowlist } from "../approval/session-cache.js";

export interface ServeFeishuOptions {
  /** If true, force wizard re-run even if config exists. */
  setup?: boolean;
  /** If true, skip conflicting-process prompt and kill the old one. */
  killOld?: boolean;
  /** If true, exit immediately after a successful connect (CI / smoke test). */
  dryRun?: boolean;
}

export async function serveFeishu(opts: ServeFeishuOptions = {}): Promise<void> {
  // 1. Setup or load config
  if (opts.setup || !configExists()) {
    await runWizard();
    if (opts.setup) {
      console.log(chalk.dim("Re-run `bubble serve --feishu` (without --setup) to start serving."));
      return;
    }
  }

  const config = loadConfig();
  const appSecret = resolveAppSecret(config);

  // 2. Process registry — detect duplicates
  const procRegistry = new ProcessRegistry();
  procRegistry.gc();
  const conflicts = procRegistry.findConflicts(config.app.appId);
  if (conflicts.length > 0) {
    if (opts.killOld || process.env.BUBBLE_KILL_OLD === "1") {
      const killed = procRegistry.killConflicts(config.app.appId);
      console.log(chalk.dim(`Killed ${killed} stale instance(s) for appId ${config.app.appId}.`));
    } else if (process.stdin.isTTY) {
      console.log(chalk.yellow(
        `\n⚠ Another bubble serve --feishu is running for app ${config.app.appId}:`,
      ));
      for (const c of conflicts) {
        console.log(`  pid ${c.entry.pid} (started ${new Date(c.entry.startedAt).toLocaleString()})`);
      }
      console.log("\n  c) Continue anyway (both will fight for events — not recommended)");
      console.log("  k) Kill the old one and continue");
      console.log("  a) Abort\n");
      const choice = await prompt("Choice [c/k/a]: ");
      if (/^k/i.test(choice)) {
        procRegistry.killConflicts(config.app.appId);
      } else if (!/^c/i.test(choice)) {
        console.log("Aborted.");
        process.exit(2);
      }
    } else {
      console.error(chalk.red(
        `Another instance is running for appId ${config.app.appId}. Set BUBBLE_KILL_OLD=1 to kill it, or run without -y to interactively resolve.`,
      ));
      process.exit(2);
    }
  }
  procRegistry.register({
    pid: process.pid,
    appId: config.app.appId,
    startedAt: Date.now(),
    cwd: process.cwd(),
  });

  // 3. Process-level dependencies (shared across scopes)
  const userConfig = new UserConfig();
  const providerRegistry = new ProviderRegistry(userConfig);
  // Use the user's home as the "root" for settings/skills/MCP discovery.
  // Per-scope cwd overrides happen at the run-driver level (future work).
  const rootCwd = homedir();
  const settingsManager = new SettingsManager(rootCwd);
  const skillRegistry = new SkillRegistry({
    cwd: rootCwd,
    skillPaths: userConfig.getSkillPaths(),
  });
  const mcpLoaded = loadMcpConfig({ cwd: rootCwd });
  const mcpManager = new McpManager({ servers: mcpLoaded.servers });
  if (mcpLoaded.servers.length > 0) {
    await mcpManager.start();
  }
  const createProvider = (providerId: string, apiKey: string, baseURL: string, promptCacheKey?: string) =>
    createProviderInstance({
      providerId,
      apiKey,
      baseURL,
      promptCacheKey,
      openAICodexAuth: providerRegistry.createOpenAICodexAuthAdapter(providerId),
    });
  const createProviderForRoute = async (route: { providerId: string; model: string }, promptCacheKey?: string) => {
    const target = providerRegistry.getConfigured().find((p) => p.id === route.providerId);
    if (!target?.apiKey) {
      throw new Error(`Subagent route requires provider "${route.providerId}", not configured.`);
    }
    return createProvider(route.providerId, target.apiKey, target.baseURL, promptCacheKey);
  };
  const deps: FeishuRuntimeDeps = {
    settingsManager,
    providerRegistry,
    userConfig,
    skillRegistry,
    mcpManager,
    createProvider,
    createProviderForRoute,
    ownerOpenId: config.app.ownerOpenId,
  };

  // 4. Persistence stores
  const scopeRegistry = ScopeRegistry.load();
  const sessionStore = SessionStore.load();
  const sessionBinder = new SessionBinder(sessionStore);

  // 5. Channel
  const channel: BubbleChannel = createBubbleChannel({
    appId: config.app.appId,
    appSecret,
    outputThrottleMs: config.preferences.outputThrottleMs,
    requireMentionInGroup: config.preferences.requireMentionInGroup,
  });

  // 6. Logger
  const logger = new FeishuLogger();
  logger.pruneOldLogs(7);

  // 7. Approval UI (shared across all scopes; clicker-restricted enforces per-scope safety)
  const approvalUI = new FeishuApprovalUI({
    sendCard: async (chatId, card) => {
      const res = await channel.send(chatId, { card }, undefined);
      return { messageId: res.messageId };
    },
    updateCard: (messageId, card) => channel.updateCard(messageId, card),
    bashAllowlist: new BashAllowlist(),
    timeoutMs: 60_000,
  });

  // 8. Runtime control
  const activeRuns = new ActiveRuns();
  const processPool = new ProcessPool({ concurrency: config.globalLimits.maxConcurrentRuns });

  // 9. Run driver
  const driver = new RunDriver({
    channel,
    deps,
    binder: sessionBinder,
    approvalUI,
    outputThrottleMs: config.preferences.outputThrottleMs,
    idleTimeoutMinutes: config.preferences.idleTimeoutMinutes,
    maxBytesPerElement: config.preferences.maxBytesPerElement,
    maxBytesPerCard: config.preferences.maxBytesPerCard,
  });

  // 10. PendingQueue with flush → run-driver
  const pendingQueue = new PendingQueue({
    debounceMs: 600,
    onFlush: async (scopeKey, batch) => {
      const parsed = parseScopeKey(scopeKey);
      if (!parsed) return;
      const scope = scopeRegistry.get(parsed.chatId);
      if (!scope) return;

      // Block further flushes for this scope while the run is in flight.
      pendingQueue.block(scopeKey);
      const { signal, complete } = await activeRuns.startOrReplace(scopeKey);
      try {
        await processPool.run(async () =>
          driver.runOnce({
            scopeKey,
            scope,
            chatId: parsed.chatId,
            userId: parsed.userId,
            prompt: combineQueuedMessages(batch),
            replyToMessageId: batch[0]?.messageId,
            abortSignal: signal,
          }),
        );
      } catch (err) {
        logger.error("run_driver_error", {
          phase: "runtime",
          scope: scopeKey,
          error: serializeError(err),
        });
      } finally {
        complete();
        pendingQueue.unblock(scopeKey);
      }
    },
  });

  // 11. Event router
  const router = new EventRouter({
    channel,
    scopeRegistry,
    sessionStore,
    activeRuns,
    pendingQueue,
    approvalUI,
    logger,
    requireMentionInGroup: config.preferences.requireMentionInGroup,
    commandContext: {
      channel,
      scopeRegistry,
      sessionStore,
      sessionBinder,
      activeRuns,
    },
  });

  // 12. Channel events for status/log
  channel.onError((err) => {
    logger.error("channel_error", { phase: "channel", error: serializeError(err) });
    console.error(chalk.red(`[channel] ${err.message}`));
  });
  channel.onReconnecting(() => {
    logger.warn("channel_reconnecting", { phase: "channel" });
    console.log(chalk.yellow("[channel] reconnecting…"));
  });
  channel.onReconnected(() => {
    logger.info("channel_reconnected", { phase: "channel" });
    console.log(chalk.green("[channel] reconnected"));
  });

  router.start();

  // 13. Shutdown
  let shuttingDown = false;
  let resolveServeDone: (() => void) | undefined;
  const serveDone = new Promise<void>((resolve) => {
    resolveServeDone = resolve;
  });
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.dim(`\nGot ${signal}, shutting down…`));
    router.stop();
    pendingQueue.shutdown();
    const aborted = activeRuns.abortAll();
    if (aborted > 0) console.log(chalk.dim(`Aborted ${aborted} active run(s).`));
    approvalUI.cancelAll("Shutdown");
    await activeRuns.waitAll(8_000);
    try { await channel.disconnect(); } catch { /* */ }
    try { await mcpManager.shutdown(); } catch { /* */ }
    procRegistry.deregister(process.pid);
    resolveServeDone?.();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // 14. Connect
  console.log(chalk.dim(`\nConnecting to Feishu (app ${config.app.appId})…`));
  try {
    await channel.connect();
  } catch (err) {
    console.error(chalk.red(`Failed to connect: ${(err as Error).message}`));
    procRegistry.deregister(process.pid);
    process.exit(1);
  }
  const botId = channel.botOpenId();
  const scopesCount = scopeRegistry.list().length;
  console.log(chalk.green(`✅ Listening on Feishu.`));
  console.log(chalk.dim(`   bot open_id: ${botId ?? "(unknown)"}`));
  console.log(chalk.dim(`   ${scopesCount} scope${scopesCount === 1 ? "" : "s"} configured`));
  console.log(chalk.dim("\nSend a message to your bot to start. /help in chat for commands."));

  if (opts.dryRun) {
    console.log(chalk.dim("\n--dry-run set; exiting after successful connect."));
    await shutdown("dry-run");
    return;
  }

  // Block here until SIGINT/SIGTERM triggers shutdown. Without this await
  // the function would return, main() would resolve, and exitAfterFlush()
  // in main.ts would call process.exit(0) — killing the freshly-connected
  // service. The LarkChannel WebSocket alone doesn't always keep Node's
  // event loop alive (e.g., under detached spawn where stdin is /dev/null).
  await serveDone;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.once("data", (data) => resolve(String(data).trim()));
  });
}

function serializeError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, name: err.name, stack: err.stack };
  return { message: String(err) };
}
