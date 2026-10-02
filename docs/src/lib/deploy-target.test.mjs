import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveDeployTarget } from './deploy-target.mjs';

describe('resolveDeployTarget', () => {
  it('serves custom builds from the invoke.ai root', () => {
    assert.deepEqual(resolveDeployTarget({ GITHUB_REPOSITORY: 'invoke-ai/InvokeAI-7' }), {
      deployTarget: 'custom',
      isGhPages: false,
      base: '',
      site: 'https://invoke.ai',
    });
  });

  it('serves ghpages builds from the building repository project URL', () => {
    const { base, site } = resolveDeployTarget({ DEPLOY_TARGET: 'ghpages', GITHUB_REPOSITORY: 'SomeUser/InvokeAI-7' });

    assert.equal(base, '/InvokeAI-7');
    assert.equal(site, 'https://someuser.github.io');
  });

  it('falls back to the upstream project URL outside GitHub Actions', () => {
    const { base, site } = resolveDeployTarget({ DEPLOY_TARGET: 'ghpages' });

    assert.equal(base, '/InvokeAI');
    assert.equal(site, 'https://invoke-ai.github.io');
  });
});
