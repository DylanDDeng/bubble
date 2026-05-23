import type { Env, FeedbackPayload, TranscriptMessage } from "./types.js";
import { checkRateLimit } from "./rate-limit.js";
import { createIssue } from "./github.js";
import { redact } from "./redact.js";

const MAX_BODY_BYTES = 200_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (req.method !== "POST") return text("Method not allowed", 405);

    const url = new URL(req.url);
    if (url.pathname !== "/submit") return text("Not found", 404);

    const body = await req.text();
    if (body.length === 0) return text("Empty body", 400);
    if (body.length > MAX_BODY_BYTES) return text("Payload too large", 413);

    const auth = req.headers.get("x-bubble-auth") ?? "";
    if (!(await verifyHmac(body, auth, env.CLIENT_SECRET))) {
      return text("Forbidden", 403);
    }

    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    const rate = await checkRateLimit(env.RATE_KV, ip);
    if (!rate.allowed) return text(rate.reason ?? "Rate limited", 429);

    let payload: FeedbackPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      return text("Invalid JSON", 400);
    }

    const validation = validatePayload(payload);
    if (!validation.ok) return text(validation.reason, 400);

    const title = buildTitle(payload);
    const issueBody = buildIssueBody(payload);
    const labels = [
      "feedback",
      "user-submitted",
      "triage",
      `v${payload.version}`,
    ];

    try {
      const issue = await createIssue(env.GITHUB_TOKEN, env.FEEDBACK_REPO, {
        title,
        body: issueBody,
        labels,
      });
      return json({ url: issue.html_url, number: issue.number });
    } catch (err) {
      console.error("github error", err);
      return text("Upstream error creating issue", 502);
    }
  },
} satisfies ExportedHandler<Env>;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Bubble-Auth",
    "Access-Control-Max-Age": "86400",
  };
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

async function verifyHmac(body: string, headerHex: string, secret: string): Promise<boolean> {
  if (!headerHex || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = bytesToHex(new Uint8Array(sig));
  return timingSafeEqual(expected, headerHex.toLowerCase());
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) {
    out += b[i].toString(16).padStart(2, "0");
  }
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function validatePayload(p: unknown): { ok: true } | { ok: false; reason: string } {
  if (!p || typeof p !== "object") return { ok: false, reason: "payload not an object" };
  const r = p as Record<string, unknown>;
  if (typeof r.description !== "string") return { ok: false, reason: "description required" };
  if (typeof r.version !== "string") return { ok: false, reason: "version required" };
  if (typeof r.platform !== "string") return { ok: false, reason: "platform required" };
  if (typeof r.clientId !== "string") return { ok: false, reason: "clientId required" };
  if (!Array.isArray(r.transcript)) return { ok: false, reason: "transcript must be array" };
  // Light spam filter: empty description AND empty transcript is useless.
  const desc = r.description.trim();
  if (desc.length === 0 && r.transcript.length === 0) {
    return { ok: false, reason: "description or transcript required" };
  }
  // Reject obvious garbage: description is a single repeated character.
  if (desc.length > 5 && /^(.)\1+$/.test(desc)) {
    return { ok: false, reason: "description looks like junk" };
  }
  return { ok: true };
}

function buildTitle(p: FeedbackPayload): string {
  const firstLine = (p.description.split("\n")[0] ?? "").trim().slice(0, 60);
  const head = firstLine || "Bubble feedback";
  return `[feedback] ${redact(head)} (v${p.version})`;
}

function buildIssueBody(p: FeedbackPayload): string {
  const safeDescription = redact(p.description);
  const safeTranscript: TranscriptMessage[] = p.transcript.map((m) => ({
    ...m,
    content: redact(m.content),
  }));
  const safeError = p.recentError ? redact(p.recentError) : "";

  const lines: string[] = [];
  lines.push("## Description");
  lines.push("");
  lines.push(safeDescription.trim() || "_(empty)_");
  lines.push("");
  lines.push("## Environment");
  lines.push("");
  lines.push(`- Bubble: \`v${p.version}\``);
  lines.push(`- Platform: \`${p.platform}/${p.arch}\``);
  lines.push(`- Node: \`${p.nodeVersion}\``);
  lines.push(`- Provider: \`${p.provider}\` · Model: \`${p.model}\``);
  lines.push("");

  if (safeError) {
    lines.push("## Recent error");
    lines.push("");
    lines.push("```");
    lines.push(safeError);
    lines.push("```");
    lines.push("");
  }

  if (safeTranscript.length > 0) {
    lines.push("## Conversation excerpt");
    lines.push("");
    lines.push("<details><summary>Last messages (click to expand)</summary>");
    lines.push("");
    for (const m of safeTranscript) {
      const label = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "error";
      lines.push(`**${label}:**`);
      lines.push("");
      lines.push("```");
      lines.push(m.content);
      lines.push("```");
      lines.push("");
    }
    lines.push("</details>");
    lines.push("");
  }

  lines.push("---");
  lines.push(`_Submitted ${new Date(p.submittedAt).toISOString()} · clientId \`${p.clientId}\`_`);
  return lines.join("\n");
}
