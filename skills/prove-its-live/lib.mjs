// deploysmoke / prove-its-live: pure logic, no network and no git, so it can be unit-tested with fixtures.

const SHA_FIELDS = ['githubCommitSha', 'gitlabCommitSha', 'bitbucketCommitSha', 'gitCommitSha', 'commitSha'];

/** Pull a commit SHA out of a /version, /build-id or health endpoint body (JSON or plain text). */
export function extractSha(body) {
  if (body == null) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    const keys = ['sha', 'commit', 'commitSha', 'commit_sha', 'gitSha', 'git_sha', 'gitCommitSha', 'revision', 'version', 'buildId', 'build_id'];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 3) return null;
      for (const k of keys) if (typeof o[k] === 'string' && /^[0-9a-f]{7,40}$/i.test(o[k].trim())) return o[k].trim().toLowerCase();
      for (const v of Object.values(o)) { const f = walk(v, depth + 1); if (f) return f; }
      return null;
    };
    const found = walk(j, 0);
    if (found) return found;
  } catch { /* not JSON: fall through to text */ }
  const m = text.match(/\b[0-9a-f]{40}\b/i) || text.match(/\b[0-9a-f]{7,12}\b/i);
  return m ? m[0].toLowerCase() : null;
}

/** The deployment a Vercel project serves on its production domains, from GET /v9/projects/:id. */
export function servedFromVercelProject(project) {
  const p = project?.targets?.production;
  if (!p) return null;
  return describeVercelDeployment(p);
}

export function describeVercelDeployment(d) {
  const meta = d.meta || {};
  let sha = null;
  for (const f of SHA_FIELDS) if (typeof meta[f] === 'string' && meta[f]) { sha = meta[f].toLowerCase(); break; }
  if (!sha && d.gitSource?.sha) sha = String(d.gitSource.sha).toLowerCase();
  return {
    id: d.id || d.uid,
    url: d.url ? `https://${d.url}` : null,
    state: d.readyState || d.state || null,
    createdAt: d.createdAt || d.created || null,
    aliases: d.alias || [],
    sha,
    ref: meta.githubCommitRef || meta.gitlabCommitRef || meta.bitbucketCommitRef || null,
    dirty: meta.gitDirty === '1' || meta.gitDirty === true,
    actor: meta.actor || null,
  };
}

/** Production deployments newer than the served one that did not become live (failed, building, canceled). */
export function newerUnservedAttempts(deployments, served) {
  if (!Array.isArray(deployments) || !served?.createdAt) return [];
  return deployments
    .map(describeVercelDeployment)
    .filter((d) => d.id !== served.id && d.createdAt > served.createdAt && d.state !== 'READY')
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * relation: how the served commit relates to the commit you expected to be live, as git reports it:
 *   'same' | 'behind' (served is an ancestor of expected) | 'ahead' (expected is an ancestor of served)
 *   | 'diverged' | 'unknown' (served commit is not in this clone)
 */
export function compare({ served, expected, relation }) {
  if (!served) {
    return {
      verdict: 'unverifiable',
      message: 'The live deployment carries no commit SHA (deployed from a local CLI or upload without git metadata). Nothing proves which code is live. Deploy from git, or expose the SHA at a /version endpoint and check that.',
    };
  }
  if (!expected) return { verdict: 'unverifiable', message: 'Could not resolve the commit you expected to be live.' };
  const same = served === expected || (served.length < 40 && expected.startsWith(served)) || (expected.length < 40 && served.startsWith(expected));
  if (same || relation === 'same') return { verdict: 'match', message: 'The live deployment serves exactly the expected commit.' };
  const messages = {
    behind: 'Production is BEHIND: the expected commit is not live. It was pushed but not deployed, the build failed, or the deploy is still running.',
    ahead: 'Production is AHEAD of the expected ref: something newer than what you compared against is live (another session or person deployed). Fetch and look before claiming anything.',
    diverged: 'Production serves a commit on a different line of history than the expected ref (another branch was deployed, or history was rewritten).',
    unknown: 'Production serves a commit that is not in this clone. Fetch all branches, or it was deployed from somewhere else.',
  };
  return { verdict: 'mismatch', relation: relation || 'unknown', message: messages[relation] || messages.unknown };
}

export const short = (sha) => (sha ? sha.slice(0, 7) : '(none)');
