import { useAuthSession, type AuthSession } from './session';

export interface Capabilities {
  /** Server-wide runtime config (e.g. which GPUs generate); `PATCH /app/runtime_config` is admin-only. */
  canManageAppConfig: boolean;
  /** The image map's supplementary cluster-label vocabulary; the PUT route is admin-only. */
  canManageImageMapVocabulary: boolean;
  canManageModels: boolean;
  canManageNodes: boolean;
  /** Upload, delete, and rescan shared fonts; all authenticated users can read fonts. */
  canManageSharedFonts: boolean;
  /** Bulk import/export of prompt templates; the routes are admin-only. */
  canManagePromptTemplates: boolean;
  /** Edit prompts shared with everyone. Never covers another user's private prompt. */
  canManageSharedSystemPrompts: boolean;
  canManageUsers: boolean;
}

export const getCapabilities = (session: AuthSession): Capabilities => {
  if (session.phase !== 'ready') {
    return {
      canManageAppConfig: false,
      canManageImageMapVocabulary: false,
      canManageModels: false,
      canManageNodes: false,
      canManageSharedFonts: false,
      canManagePromptTemplates: false,
      canManageSharedSystemPrompts: false,
      canManageUsers: false,
    };
  }

  const isSingleUser = !session.multiuserEnabled;
  const isAdmin = isSingleUser || session.user?.is_admin === true;

  return {
    canManageAppConfig: isAdmin,
    canManageImageMapVocabulary: isAdmin,
    canManageModels: isAdmin,
    canManageNodes: isAdmin,
    canManageSharedFonts: isAdmin,
    // Matches the routers' `AdminUserOrDefault`: everyone qualifies in
    // single-user mode, only admins once multiuser is on.
    canManagePromptTemplates: isAdmin,
    // The router lets an admin write any prompt; the UI offers it only for shared ones, so an
    // admin never edits another user's private prompt by accident.
    canManageSharedSystemPrompts: isAdmin,
    canManageUsers: session.multiuserEnabled && session.user?.is_admin === true,
  };
};

export const useCapabilities = (): Capabilities => getCapabilities(useAuthSession());
