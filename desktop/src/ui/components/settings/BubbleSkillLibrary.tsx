import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RefreshCw } from '../icons';
import { useAppStore } from '../../store/useAppStore';
import type { ProviderListSkillsResult, ProviderSkillDescriptor } from '../../types';
import { CodexSkillDetailDialog, SkillListPane } from './CodexPluginLibrary';

const EMPTY_SKILLS_RESULT: ProviderListSkillsResult = {
  skills: [],
  source: 'empty',
  cached: false,
};

function normalizeRemoteErrorMessage(error: unknown, fallback: string): string {
  const rawMessage = error instanceof Error ? error.message : fallback;
  return rawMessage.replace(/^Error invoking remote method '[^']+':\s*/, '').trim();
}

function normalizeSearchText(value: string | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/[:/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function skillSearchBlob(skill: ProviderSkillDescriptor): string {
  return normalizeSearchText(
    [skill.name, skill.description, skill.scope].filter(Boolean).join('\n')
  );
}

/** Skills and full documents are resolved through the local Bubble SDK. */
export function BubbleSkillLibraryContent() {
  const { activeSessionId, sessions, projectCwd } = useAppStore();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ProviderListSkillsResult>(EMPTY_SKILLS_RESULT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [skillContent, setSkillContent] = useState<{
    path: string;
    content: string | null;
    error: string | null;
  } | null>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const discoveryCwd = activeSession?.cwd || projectCwd || undefined;
  const normalizedQuery = normalizeSearchText(query);

  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return result.skills;
    return result.skills.filter((skill) => skillSearchBlob(skill).includes(normalizedQuery));
  }, [normalizedQuery, result.skills]);

  const selectedSkill = useMemo(
    () => result.skills.find((skill) => skill.path === selectedPath) || null,
    [result.skills, selectedPath]
  );

  const loadSkills = async (forceReload = false) => {
    setLoading(true);
    setError(null);
    try {
      setResult(await window.electron.listBubbleSkills({ cwd: discoveryCwd, forceReload }));
    } catch (loadError) {
      setResult(EMPTY_SKILLS_RESULT);
      setError(normalizeRemoteErrorMessage(loadError, 'Failed to load Bubble skills.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSkills();
  }, [discoveryCwd]);

  const openSkillDetail = async (skill: ProviderSkillDescriptor) => {
    setSelectedPath(skill.path);
    setSkillContent({
      path: skill.path,
      content: null,
      error: null,
    });
    setDetailOpen(true);
    try {
      const result = await window.electron.readBubbleSkillContent(skill.name, discoveryCwd);
      setSkillContent({ path: skill.path, content: result.content || null, error: result.ok ? null : result.message || 'Could not read skill.' });
    } catch (error) {
      setSkillContent({ path: skill.path, content: null, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => void loadSkills(true)}
          disabled={loading}
          className="inline-flex h-8 items-center gap-2 rounded-full border border-[var(--border)] px-3 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span>Refresh</span>
        </button>
      </div>

      <SkillListPane
        skills={filteredSkills}
        loading={loading}
        error={error}
        discoveryCwd={discoveryCwd}
        query={query}
        subtitle="Extend Bubble with task-specific skills"
        onQueryChange={setQuery}
        onSelect={openSkillDetail}
      />

      <CodexSkillDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        skill={selectedSkill}
        content={skillContent}
        mentionPrefix="/"
      />
    </div>
  );
}
