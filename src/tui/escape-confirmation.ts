export type EscapeConfirmationDecision =
  | { action: "arm"; expiresAt: number }
  | { action: "confirm" };

export class EscapeConfirmationGate {
  private armedRunId: number | undefined;
  private deadline = 0;

  constructor(private readonly windowMs: number) {}

  press(runId: number, now = Date.now()): EscapeConfirmationDecision {
    if (this.armedRunId === runId && now <= this.deadline) {
      this.clear();
      return { action: "confirm" };
    }

    this.armedRunId = runId;
    this.deadline = now + this.windowMs;
    return { action: "arm", expiresAt: this.deadline };
  }

  isArmed(runId: number, now = Date.now()): boolean {
    if (this.armedRunId !== runId) return false;
    if (now > this.deadline) {
      this.clear();
      return false;
    }
    return true;
  }

  clear() {
    this.armedRunId = undefined;
    this.deadline = 0;
  }
}
