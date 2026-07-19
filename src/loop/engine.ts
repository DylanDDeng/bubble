/**
 * /loop — recurring prompts (background-tasks design §2.6).
 *
 * Pure decision logic kept out of the TUI, mirroring goal/engine.ts: the TUI
 * owns a 1s ticker and calls decideLoopFiring per loop; this module owns
 * parsing, caps, and the defer-not-stack rule (a firing due while a turn is
 * running reschedules with a notice instead of piling up).
 */

export interface LoopState {
  id: number;
  prompt: string;
  intervalMs: number;
  nextFireAt: number;
  fires: number;
}

export const MAX_ACTIVE_LOOPS = 5;
export const MIN_LOOP_INTERVAL_MS = 60_000;

export interface ParsedLoopCommand {
  action: "start" | "list" | "stop" | "help";
  intervalMs?: number;
  prompt?: string;
  stopId?: number;
  error?: string;
}

export function parseLoopCommand(raw: string): ParsedLoopCommand {
  const rest = raw.trim().replace(/^\/loop\s*/, "").trim();
  if (!rest) return { action: "help" };
  if (rest === "list") return { action: "list" };
  const stop = rest.match(/^stop(?:\s+(\d+))?$/);
  if (stop) {
    return { action: "stop", stopId: stop[1] ? Number(stop[1]) : undefined };
  }

  const match = rest.match(/^(\d+)([smh])\s+(.+)$/s);
  if (!match) {
    return {
      action: "start",
      error: "Usage: /loop <interval> <prompt> — interval like 90s, 5m, 1h (min 60s). Also: /loop list, /loop stop [id].",
    };
  }
  const value = Number(match[1]);
  const unit = match[2] as "s" | "m" | "h";
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const intervalMs = Math.max(MIN_LOOP_INTERVAL_MS, value * multiplier);
  const prompt = match[3]!.trim();
  if (!prompt) {
    return { action: "start", error: "Usage: /loop <interval> <prompt> — the prompt is required." };
  }
  return { action: "start", intervalMs, prompt };
}

export type LoopFiringDecision = "fire" | "defer" | "wait";

export function decideLoopFiring(loop: LoopState, now: number, turnRunning: boolean): LoopFiringDecision {
  if (now < loop.nextFireAt) return "wait";
  return turnRunning ? "defer" : "fire";
}

export function formatLoopList(loops: LoopState[], now: number): string {
  if (loops.length === 0) return "No active loops. Start one with /loop <interval> <prompt>.";
  return loops
    .map((loop) => {
      const nextIn = Math.max(0, Math.round((loop.nextFireAt - now) / 1000));
      return `#${loop.id} every ${formatInterval(loop.intervalMs)} · fired ${loop.fires}x · next in ${nextIn}s · ${truncate(loop.prompt, 60)}`;
    })
    .join("\n");
}

export function formatInterval(intervalMs: number): string {
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  return `${Math.round(intervalMs / 1000)}s`;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
