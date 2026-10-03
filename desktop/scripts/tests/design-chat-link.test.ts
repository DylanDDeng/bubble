import assert from "node:assert/strict";
import { useComposerQueueStore } from "../../src/ui/store/useComposerQueueStore";

// A queued design comment always runs as its own turn with its own context.
const q = useComposerQueueStore.getState();
const item = (id: string, extra = {}) => ({
  id,
  displayPrompt: id,
  effectivePrompt: id,
  attachments: [],
  references: {},
  ...extra,
});
q.enqueue("s", item("plain-1"));
q.enqueue("s", item("design", { exclusive: true, dispatch: () => {}, design: { commentId: "c1" } as never }));
q.enqueue("s", item("plain-2"));
const first = useComposerQueueStore.getState().takeNextBatch("s");
assert.deepEqual(first.map((i) => i.id), ["plain-1"]);
const second = useComposerQueueStore.getState().takeNextBatch("s");
assert.deepEqual(second.map((i) => i.id), ["design"]);
assert.equal(second[0].design?.commentId, "c1");
assert.deepEqual(useComposerQueueStore.getState().takeNextBatch("s").map((i) => i.id), ["plain-2"]);
console.log("Design chat link: queued comments stay exclusive turns passed");
