/**
 * System prompts steer the Expand Prompt LLM. They are user-owned named records that may be
 * shared with everyone on the install.
 *
 * Ownership mirrors prompt templates, with one deliberate difference: there is no "default"
 * flag. The backend seeds its built-ins under the user id `system`, but that same id is what
 * *every* request carries in single-user mode, so an install that later switched to multiuser
 * has ordinary user-created prompts owned by `system` too. Visibility and editability are
 * therefore decided by `is_public` and ownership alone — never by comparing against `system`.
 */

export interface SystemPromptAccount {
  currentUserId: string | null;
  multiuserEnabled: boolean;
}

interface SystemPromptOwnershipRecord {
  isPublic: boolean;
  userId: string;
}

export interface ClassifiedSystemPrompts<T> {
  personalPrompts: T[];
  sharedPrompts: T[];
  /** The records visible to this account, personal first. */
  prompts: T[];
}

export const classifySystemPrompts = <T extends SystemPromptOwnershipRecord>(
  records: readonly T[],
  account: SystemPromptAccount
): ClassifiedSystemPrompts<T> => {
  const personalPrompts: T[] = [];
  const sharedPrompts: T[] = [];

  for (const record of records) {
    if (!account.multiuserEnabled || record.userId === account.currentUserId) {
      personalPrompts.push(record);
    } else if (record.isPublic) {
      sharedPrompts.push(record);
    }
  }

  return { personalPrompts, prompts: [...personalPrompts, ...sharedPrompts], sharedPrompts };
};

export const isOwnedSystemPrompt = (record: SystemPromptOwnershipRecord, account: SystemPromptAccount): boolean =>
  !account.multiuserEnabled || (account.currentUserId !== null && record.userId === account.currentUserId);

export class SystemPromptOwnershipError extends Error {
  constructor() {
    super('Only personal system prompts can be changed.');
    this.name = 'SystemPromptOwnershipError';
  }
}

export const requireOwnedSystemPrompt = (record: SystemPromptOwnershipRecord, account: SystemPromptAccount): void => {
  if (!isOwnedSystemPrompt(record, account)) {
    throw new SystemPromptOwnershipError();
  }
};

/**
 * The selection that should actually be in effect.
 *
 * The stored id outlives the record it points at — another tab can delete it, and a shared
 * prompt stops being visible when its owner unshares it. Rather than persist a corrective
 * write, the selection is resolved on read: a stale id falls back to the first visible prompt,
 * which is also what an install with no selection yet gets. Returns null only when there is
 * nothing to select.
 */
export const resolveSelectedSystemPromptId = (
  prompts: readonly { id: string }[],
  selectedId: string | null
): string | null => {
  if (selectedId !== null && prompts.some((prompt) => prompt.id === selectedId)) {
    return selectedId;
  }

  return prompts[0]?.id ?? null;
};

/**
 * Bounds the Expand Prompt endpoint enforces on a per-prompt output-token cap
 * (`ExpandPromptRequest.max_tokens`). Kept here so the editor can reject a bad value in place
 * rather than surfacing a 422.
 */
export const SYSTEM_PROMPT_MAX_TOKENS_MIN = 1;
export const SYSTEM_PROMPT_MAX_TOKENS_MAX = 2048;
/** What the backend uses when a prompt names no cap of its own. Shown as the field's placeholder. */
export const SYSTEM_PROMPT_MAX_TOKENS_DEFAULT = 300;

/** `null` = leave it to the backend default; `'invalid'` = not saveable. */
export type ParsedMaxTokens = number | null | 'invalid';

/**
 * Reads the editor's max-tokens input.
 *
 * The draft holds the raw string rather than a number so a half-typed value is never clamped
 * out from under the user; the result is only interpreted on save.
 */
export const parseMaxTokensInput = (raw: string): ParsedMaxTokens => {
  const trimmed = raw.trim();

  if (trimmed === '') {
    return null;
  }

  // Deliberately strict: `Number('12e3')` and `Number(' 12 ')` both parse, and neither is a
  // token count anyone meant to type.
  if (!/^\d+$/.test(trimmed)) {
    return 'invalid';
  }

  const parsed = Number(trimmed);

  if (parsed < SYSTEM_PROMPT_MAX_TOKENS_MIN || parsed > SYSTEM_PROMPT_MAX_TOKENS_MAX) {
    return 'invalid';
  }

  return parsed;
};
