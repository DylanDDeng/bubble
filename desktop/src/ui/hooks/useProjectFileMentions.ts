import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ProjectTreeNode } from '../types';
import {
  filterProjectFileSuggestions,
  flattenProjectTreeFiles,
  getProjectFileMentionState,
  type ProjectFileSuggestion,
} from '../utils/project-file-mentions';

export function useProjectFileMentions({
  cwd,
  prompt,
  cursorIndex,
}: {
  cwd?: string | null;
  prompt: string;
  cursorIndex: number;
}) {
  const { projectTree, projectTreeCwd, setProjectTree } = useAppStore();
  const [localTree, setLocalTree] = useState<ProjectTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Restored drafts must not start filesystem work merely by mounting.
  const [edited, setEdited] = useState<{ cwd: string | null | undefined; prompt: string } | null>(null);
  const userRequested = edited?.cwd === cwd && edited?.prompt === prompt;
  const mention = useMemo(() => getProjectFileMentionState(prompt, cursorIndex), [cursorIndex, prompt]);
  const hasMentionQuery = userRequested && mention !== null;

  useEffect(() => {
    const current = cwd?.trim() || '';
    if (!current || !hasMentionQuery) {
      setLocalTree(null);
      setLoading(false);
      return;
    }

    if (projectTreeCwd === current && projectTree) {
      setLocalTree(projectTree);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const treeRequestId = crypto.randomUUID();
    setLoading(true);
    window.electron
      .getProjectTree(current, treeRequestId)
      .then((tree) => {
        if (cancelled) return;
        setLocalTree(tree);
        // The Files panel may be temporarily rooted on an external folder
        // (Grok session images, citation paths). Overwriting that cache
        // blanks the rail with "No files found".
        const cacheCwd = useAppStore.getState().projectTreeCwd;
        if (!cacheCwd || cacheCwd === current) {
          setProjectTree(current, tree);
        }
      })
      .catch(() => {
        if (!cancelled) setLocalTree(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      void window.electron.cancelProjectTreeRead(treeRequestId);
    };
  }, [cwd, hasMentionQuery, projectTree, projectTreeCwd, setProjectTree]);

  const files = useMemo(
    () => flattenProjectTreeFiles(localTree, cwd?.trim() || ''),
    [cwd, localTree]
  );

  const suggestions = useMemo(
    () => (hasMentionQuery && mention ? filterProjectFileSuggestions(files, mention.query) : []),
    [files, mention, hasMentionQuery]
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    if (selectedIndex < suggestions.length) {
      return;
    }

    setSelectedIndex(0);
  }, [selectedIndex, suggestions.length]);

  return {
    loading,
    mention,
    hasMentionQuery,
    onUserInput: (nextPrompt: string) => setEdited({ cwd, prompt: nextPrompt }),
    suggestions,
    selectedIndex,
    setSelectedIndex,
    moveSelection: (direction: 1 | -1) => {
      if (suggestions.length === 0) {
        return;
      }

      setSelectedIndex((current) => {
        const next = current + direction;
        if (next < 0) {
          return suggestions.length - 1;
        }
        if (next >= suggestions.length) {
          return 0;
        }
        return next;
      });
    },
    getCurrentSuggestion: (): ProjectFileSuggestion | null => suggestions[selectedIndex] || null,
  };
}
