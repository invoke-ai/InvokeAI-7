import type { SystemPromptDraft, SystemPromptRecord } from '@features/generation/data/systemPrompts';

import {
  buildDuplicateName,
  canEditSystemPrompt,
  classifySystemPrompts,
  requireEditableSystemPrompt,
  type SystemPromptEditAuthority,
} from '@features/generation/core/systemPrompts';
import {
  createSystemPrompt,
  deleteSystemPrompt,
  invalidateSystemPrompts,
  systemPromptsQueryOptions,
  updateSystemPrompt,
} from '@features/generation/data/systemPrompts';
import { useGenerationUi } from '@features/generation/ui/GenerationUiContext';
import { assertAccountScopeCurrent, captureAccountScope } from '@platform/state/accountLifecycle';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

export interface SystemPromptCatalog {
  personalPrompts: SystemPromptRecord[];
  sharedPrompts: SystemPromptRecord[];
  prompts: SystemPromptRecord[];
  isLoading: boolean;
  isLoaded: boolean;
  canEdit: (prompt: SystemPromptRecord) => boolean;
  create: (draft: SystemPromptDraft) => Promise<SystemPromptRecord>;
  /** Copies any visible prompt into one this account owns. Needs no management rights. */
  duplicate: (prompt: SystemPromptRecord) => Promise<SystemPromptRecord>;
  update: (prompt: SystemPromptRecord, draft: SystemPromptDraft) => Promise<SystemPromptRecord>;
  remove: (prompt: SystemPromptRecord) => Promise<void>;
}

export const useSystemPrompts = ({ isEnabled = true }: { isEnabled?: boolean } = {}): SystemPromptCatalog => {
  const queryClient = useQueryClient();
  const { account, capabilities } = useGenerationUi();
  const query = useQuery({ ...systemPromptsQueryOptions(), enabled: isEnabled });
  const classified = useMemo(() => classifySystemPrompts(query.data ?? [], account), [account, query.data]);
  const authority = useMemo<SystemPromptEditAuthority>(
    () => ({ ...account, canManageSharedPrompts: capabilities.canManageSharedSystemPrompts }),
    [account, capabilities.canManageSharedSystemPrompts]
  );

  const runAndInvalidate = useCallback(
    async <T>(run: () => Promise<T>): Promise<T> => {
      const owner = captureAccountScope();
      const result = await run();

      assertAccountScopeCurrent(owner);
      await invalidateSystemPrompts(queryClient);
      return result;
    },
    [queryClient]
  );

  const create = useCallback(
    (draft: SystemPromptDraft) => runAndInvalidate(() => createSystemPrompt(draft)),
    [runAndInvalidate]
  );

  const update = useCallback(
    (prompt: SystemPromptRecord, draft: SystemPromptDraft) => {
      // Mirrors the affordance so a mis-rendered edit control fails here rather than as a 403 --
      // and so the one case the API would allow but this UI does not, another user's private
      // prompt, cannot be reached from the client at all.
      requireEditableSystemPrompt(prompt, authority);
      return runAndInvalidate(() => updateSystemPrompt(prompt.id, draft));
    },
    [authority, runAndInvalidate]
  );

  const duplicate = useCallback(
    (prompt: SystemPromptRecord) =>
      runAndInvalidate(() =>
        createSystemPrompt({
          content: prompt.content,
          maxTokens: prompt.maxTokens,
          // Taken from the list the viewer can see, which is the same list the new name has to
          // be distinguishable in.
          name: buildDuplicateName(
            prompt.name,
            classified.prompts.map((visible) => visible.name)
          ),
        })
      ),
    [classified.prompts, runAndInvalidate]
  );

  const remove = useCallback(
    (prompt: SystemPromptRecord) => {
      requireEditableSystemPrompt(prompt, authority);
      return runAndInvalidate(() => deleteSystemPrompt(prompt.id));
    },
    [authority, runAndInvalidate]
  );

  const canEdit = useCallback((prompt: SystemPromptRecord) => canEditSystemPrompt(prompt, authority), [authority]);

  return {
    canEdit,
    create,
    duplicate,
    isLoaded: query.isSuccess,
    isLoading: query.isPending,
    personalPrompts: classified.personalPrompts,
    prompts: classified.prompts,
    remove,
    sharedPrompts: classified.sharedPrompts,
    update,
  };
};
