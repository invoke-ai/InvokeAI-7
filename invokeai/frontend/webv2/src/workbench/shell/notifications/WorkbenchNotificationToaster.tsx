import type { WorkbenchNotificationKind } from '@workbench/projectContracts';

import { toaster } from '@platform/ui';
import { useWorkbenchPreferenceSelector } from '@workbench/settings/store';
import { useWorkbenchSelector } from '@workbench/WorkbenchContext';
import { useEffect, useRef } from 'react';

import { getToastKey, shouldToastNotification } from './toastPolicy';

const notificationToastType: Record<WorkbenchNotificationKind, 'error' | 'info' | 'success'> = {
  error: 'error',
  info: 'info',
  success: 'success',
};

export const WorkbenchNotificationToaster = () => {
  const notifications = useWorkbenchSelector((snapshot) => snapshot.notifications);
  const notifyOnEnqueue = useWorkbenchPreferenceSelector((prefs) => prefs.notifyOnEnqueue);
  const toastedNotificationIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (toastedNotificationIdsRef.current === null) {
      toastedNotificationIdsRef.current = new Set(notifications.map(getToastKey));
      return;
    }

    for (const notification of [...notifications].reverse()) {
      const toastKey = getToastKey(notification);

      if (toastedNotificationIdsRef.current.has(toastKey)) {
        continue;
      }

      toastedNotificationIdsRef.current.add(toastKey);

      if (!shouldToastNotification(notification, { notifyOnEnqueue })) {
        continue;
      }

      queueMicrotask(() => {
        toaster.create({
          description: notification.message,
          title: notification.title,
          type: notificationToastType[notification.kind],
        });
      });
    }
  }, [notifications, notifyOnEnqueue]);

  return null;
};
