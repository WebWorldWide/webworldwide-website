/**
 * GitHub Pages deploy status for a published commit — shared by the
 * /api/publish/deploy/:sha route (the editor's "Building… → Live" badge) and
 * by the cross-posters, which must not announce a post before its page (and
 * cover image) is actually live.
 */
export type DeployStatus = {
  status: string; // queued | in_progress | completed | pending | superseded | not_pushed | not_on_main | error
  conclusion?: string | null;
  url?: string;
  name?: string;
  reason?: string;
};

let fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
/** Test hook. */
export function setDeployFetch(fn: typeof fetch | null) {
  fetchImpl = fn || ((input, init) => globalThis.fetch(input, init));
}

export async function getDeployStatus(sha: string): Promise<DeployStatus> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { status: 'error', reason: 'bad_sha' };
  const repo = process.env.GITHUB_REPO || 'WebWorldWide/webworldwide-website';
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'wwwide-cms',
  };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  try {
    // 1. Is the commit actually ON main? `/commits/:sha` alone returns 200 for
    //    a commit on any pushed branch, which made a stranded feature-branch
    //    commit look "pending" forever.
    const cmp = await fetchImpl(`https://api.github.com/repos/${repo}/compare/main...${sha}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (cmp.status === 404) return { status: 'not_pushed' };
    if (!cmp.ok) return { status: 'error', reason: `github_${cmp.status}` };
    const cmpData = await cmp.json();
    if (cmpData.status !== 'identical' && cmpData.status !== 'behind') {
      return { status: 'not_on_main' };
    }
    // 2. The Pages deploy run for this exact commit — matched by workflow FILE,
    //    never by falling back to whatever ran first.
    const r = await fetchImpl(
      `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`,
      { headers, signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return { status: 'error', reason: `github_${r.status}` };
    const data = await r.json();
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const deploy = runs.find((x) => String(x.path || '').endsWith('.github/workflows/deploy.yml'));
    if (!deploy) return { status: cmpData.status === 'behind' ? 'superseded' : 'pending' };
    return {
      status: deploy.status,
      conclusion: deploy.conclusion,
      url: deploy.html_url,
      name: deploy.name,
    };
  } catch (err) {
    console.warn('[deploy-status] failed:', err instanceof Error ? err.message : err);
    return { status: 'error', reason: 'network' };
  }
}

/**
 * Resolve once the deploy for `sha` is live (true) or has definitively failed
 * / timed out (false). A "superseded" commit counts as live: a newer deploy
 * already contains it.
 */
export async function waitForDeploy(
  sha: string,
  { timeoutMs = 15 * 60_000, intervalMs = 15_000 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await getDeployStatus(sha);
    if (st.status === 'completed') return st.conclusion === 'success';
    if (st.status === 'superseded') return true;
    if (st.status === 'not_pushed' || st.status === 'not_on_main') return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
