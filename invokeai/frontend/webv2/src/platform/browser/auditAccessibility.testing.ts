import axe from 'axe-core';

import { settleAnimations } from './settleAnimations.testing';

/**
 * Run an accessibility audit against settled UI.
 *
 * The settling is the point. Auditing a surface that is still animating in reports colour
 * contrast against a half-composited backdrop — see {@link settleAnimations} — and the failure
 * is load-dependent, so it lands on whoever next adds an unrelated test file rather than on
 * whoever wrote the audit. Pairing the two here rather than leaving `settleAnimations` to be
 * remembered at each call site is what keeps that from coming back; `architecture/axeAudits`
 * holds callers to it.
 *
 * Returns the violations rather than asserting, so a caller still chooses what to expect of
 * them — usually `toEqual([])`, which prints the offending nodes and colours on failure.
 */
export const auditAccessibility = async (target: Element): Promise<axe.Result[]> => {
  await settleAnimations();

  return (await axe.run(target)).violations;
};
