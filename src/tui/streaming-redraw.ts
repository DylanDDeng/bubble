export type RedrawReason = "normal" | "streaming-tool-call";

export class StreamingRedrawThrottler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastRedrawAt = 0;

  constructor(private readonly intervalMs: number) {}

  schedule(reason: RedrawReason, redraw: () => void): boolean {
    if (reason !== "streaming-tool-call") {
      this.cancel();
      redraw();
      return true;
    }

    const now = Date.now();
    const elapsed = now - this.lastRedrawAt;
    if (elapsed < this.intervalMs) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.lastRedrawAt = Date.now();
          redraw();
        }, this.intervalMs - elapsed);
      }
      return false;
    }

    this.lastRedrawAt = now;
    redraw();
    return true;
  }

  cancel() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
