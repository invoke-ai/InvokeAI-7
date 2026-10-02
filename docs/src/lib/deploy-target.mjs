// Resolves where the built site will be served. Shared by astro.config.mjs and the
// deploy-output check so both agree on the base path.
//
// 'custom' serves from the invoke.ai domain root. 'ghpages' serves from the GitHub Pages
// project URL, <owner>.github.io/<repo>, so site and base come from GITHUB_REPOSITORY when
// Actions provides it (this repo, a renamed copy such as InvokeAI-7, or a fork).
export function resolveDeployTarget(env = process.env) {
  const deployTarget = env.DEPLOY_TARGET ?? 'custom';

  if (deployTarget !== 'ghpages') {
    return { deployTarget, isGhPages: false, base: '', site: 'https://invoke.ai' };
  }

  const [owner, repo] = env.GITHUB_REPOSITORY?.split('/') ?? [];

  return {
    deployTarget,
    isGhPages: true,
    base: `/${repo || 'InvokeAI'}`,
    site: `https://${(owner || 'invoke-ai').toLowerCase()}.github.io`,
  };
}
