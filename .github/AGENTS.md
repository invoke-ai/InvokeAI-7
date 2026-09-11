# CI and contributions

- Shared engineering and package rules live in the root `AGENTS.md`. Read the affected package's guidance before changing checks.
- Preserve supported events: pull requests, main pushes, merge groups, manual dispatch, and reusable workflow calls. Never assume `github.base_ref` is populated outside a PR event.
- Include the workflow itself and relevant shared actions/configuration in change detection. Test-only and tooling-only changes must reach their owning checks; skipped work must not hide required validation.
- Use existing Node/Python/pnpm/uv versions and lockfiles. Keep dependency installs reproducible and respect hardware/platform matrices. Preserve pinned action revisions where used.
- Prefer package completion commands over reproducing their internals in YAML. Webv2's `pnpm check:release` includes architecture, tests, performance/build, project files, and accessibility; install Chromium and required Linux dependencies first.
- Preserve diagnostic artifacts on failure with `always()` where appropriate. Keep generated review/performance artifacts out of Git. Distinguish real checks from skipped or unavailable checks.
- Keep hooks aligned with CI's Ruff version/configuration. Do not add formatter rewrites to validation or silently relax failures/budgets to make a new gate green.
- PR descriptions use `pull_request_template.md` in this directory as written. Summary leads with the problem and resulting behavior; QA Instructions list actual commands and results and state skipped, failing, or unavailable checks; Review summarizes material findings resolved and the final blocker-only result; Compatibility / Rollout appears only when applicable. Include relevant UI evidence or performance measurements. Keep summaries short; do not attach planning logs.
- Workflow files add checks but do not configure hosted branch protection or install local hooks. Do not claim either happened without verification.
