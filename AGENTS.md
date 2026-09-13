# Working on InvokeAI

## Communication

- Speak plainly and matter-of-factly. Assume readers benefit from short, skimmable updates; avoid filler, ceremony, and repeated status summaries.
- Ask only when a decision cannot be inferred safely from the repository or request. Continue authorized work without repeated permission requests.
- Lead with outcomes, blockers, and concrete evidence. Distinguish verified results from assumptions and checks you could not run.

## Find the right owner

Before editing, read the applicable `AGENTS.md` files along each target path, even when starting at the repository root. Scoped guidance adds to these rules. `CLAUDE.md` files only import their sibling `AGENTS.md`; keep policy canonical here.

| Area | Guidance and source of truth |
| --- | --- |
| Active frontend | [webv2/AGENTS.md](invokeai/frontend/webv2/AGENTS.md), its `ARCHITECTURE.md` and executable architecture policy |
| API, services, invocations | [app/AGENTS.md](invokeai/app/AGENTS.md) |
| Inference and model management | [backend/AGENTS.md](invokeai/backend/AGENTS.md) |
| Python tests | [tests/AGENTS.md](tests/AGENTS.md); also read guidance for the production code under test |
| Legacy frontend and generated API artifacts | [web/AGENTS.md](invokeai/frontend/web/AGENTS.md) |
| CI and contribution tooling | [.github/AGENTS.md](.github/AGENTS.md) |
| Documentation | `docs/README.md` and `docs/package.json`; keep documentation about the implemented product current |

Ordinary frontend features and fixes target **webv2**. The backend serves it when launched with `--webv2`; a default launch still selects legacy web. Verify the build and launch target when investigating UI behavior. Legacy web still owns generated OpenAPI/type artifacts.

## Engineering standard

- Produce correct, functional, efficient, maintainable, DRY, production-quality code. Inspect implementations, callers, contracts, and existing tests before designing changes.
- Define the observable outcome and relevant validation. For bugs, establish a reproduction or failing behavioral test where feasible, then address the root cause. Reconsider the design when narrow fixes keep accumulating.
- Consider edge cases, failure modes, data lifecycle, and operational limits. Keep ownership explicit and concentrate behavior behind small interfaces.
- Every function, abstraction, dependency, fallback, and test must earn its place. Avoid pass-through wrappers, speculative extensibility, redundant validation, unnecessary configuration, and one-use abstractions that hide no meaningful complexity.
- Small adapters are useful when they translate contracts, isolate dependencies, or own a lifecycle. Extract shared behavior when it prevents drift or simplifies callers; do not abstract merely because code looks similar.
- Remove code, tests, and scaffolding made obsolete by the change. Preserve unrelated work and avoid drive-by rewrites.
- Comment only non-obvious intent, constraints, or trade-offs. Do not narrate code.
- Tests should protect meaningful behavior and catch a plausible regression. Avoid trivial constant/type/re-export assertions, expected values recomputed by the implementation's algorithm, and mocks that only verify internal choreography.
- Test through the interface that owns the behavior. Prefer real lightweight dependencies and isolated fixtures; use doubles for expensive or external systems. Choose regression coverage for value, not test counts.
- Keep dependencies and lockfile changes intentional. Do not weaken assertions, gates, architecture policy, or performance budgets just to pass. Explain existing failures and verification limits.
- Keep durable architecture/reference documentation aligned with implemented behavior. Installed skills are optional helpers, not prerequisites; adapt their principles to this repository's stack and interfaces. Do not import personal paths or generic skill ceremony into the workflow.

## Performance and efficiency

- Actively inspect the PR's affected hot paths and immediate callers for efficiency wins: repeated work, unnecessary renders/subscriptions, request waterfalls, excess queries, serialization/copies, unbounded collections, and retained resources.
- For inference, consider device transfers, dtype conversions, peak memory, model/cache lifetimes, and unnecessary synchronization.
- Implement clear, low-risk improvements within the PR's scope. Larger optimizations must directly serve its outcome; mention unrelated opportunities briefly without expanding the PR.
- Measure nontrivial optimizations and performance claims using existing budgets, representative fixtures, query counts, profiling, or focused benchmarks. Report material before/after results and their limits.
- Preserve correctness and clarity. Add caching, memoization, concurrency, or batching only with understood invalidation, lifetimes, ordering, and cost. Do not invent an optimization or benchmark to satisfy a checklist.

