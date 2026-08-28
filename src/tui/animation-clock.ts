/**
 * One clock owns all decorative TUI animation. Components expose pure frame
 * advancement; they never create timers or request renders independently.
 */
export class TuiAnimationClock {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onTick: (elapsedMs: number) => void,
    private readonly intervalMs = 100,
  ) {}

  setActive(active: boolean): void {
    if (active) {
      if (this.timer) return;
      this.timer = setInterval(() => this.onTick(this.intervalMs), this.intervalMs);
      return;
    }
    this.stop();
  }

  isActive(): boolean {
    return this.timer !== null;
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
