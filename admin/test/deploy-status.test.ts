// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeployStatus, waitForDeploy, setDeployFetch } from '../src/services/deploy-status.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const SHA = 'abcdef1234567';

test('deploy status: not on main / not pushed / success', async () => {
  setDeployFetch(async (url) => (String(url).includes('/compare/') ? json({}, 404) : json({})));
  assert.equal((await getDeployStatus(SHA)).status, 'not_pushed');
  setDeployFetch(async (url) =>
    String(url).includes('/compare/') ? json({ status: 'ahead' }) : json({}),
  );
  assert.equal((await getDeployStatus(SHA)).status, 'not_on_main');
  setDeployFetch(async (url) =>
    String(url).includes('/compare/')
      ? json({ status: 'identical' })
      : json({
          workflow_runs: [
            { path: '.github/workflows/quality.yml', status: 'completed', conclusion: 'success' },
            {
              path: '.github/workflows/deploy.yml',
              status: 'completed',
              conclusion: 'success',
              html_url: 'u',
            },
          ],
        }),
  );
  const st = await getDeployStatus(SHA);
  assert.equal(st.status, 'completed');
  assert.equal(st.conclusion, 'success');
  assert.equal((await getDeployStatus('nope')).status, 'error');
  setDeployFetch(null);
});

test('waitForDeploy resolves true once live, false on failure', async () => {
  let n = 0;
  setDeployFetch(async (url) => {
    if (String(url).includes('/compare/')) return json({ status: 'identical' });
    n += 1;
    return json({
      workflow_runs: [
        {
          path: '.github/workflows/deploy.yml',
          status: n < 3 ? 'in_progress' : 'completed',
          conclusion: n < 3 ? null : 'success',
        },
      ],
    });
  });
  assert.equal(await waitForDeploy(SHA, { intervalMs: 5, timeoutMs: 2000 }), true);
  setDeployFetch(async (url) =>
    String(url).includes('/compare/')
      ? json({ status: 'identical' })
      : json({
          workflow_runs: [
            { path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'failure' },
          ],
        }),
  );
  assert.equal(await waitForDeploy(SHA, { intervalMs: 5, timeoutMs: 2000 }), false);
  setDeployFetch(null);
});
