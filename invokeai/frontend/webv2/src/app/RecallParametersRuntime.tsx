import { getAuthSession } from '@features/identity';
import { useMountEffect } from '@platform/react/useMountEffect';
import { socketHub } from '@platform/transport/socketHub';
import { attachRecallParametersRuntime } from '@workbench/image-actions/recallParametersBridge';
import { useWorkbenchInternalStore } from '@workbench/WorkbenchContext';
import { useTranslation } from 'react-i18next';

/** Single-user servers tag events with a system user id, so only multi-user sessions can be fenced. */
const getSessionUserId = (): string | null => {
  const session = getAuthSession();
  return session.multiuserEnabled ? (session.user?.user_id ?? null) : null;
};

/** App-owned composition: external `POST /api/v1/recall` updates land in the active project's Generate panel. */
export const RecallParametersRuntime = () => {
  const store = useWorkbenchInternalStore();
  // Captured once at mount; i18next resolves it against the current language at each call.
  const { t } = useTranslation();

  useMountEffect(
    () =>
      attachRecallParametersRuntime({
        commands: store.commands,
        getSessionUserId,
        hub: socketHub,
        queries: store.queries,
        t,
      }).dispose
  );

  return null;
};
