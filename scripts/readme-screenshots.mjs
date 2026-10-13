#!/usr/bin/env node
// Regenerates the README screenshots in docs/screenshots/ (0.76.3).
//
//   node scripts/readme-screenshots.mjs [--out docs/screenshots]
//
// Uses the isolated test instance of the non-regression tooling
// (_regression_sandbox.mjs): a copy of the working tree on a free port, fake
// `claude`, FICTIONAL fixture projects (alpha, beta, omega…). Port 7777 is
// rewritten in the copy, so production is never contacted, and nothing of the
// real fleet (names, logs, paths, addresses) can appear in a capture. The
// instance is stopped before the script exits.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, startSandbox } from './_regression_sandbox.mjs';

const argv = process.argv.slice(2);
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'docs/screenshots';
const OUT = path.resolve(REPO, outArg);
const VIEWPORT = { width: 1440, height: 900 };

// A small but readable history for the git tab: feature branches, merges, tags.
function demoHistory(dir) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' };
  let day = 1;
  const g = (...a) => {
    const stamp = `2026-10-${String(day).padStart(2, '0')}T10:00:00`;
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const commit = (file, text, msg) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.appendFileSync(path.join(dir, file), text + '\n');
    g('add', '-A'); g('commit', '-q', '-m', msg); day++;
  };
  fs.mkdirSync(dir, { recursive: true });
  g('init', '-q', '-b', 'main');
  commit('README.md', '# omega', 'chore: initial project skeleton');
  commit('src/app.mjs', 'export const app = 1;', 'feat: application entry point');
  g('tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
  g('checkout', '-q', '-b', 'feature/search');
  commit('src/search.mjs', 'export const search = () => [];', 'feat(search): index the documents');
  commit('test/search.test.mjs', '// search', 'test(search): ranking cases');
  g('checkout', '-q', 'main');
  commit('src/app.mjs', '// fix', 'fix: handle an empty configuration');
  g('merge', '-q', '--no-ff', 'feature/search', '-m', "Merge branch 'feature/search'"); day++;
  g('checkout', '-q', '-b', 'feature/export');
  commit('src/export.mjs', 'export const toCsv = () => "";', 'feat(export): CSV export');
  g('checkout', '-q', 'main');
  commit('CHANGELOG.md', '## 1.1.0', 'docs: changelog for 1.1.0');
  g('tag', '-a', 'v1.1.0', '-m', 'v1.1.0');
  commit('src/app.mjs', '// perf', 'perf: cache the parsed settings');
}

const sb = await startSandbox({ worktree: true }, 'readme-shots');
let browser;
try {
  const omega = path.join(sb.root, 'projects', 'omega');
  if (!fs.existsSync(path.join(omega, '.git'))) demoHistory(omega);

  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const home = `${sb.url}/?token=${sb.token}`;
  fs.mkdirSync(OUT, { recursive: true });
  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name) }); console.log(`  ${name}`); };
  const settle = (ms = 800) => new Promise(r => setTimeout(r, ms));

  await page.goto(home);
  await page.locator('.brand').waitFor();
  await page.waitForFunction(() => /À examiner/.test(document.querySelector('#rail-body')?.textContent || ''), null, { timeout: 15_000 });
  await settle(1500);
  await shot('dashboard-overview.png');

  await page.click('#btn-todo');
  await page.waitForSelector('#side-panel.is-open .todo-item', { timeout: 10_000 });
  await settle();
  await shot('side-panel-todo.png');

  await page.click('#side-panel [data-sp-tab="git"]');
  await page.selectOption('#side-panel .gg-project', 'omega');
  await page.waitForFunction(() => document.querySelectorAll('#side-panel .gg-row').length >= 5, null, { timeout: 10_000 });
  await settle();
  await shot('side-panel-git.png');
  await page.keyboard.press('Escape');
} finally {
  try { await browser?.close(); } catch {}
  await sb.stop();
  fs.rmSync(sb.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(`screenshots written to ${path.relative(REPO, OUT) || '.'}`);
