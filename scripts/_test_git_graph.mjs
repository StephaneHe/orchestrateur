#!/usr/bin/env node
// ============================================================================
// scripts/_test_git_graph.mjs — read-only git graph of each musician (0.76.0)
// ============================================================================
//
// User request (2026-10-13): « Sur dev, je veux que l'on reprenne
// l'implémentation de notre todo list et git visualisation sur pannel » —
// git part: in the same side panel, each musician's git tree (commits,
// branches, tags), READ-ONLY: no git operation can be triggered from the UI.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRefs, parseGitLog, layoutGraph, readGitGraph, gitReadArgs } from './git-graph-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gitgraph-'));
const g = (dir, ...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL', '-c', 'init.defaultBranch=main', ...a], { encoding: 'utf8', windowsHide: true });

/** Every parent→child link of the window is drawn: a chain of segments joins them. */
function connected(commits, layout) {
  const idx = new Map(commits.map((c, i) => [c.sha, i]));
  const next = new Map();
  for (const s of layout.segments) {
    const k = `${s.r1}:${s.l1}`;
    if (!next.has(k)) next.set(k, []);
    next.get(k).push(`${s.r2}:${s.l2}`);
  }
  const missing = [];
  commits.forEach((c, i) => {
    for (const p of c.parents) {
      const j = idx.get(p);
      if (j == null) continue;
      const goal = `${j}:${layout.rows[j].lane}`;
      const seen = new Set(), stack = [`${i}:${layout.rows[i].lane}`];
      let found = false;
      while (stack.length && !found) {
        const cur = stack.pop();
        if (cur === goal) { found = true; break; }
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const n of next.get(cur) || []) if (Number(n.split(':')[0]) <= j) stack.push(n);
      }
      if (!found) missing.push(`${c.short}→${p.slice(0, 7)}`);
    }
  });
  return missing;
}
const repoState = (dir) => ({
  refs: g(dir, 'for-each-ref', '--format=%(refname) %(objectname)').stdout,
  head: fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8'),
  index: fs.statSync(path.join(dir, '.git', 'index')).mtimeMs,
  // GIT_OPTIONAL_LOCKS=0: this check itself must not rewrite the index.
  status: spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true }).stdout,
});

