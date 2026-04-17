export interface SkillMeta {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  version?: number;
  tags?: string[];
}

export interface SkillResourceIndex {
  references: string[];
  scripts: string[];
  assets: string[];
}

export interface SkillRecord {
  meta: SkillMeta;
  rootDir: string;
  skillFile: string;
  content: string;
  resources: SkillResourceIndex;
  source: "user" | "project" | "configured";
}

export interface SkillSummary {
  name: string;
  description: string;
  tags?: string[];
  source?: "user" | "project" | "configured";
}

export interface SkillDiagnostic {
  level: "warning" | "error";
  skillName?: string;
  filePath?: string;
  message: string;
}

