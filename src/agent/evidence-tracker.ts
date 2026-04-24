import type { ParsedToolCall, ToolResult } from "../types.js";

export interface InvestigationCoverage {
  configLoadPaths: boolean;
  envReads: boolean;
  persistencePaths: boolean;
  exposurePaths: boolean;
  maskingSignals: boolean;
}

const DEFAULT_COVERAGE: InvestigationCoverage = {
  configLoadPaths: false,
  envReads: false,
  persistencePaths: false,
  exposurePaths: false,
  maskingSignals: false,
};

const CONFIG_PATTERNS = [
  /\bconfig\.(json|ya?ml|toml|ini)\b/i,
  /\bsettings\.(json|ya?ml|toml)\b/i,
  /\bauth\.json\b/i,
  /\buserconfig\b/i,
  /\breadfilesync\b/i,
];

const ENV_PATTERNS = [
  /\bprocess\.env\b/i,
  /\bimport\.meta\.env\b/i,
  /\bgetenv\(/i,
  /\bloadenv\b/i,
  /\bdotenv\b/i,
  /\b\.env\b/i,
];

const PERSISTENCE_PATTERNS = [
  /\bwritefilesync\b/i,
  /\bwritefile\b/i,
  /\bauth\.json\b/i,
  /\bconfig\.json\b/i,
  /\blocalstorage\b/i,
  /\bsqlite\b/i,
  /\bkeychain\b/i,
  /\bcredential\b/i,
  /\bstore\b/i,
];

const EXPOSURE_PATTERNS = [
  /\bconsole\.log\b/i,
  /\blogger\./i,
  /\bres\.json\b/i,
  /\breturn\s+\{/i,
  /\bwindow\./i,
  /\bdocument\./i,
  /\bserialize\b/i,
  /\bresponse\b/i,
];

const MASKING_PATTERNS = [
  /\bmask(key|ed)?\b/i,
  /\bredact(ed|ion)?\b/i,
  /\bhidden\b/i,
  /\bobfuscated\b/i,
  /\*\*\*\*/i,
  /\.\.\./i,
];

export class EvidenceTracker {
  private coverage: InvestigationCoverage = { ...DEFAULT_COVERAGE };

  observe(toolCall: Pick<ParsedToolCall, "name" | "parsedArgs">, result: ToolResult): void {
    const haystack = [
      typeof toolCall.parsedArgs.path === "string" ? toolCall.parsedArgs.path : "",
      typeof toolCall.parsedArgs.command === "string" ? toolCall.parsedArgs.command : "",
      typeof toolCall.parsedArgs.pattern === "string" ? toolCall.parsedArgs.pattern : "",
      result.content,
    ].join("\n");

    if (!this.coverage.configLoadPaths && matchesAny(CONFIG_PATTERNS, haystack)) {
      this.coverage.configLoadPaths = true;
    }
    if (!this.coverage.envReads && matchesAny(ENV_PATTERNS, haystack)) {
      this.coverage.envReads = true;
    }
    if (!this.coverage.persistencePaths && matchesAny(PERSISTENCE_PATTERNS, haystack)) {
      this.coverage.persistencePaths = true;
    }
    if (!this.coverage.exposurePaths && matchesAny(EXPOSURE_PATTERNS, haystack)) {
      this.coverage.exposurePaths = true;
    }
    if (!this.coverage.maskingSignals && matchesAny(MASKING_PATTERNS, haystack)) {
      this.coverage.maskingSignals = true;
    }
  }

  snapshot(): InvestigationCoverage {
    return { ...this.coverage };
  }

  key(): string {
    const coverage = this.snapshot();
    return Object.values(coverage).map((value) => (value ? "1" : "0")).join("");
  }

  isCoreCoverageComplete(): boolean {
    return this.coverage.configLoadPaths
      && this.coverage.envReads
      && this.coverage.persistencePaths
      && this.coverage.exposurePaths;
  }
}

function matchesAny(patterns: RegExp[], haystack: string): boolean {
  return patterns.some((pattern) => pattern.test(haystack));
}
