// ============================================================================
// tests/kg-fixture.mjs — knowledge index of a test instance (0.131.0)
// ============================================================================
//
// For the HTTP journey `kg-review` and the browser journey `kg-tab`: builds the
// index of an instance from the anonymised corpus, has the FAKE claude propose
// two facts (kg.extract on for that only), and gives everything back as it
// was. Everything goes through the instance's own scripts/kg.mjs (its single
// writer); the index folder is reached through KG.KG_DIR.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const KG_BOX_QUOTE = 'Pour le **développement de boxapp**, router les tâches de code sur **`claude-opus-5`** (pas sonnet/haiku).';
export const KG_ALL_QUOTE = 'Tous les dispatches tournent sur **`claude-opus-5-5`**.';

/** → null when this state of the code has no phase 1, else the fixture handle. */
export async function seedKg(root) {
  const kgFile = path.join(root, 'scripts', 'kg.mjs');
  if (!fs.existsSync(kgFile)) return null;
  const KG = await import(pathToFileURL(kgFile).href);
  if (typeof KG.decide !== 'function') return null;
  const { corpusCopy } = await import(pathToFileURL(path.join(root, 'tests', 'kg-corpus', 'fixture.mjs')).href);
  const routingFile = path.join(root, 'model-routing.json');
  const saved = fs.existsSync(routingFile) ? fs.readFileSync(routingFile) : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-fixture-'));
  const corpus = corpusCopy(path.join(tmp, 'corpus'));
  KG.writeKgSettings(root, { mode: 'shadow', by: 'recette' });
  const built = await KG.build(root, { corpus, repo: null });
  KG.writeKgSwitch(root, { key: 'extract', on: true, by: 'recette' });
  const env = { ...process.env, CLAUDE_BIN: path.join(root, 'tests', 'fake_claude', 'fake_claude.mjs'),
    FAKE_CLAUDE_KG_MAP: JSON.stringify({
      'feedback_boxapp_opus5.md': { facts: [{ s: 'mem:feedback_boxapp_opus5', p: 'applies_to', o: 'projet:boxapp', quote: KG_BOX_QUOTE, scope: 'projet:boxapp' }] },
      'feedback_all_opus5.md': { facts: [{ s: 'mem:feedback_all_opus5', p: 'applies_to', o: 'projet:boxapp', quote: KG_ALL_QUOTE, scope: '*' }] },
    }) };
  const extracted = await KG.extract(root, { corpus, env, only: 'memory', max: 20 });
  KG.writeKgSwitch(root, { key: 'extract', on: false, by: 'recette' });
  return { KG, root, tmp, corpus, saved, routingFile, built, extracted,
    ui: (on) => KG.writeKgSwitch(root, { key: 'ui', on, by: 'recette' }) };
}

/** Gives the instance back as it was: model-routing.json byte for byte, no index. */
export function clearKg(fx) {
  if (!fx) return;
  if (fx.saved) fs.writeFileSync(fx.routingFile, fx.saved); else fs.rmSync(fx.routingFile, { force: true });
  fs.rmSync(path.join(fx.root, ...fx.KG.KG_DIR.split('/')), { recursive: true, force: true });
  fs.rmSync(fx.tmp, { recursive: true, force: true });
}
