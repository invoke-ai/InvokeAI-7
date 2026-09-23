export const getImageMapClickSelectsCluster = (values: Record<string, unknown>): boolean =>
  values.clickSelectsCluster === true;

/** Labels are drawn unless the user has turned them off. */
export const getImageMapShowClusterLabels = (values: Record<string, unknown>): boolean =>
  values.showClusterLabels !== false;
