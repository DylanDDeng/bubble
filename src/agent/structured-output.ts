/**
 * Structured output for subagents (design v2 §1.2).
 *
 * When a spawn/batch member carries an `output_schema`, its task is augmented
 * with an instruction to return ONLY JSON matching the schema; after it
 * finishes, its summary is validated against the schema, with one corrective
 * retry. The parent then gets a typed object it can branch on, rather than
 * prose to re-parse.
 *
 * The validator is a deliberately small, dependency-free subset of JSON Schema
 * — enough for LLM structured output (object/array/string/number/integer/
 * boolean/null, properties, required, items, enum, nullable). It is not a full
 * JSON Schema implementation; unknown keywords are ignored (permissive).
 */

export interface SchemaValidationOk {
  ok: true;
  value: unknown;
}
export interface SchemaValidationError {
  ok: false;
  errors: string[];
}
export type SchemaValidationResult = SchemaValidationOk | SchemaValidationError;

/** Extracts a JSON value from a child summary that may be fenced or prose-wrapped. */
export function extractJson(summary: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = (summary ?? "").trim();
  if (!text) return { ok: false, error: "empty summary" };

  const candidates: string[] = [];
  // 1) ```json … ``` or ``` … ``` fenced block.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  // 2) the whole string.
  candidates.push(text);
  // 3) the first balanced {...} or [...] span.
  const span = firstBalancedSpan(text);
  if (span) candidates.push(span);

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: "no parseable JSON found in summary" };
}

function firstBalancedSpan(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Validates a child summary: extracts JSON then checks it against the schema. */
export function validateStructuredSummary(summary: string, schema: unknown): SchemaValidationResult {
  const extracted = extractJson(summary);
  if (!extracted.ok) return { ok: false, errors: [extracted.error] };
  const errors: string[] = [];
  validateValue(extracted.value, schema, "$", errors);
  return errors.length === 0 ? { ok: true, value: extracted.value } : { ok: false, errors };
}

function validateValue(value: unknown, schema: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return; // permissive: no constraints
  const s = schema as Record<string, unknown>;

  // enum
  if (Array.isArray(s.enum)) {
    if (!s.enum.some((option) => deepEqual(option, value))) {
      errors.push(`${path}: value not in enum`);
    }
  }

  const declaredType = s.type;
  const types = Array.isArray(declaredType)
    ? declaredType.filter((t): t is string => typeof t === "string")
    : typeof declaredType === "string"
      ? [declaredType]
      : [];
  const nullable = s.nullable === true || types.includes("null");

  if (value === null) {
    if (types.length > 0 && !nullable) errors.push(`${path}: null not allowed`);
    return;
  }

  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    errors.push(`${path}: expected ${types.join("|")}, got ${jsonType(value)}`);
    return; // type mismatch — deeper checks would be noise
  }

  // object
  if (matchesType(value, "object") && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !(key in obj)) errors.push(`${path}.${key}: required`);
      }
    }
    if (s.properties && typeof s.properties === "object") {
      const props = s.properties as Record<string, unknown>;
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) validateValue(obj[key], sub, `${path}.${key}`, errors);
      }
    }
  }

  // array
  if (Array.isArray(value) && s.items && typeof s.items === "object") {
    value.forEach((item, i) => validateValue(item, s.items, `${path}[${i}]`, errors));
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true; // unknown type keyword — permissive
  }
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

/** Appends the "respond with only JSON matching this schema" instruction to a task. */
export function appendOutputSchemaInstructions(task: string, schema: unknown): string {
  return [
    task,
    "",
    "OUTPUT FORMAT (required): your entire final handoff must be a single JSON value that conforms to this JSON Schema, and nothing else — no prose before or after, no markdown fences.",
    "JSON Schema:",
    safeSchemaString(schema),
  ].join("\n");
}

/** Corrective re-prompt sent once when the first summary fails validation. */
export function buildSchemaCorrectionPrompt(schema: unknown, previous: string): string {
  return [
    "Your previous response was not valid JSON for the required schema.",
    "Reply again with ONLY a single JSON value conforming to this schema — no prose, no code fences.",
    "JSON Schema:",
    safeSchemaString(schema),
    "",
    "Your previous (invalid) response was:",
    (previous ?? "").slice(0, 2000),
  ].join("\n");
}

function safeSchemaString(schema: unknown): string {
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return String(schema);
  }
}
