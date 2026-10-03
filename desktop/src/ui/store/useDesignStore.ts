import { create } from "zustand";
import { useAppStore } from "./useAppStore";
import type { DesignSummary } from "../../shared/design-types";

/** A request from outside the canvas (e.g. chat "View thread") to focus a target. */
export interface DesignFocusRequest {
  sessionId: string;
  documentId: string;
  boardId?: string;
  commentId?: string;
  nonce: number;
}

export const useDesignStore = create<{
  titles: Record<string, string>;
  remember: (doc: Pick<DesignSummary, "id" | "title">) => void;
  focusRequest: DesignFocusRequest | null;
  requestFocus: (request: Omit<DesignFocusRequest, "nonce">) => void;
  consumeFocus: (nonce: number) => void;
}>((set) => ({
  titles: {},
  remember: (doc) =>
    set((s) =>
      s.titles[doc.id] === doc.title
        ? s
        : { titles: { ...s.titles, [doc.id]: doc.title } },
    ),
  focusRequest: null,
  requestFocus: (request) => {
    set({ focusRequest: { ...request, nonce: Date.now() + Math.random() } });
    useAppStore
      .getState()
      .setActiveRightUtilityTab(`design:${request.documentId}`);
  },
  consumeFocus: (nonce) =>
    set((s) =>
      s.focusRequest?.nonce === nonce ? { focusRequest: null } : s,
    ),
}));

export function subscribeDesignChanges() {
  return window.electron.design?.onChanged((event) => {
    useDesignStore
      .getState()
      .remember({ id: event.documentId, title: event.title });
    const store = useAppStore.getState();
    // Background generation never steals the foreground conversation's panel.
    // Bubble designing opens the canvas beside the chat, never in full view.
    if (event.created && store.activeSessionId === event.sessionId) {
      store.setActiveRightUtilityTab(`design:${event.documentId}`);
      if (store.rightPanelFullscreen) store.setRightPanelFullscreen(null);
    }
  });
}
