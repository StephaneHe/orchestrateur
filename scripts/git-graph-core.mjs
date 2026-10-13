// ============================================================================
// scripts/git-graph-core.mjs — read-only git graph of a musician's repository
// (0.76.0)
// ============================================================================
//
// User request (2026-10-13): « Sur dev, je veux que l'on reprenne
// l'implémentation de notre todo list et git visualisation sur pannel » —
// git part: in the same side panel, each musician's git tree (commits,
// branches, tags), READ-ONLY: nothing in the UI can trigger a git operation.
//
// The only git command run here is `git log` (GIT_READ_ARGS), with
// GIT_OPTIONAL_LOCKS=0 so that git never refreshes the index on disk. The
// argv is an array (never a shell string); the directory comes from
// config.json, never from the request.
// The lane layout is pure: rows in topological order (children first), one
// lane per open line of history, segments between consecutive rows.
// ============================================================================

import { execFile } from 'node:child_process';

export const GIT_N_DEFAULT = 80;
export const GIT_N_MAX = 300;
const FS = '\x1f', RS = '\x1e';
/** The one and only git invocation of the graph (read-only). */
export function gitReadArgs(n) {
  return ['--no-pager', 'log', '--all', '--topo-order', '--no-color', '--decorate=full', `--max-count=${n}`,
    `--format=%H${FS}%P${FS}%D${FS}%an${FS}%aI${FS}%s${RS}`];
}

/**
 * %D with --decorate=full: "HEAD -> refs/heads/main, refs/remotes/origin/main,
 * tag: refs/tags/v1.0" → {head, branches, remotes, tags} (short names).
 */
export function parseRefs(d) {
  const out = { head: null, branches: [], remotes: [], tags: [] };
  for (const raw of String(d || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (raw === 'HEAD') { out.head = 'detached'; continue; }
    let ref = raw;
    const hm = /^HEAD -> (.+)$/.exec(raw);
    if (hm) ref = hm[1];
    const tm = /^tag: (.+)$/.exec(ref);
    if (tm) ref = tm[1];
    let m;
    if ((m = /^refs\/heads\/(.+)$/.exec(ref))) { out.branches.push(m[1]); if (hm) out.head = m[1]; }
    else if ((m = /^refs\/tags\/(.+)$/.exec(ref))) out.tags.push(m[1]);
    else if ((m = /^refs\/remotes\/(.+)$/.exec(ref))) { if (!/\/HEAD$/.test(m[1])) out.remotes.push(m[1]); }
    // Other refs (refs/stash, notes…) are not part of the tree view.
  }
  return out;
}

/** Output of `git log` (gitReadArgs) → commits [{sha, short, parents, refs, author, date, subject}]. */
export function parseGitLog(out) {
  return String(out || '').split(RS).map(r => r.replace(/^\s+/, '')).filter(Boolean).map(rec => {
    const [sha, parents, refs, author, date, ...rest] = rec.split(FS);
    return { sha, short: sha.slice(0, 7), parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: parseRefs(refs), author, date, subject: rest.join(FS).replace(/\s+$/, '') };
  }).filter(c => /^[0-9a-f]{7,64}$/.test(c.sha));
}

/**
 * Lanes of the graph. → {rows: [{lane}], segments: [{r1, l1, r2, l2, lane}],
 * lanes, open} — segment (r1,l1)→(r2,l2) between consecutive rows; `open`
 * lists the lanes still running below the last row (history continues).
 */
export function layoutGraph(commits) {
  // lane k carries ONE line of history: expect[k] = sha it leads to, origin[k]
  // = x (lane) of that line at the previous row (the commit's lane when the
  // line was just opened there by a merge parent).
  const expect = [], origin = [];
  const free = () => { const i = expect.indexOf(null); return i >= 0 ? i : expect.push(null) - 1; };
  const rows = [], segments = [];
  let joins = [];   // lines leaving the previous commit towards a lane already carrying their parent
  commits.forEach((c, r) => {
    const mine = expect.map((s, k) => (s === c.sha ? k : -1)).filter(k => k >= 0);
    const lane = mine.length ? Math.min(...mine) : free();
    const target = (k) => (expect[k] === c.sha ? lane : k);   // where lane k's line is at this row
    if (r > 0) {
      expect.forEach((s, k) => { if (s != null) segments.push({ r1: r - 1, l1: origin[k], r2: r, l2: target(k), lane: target(k) }); });
      for (const j of joins) segments.push({ r1: r - 1, l1: j.from, r2: r, l2: target(j.lane), lane: target(j.lane) });
    }
    for (const k of mine) { expect[k] = null; origin[k] = null; }
    expect[lane] = null;
    joins = [];
    const born = new Set();                 // lanes opened here by a merge parent
    const [first, ...others] = c.parents;
    if (first) {
      const at = expect.indexOf(first);
      if (at >= 0) joins.push({ from: lane, lane: at });            // branch point: join that line
      else expect[lane] = first;
    }
    for (const p of others) {
      const at = expect.indexOf(p);
      if (at >= 0) { joins.push({ from: lane, lane: at }); continue; }   // merge into an existing line
      const k = free();
      expect[k] = p;
      born.add(k);
    }
    // At the next row, a line starts from this commit if it was opened here,
    // otherwise from its own lane (it passed through, or continues the commit's lane).
    expect.forEach((s, k) => { origin[k] = s == null ? null : (born.has(k) ? lane : k); });
    rows.push({ lane });
    while (expect.length && expect[expect.length - 1] === null) { expect.pop(); origin.pop(); }
  });
  const open = [
    ...expect.map((s, k) => (s == null ? null : { lane: k, from: origin[k] })).filter(Boolean),
    ...joins.map(j => ({ lane: j.lane, from: j.from })),
  ];
  const lanes = Math.max(1, ...rows.map(x => x.lane + 1), ...segments.map(s => Math.max(s.l1, s.l2) + 1), ...open.map(o => o.lane + 1));
  return { rows, segments, lanes, open };
}

/** Runs the read-only `git log` in `dir`. → {repo, commits, head, layout, truncated, error?} */
export function readGitGraph(dir, { n = GIT_N_DEFAULT, timeoutMs = 10_000 } = {}) {
  const count = Math.max(1, Math.min(GIT_N_MAX, Number(n) || GIT_N_DEFAULT));
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...gitReadArgs(count + 1)], { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '');
        if (/not a git repository/i.test(msg)) return resolve({ repo: false, commits: [] });
        if (/does not have any commits|unknown revision|bad default revision/i.test(msg)) return resolve({ repo: true, commits: [], head: null, layout: layoutGraph([]), truncated: false });
        return resolve({ repo: true, commits: [], error: msg.split('\n')[0].slice(0, 300) });
      }
      const all = parseGitLog(stdout);
      const commits = all.slice(0, count);
      const head = commits.find(c => c.refs.head)?.refs.head || null;
      resolve({ repo: true, commits, head, layout: layoutGraph(commits), truncated: all.length > count });
    });
  });
}