## Product quality

InvokeAI is a polished professional creative product. Maintain a first-class desktop experience: deliberate layouts, responsive interactions, cohesive controls, accessibility, and performance. Complete loading, empty, error, and recovery states. Verify changed interactions in the browser; automated checks do not establish visual quality by themselves.

## Milestones and code review rules

A milestone is one coherent, commit-ready unit of work. Before calling it commit-worthy:

1. Run relevant checks, then spawn three independent, read-only review subagents with distinct focuses: correctness/spec conformance; architecture/operational safety/performance/unnecessary complexity; and test value/gaps/product quality (including accessibility for UI changes).
2. Give each reviewer the same fixed comparison base, acceptance criteria, and complete candidate changes, including staged, unstaged, and new files. Reviewers inspect independently and do not edit, commit, or recursively delegate reviews.
3. Require concrete locations, impact, and a failure scenario or engineering cost. Material findings affect behavior, safety, maintainability, efficiency, or meaningful coverage; style preferences alone are not blockers.
4. Resolve every material finding, add useful regression coverage, and rerun affected checks. Request final blocker-only review of the resulting candidate. Further edits invalidate the relevant review results.
5. Do not call work commit-worthy with material findings or unexplained failing gates. Report what passed, what failed or was unavailable, and material remaining limitations.

If the environment cannot spawn subagents, perform separate self-review passes with the same focuses and explicitly disclose that independent review was unavailable. Never represent self-review as independent review. Delegating implementation is optional; use it for independently useful tasks with clear ownership.

## Commands and environments

- Use **pnpm 10**, never npm/yarn, for frontends and docs. Each package owns its lockfile. Use `pnpm -C <package> ...`; `.nvmrc` records the development Node version. Read the package scripts instead of assuming root Makefile frontend commands target webv2.
- Use the existing Python environment and `uv.lock`. For a fresh test environment: `uv sync --locked --extra test`; do not replace a configured accelerator environment with a different backend as routine setup.
- From the root: `uv tool run ruff@0.11.2 check <paths>` and `uv tool run ruff@0.11.2 format --check <paths>`. Python uses 120-column formatting and absolute imports. Respect configured vendored-code exclusions.
- Run focused Python tests with `uv run --no-sync pytest <test-paths>`; the full CI suite is `uv run --no-sync pytest -n logical` (xdist; each file's tests stay on a single worker). Slow tests are excluded by default: `slow` is the lane for what needs a development machine -- real accelerator hardware, or a quiet one for timing -- and is run there with `-m slow`, not by CI.
- `uv run --no-sync mypy scripts/invokeai-web.py` is an additional diagnostic using the current exclusions, not an enforced CI gate. Do not describe it as comprehensive type coverage.
- Choose checks by changed behavior. Broaden to the milestone's required gates before review; do not repeatedly rerun unchanged checks without a reason.
- Install local hooks with `uv run --no-sync pre-commit install` after test dependencies are available. Hook installation is local to each checkout and is not implied by committing the configuration.

## Scratch files and repository hygiene

- Never commit task plans, work logs, investigation notes, review transcripts, or handoffs, regardless of filename. Use `.scratch/agents/<task>/` if persistence is useful; creating these files is optional.
- Durable documentation of implemented architecture, decisions, APIs, and setup belongs in version control. Do not turn scratch logs into permanent docs merely to bypass this rule.
- Ignore rules keep recognized scratch/planning paths out of ordinary staging; they do not prevent force-adds or remove files already tracked by Git.
- Inspect the staged diff and new files for planning material, including unexpected filenames. Never force-add planning artifacts or introduce `package-lock.json`/`yarn.lock`.

## Commits and pull requests

- Commit readiness does not itself authorize committing or pushing. Follow the request's existing authorization; do not add an automatic commit/push step to each subtask.
- Use Conventional Commits with the shortest descriptive, skimmable subject that states the outcome.
- Follow the subject with one to three short, factual lines summarizing material changes; use bullets when useful. Omit implementation narration and details already clear from the subject.
- Leave authorship to the configured Git author. Do not add agent attribution or co-author trailers.
- Pull request descriptions follow `.github/pull_request_template.md`: keep its headings in order, fill every applicable section per its inline guidance, and omit only the sections the template marks as conditional. Tick a checklist item only when it is true for the PR.
