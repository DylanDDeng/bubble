import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { DesktopService } from "./service.mjs";
const root = process.env.BUBBLE_SDK_ROOT;
const { BubbleSdk, encodeModel } = await import(
  pathToFileURL(join(root, "dist/sdk/index.js")).href
);
const { listBuiltinModels } = await import(
  pathToFileURL(join(root, "dist/model-catalog.js")).href
);
const sdk = new BubbleSdk({ defaultCwd: process.env.BUBBLE_DESKTOP_CWD });
function models() {
  return sdk.registry
    .getConfigured()
    .filter((p) => p.enabled)
    .flatMap((p) => {
      const cached = sdk.registry.getCachedDiscoverySnapshot(p.id)?.models;
      const custom = sdk.registry.getModelConfig().getCustomModels(p.id);
      const builtin = listBuiltinModels(
        p.id === "openai" && p.authType === "oauth" ? "openai-codex" : p.id,
      );
      const seen = new Set();
      return [...(cached ?? []), ...custom, ...builtin]
        .filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        })
        .map((m) => ({
          id: encodeModel(p.id, m.id),
          name: m.name || m.id,
          provider: p.name,
          reasoningLevels: m.reasoningLevels ?? [],
          defaultReasoningLevel: m.defaultReasoningLevel,
        }));
    });
}
const send = (value) => {
  if (process.connected) process.send(value);
};
const service = new DesktopService(sdk, (event) => send({ event }), models);
process.on("message", async ({ id, method, params }) => {
  try {
    send({ id, result: await service.call(method, params) });
  } catch (error) {
    send({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
process.on("disconnect", async () => {
  await Promise.race([
    service.close(),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  process.exit(0);
});
send({ ready: true });
