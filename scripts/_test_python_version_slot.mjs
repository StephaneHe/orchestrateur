// Requirement (2026-10-29): « la livraison doit trouver la version Python
// __version__ ». Program delivery failed with « version introuvable dans
// bookhaven.py » although the file holds `__version__ = "2.15.20"` (line 51),
// declared in versionFiles. Cause: versionSlot() (code-delivery.mjs) and
// readVersion() (pipeline-engine.mjs, used by the Livrer criterion) have no
// Python pattern.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releasePlan, deliverRelease } from './code-delivery.mjs';
import { readVersion } from './pipeline-engine.mjs';

let fail = 0;
const ok = (c, l, d) => { if (!c) fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyver-'));
try {
  for (const q of ['"', "'"]) {
    fs.writeFileSync(path.join(dir, 'bookhaven.py'), `"""Server."""\nimport os\n\n__version__ = ${q}2.15.20${q}\n`);
    const plan = releasePlan(dir, { versionFiles: ['bookhaven.py'] });
    ok(plan.ok === true, `releasePlan recognises __version__ with ${q} quotes`, plan.why);
  }

  fs.writeFileSync(path.join(dir, 'bookhaven.py'), '__version__ = "2.15.20"\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
  const r = deliverRelease(dir, { versionFiles: ['bookhaven.py'] }, { bump: 'patch', changelog: '### Fixed\n- x\n' }, { date: '2026-10-30' });
  const msg = JSON.stringify(r);
  ok(!/version introuvable/.test(msg), 'deliverRelease does not report « version introuvable »', msg);

  const rv = (t) => readVersion('bookhaven.py', t);
  ok(rv('__version__ = "2.15.20"\n') === '2.15.20', 'readVersion reads __version__ (double quotes)', rv('__version__ = "2.15.20"\n'));
  ok(rv("import os\n__version__ = '1.0.3'\n") === '1.0.3', 'readVersion reads __version__ (single quotes)');
  ok(rv('__version__: str = "3.1.4"\n') === '3.1.4', 'readVersion reads an annotated __version__');
  ok(rv('x = 1\n') === null, 'readVersion returns null without __version__');
  ok(readVersion('bookhaven.py', fs.readFileSync(path.join(dir, 'bookhaven.py'), 'utf8')) === '2.15.21', 'after delivery the engine reads the bumped version');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
