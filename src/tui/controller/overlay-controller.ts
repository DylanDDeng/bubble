/**
 * Blocking-interaction lifecycle (controller extraction §3).
 *
 * Models plan approvals, tool approvals, questions, and feedback as owned
 * requests with exactly one terminal state. Legacy wiring lives in
 * app.tsx:542-583 (promise-resolver refs + question subscription) but never
 * settles requests on session switch or shutdown — this controller makes
 * that guarantee explicit (design doc behavior delta).
 */
import type { ApprovalDecision, ApprovalRequest } from "../../approval/types.js";
import type { PlanDecision } from "../../types.js";
import type { QuestionController } from "../../question/controller.js";

export type OverlayTerminalState = "accepted" | "rejected" | "cancelled" | "disposed";
export type SettleVia = "user" | "session-switch" | "shutdown" | "replaced";

export interface PlanRequestPayload {
  plan: string;
}

export class OwnedRequest<TDecision> {
  state: "pending" | OverlayTerminalState = "pending";
  private resolvers: Array<(decision: TDecision) => void> = [];

  readonly result: Promise<TDecision>;

  constructor(
    readonly id: string,
    readonly kind: "plan" | "approval" | "question" | "feedback",
    private readonly onSettle?: (request: OwnedRequest<TDecision>, via: SettleVia) => void,
  ) {
    this.result = new Promise<TDecision>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  settle(decision: TDecision, via: SettleVia): boolean {
    if (this.state !== "pending") return false;
    this.state = decision === undefined
      ? (via === "user" ? "cancelled" : via === "replaced" ? "disposed" : "cancelled")
      : "accepted";
    const resolve = this.resolvers[0];
    this.resolvers = [];
    resolve?.(decision);
    this.onSettle?.(this, via);
    return true;
  }
}

export interface OverlaySnapshot {
  plan?: { id: string; plan: string };
  approval?: { id: string; request: ApprovalRequest };
  question?: { id: string };
}

let nextRequestId = 0;

export class OverlayRequestController {
  private readonly requests = new Map<string, OwnedRequest<unknown>>();
  private questionUnsubscribe?: () => void;
  private notifyChange: () => void = () => {};

  constructor(private readonly deps: { questionController?: QuestionController } = {}) {}

  /** Host wires change notification (snapshot rebuild). */
  onChange(listener: () => void): void {
    this.notifyChange = listener;
  }

  installPlanHandler(ref: { current?: (plan: string) => Promise<PlanDecision> }): void {
    ref.current = (plan: string) => {
      void plan;
      const request = new OwnedRequest<PlanDecision>(`plan-${++nextRequestId}`, "plan", (r) => {
        if (r.state === "pending") return;
        void r;
        this.notifyChange();
      });
      this.requests.set(request.id, request as OwnedRequest<unknown>);
      this.notifyChange();
      return request.result.then((decision) => {
        this.requests.delete(request.id);
        return decision;
      });
    };
  }

  installApprovalHandler(ref: { current?: (request: ApprovalRequest) => Promise<ApprovalDecision> }): void {
    ref.current = (request: ApprovalRequest) => {
      void request;
      const owned = new OwnedRequest<ApprovalDecision>(`approval-${++nextRequestId}`, "approval", () => {
        this.notifyChange();
      });
      this.requests.set(owned.id, owned as OwnedRequest<unknown>);
      this.notifyChange();
      return owned.result.then((decision) => {
        this.requests.delete(owned.id);
        return decision;
      });
    };
  }

  adoptQuestionStream(): void {
    const controller = this.deps.questionController;
    if (!controller || this.questionUnsubscribe) return;
    this.questionUnsubscribe = controller.subscribe((event) => {
      if (event.type === "asked") {
        const owned = new OwnedRequest<{ reply: Record<string, string> }>(event.request.id, "question", () => {
          this.notifyChange();
        });
        this.requests.set(owned.id, owned as OwnedRequest<unknown>);
      } else {
        this.requests.delete(event.request.id);
      }
      this.notifyChange();
    });
  }

  openFeedback(initialDescription: string): OwnedRequest<"dismissed"> {
    const owned = new OwnedRequest<"dismissed">(`feedback-${++nextRequestId}`, "feedback", () => {
      this.notifyChange();
    });
    this.requests.set(owned.id, owned as OwnedRequest<unknown>);
    void initialDescription;
    this.notifyChange();
    return owned;
  }

  /** Settle every pending request (session switch, shutdown, replacement). */
  settleAll(via: "session-switch" | "shutdown"): number {
    let settled = 0;
    for (const request of [...this.requests.values()]) {
      if (request.state === "pending") {
        // Resolve the promise (undefined decision) and mark the terminal state.
        request.settle(undefined as never, via);
        request.state = via === "shutdown" ? "cancelled" : "disposed";
        settled += 1;
      }
    }
    this.requests.clear();
    if (settled > 0) this.notifyChange();
    return settled;
  }

  /** Drain the question subscription (controller shutdown). */
  dispose(): void {
    this.questionUnsubscribe?.();
    this.questionUnsubscribe = undefined;
    this.settleAll("shutdown");
  }

  pendingCount(): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.state === "pending") count += 1;
    }
    return count;
  }
}
