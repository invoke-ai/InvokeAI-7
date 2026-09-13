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

/** What the viewer is allowed to change, beyond what they own. */
export interface SystemPromptEditAuthority extends SystemPromptAccount {
  /** Admin-derived. Grants edit rights over shared prompts only -- see `canEditSystemPrompt`. */
  canManageSharedPrompts: boolean;
}

/**
 * Own prompts always; shared ones when the viewer may manage them.
 *
 * Deliberately never true for another user's private prompt: the REST layer does let an admin
 * write one, but offering it here would turn a moderation capability into an everyday button.
 * `classifySystemPrompts` already keeps those records out of the list, and this is the second
 * guard so that a change to the first cannot silently expose them.
 */
export const canEditSystemPrompt = (
  record: SystemPromptOwnershipRecord,
  authority: SystemPromptEditAuthority
): boolean => isOwnedSystemPrompt(record, authority) || (authority.canManageSharedPrompts && record.isPublic);

export class SystemPromptOwnershipError extends Error {
  constructor() {
    super('Only your own system prompts, or shared ones you manage, can be changed.');
    this.name = 'SystemPromptOwnershipError';
  }
}

export const requireEditableSystemPrompt = (
  record: SystemPromptOwnershipRecord,
  authority: SystemPromptEditAuthority
): void => {
  if (!canEditSystemPrompt(record, authority)) {
    throw new SystemPromptOwnershipError();
  }
};

/**
 * A name for a copy that does not collide with one already in the list.
 *
 * Duplicating twice gives "... (copy)" then "... (copy 2)". A source that is itself a copy keeps
 * its suffix rather than being parsed apart, so the chain stays readable and the rule stays one
 * anyone can predict from the name they are looking at.
 */
export const buildDuplicateName = (sourceName: string, existingNames: Iterable<string>): string => {
  const taken = new Set(existingNames);
  const base = `${sourceName} (copy)`;

  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${sourceName} (copy ${String(suffix)})`;

    if (!taken.has(candidate)) {
      return candidate;
    }
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
