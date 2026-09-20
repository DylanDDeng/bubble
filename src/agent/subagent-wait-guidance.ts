/** Scheduling advice, not a timeout policy: the model keeps control of each wait. */
export const SUBAGENT_WAIT_GUIDANCE = [
  "Coordinate around dependencies: after delegation, continue useful non-overlapping work that does not require the child's result; wait_agent when that result is needed for your next meaningful step or final synthesis.",
  "Choose a wait timeout according to the task and your next decision. It is an upper bound, not a mandatory delay: wait_agent returns early when a target finishes, so a generous timeout does not slow down a short task.",
  "A short wait is appropriate when its outcome informs a concrete scheduling decision. Avoid repeated short checks solely to see whether time has passed; use list_agents for a status snapshot when that information is useful.",
  "The same decision-value principle applies to list_agents: do not replace short waits with repeated status polling. With multiple children, wait_agent may return as soon as any target finishes; use explicit IDs for the remaining children whose results you still need, rather than repeatedly collecting an already-finished child.",
  "A timeout ends only that wait, not the child's work. Reassess available independent work and whether the result still blocks progress before waiting again; do not duplicate the delegated task.",
] as const;