try {
  console.log('\n── 1. Refs : branches, HEAD, distantes, tags');
  const r = parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/heads/feature/x');
  ok(r.head === 'main' && r.branches.join() === 'main,feature/x' && r.remotes.join() === 'origin/main' && r.tags.join() === 'v1.0', JSON.stringify(r));
  ok(parseRefs('HEAD').head === 'detached' && parseRefs('').branches.length === 0, 'HEAD détaché ; rien');

  console.log('\n── 2. Un vrai dépôt : branche, fusion, tags');
  const repo = path.join(T, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q');
  const commit = (file, msg) => { fs.writeFileSync(path.join(repo, file), msg); g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', msg); };
  commit('a.txt', 'c1 initial'); g(repo, 'tag', 'v1.0');
  g(repo, 'checkout', '-q', '-b', 'feature/x'); commit('b.txt', 'c2 feature'); commit('b2.txt', 'c3 feature suite');
  g(repo, 'checkout', '-q', 'main'); commit('c.txt', 'c4 main');
  g(repo, 'merge', '-q', '--no-ff', '-m', 'c5 merge feature', 'feature/x'); g(repo, 'tag', '-a', 'v2.0', '-m', 'v2');
  commit('d.txt', 'c6 after merge');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x');
  const before = repoState(repo);
  const gg = await readGitGraph(repo, { n: 50 });
  ok(gg.repo && gg.commits.length === 6 && !gg.truncated, `6 commits lus (${gg.commits.length})`);
  ok(gg.head === 'main' && gg.commits[0].subject === 'c6 after merge', `HEAD = main, plus récent en tête (${gg.head})`);
  const merge = gg.commits.find(c => c.subject === 'c5 merge feature');
  ok(merge?.parents.length === 2 && merge.refs.tags.includes('v2.0'), 'fusion : 2 parents, tag annoté v2.0');
  ok(gg.commits.find(c => c.subject === 'c3 feature suite')?.refs.branches.includes('feature/x') && gg.commits.at(-1).refs.tags.includes('v1.0'), 'branche feature/x et tag v1.0 sur leurs commits');
  ok(gg.layout.lanes >= 2 && gg.layout.rows.length === 6, `${gg.layout.lanes} voies`);
  ok(gg.layout.segments.every(s => s.r2 === s.r1 + 1 && s.l1 < gg.layout.lanes && s.l2 < gg.layout.lanes), 'segments entre lignes consécutives, dans les voies');
  const miss = connected(gg.commits, gg.layout);
  ok(!miss.length, 'chaque lien parent → enfant est dessiné', miss.join(' '));
  const laneOf = (s) => gg.layout.rows[gg.commits.findIndex(c => c.subject === s)].lane;
  ok(laneOf('c2 feature') === laneOf('c3 feature suite') && laneOf('c3 feature suite') !== laneOf('c4 main') && laneOf('c4 main') === laneOf('c5 merge feature'),
    `la branche a sa propre voie (feature ${laneOf('c3 feature suite')}, main ${laneOf('c4 main')})`);

  console.log('\n── 3. LECTURE SEULE : le dépôt ne bouge pas');
  await readGitGraph(repo, { n: 2 }); await readGitGraph(repo, { n: 300 });
  const after = repoState(repo);
  ok(after.refs === before.refs && after.head === before.head, 'refs et HEAD inchangés');
  ok(after.index === before.index, 'index git jamais réécrit (GIT_OPTIONAL_LOCKS=0)');
  ok(after.status === before.status && /untracked\.txt/.test(after.status), 'état de travail inchangé');
  const args = gitReadArgs(10);
  ok(args.includes('log') && !args.some(a => /^(commit|push|pull|fetch|checkout|switch|reset|merge|rebase|tag|branch|gc|stash|clean|rm|add)$/.test(a)), `seule commande : git log (${args.slice(0, 3).join(' ')} …)`);
  const core = fs.readFileSync(path.join(ROOT, 'scripts', 'git-graph-core.mjs'), 'utf8');
  ok((core.match(/execFile\(/g) || []).length === 1 && /execFile\('git', \['-C', dir, \.\.\.gitReadArgs\(/.test(core)
    && (core.match(/from 'node:child_process'/g) || []).length === 1 && /import \{ execFile \} from 'node:child_process';/.test(core) && !/shell:\s*true/.test(core),
    'un seul appel git (execFile, seul import de child_process), argv en tableau, sans shell');

  console.log('\n── 4. Fenêtre, dépôt vide, pas de dépôt');
  const small = await readGitGraph(repo, { n: 2 });
  ok(small.commits.length === 2 && small.truncated && small.layout.open.length >= 1, 'n = 2 : tronqué, l’historique continue en dessous');
  const empty = path.join(T, 'empty'); fs.mkdirSync(empty); g(empty, 'init', '-q');
  const e = await readGitGraph(empty);
  ok(e.repo && e.commits.length === 0 && !e.error, 'dépôt sans commit : vide, sans erreur', JSON.stringify(e));
  const none = path.join(T, 'none'); fs.mkdirSync(none);
  ok((await readGitGraph(none)).repo === false, 'dossier sans git : repo = false');
  const parsed = parseGitLog(`${'a'.repeat(40)}\x1f\x1fHEAD -> refs/heads/m\x1fx\x1f2026-10-13T10:00:00+03:00\x1fsujet\x1fà\x1fdeux\x1e`);
  ok(parsed[0].subject === 'sujet\x1fà\x1fdeux' && parsed[0].parents.length === 0, 'sujet intact, commit racine');
  ok(layoutGraph([]).rows.length === 0, 'graphe vide');

  console.log('\n── 5. Vrai dépôt de la dev');
  const dev = await readGitGraph(ROOT, { n: 40 });
  ok(dev.repo && dev.commits.length > 0 && !!dev.head && !connected(dev.commits, dev.layout).length, `${dev.commits.length} commits, HEAD ${dev.head}, tous les liens dessinés`);

  console.log('\n── 6. Câblage : GET seulement, aucune action git dans l’UI, même panneau que la TODO');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/app\.get\('\/api\/git-graph'/.test(srv) && /app\.get\('\/api\/git-graph\/:project'/.test(srv) && !/app\.(post|put|patch|delete)\('\/api\/git/.test(srv), 'routes GET seulement');
  ok(/config\.projects \|\| \[\]\)\.find\(x => x && x\.name === req\.params\.project/.test(srv), 'projet pris dans config.json (liste blanche)');
  const ui = fs.readFileSync(path.join(ROOT, 'public', 'git-panel.js'), 'utf8');
  ok(/SidePanel\.register\(\{\s*id: "git"/.test(ui) && !/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(ui), 'onglet du panneau partagé, aucun envoi');
  const fetches = [...ui.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]);
  ok(fetches.length >= 2 && fetches.every(f => /\/api\/git-graph/.test(f) && !/method/.test(f)), `requêtes de l’onglet : GET /api/git-graph seulement (${fetches.length})`);
  ok(!/\b(git (checkout|reset|push|pull|fetch|merge|rebase|revert|commit|branch -d|tag -d))\b/i.test(ui) && !/<a\s/i.test(ui), 'aucune commande git ni lien d’action dans l’onglet');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok(/id="btn-git"[^>]*data-sp-open="git"/.test(html) && /git-panel\.js/.test(html), 'pill ⎇ Git et script');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
