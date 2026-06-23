// Regenerates src/shared/aegis-built-in-catalog.ts from Bubble's real model
// catalog, so the GUI agent/model picker shows Bubble's actual models.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mc = await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
const pr = await import('@bubblebrain-ai/bubble/dist/provider-registry.js');

const providers = pr.BUILTIN_PROVIDERS.map((p) => ({
  id: p.id,
  name: p.name || p.id,
  baseUrl: p.baseURL || p.baseUrl || '',
}));

const models = mc.BUILTIN_MODELS.map((m) => ({
  id: m.id,
  name: m.name || m.id,
  providerId: m.providerId,
  contextWindow: m.contextWindow,
}));

const DEFAULT = models.find((m) => m.providerId === 'zhipuai' && m.id === 'glm-5.2') || models[0];

const j = (v) => JSON.stringify(v);
const provLines = providers.map((p) => `  { id: ${j(p.id)}, name: ${j(p.name)}, baseUrl: ${j(p.baseUrl)} },`).join('\n');
const modelLines = models
  .map((m) => `  { id: ${j(m.id)}, name: ${j(m.name)}, providerId: ${j(m.providerId)}, contextWindow: ${m.contextWindow ?? 0} },`)
  .join('\n');

const out = `// AUTO-GENERATED from Bubble's model catalog by scripts/generate-aegis-catalog.mjs.
// The "aegis" slot is Bubble; these are Bubble's real providers/models.
export interface AegisBuiltInProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
}

export interface AegisBuiltInModelDefinition {
  id: string;
  name: string;
  providerId: string;
  contextWindow?: number;
}

export const AEGIS_BUILT_IN_PROVIDERS: AegisBuiltInProviderDefinition[] = [
${provLines}
];

export const AEGIS_BUILT_IN_MODELS: AegisBuiltInModelDefinition[] = [
${modelLines}
];

export const AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID = ${j(DEFAULT.providerId)};
export const AEGIS_BUILT_IN_DEFAULT_MODEL_ID = ${j(DEFAULT.id)};
export const AEGIS_BUILT_IN_DEFAULT_MODEL = \`\${AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID}:\${AEGIS_BUILT_IN_DEFAULT_MODEL_ID}\`;

export function encodeAegisBuiltInModel(providerId: string, modelId: string): string {
  return \`\${providerId}:\${modelId}\`;
}

export function decodeAegisBuiltInModel(value: string): { providerId?: string; modelId: string } {
  if (value.includes(':')) {
    const [providerId, ...rest] = value.split(':');
    return { providerId, modelId: rest.join(':') };
  }
  return { modelId: value };
}

export function getAegisBuiltInProvider(providerId: string): AegisBuiltInProviderDefinition | undefined {
  return AEGIS_BUILT_IN_PROVIDERS.find((provider) => provider.id === providerId);
}

export function listAegisBuiltInModels(providerId: string): AegisBuiltInModelDefinition[] {
  return AEGIS_BUILT_IN_MODELS.filter((model) => model.providerId === providerId);
}

export function getAegisBuiltInModel(providerId: string, modelId: string): AegisBuiltInModelDefinition | undefined {
  return AEGIS_BUILT_IN_MODELS.find((model) => model.providerId === providerId && model.id === modelId);
}

export function resolveAegisBuiltInModel(value?: string | null, providerId?: string | null): {
  providerId: string;
  modelId: string;
  encoded: string;
} {
  const decoded = decodeAegisBuiltInModel((value || '').trim() || AEGIS_BUILT_IN_DEFAULT_MODEL);
  const explicitProviderId = decoded.providerId || providerId?.trim();
  const providerModel = explicitProviderId
    ? getAegisBuiltInModel(explicitProviderId, decoded.modelId)
    : undefined;
  const inferredModel = providerModel
    || AEGIS_BUILT_IN_MODELS.find((model) => model.id === decoded.modelId)
    || getAegisBuiltInModel(AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID, AEGIS_BUILT_IN_DEFAULT_MODEL_ID);
  const resolvedProviderId = inferredModel?.providerId || AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID;
  const resolvedModelId = inferredModel?.id || AEGIS_BUILT_IN_DEFAULT_MODEL_ID;
  return {
    providerId: resolvedProviderId,
    modelId: resolvedModelId,
    encoded: encodeAegisBuiltInModel(resolvedProviderId, resolvedModelId),
  };
}
`;

writeFileSync(resolve(root, 'src/shared/aegis-built-in-catalog.ts'), out);
console.log(`wrote aegis catalog: ${providers.length} providers, ${models.length} models, default ${DEFAULT.providerId}:${DEFAULT.id}`);
