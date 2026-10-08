// ============================================================================
// scripts/_regression_browser.mjs — parcours navigateur (Edge / Playwright)
// ============================================================================
//
// Appelé par scripts/regression.mjs sur l'INSTANCE DE TEST (jamais 7777).
// Chaque parcours est un clic réel dans le vrai dashboard ; l'état de la flotte
// de fixtures est connu (voir _regression_sandbox.mjs), donc chaque attente est
// précise. Les parcours de la vue Projets passent en NA sur un état du code qui
// ne l'a pas (bouton #btn-projects absent).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { serverEnv } from './_regression_sandbox.mjs';

/** Tour réel (copie de dispatch.mjs de l'instance + faux claude) qui demande
 *  une autorisation et attend la décision prise dans le navigateur (0.45.0). */
function permDispatch(sb, project, perm, extra = {}) {
  const env = { ...serverEnv(sb.root, sb.port), FAKE_CLAUDE_LATENCY_MS: '20', ORCH_PERM_POLL_MS: '150', FAKE_CLAUDE_PERM: perm, ...extra };
  const c = spawn(process.execPath, [path.join(sb.root, 'scripts', 'dispatch.mjs'), project, 'recette autorisation (navigateur)'], { cwd: sb.root, env, windowsHide: true });
  return new Promise(r => c.on('exit', code => r(code)));
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export async function browserChecks(sb, t) {
  const { check, record, NA, assert, sleep, until } = t;
  const B = 'navigateur';
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch (e) { record(B, 'launch', 'Lancement du navigateur', 'KO', `playwright-core absent (npm install) : ${e.message}`); return; }
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch (e) { record(B, 'launch', 'Lancement du navigateur', 'KO', e.message); return; }
  record(B, 'launch', 'Lancement du navigateur (Edge headless)', 'OK');

  const H = { 'X-Orchestrator-Token': sb.token };
  const api = async (p) => (await fetch(sb.url + p, { headers: H })).json();
  const shotsDir = t.shots ? path.resolve(t.shots) : null;
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
  const shot = async (page, name, opts = {}) => {
    if (!shotsDir) return;
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`), ...opts });
  };

  const pageErrors = [];
  const wire = (page) => {
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'note de recette' : undefined).catch(() => {}));
  };
  const hash = (page) => page.evaluate(() => location.hash);
  const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
  const setHash = (page, h) => page.evaluate((x) => { location.hash = x; }, h);

  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
    const page = await ctx.newPage();
    wire(page);

    await check(B, 'load', 'Chargement du dashboard avec jeton, version du serveur au pied de page', async () => {
      const r = await page.goto(`${sb.url}/?token=${sb.token}`);
      assert(r.status() === 200, `HTTP ${r.status()}`);
      await page.locator('.brand').waitFor({ timeout: 10_000 });
      const v = await until(async () => { const x = await page.textContent('#app-version'); return /serveur v\d/.test(x || '') ? x : null; }, 8000);
      assert(v, 'version absente du pied de page');
      return v;
    });
    await check(B, 'sync', 'Topbar : flux temps réel « synchronisé »', async () => {
      const ok = await until(async () => (await page.textContent('#conn-status .conn-text')) === 'synchronisé', 15_000);
      assert(ok, `état : ${await page.textContent('#conn-status .conn-text')}`);
    });
    await check(B, 'thread', 'Fil du chef : historique rechargé', async () => {
      const ok = await until(async () => (await page.textContent('#cv-scroll')).includes('la flotte est calme'), 10_000);
      assert(ok, 'réponse historique du chef absente');
    });
    // ---------------- Taille du texte (0.34.0) ----------------
    const rootPx = (pg) => pg.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const overflowX = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await check(B, 'text-size', 'Taille du texte : A− / A / A+ de 85 % à 150 %, toute l\'interface, mémorisée, Ctrl+Alt, jamais dans un champ', async () => {
      if (!(await page.locator('#text-size').count())) NA('réglage absent de cet état du code');
      assert(await visible(page, '#text-size'), 'réglage masqué');
      assert((await page.textContent('#text-size [data-ts="0"]')).replace(/\s+/g, ' ').trim() === '100 %', 'pas à 100 % par défaut');
      for (const sel of ['[data-ts="-1"]', '[data-ts="0"]', '[data-ts="1"]']) assert(await page.getAttribute('#text-size ' + sel, 'aria-label'), `aria-label manquant ${sel}`);
      assert(await rootPx(page) === 16, `racine ${await rootPx(page)} px à 100 %`);
      const ref = async () => page.evaluate(() => ['#rail-body .rail-group-head', '.brand', '#composer-input'].map(q => parseFloat(getComputedStyle(document.querySelector(q)).fontSize)));
      const base = await ref();
      for (let i = 0; i < 6; i++) { const b = page.locator('#text-size [data-ts="1"]'); if (await b.isEnabled()) await b.click(); }
      assert((await page.textContent('#text-size [data-ts="0"]')).replace(/\s+/g, ' ').trim() === '150 %' && await page.locator('#text-size [data-ts="1"]').isDisabled(), 'maximum 150 % non atteint / A+ pas désactivé');
      const clipped = await page.evaluate(() => [...document.querySelectorAll('#rail-body .rail-item')].filter(it => {
        const st = it.querySelector('.rr-state'), ack = it.querySelector('.rr-ack');
        return st && ack && st.getBoundingClientRect().right > ack.getBoundingClientRect().left + 0.5;
      }).length);
      assert(clipped === 0, `${clipped} libellé(s) d'état sous le bouton « Vu / Répondue » à 150 %`);
      assert(await page.evaluate(() => { const b = document.querySelector('#text-size [data-ts="0"]'); return b.scrollHeight <= b.clientHeight + 1 && !/\n/.test(b.innerText); }), '« 150 % » sur deux lignes');
      const big = await ref();
      big.forEach((v, i) => assert(Math.abs(v / base[i] - 1.5) < 0.02, `police ${i} : ${base[i]} → ${v} (×1.5 attendu)`));
      assert(await overflowX(page) <= 0, `débordement horizontal à 150 % : ${await overflowX(page)} px`);
      await sleep(400);
      await shot(page, 'texte-150-desktop');
      await page.reload(); await page.locator('.brand').waitFor();
      assert(await rootPx(page) === 24, `non mémorisé après rechargement : ${await rootPx(page)} px`);
      // Clavier : Ctrl+Alt+0 rétablit, Ctrl+Alt+- réduit, bornes respectées.
      await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('Control+Alt+0');
      assert(await until(async () => (await rootPx(page)) === 16, 2000), 'Ctrl+Alt+0 sans effet');
      for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Alt+-');
      assert(Math.abs(await rootPx(page) - 13.6) < 0.05 && await page.locator('#text-size [data-ts="-1"]').isDisabled(), `minimum 85 % : ${await rootPx(page)} px`);
      await page.keyboard.press('Control+Alt+=');
      assert(Math.abs(await rootPx(page) - 14.4) < 0.05, `Ctrl+Alt+= : ${await rootPx(page)} px`);
      await page.keyboard.press('Control+Alt+-');
      await sleep(400);
      await shot(page, 'texte-85-desktop');
      // Dans un champ de saisie, Ctrl+Alt (= AltGr sous Windows) reste à la frappe.
      await page.focus('#composer-input');
      await page.keyboard.press('Control+Alt+0');
      assert(Math.abs(await rootPx(page) - 13.6) < 0.05, 'raccourci intercepté dans le composer');
      await page.click('#text-size [data-ts="0"]');
      assert(await rootPx(page) === 16 && await page.evaluate(() => localStorage.getItem('ui.textScale')) === null, 'retour à 100 % non mémorisé');
      return `polices ${base.join('/')} px → ${big.join('/')} px à 150 %`;
    });
    const railHeads = () => page.evaluate(() => [...document.querySelectorAll('#rail-body .rail-group-head')].map(h => h.textContent.replace(/\s+/g, ' ').trim()));
    await check(B, 'rail', 'Rail PILOTAGE : À examiner + cadres des musiciens (ou dépliage « Tous » sans cadres)', async () => {
      const txt = await page.textContent('#rail-body');
      assert(/En cours/.test(txt) && /À examiner/.test(txt), 'groupes absents');
      assert(await page.locator('.rail-row[data-name="eps"][data-state="live"]').count() >= 1, 'eps pas en cours');
      assert(await page.locator('.rail-row[data-name="gamma"][data-state="error"]').count() >= 1, 'gamma pas à examiner');
      if (await page.locator('[data-fold="cards"]').count()) {
        // 0.31.0 : 2e partie du Pilotage = un cadre par musicien, visible d'emblée.
        assert(await page.locator('.rail-card[data-name="kappa"]').count() === 1, 'cadre de kappa absent');
        // 0.32.0 : plus de bloc « En cours » ; les tours en cours sont les
        // premiers cadres, avec la durée du tour et la file.
        if (!(await railHeads()).some(h => /^En cours \(/.test(h))) {
          const first = page.locator('.rail-card').first();
          assert((await first.getAttribute('data-name')) === 'eps' && (await first.getAttribute('data-state')) === 'live', 'eps (en cours) pas en tête des cadres');
          const t = (await first.textContent()).replace(/\s+/g, ' ');
          assert(/En cours/.test(t) && /tour (< 1|\d+) (min|h)/.test(t) && /⏳ 2/.test(t), `cadre eps : ${t}`);
        }
        await page.click('[data-fold="cards"]');
        assert(await page.locator('.rail-card').count() === 0, 'les cadres ne se replient pas');
        await page.click('[data-fold="cards"]');
        return 'cadres des musiciens';
      }
      await page.click('[data-fold="all"]');
      assert(await page.locator('.rail-row[data-name="kappa"]').count() >= 1, '« Tous les musiciens » ne se déplie pas');
      await page.click('[data-fold="all"]');
    });
    await check(B, 'rail-no-running', 'Pilotage sans bloc « En cours » : la place va aux cadres, tours en cours en tête', async () => {
      if (!(await page.locator('[data-fold="cards"]').count())) NA('cadres absents de cet état du code');
      if ((await railHeads()).some(h => /^En cours \(/.test(h))) NA('bloc « En cours » encore présent dans cet état du code (avant 0.32.0)');
      const states = await page.evaluate(() => [...document.querySelectorAll('.rail-card')].map(c => c.dataset.state));
      const isLive = (x) => x === 'live' || x === 'think';
      const firstRest = states.findIndex(x => !isLive(x));
      assert(firstRest === -1 || states.slice(firstRest).every(x => !isLive(x)), `un cadre en cours après un cadre au repos : ${states.join(',')}`);
      const h = await page.evaluate(() => ({
        top: document.querySelector('#rail-body .rail-top')?.getBoundingClientRect().height || 0,
        bottom: document.querySelector('#rail-body .rail-bottom')?.getBoundingClientRect().height || 0,
      }));
      assert(h.bottom > h.top, `les cadres n'ont pas la plus grande part : haut ${Math.round(h.top)} px, bas ${Math.round(h.bottom)} px`);
      return `haut ${Math.round(h.top)} px · cadres ${Math.round(h.bottom)} px`;
    });
    await check(B, 'attention', 'Bande d\'attention : compteurs, dépliage, question visible', async () => {
      assert(await visible(page, '#attention'), 'bande masquée');
      const counts = await page.textContent('#attention .att-counts');
      assert(/question/.test(counts) && /échec/.test(counts), `compteurs : ${counts}`);
      await page.click('#attention .att-line');
      assert(await visible(page, '#attention .att-list'), 'liste non dépliée');
      assert(await page.locator('#attention .att-item', { hasText: 'beta' }).count() === 1, 'question de beta absente');
    });
    await check(B, 'resolve', '« ✓ Marquer comme répondue » : la question quitte l\'attention, le serveur l\'enregistre', async () => {
      await page.click('#attention [data-resolve-question="beta"]');
      const gone = await until(async () => (await page.locator('#attention .att-item', { hasText: 'beta' }).count()) === 0, 10_000);
      assert(gone, 'toujours dans la bande');
      const c = await api('/api/config');
      assert(c.projects.find(p => p.name === 'beta').currentState === 'idle', 'serveur : beta pas idle');
    });
    await check(B, 'dive', 'Volet musicien : ouverture depuis le rail, onglets, retour', async () => {
      if (!(await visible(page, '.rail-row[data-name="alpha"]'))) await page.click('[data-fold="all"]');
      await page.locator('.rail-row[data-name="alpha"]').first().click();
      assert(await until(async () => (await hash(page)) === '#/m/alpha' && await visible(page, '#dive'), 5000), 'volet masqué');
      assert((await page.textContent('#dive .dive-name')) === 'alpha', 'nom');
      await page.click('#dive .dive-tab[data-tab="result"]');
      assert(await until(async () => /terminé/.test(await page.textContent('#dive .dive-result')), 5000), 'onglet Dernier résultat');
      await page.click('#dive .dive-tab[data-tab="journal"]');
      assert(await until(async () => (await page.locator('#dive .dj-line').count()) > 0, 5000), 'onglet Journal');
      await page.click('#dive .dive-back');
      assert(await until(async () => !(await visible(page, '#dive')), 5000), 'retour');
    });
    await check(B, 'queue', 'File du musicien dans le volet + « Retirer »', async () => {
      await setHash(page, '#/m/eps');
      assert(await until(async () => (await page.locator('#dive .dq-item').count()) === 2, 10_000), `entrées : ${await page.locator('#dive .dq-item').count()}`);
      await page.locator('#dive .dq-rm').first().click();
      assert(await until(async () => (await page.locator('#dive .dq-item').count()) === 1, 10_000), 'entrée non retirée');
      assert((await api('/api/queue/eps')).count === 1, 'serveur : file ≠ 1');
      await page.click('#dive .dive-back');
    });
    await check(B, 'search', 'Annuaire / recherche : filtrer puis Entrée ouvre le volet', async () => {
      await page.click('#btn-search');
      assert(await visible(page, '#overlay-search'), 'overlay');
      await page.fill('#overlay-search .psr-input', 'lam');
      await page.keyboard.press('Enter');
      assert(await until(async () => (await hash(page)) === '#/m/lambda' && await visible(page, '#dive'), 5000), 'volet lambda');
      await page.keyboard.press('Escape');
      assert(await until(async () => !(await visible(page, '#dive')), 5000), 'Échap ne ferme pas');
    });
    await check(B, 'chef-header', 'En-tête chef : ouvre le pupitre du chef', async () => {
      await page.click('#chef-status');
      assert(await until(async () => (await hash(page)) === '#/m/chef', 5000), 'hash');
      await page.click('#dive .dive-back');
    });
    await check(B, 'briefing', 'Menu ⋮ → Briefing de l\'orchestre', async () => {
      await page.click('#btn-menu');
      await page.click('#topmenu [data-act="briefing"]');
      assert(await visible(page, '#overlay-briefing'), 'overlay');
      assert(await until(async () => (await page.textContent('#overlay-briefing .pb-body')).includes('gamma'), 5000), 'contenu');
      await page.click('#overlay-briefing .pb-close');
    });
    await check(B, 'composer', 'Barre de saisie → chef : bulle utilisateur puis réponse du chef', async () => {
      await page.fill('#composer-input', 'Bonjour chef, message de recette');
      await page.click('#composer-send');
      assert(await until(async () => (await page.textContent('#cv-scroll')).includes('message de recette'), 5000), 'bulle utilisateur');
      assert(await until(async () => (await page.textContent('#cv-scroll')).includes('fake reply to'), 45_000, 500), 'aucune réponse du chef en 45 s');
    });
    await check(B, 'pool', 'File de direction : 2e message en attente, bande visible, « Retirer » rend le brouillon', async () => {
      await page.fill('#composer-input', 'Premier message pool');
      await page.click('#composer-send');
      await until(async () => !(await page.locator('#composer-input').isDisabled()), 5000);
      await page.fill('#composer-input', 'Second message à retirer');
      await page.click('#composer-send');
      assert(await until(async () => (await page.locator('#poolband .pb-head', { hasText: 'Second message' }).count()) > 0
        || (await visible(page, '#poolband') && (await page.textContent('#poolband')).length > 0), 10_000), 'bande de file de direction absente');
      if (!(await visible(page, '#poolband .pb-list'))) await page.click('#poolband .pb-line');
      await page.locator('#poolband .pb-item', { hasText: 'Second message' }).locator('[data-pool-withdraw]').click();
      assert(await until(async () => (await page.inputValue('#composer-input')).includes('Second message'), 8000), 'brouillon non rendu');
      await page.fill('#composer-input', '');
    });
    await check(B, 'attach', 'Pièce jointe : image choisie → vignette → envoi au chef', async () => {
      await page.setInputFiles('#composer-file', { name: 'recette.png', mimeType: 'image/png', buffer: PNG_1PX });
      assert(await until(async () => visible(page, '#composer-image-strip'), 5000), 'vignette absente');
      await page.fill('#composer-input', 'Voici une capture');
      await page.click('#composer-send');
      assert(await until(async () => !(await visible(page, '#composer-image-strip')), 8000), 'vignette non envoyée');
      assert(await until(async () => (await page.locator('#cv-scroll img').count()) > 0, 5000), 'image absente de la bulle');
    });
    await check(B, 'realtime', 'Temps réel : un tour lancé par l\'API change l\'état côté client sans rechargement', async () => {
      const before = await page.evaluate(() => App.musicians.get('kappa').state);
      await fetch(`${sb.url}/api/dispatch`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'kappa', prompt: 'Tour de recette', queueIfBusy: true }) });
      const after = await until(async () => { const s = await page.evaluate(() => App.musicians.get('kappa').state); return s !== before ? s : null; }, 20_000, 250);
      assert(after, `état resté « ${before} »`);
      return `${before} → ${after}`;
    });

    // ------------- Refus d'autorisation (incident du 28/09, 0.29.1) -------------
    const appendLog = (name, evs) => fs.appendFileSync(path.join(sb.root, 'logs', `${name}.jsonl`),
      evs.map(e => JSON.stringify({ timestamp: new Date().toISOString(), ...e })).join('\n') + '\n');
    const readLogB = (name) => fs.readFileSync(path.join(sb.root, 'logs', `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
    const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const toolRes = (id, content, is_error) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) }] } });
    await check(B, 'denial-false', 'Refus d\'autorisation : un Read dont le contenu contient « requires approval » ne déclenche RIEN', async () => {
      appendLog('eps', [toolUse('toolu_fp1', 'Read', { file_path: 'public/app.js' }),
        toolRes('toolu_fp1', '// Detect permission denials (tool_result with "requires approval")\nif (!c.includes("requires approval")) continue;', false),
        toolUse('toolu_fp2', 'Bash', { command: 'grep -n "requires approval" public/app.js' }),
        toolRes('toolu_fp2', 'Exit code 1\n  if (!c.includes("requires approval")) continue;', true)]);
      await until(async () => (await page.evaluate(() => App.musicians.get('eps').ring.some(e => JSON.stringify(e).includes('toolu_fp2')))), 8000);
      await sleep(500);
      assert(await page.locator('.perm-denial-toast').count() === 0, 'un panneau d\'autorisation est apparu');
      assert(await page.evaluate(() => App.musicians.get('eps').pendingDenials.length) === 0, 'pendingDenials non vide');
    });
    await check(B, 'denial-true', 'Refus d\'autorisation réel : panneau complet (musicien, outil, appel, quoi faire), aussi dans le volet', async () => {
      if (!(await page.evaluate(() => !!window.PermissionDenial))) NA('détecteur absent de cet état du code');
      appendLog('eps', [toolUse('toolu_d1', 'Bash', { command: 'rm -rf build && git push origin main' }),
        toolRes('toolu_d1', 'This command requires approval', true)]);
      const toast = page.locator('.perm-denial-toast').last();
      assert(await until(async () => (await page.locator('.perm-denial-toast').count()) > 0, 8000), 'aucun panneau');
      const t = await toast.textContent();
      for (const want of ['eps', 'Bash', 'rm -rf build && git push origin main']) assert(t.includes(want), `panneau sans « ${want} » : ${t}`);
      assert(/déjà dans ses outils|déjà accordé/.test(t), `panneau : l'outil est déjà accordé, le dire : ${t}`);
      assert(await toast.locator('.ct-add-btn').count() === 0, 'bouton « Autoriser Bash » proposé alors que Bash est déjà autorisé');
      appendLog('eps', [toolUse('toolu_d2', 'Agent', { description: 'explorer le module natif', prompt: '…' }),
        toolRes('toolu_d2', "Claude requested permissions to use Agent, but you haven't granted it yet.", true)]);
      assert(await until(async () => (await page.locator('.perm-denial-toast .ct-add-btn[data-tool="Agent"]').count()) > 0, 8000), 'pas de bouton « Autoriser Agent »');
      await setHash(page, '#/m/eps');
      assert(await until(async () => visible(page, '#dive .dive-denials'), 5000), 'volet : refus non affichés');
      const d = await page.textContent('#dive .dive-denials');
      assert(d.includes('rm -rf build') && d.includes('Agent') && d.includes('explorer le module natif'), `volet : ${d}`);
      assert(await page.locator('#dive .dive-denials .ev-perm-add-btn[data-tool="Agent"]').count() === 1, 'volet : bouton Agent');
      await page.click('#dive .dive-back');
      await page.evaluate(() => document.querySelectorAll('.perm-denial-toast').forEach(t => t.remove()));
    });

    // -------- Refus traités : ils s'en vont après validation (0.37.0) --------
    await check(B, 'denial-ack', 'Refus d\'autorisation : « commande » sans Autoriser et « ✓ Vu » le retire ; « outil » accordé puis retiré ; rien ne revient au rechargement', async () => {
      if (!(await page.evaluate(() => typeof window.PermissionDenial?.classify === 'function'))) NA('fonction absente de cet état du code');
      const ts = (x) => new Date(Date.now() - x * 1000).toISOString();
      // Cas exact signalé par l'utilisateur (Get-Content avec une LISTE de fichiers).
      const PS = 'Get-Content README.md,CHANGELOG.md,TODO_LIST.md,package.json,serve.py,start-player-server.bat,start-server.bat,.gitignore,dl-batch.bat,concat-bastard.sh,ffmpeg-faststart.bat,run-scrap-heap.bat -Encoding utf8; Get-ChildItem parts | select -first 5 Name';
      const PS_MSG = 'get-content uses a parameter or complex path expression (array literal, subexpression, unknown parameter, etc.) that cannot be statically validated and requires manual approval';
      appendLog('omega', [
        { type: 'user_prompt', text: 'Faire le point sur le dépôt', timestamp: ts(60) }, { type: 'system', subtype: 'init', timestamp: ts(59) },
        toolUse('toolu_ps1', 'PowerShell', { command: PS }),
        { type: 'system', subtype: 'permission_denied', tool_name: 'PowerShell', tool_use_id: 'toolu_ps1', decision_reason_type: 'subcommandResults', message: PS_MSG },
        toolRes('toolu_ps1', PS_MSG, true),
        toolUse('toolu_ws1', 'WebSearch', { query: 'actualité du projet' }),
        toolRes('toolu_ws1', "Claude requested permissions to use WebSearch, but you haven't granted it yet.", true),
        { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 9000, result: 'Point fait (deux appels refusés).',
          permission_denials: [{ tool_name: 'PowerShell', tool_use_id: 'toolu_ps1', tool_input: { command: PS } }, { tool_name: 'WebSearch', tool_use_id: 'toolu_ws1', tool_input: { query: 'actualité du projet' } }] },
      ]);
      await page.evaluate(() => document.querySelectorAll('.perm-denial-toast').forEach(t => t.remove()));
      await setHash(page, '#/m/omega');
      assert(await until(async () => (await page.locator('#dive .dive-denials .dd-item').count()) === 2, 10_000), `refus affichés : ${await page.locator('#dive .dive-denials .dd-item').count()}`);
      const ps = page.locator('#dive .dd-item[data-tool-id="toolu_ps1"]');
      assert((await ps.getAttribute('data-kind')) === 'command', 'PowerShell : nature « command » attendue');
      assert(await ps.locator('.ev-perm-add-btn').count() === 0, 'PowerShell : « Autoriser » proposé alors que c\'est inutile');
      assert(/ne changerait rien/.test(await ps.textContent()) && /cannot be statically validated/.test(await ps.textContent()), 'PowerShell : explication ou motif absent');
      const ws = page.locator('#dive .dd-item[data-tool-id="toolu_ws1"]');
      assert((await ws.getAttribute('data-kind')) === 'tool' && await ws.locator('.ev-perm-add-btn[data-tool="WebSearch"]').count() === 1, 'WebSearch : « + Autoriser WebSearch » attendu');
      await shot(page, 'refus-volet-desktop');
      await ps.locator('[data-ack-denial]').click();
      assert(await until(async () => (await page.locator('#dive .dd-item[data-tool-id="toolu_ps1"]').count()) === 0, 5000), '« ✓ Vu » ne retire pas le refus');
      assert(await until(async () => readLogB('omega').some(e => e.subtype === 'denials_acknowledged' && e.toolIds.includes('toolu_ps1') && e.action === 'seen'), 5000), 'serveur : « Vu » non enregistré');
      await ws.locator('.ev-perm-add-btn').click();
      assert(await until(async () => (await page.locator('#dive .dive-denials .dd-item').count()) === 0, 8000), 'WebSearch accordé mais le refus reste affiché');
      const proj = JSON.parse(fs.readFileSync(path.join(sb.root, 'config.json'), 'utf8')).projects.find(p => p.name === 'omega');
      const st = JSON.parse(fs.readFileSync(path.join(proj.path, '.claude', 'settings.json'), 'utf8'));
      assert(st.permissions.allow.includes('WebSearch'), 'WebSearch absent de .claude/settings.json');
      assert(readLogB('omega').some(e => e.subtype === 'denials_acknowledged' && e.toolIds.includes('toolu_ws1') && e.action === 'granted'), 'serveur : refus accordé non acquitté');
      // Rechargement : rien ne revient. Dans un second onglet neuf (état relu
      // depuis le serveur) — recharger la page principale fausserait les
      // parcours suivants (fixtures sans horodatage repassées « non lues »).
      const p2 = await ctx.newPage();
      wire(p2);
      await p2.evaluate(() => localStorage.removeItem('perm.acked')).catch(() => {});
      await p2.goto(`${sb.url}/?token=${sb.token}#/m/omega`);
      await p2.locator('.brand').waitFor();
      await p2.evaluate(() => localStorage.removeItem('perm.acked'));
      await p2.reload(); await p2.locator('.brand').waitFor();
      await until(async () => (await p2.locator('#dive .jt, #dive .dj-line').count()) > 0, 8000);
      await sleep(1500);
      assert(await p2.locator('#dive .dive-denials .dd-item').count() === 0, 'les refus traités reviennent après rechargement (acquittement lu dans le log, pas seulement en local)');
      await p2.close();
      // Même cas, quand seul le `result` est connu (motif du CLI hors de la
      // fenêtre chargée) : toujours « commande », jamais « Ajouter PowerShell ».
      appendLog('omega', [
        { type: 'user_prompt', text: 'Relire la documentation', timestamp: ts(20) }, { type: 'system', subtype: 'init', timestamp: ts(19) },
        toolUse('toolu_01R4xqsbBXjaFpR55r94y8iZ', 'PowerShell', { command: PS, description: 'Read project docs and key scripts' }),
        { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 5000, result: 'Documentation relue.',
          permission_denials: [{ tool_name: 'PowerShell', tool_use_id: 'toolu_01R4xqsbBXjaFpR55r94y8iZ', tool_input: { command: PS, description: 'Read project docs and key scripts' } }] },
      ]);
      await setHash(page, '#/m/omega');
      const exact = page.locator('#dive .dd-item[data-tool-id="toolu_01R4xqsbBXjaFpR55r94y8iZ"]');
      assert(await until(async () => (await exact.count()) === 1, 10_000), 'cas exact : refus non affiché');
      const et = await exact.textContent();
      assert((await exact.getAttribute('data-kind')) === 'command' && await exact.locator('.ev-perm-add-btn').count() === 0, 'cas exact : « commande » attendue, sans bouton Ajouter');
      assert(!/à ses outils/.test(await page.textContent('#dive .dive-denials')) && /ne changerait rien/.test(et) && /Get-Content README\.md,CHANGELOG\.md/.test(et), `cas exact : texte ${et}`);
      await shot(page, 'refus-cas-exact');
      await exact.locator('[data-ack-denial]').click();
      assert(await until(async () => (await exact.count()) === 0, 5000), 'cas exact : « ✓ Vu » ne le retire pas');
      await page.click('#dive .dive-back');
      // Panneau en direct : refus « commande » → pas d'Autoriser, « ✓ Vu » le retire.
      appendLog('eps', [toolUse('toolu_ps2', 'PowerShell', { command: 'Get-Content $(Join-Path . a.txt)' }),
        { type: 'system', subtype: 'permission_denied', tool_name: 'PowerShell', tool_use_id: 'toolu_ps2', decision_reason_type: 'subcommandResults', message: 'Command contains subexpressions $()' },
        toolRes('toolu_ps2', 'This PowerShell command contains multiple operations. The following part requires approval: Get-Content $(Join-Path . a.txt)', true)]);
      const toast = page.locator('.perm-denial-toast[data-tool-id="toolu_ps2"]');
      assert(await until(async () => (await toast.count()) === 1, 8000), 'aucun panneau pour le refus en direct');
      assert(await toast.locator('.ct-add-btn').count() === 0 && await toast.locator('.ct-ack-btn').count() === 1, 'panneau : pas d\'Autoriser, un « ✓ Vu »');
      await toast.locator('.ct-ack-btn').click();
      assert(await until(async () => (await toast.count()) === 0, 3000), 'le panneau reste après « Vu »');
      await setHash(page, '#/m/eps');
      await sleep(800);
      assert(await page.locator('#dive .dd-item[data-tool-id="toolu_ps2"]').count() === 0, 'refus acquitté encore visible dans le volet');
      await page.click('#dive .dive-back');
    });

    // ---------------------- Vue « Projets » ----------------------
    const hasProjects = (await page.locator('#btn-projects').count()) > 0;
    const pv = (id, name, fn) => check(B, 'projets-' + id, 'Projets · ' + name, async () => { if (!hasProjects) NA('vue absente de cet état du code'); return fn(); });
    await setHash(page, '#/');

    await pv('pill', 'pill de la topbar avec compteurs', async () => {
      assert(await visible(page, '#btn-projects'), 'pill masquée');
      const txt = await page.textContent('#btn-projects');
      assert(/Projets/.test(txt) && /⚠\s*\d/.test(txt), `texte : ${txt}`);
      return txt.replace(/\s+/g, ' ');
    });
    await pv('open', 'ouverture : remplace fil + rail', async () => {
      await page.click('#btn-projects');
      assert(await until(async () => (await hash(page)) === '#/projets' && await visible(page, '#projects'), 5000), 'vue masquée');
      assert(!(await visible(page, '#conductor-view')) && !(await visible(page, '#rail')), 'fil/rail encore visibles');
    });
    const groups = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.pv-section')].map(s =>
      [s.dataset.group, [...s.querySelectorAll('.pv-item')].filter(i => !i.hidden).map(i => i.dataset.name)])));
    await pv('groups', 'groupes disjoints, chaque projet une fois, ordre d\'attention', async () => {
      await sleep(1800);   // laisse passer le délai de permutation stable
      const g = await groups();
      const all = Object.values(g).flat();
      assert(all.length === 14 && new Set(all).size === 14, `${all.length} tuiles / ${new Set(all).size} uniques`);
      for (const n of ['gamma', 'theta', 'iota', 'eta']) assert(g.attention.includes(n), `${n} pas dans Attention`);
      assert(g.attention[0] === 'eta', `la question doit être en tête (${g.attention.join(',')})`);
      for (const n of ['eps', 'delta']) assert(g.active.includes(n), `${n} pas dans Actifs`);
      for (const n of ['alpha', 'lambda', 'beta', 'mu', 'zeta']) assert(g.rest.includes(n), `${n} pas au Repos`);
      // 0.38.0 : plus de groupe « Parqués » ; zeta (ancien marqueur) est au repos.
      assert(!('parked' in g), 'groupe « Parqués » encore présent');
      assert(g.rest.includes('zeta'), `zeta (ancien marqueur) pas au Repos : ${JSON.stringify(g)}`);
      return JSON.stringify(g);
    });
    await pv('tiles', 'tuiles : sorte, mot d\'état visible, badges, chips, aria-label', async () => {
      const k = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.pv-tile')].map(b => [b.dataset.name, {
        kind: b.dataset.kind, word: b.querySelector('.pv-word')?.textContent || '', aria: b.getAttribute('aria-label') || '', text: b.textContent }])));
      // alpha : son volet a été ouvert plus haut ⇒ marqué lu ⇒ « Prêt ».
      const want = { iota: 'dead', theta: 'stall', gamma: 'error', eta: 'question', eps: 'live', delta: 'chef', alpha: 'idle', lambda: 'idle' };
      for (const [n, kind] of Object.entries(want)) assert(k[n]?.kind === kind, `${n} : ${k[n]?.kind} ≠ ${kind}`);
      for (const [n, x] of Object.entries(k)) assert(x.word.trim() && x.aria.startsWith(n), `${n} sans mot ou aria-label`);
      assert(!Object.values(k).some(x => /PARQUÉ/.test(x.text)), 'badge PARQUÉ encore affiché');
      assert(/CHEF/.test(k.chef.text), 'badge CHEF');
      assert(/⏳ 1/.test(k.eps.text) && /⇄ chef/.test(k.eps.text), `chips eps : ${k.eps.text}`);
      assert(/jamais observé/.test(k.omega?.text || '') || /il y a|instant/.test(k.omega?.text || ''), 'âge omega');
    });
    await pv('filter', 'filtre texte', async () => {
      await page.fill('#projects .pv-filter', 'gam');
      const g = await groups();
      assert(Object.values(g).flat().join() === 'gamma', `filtre : ${JSON.stringify(g)}`);
      await page.fill('#projects .pv-filter', '');
    });
    await pv('only', 'compteur « Attention » isole le groupe, second clic annule', async () => {
      await page.click('#projects .pv-count[data-only="attention"]');
      const hid = await page.evaluate(() => [...document.querySelectorAll('.pv-section')].filter(s => s.hidden).map(s => s.dataset.group));
      assert(hid.sort().join() === 'active,rest', `masqués : ${hid}`);
      await page.click('#projects .pv-count[data-only="attention"]');
      assert(await page.evaluate(() => [...document.querySelectorAll('.pv-section')].every(s => !s.hidden)), 'non rétabli');
    });
    await pv('details', 'détails : version source, APK, dernier tour', async () => {
      await page.check('#projects .pv-details input');
      const more = await page.textContent('.pv-tile[data-name="alpha"] .pv-more');
      assert(await visible(page, '.pv-tile[data-name="alpha"] .pv-more'), 'ligne détails masquée');
      assert(/code v1\.2\.3/.test(more) && /APK copié/.test(more) && /\$0\.42/.test(more), `détails : ${more}`);
      await page.uncheck('#projects .pv-details input');
    });
    await pv('tile-open', 'clic sur une tuile → volet → retour à la vue', async () => {
      await page.click('.pv-tile[data-name="alpha"]');
      assert(await until(async () => (await hash(page)) === '#/m/alpha' && await visible(page, '#dive'), 5000), 'volet');
      assert(await until(async () => !(await visible(page, '#projects')), 3000), 'vue encore visible sous le volet');
      await page.click('#dive .dive-back');
      assert(await until(async () => (await hash(page)) === '#/projets' && await visible(page, '#projects'), 5000), `retour : ${await hash(page)}`);
    });
    await pv('keyboard', 'clavier : flèches entre tuiles, Échap → salle, g p → vue', async () => {
      await page.locator('.pv-tile').first().focus();
      const first = await page.evaluate(() => document.activeElement.dataset.name);
      await page.keyboard.press('ArrowRight');
      const second = await page.evaluate(() => document.activeElement.dataset.name);
      assert(first && second && first !== second, 'flèche sans effet');
      await page.keyboard.press('Escape');
      assert(await until(async () => ['#/', ''].includes(await hash(page)) && await visible(page, '#conductor-view'), 5000), 'Échap');
      await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('g'); await page.keyboard.press('p');
      assert(await until(async () => (await hash(page)) === '#/projets' && await visible(page, '#projects'), 5000), 'g p');
    });
    await pv('flag-hot', 'drapeau config.json ui.projectsView=false à chaud puis rétabli (sans rechargement)', async () => {
      const f = path.join(sb.root, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      cfg.ui = { projectsView: false };
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
      assert(await until(async () => !(await visible(page, '#btn-projects')) && (await hash(page)) !== '#/projets', 15_000), 'vue toujours active');
      await setHash(page, '#/projets');
      assert(await until(async () => (await hash(page)) !== '#/projets', 5000), 'lien direct non refusé');
      cfg.ui = { projectsView: true };
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
      assert(await until(async () => visible(page, '#btn-projects'), 15_000), 'vue non rétablie');
    });
    await pv('param', 'paramètre ?projets=0 (ce navigateur) puis ?projets=1', async () => {
      await page.goto(`${sb.url}/?projets=0`);
      await page.locator('.brand').waitFor();
      await sleep(500);
      assert(!(await visible(page, '#btn-projects')), 'pill visible malgré ?projets=0');
      await page.goto(`${sb.url}/?projets=1`);
      await page.locator('.brand').waitFor();
      assert(await until(async () => visible(page, '#btn-projects'), 5000), 'pill absente après ?projets=1');
    });
    // ---------------- « À examiner » acquittable, journal, cadres (0.31.0) ----------------
    const hasCards = async () => (await page.locator('[data-fold="cards"]').count()) > 0;
    const v031 = (id, name, fn) => check(B, id, name, async () => {
      await setHash(page, '#/');
      await page.locator('.brand').waitFor();
      if (!(await page.evaluate(() => !!window.Activite))) NA('fonction absente de cet état du code');
      return fn();
    });
    const inExamine = (name) => page.evaluate((n) => {
      const g = [...document.querySelectorAll('#rail-body .rail-group')].find(x => /À examiner/.test(x.querySelector('.rail-group-head')?.textContent || ''));
      return !!g && !!g.querySelector(`.rail-row[data-name="${n}"]`);
    }, name);
    await v031('examine-stopped', '« À examiner » : arrêt par le chef affiché comme tel, « ✓ Vu » le retire, persistant au rechargement', async () => {
      const ts = (x) => new Date(Date.now() - x * 1000).toISOString();
      appendLog('mu', [{ type: 'user_prompt', text: 'Renommer le module', timestamp: ts(90) }, { type: 'system', subtype: 'init', timestamp: ts(89) },
        { type: 'result', subtype: 'error_killed_by_conductor', is_error: true, stopped_by: 'chef', reason: 'boucle sans progrès', duration_ms: 0 },
        { type: 'result', subtype: 'error_model_unavailable', is_error: true, num_turns: 0, result: 'model demandé indisponible' }]);
      assert(await until(() => inExamine('mu'), 8000), 'mu absent de « À examiner »');
      const row = page.locator('#rail-body .rail-row[data-name="mu"][data-stopped="1"]').first();
      const txt = await row.textContent();
      assert(/Arrêté par le chef/.test(txt) && /boucle sans progrès/.test(txt) && !/Échec/.test(txt), `cadre : ${txt}`);
      assert(/arrêté/.test(await page.textContent('#attention .att-counts')), 'bande d\'attention sans l\'arrêt');
      await page.locator('#rail-body .rail-item [data-ack="mu"]').click();
      assert(await until(async () => !(await inExamine('mu')), 8000), 'toujours dans « À examiner »');
      assert(await until(async () => (await api('/api/config')).projects.find(p => p.name === 'mu').currentState === 'idle', 5000), 'serveur : mu pas idle');
      await page.reload();
      await page.locator('.brand').waitFor();
      await until(async () => (await page.locator('#rail-body .rail-row').count()) > 0, 8000);
      await sleep(800);
      assert(!(await inExamine('mu')), 'revenu dans « À examiner » après rechargement');
    });
    await v031('examine-seen', 'Règle « vu » : ouvrir le volet d\'un échec l\'acquitte (pas une question)', async () => {
      assert(await inExamine('gamma'), 'gamma devrait être à examiner');
      await setHash(page, '#/m/gamma');
      assert(await until(async () => (await api('/api/config')).projects.find(p => p.name === 'gamma').currentState === 'idle', 8000), 'serveur : gamma pas acquitté');
      const jt = await until(async () => { const t = await page.textContent('#dive .dive-turns'); return /marqué vu/.test(t || '') ? t : null; }, 8000);
      assert(jt, 'journal : « ✓ marqué vu » absent');
      await page.click('#dive .dive-back');
      assert(await until(async () => !(await inExamine('gamma')), 5000), 'gamma toujours à examiner');
      assert(await inExamine('eta') || (await api('/api/config')).projects.find(p => p.name === 'eta').currentState === 'input', 'une question ne doit pas être acquittée');
    });
    await v031('journal-tab', 'Volet : journal d\'activité par défaut (demande, résultat, coût), log brut à un clic', async () => {
      if (!(await hasCards())) NA('cadres désactivés');
      await page.locator('.rail-card[data-name="alpha"]').click();
      assert(await until(async () => (await hash(page)) === '#/m/alpha' && await visible(page, '#dive .dive-turns'), 5000), 'journal non affiché par défaut');
      assert(await until(async () => (await page.locator('#dive .jt').count()) > 0, 8000), 'aucun tour');
      const t = await page.textContent('#dive .jt:first-of-type');
      for (const want of ['Publier la version 1.2.3', 'Version 1.2.3 publiée', '$0.42', 'v1.2.3']) assert(t.includes(want), `tour sans « ${want} » : ${t}`);
      await page.click('#dive .jt-link[data-dive-tab="journal"]');
      assert(await until(async () => (await page.locator('#dive .dj-line').count()) > 0, 5000), 'log brut inaccessible');
      await page.click('#dive .dive-tab[data-tab="turns"]');
    });
    await v031('journal-live', 'Journal en temps réel : un nouveau tour apparaît sans rechargement', async () => {
      await setHash(page, '#/m/alpha');
      await until(async () => (await page.locator('#dive .jt').count()) > 0, 8000);
      const n0 = await page.locator('#dive .jt').count();
      appendLog('alpha', [{ type: 'user_prompt', text: 'Préparer la version 1.2.4' }, { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }]);
      assert(await until(async () => (await page.locator('#dive .jt').count()) === n0 + 1
        && /Préparer la version 1\.2\.4/.test(await page.textContent('#dive .jt:first-of-type')), 8000), 'tour en cours non affiché');
      appendLog('alpha', [{ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 4000, total_cost_usd: 0.05, result: 'Version 1.2.4 prête, commit 9f8e7d6.' }]);
      assert(await until(async () => /commit 9f8e7d6/.test(await page.textContent('#dive .jt:first-of-type')), 8000), 'fin de tour non affichée');
      await page.click('#dive .dive-back');
    });
    await v031('cards-order', 'Cadres du Pilotage : du plus récemment actif au plus ancien, clic → journal', async () => {
      if (!(await hasCards())) NA('cadres désactivés');
      const rb = await page.locator('#rail').boundingBox();
      await page.mouse.move(rb && rb.x < 800 ? 1200 : 200, 300);   // hors du rail : l'ordre n'est jamais permuté sous le pointeur
      await sleep(1800);
      // L'ordre affiché suit l'instantané avec un différé voulu (1,5 s, jamais
      // sous le pointeur) : on attend qu'il soit stabilisé, puis on le vérifie.
      // Un musicien EN COURS écrit sans cesse dans son log (eps, dans le bac à
      // sable) : il peut légitimement passer devant. alpha, qui vient de finir un
      // tour, doit précéder tous les autres.
      const read = () => page.evaluate(() => [...document.querySelectorAll('.rail-card')].map(c => ({ n: c.dataset.name, s: c.dataset.state, t: Number(c.dataset.last) })));
      const live = (x) => x.s === 'live' || x.s === 'think';
      const sorted = (o) => {
        const rest = o.filter(x => !live(x));
        return o.slice(0, o.length - rest.length).every(live) && rest.every((x, i) => i === 0 || rest[i - 1].t >= x.t);
      };
      const firstIdle = (o) => o.find(x => x.s !== 'live' && x.s !== 'think')?.n;
      let order = await until(async () => { const o = await read(); return o.length && firstIdle(o) === 'alpha' && sorted(o) ? o : null; }, 12_000);
      if (!order) order = await read();
      assert(firstIdle(order) === 'alpha', `alpha (le plus récent hors tours en cours) pas en tête : ${order.map(x => x.n).join(' > ')}`);
      assert(sorted(order),
        `ordre : ${order.map(x => `${x.n}(${x.s})`).join(' > ')}`);
      assert(order[order.length - 1].t === 0 || order.every(x => x.t > 0), 'jamais observé hors de la fin');
      assert(!order.some(x => x.n === 'chef'), 'chef dans les cadres');
      assert(order.some(x => x.n === 'zeta') && order.some(x => x.n === 'eta'), 'un projet à l\'ancien marqueur « parked » manque dans les cadres');
      const card = await page.textContent('.rail-card[data-name="alpha"]');
      assert(/il y a|à l'instant/.test(card), `âge absent : ${card}`);
      return order.map(x => x.n).join(' > ');
    });
    // ---------------- Plié / déplié du journal (0.33.0) ----------------
    const LONG_PROMPT = 'Rapport détaillé demandé : ' + 'contexte long, '.repeat(30) + 'FIN DE LA DEMANDE';
    const LONG_RESULT = [
      '## Rapport détaillé', '', 'Voici le **bilan complet** de la migration.', '',
      '- étape un : schéma migré', '- étape deux : données recopiées', '- étape trois : index reconstruits', '',
      '| Table | Lignes | Statut |', '|---|---|---|', '| users | 1200 | ok |', '| orders | 98000 | ok |', '',
      '```sql', 'SELECT count(*) FROM orders;', '```', '',
      'Documentation : https://example.org/doc', '', 'Paragraphe '.repeat(60), '', 'FIN DU TEXTE',
    ].join('\n');
    const longCard = () => page.locator('#dive .jt', { hasText: 'Rapport détaillé' }).first();
    await v031('journal-fold', 'Journal : entrée longue pliée par défaut, « Afficher tout » déplie le texte complet (Markdown), clavier, état gardé au rafraîchissement', async () => {
      await setHash(page, '#/m/alpha');
      await until(async () => (await page.locator('#dive .jt').count()) > 0, 8000);
      appendLog('alpha', [{ type: 'user_prompt', text: LONG_PROMPT }, { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
        { type: 'assistant', message: { content: [{ type: 'text', text: LONG_RESULT }] } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 61000, total_cost_usd: 0.31, result: LONG_RESULT }]);
      assert(await until(async () => (await longCard().count()) > 0, 8000), 'entrée longue absente');
      const card = longCard();
      const btn = card.locator('[data-jt-toggle]');
      if (!(await btn.count())) NA('serveur sans texte complet (turn-core.js antérieur à 0.33.0 chargé par le serveur)');
      assert((await btn.getAttribute('aria-expanded')) === 'false' && /Afficher tout/.test(await btn.textContent()), 'pas plié par défaut');
      assert(!(await card.locator('.jt-full').isVisible()), 'texte complet visible alors que plié');
      assert(!/FIN DU TEXTE/.test(await card.textContent()), 'l\'aperçu ne doit pas contenir tout le texte');
      await shot(page, 'journal-replie-desktop');
      await btn.click();
      assert(await until(async () => (await longCard().locator('[data-jt-toggle]').getAttribute('aria-expanded')) === 'true', 3000), 'ne se déplie pas');
      const full = longCard().locator('.jt-full');
      assert(await full.isVisible(), 'texte complet masqué');
      const ft = await full.textContent();
      for (const want of ['FIN DE LA DEMANDE', 'FIN DU TEXTE', 'étape trois', 'SELECT count(*) FROM orders;']) assert(ft.includes(want), `texte complet sans « ${want} »`);
      assert(await full.locator('table td', { hasText: 'orders' }).count() === 1, 'tableau non rendu');
      assert(await full.locator('li').count() >= 3 && await full.locator('pre code').count() >= 1 && await full.locator('strong', { hasText: 'bilan complet' }).count() === 1, 'liste / code / gras non rendus');
      assert(await full.locator('a[href="https://example.org/doc"]').count() === 1, 'lien non rendu');
      await shot(page, 'journal-deplie-desktop');
      // Clavier : Entrée replie, le focus reste sur le contrôle.
      await longCard().locator('[data-jt-toggle]').focus();
      await page.keyboard.press('Enter');
      assert(await until(async () => (await longCard().locator('[data-jt-toggle]').getAttribute('aria-expanded')) === 'false', 3000), 'Entrée ne replie pas');
      assert(await page.evaluate(() => !!document.activeElement?.matches?.('[data-jt-toggle]')), 'focus perdu après Entrée');
      await page.keyboard.press(' ');
      assert(await until(async () => (await longCard().locator('[data-jt-toggle]').getAttribute('aria-expanded')) === 'true', 3000), 'Espace ne déplie pas');
      // Temps réel : un nouveau tour arrive, l'entrée longue reste dépliée.
      appendLog('alpha', [{ type: 'user_prompt', text: 'Vérification rapide' }, { type: 'system', subtype: 'init' },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 2000, result: 'Vérification faite, rien à signaler.' }]);
      assert(await until(async () => /Vérification rapide/.test(await page.textContent('#dive .jt:first-of-type')), 8000), 'nouveau tour non affiché');
      assert((await longCard().locator('[data-jt-toggle]').getAttribute('aria-expanded')) === 'true' && await longCard().locator('.jt-full').isVisible(),
        'l\'entrée dépliée s\'est repliée au rafraîchissement');
      // « Réduire » en bas d'un long texte : replie et ramène l'entrée.
      await longCard().locator('[data-jt-collapse]').click();
      assert(await until(async () => (await longCard().locator('[data-jt-toggle]').getAttribute('aria-expanded')) === 'false', 3000), '« Réduire » du bas sans effet');
      await page.click('#dive .dive-back');
    });
    await v031('flags-031', 'Désactivation à chaud : ui.activityJournal / ui.railCards = false puis rétablis', async () => {
      const fc = path.join(sb.root, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(fc, 'utf8'));
      cfg.ui = { ...(cfg.ui || {}), activityJournal: false, railCards: false };
      fs.writeFileSync(fc, JSON.stringify(cfg, null, 2) + '\n');
      assert(await until(async () => (await page.locator('.rail-card').count()) === 0 && (await page.locator('[data-fold="all"]').count()) === 1, 15_000), 'cadres toujours là');
      await setHash(page, '#/m/alpha');
      assert(await until(async () => visible(page, '#dive .dive-activity'), 5000), 'volet sans journal : onglet Activité attendu');
      assert(!(await visible(page, '#dive .dive-tab[data-tab="turns"]')), 'onglet journal encore visible');
      await page.click('#dive .dive-back');
      cfg.ui = { ...(cfg.ui || {}), activityJournal: true, railCards: true };
      fs.writeFileSync(fc, JSON.stringify(cfg, null, 2) + '\n');
      assert(await until(async () => (await page.locator('.rail-card').count()) > 0, 15_000), 'cadres non rétablis');
    });
    // ---------------- Models par tâche (0.39.0 → 0.40.0 : 13 pipelines) ----------------
    // Exigences utilisateur : une vue claire de l'enchaînement des tâches, un
    // model par tâche (menu groupé Anthropic / OpenAI / NVIDIA / OpenRouter) ;
    // puis « tous les pipelines », lisibles, boucles comprises, et le travail
    // images / vidéo / audio avec les models spécialisés et les outils locaux.
    const hasModels = async (pg) => (await pg.locator('#btn-models').count()) > 0;
    const TABS = 'Développement,Discussion,Routage (chef),Incident,Recherche,Audit sécurité,Maintenance,Nouveau projet,Données,Rédaction,Images,Vidéo,Audio';
    await check(B, 'models-view', 'Models par tâche : 13 onglets de pipeline, bandeau, légende, chaque étape a titre + quand/quoi + exemple + menu (variantes repliables), boucles et retours dessinés, étape optionnelle distincte, renvois, menus par capacité (outils locaux), conseils, choix enregistré puis relu après rechargement, historique', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      await setHash(page, '#/');
      await page.click('#btn-models');
      assert(await until(async () => (await hash(page)) === '#/models' && await visible(page, '#models'), 5000), 'la pill n\'ouvre pas la vue');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'onglets absents');
      if (!(await page.locator('#models .mr-tab').count())) NA('structure en pipelines absente de cet état du code');
      assert(!(await visible(page, '#rail')) && !(await visible(page, '#conductor-view')), 'le fil ou le rail reste affiché');
      const tabs = await page.$$eval('#models .mr-tab', els => els.map(e => e.textContent.replace(/\d+\/\d+/, '').replace(/^\W+/u, '').trim()));
      assert(tabs.length === 13, `${tabs.length} onglets : ${tabs.join(', ')}`);
      assert(tabs.join(',') === TABS, `onglets : ${tabs.join(',')}`);
      assert(await page.locator('#models .mr-legend li').count() >= 7, 'légende incomplète');
      for (const sym of ['→', '↻', '↩', '⤳', '◇']) assert((await page.textContent('#models .mr-legend')).includes(sym), `légende sans ${sym}`);
      // Chaque onglet : bandeau, et chaque étape complète.
      const pipelineIds = await page.$$eval('#models .mr-tab', els => els.map(e => e.dataset.pipeline));
      let nSelects = 0;
      for (const id of pipelineIds) {
        await page.click(`#models .mr-tab[data-pipeline="${id}"]`);
        assert(await until(async () => (await page.getAttribute('#models .mr-panel', 'data-pipeline')) === id, 3000), `onglet ${id} non affiché`);
        assert(await page.getAttribute(`#models .mr-tab[data-pipeline="${id}"]`, 'aria-selected') === 'true', `${id} : aria-selected`);
        const banner = await page.textContent('#models .mr-banner');
        assert(/À quoi il sert/.test(banner) && /Quand il s’applique/.test(banner), `${id} : bandeau incomplet`);
        const bad = await page.$$eval('#models .mr-panel .mr-card', cards => cards.map(c => {
          const t = c.querySelector('.mr-card-title')?.textContent.trim(), what = c.querySelector('.mr-what')?.textContent.trim(), ex = c.querySelector('.mr-ex')?.textContent.trim();
          const ref = c.classList.contains('mr-ref');
          const menu = ref ? !!c.querySelector('.mr-goto') : !!c.querySelector(':scope > .mr-select, :scope > .mr-sel-pair .mr-select');
          const vars = c.querySelectorAll('.mr-var').length, varSel = c.querySelectorAll('.mr-var .mr-select').length;
          return (!t || !what || !ex || !menu || vars !== varSel) ? `${c.dataset.step}` : null;
        }).filter(Boolean));
        assert(!bad.length, `${id} : étape(s) incomplète(s) ${bad.join(', ')}`);
        nSelects += await page.locator('#models .mr-panel .mr-select').count();
        // Menus des étapes texte : les 4 fournisseurs, OpenRouter grisé sans clé.
        const groups = await page.$$eval('#models .mr-panel .mr-card > .mr-select[data-filled], #models .mr-panel .mr-card > .mr-sel-pair .mr-select[data-filled]', sels => sels.map(s => [...s.querySelectorAll('optgroup')].map(g => `${g.dataset.provider}:${g.disabled ? 'off' : 'on'}`).join(',')));
        for (const g of groups) assert(g.startsWith('anthropic:') && g.includes('openai:') && g.includes('nvidia:') && g.includes('openrouter:off'), `${id} : groupes ${g}`);
      }
      assert(nSelects >= 90, `${nSelects} menus au total`);
      // Développement : boucle TDD, retour Revue → 4, 4c optionnel, 4b à 5 variantes.
      await page.click('#models .mr-tab[data-pipeline="dev"]');
      const loopTxt = await page.textContent('#models .mr-loop');
      assert((await page.locator('#models .mr-loop .mr-card').count()) === 3 && /4c Refactor → 4a Rouge/.test(loopTxt), 'boucle TDD 4a→4b→4c→4a non dessinée');
      assert(await page.locator('#models .mr-loop .mr-loop-line').count() === 1, 'flèche de retour de la boucle absente');
      assert(/5 Revue → 4 Boucle TDD/.test(await page.textContent('#models .mr-loops')), 'retour Revue → 4 absent');
      assert(/retour vers 4 Boucle TDD/.test(await page.textContent('#models .mr-card[data-step="revue"]')), 'retour Revue non signalé sur l\'étape');
      assert(await page.$eval('#models .mr-card[data-step="refactor"]', c => c.classList.contains('is-optional') && getComputedStyle(c).borderTopStyle === 'dashed'), '4c optionnel sans style distinct');
      assert(await page.locator('#models .mr-card[data-step="vert"] .mr-var').count() === 5, 'variantes de 4b');
      assert(/Bugfix/.test(await page.textContent('#models .mr-banner')) && /Spike/.test(await page.textContent('#models .mr-banner')), 'variantes Bugfix / Spike non affichées');
      // Flux horizontal sur PC : les premières étapes sur une ligne, de gauche à droite.
      const pos = await page.$$eval('#models .mr-flow > .mr-node', ns => ns.slice(0, 3).map(n => { const r = n.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left)]; }));
      assert(pos[0][0] === pos[1][0] && pos[1][1] > pos[0][1], `flux non horizontal : ${JSON.stringify(pos)}`);
      // Renvoi Incident → Développement.
      await page.click('#models .mr-tab[data-pipeline="incident"]');
      assert(/Incident|Développement/.test(await page.textContent('#models .mr-loops')), 'renvoi Incident non listé');
      await page.click('#models .mr-card[data-step="corriger"] .mr-goto');
      assert(await until(async () => (await page.getAttribute('#models .mr-panel', 'data-pipeline')) === 'dev', 3000), 'le renvoi n\'ouvre pas Développement');
      // Média : menus par capacité, outils locaux réellement installés.
      await page.click('#models .mr-tab[data-pipeline="images"]');
      assert(/2 Générer \/ éditer \/ analyser|3 Vérifier visuellement → 2/.test(await page.textContent('#models .mr-loops')), 'boucle Images absente');
      await page.click('#models .mr-card[data-step="produire"] .mr-vars > summary');
      assert(await until(async () => (await page.locator('#models .mr-select[data-slot="images.produire.vignettes"] optgroup').count()) > 0, 3000), 'variantes Images non remplies à l\'ouverture');
      const gen = await page.$eval('#models .mr-select[data-slot="images.produire.generation"]', s => [...s.querySelectorAll('optgroup')].map(g => ({ p: g.dataset.provider, off: g.disabled, n: g.children.length, l: g.label })));
      assert(gen.find(g => g.p === 'anthropic').off && /aucun model/.test(gen.find(g => g.p === 'anthropic').l), 'génération d\'image : Anthropic proposé');
      assert(gen.find(g => g.p === 'openrouter').n >= 1, 'génération d\'image : models OpenRouter absents');
      const thumbs = await page.$eval('#models .mr-select[data-slot="images.produire.vignettes"]', s => [...s.querySelectorAll('optgroup')].map(g => ({ p: g.dataset.provider, off: g.disabled, opts: [...g.querySelectorAll('option')].map(o => o.value + (o.disabled ? ':off' : '')) })));
      assert(thumbs.filter(g => g.p !== 'local').every(g => g.off), 'vignettes : un LLM proposé');
      assert(thumbs.find(g => g.p === 'local').opts.includes('local|ffmpeg'), 'vignettes : ffmpeg absent');
      await page.click('#models .mr-tab[data-pipeline="audio"]');
      await page.click('#models .mr-card[data-step="traiter"] .mr-vars > summary');
      assert(await until(async () => (await page.locator('#models .mr-select[data-slot="audio.traiter.tts"] optgroup').count()) > 0, 3000), 'variantes Audio non remplies à l\'ouverture');
      const tts = await page.$eval('#models .mr-select[data-slot="audio.traiter.tts"]', s => [...s.querySelectorAll('optgroup[data-provider="local"] option')].map(o => o.value + (o.disabled ? ':off' : '')));
      assert(tts.includes('local|web-speech') && tts.includes('local|piper:off'), `TTS local : ${tts}`);
      await page.selectOption('#models .mr-select[data-slot="audio.traiter.stt"]', 'local|whisper');
      assert(await until(async () => /enregistré/.test(await page.textContent('#models [data-status="audio.traiter.stt"]')), 5000), 'whisper local non enregistré');
      // Choix, conseil d'indépendance, persistance (onglet, variante dépliée, valeurs).
      await page.click('#models .mr-tab[data-pipeline="dev"]');
      const defOpt = await page.$eval('#models .mr-select[data-slot="dev.rouge"] option', o => ({ v: o.value, t: o.textContent }));
      assert(defOpt.v === '' && /défaut du projet/.test(defOpt.t), 'option « (défaut du projet) » absente');
      await page.selectOption('#models .mr-select[data-slot="dev.rouge"]', 'openai|gpt-6-astra');
      assert(await until(async () => /enregistré/.test(await page.textContent('#models [data-status="dev.rouge"]')), 5000), 'indicateur « enregistré » absent');
      await page.selectOption('#models .mr-select[data-slot="dev.vert"]', 'openai|gpt-6-astra');
      assert(await until(async () => visible(page, '#models [data-warn="dev.vert"]'), 5000), 'conseil 4a / 4b non affiché');
      assert(await page.getAttribute('#models .mr-card[data-step="rouge"]', 'data-provider') === 'openai', 'couleur du fournisseur absente');
      await page.click('#models .mr-card[data-step="vert"] .mr-vars > summary');
      assert(await until(async () => (await page.locator('#models .mr-select[data-slot="dev.vert.complexe"] optgroup').count()) > 0, 3000), 'variantes de 4b non remplies à l\'ouverture');
      const vDef = await page.$eval('#models .mr-select[data-slot="dev.vert.complexe"] option', o => o.textContent);
      assert(/model de l’étape/.test(vDef), 'variante : option « model de l’étape » absente');
      await page.selectOption('#models .mr-select[data-slot="dev.vert.complexe"]', 'anthropic|claude-opus-5-5');
      assert(await until(async () => /enregistré/.test(await page.textContent('#models [data-status="dev.vert.complexe"]')), 5000), 'variante non enregistrée');
      const srv = await api('/api/model-routing');
      assert(srv.assignments['dev.rouge']?.model === 'gpt-6-astra' && srv.assignments['dev.vert.complexe']?.model === 'claude-opus-5-5', 'serveur : choix non enregistrés');
      await page.reload();
      assert(await until(async () => (await page.getAttribute('#models .mr-panel', 'data-pipeline')) === 'dev', 10_000), 'onglet non mémorisé');
      assert(await until(async () => (await page.inputValue('#models .mr-select[data-slot="dev.rouge"]')) === 'openai|gpt-6-astra', 5000), 'choix non relu après rechargement');
      assert(await page.$eval('#models .mr-card[data-step="vert"] details.mr-vars', d => d.open), 'variantes dépliées non mémorisées');
      assert((await page.inputValue('#models .mr-select[data-slot="dev.vert.complexe"]')) === 'anthropic|claude-opus-5-5', 'variante non relue');
      assert((await page.locator('#models [data-dots="dev.vert"] .mr-dot[data-provider="anthropic"]').count()) === 1, 'pastille de variante absente');
      await page.click('#models .mr-hist-btn');
      assert(await until(async () => /gpt-6-astra/.test(await page.textContent('#models .mr-history')), 3000), 'historique sans le changement');
      await shot(page, 'models-desktop', { fullPage: true });
      if (shotsDir) {
        // La vue défile dans son propre conteneur : une fenêtre haute montre tout le schéma.
        await page.setViewportSize({ width: 1600, height: 3400 });
        for (const id of ['dev', 'images', 'audio', 'routage']) {
          await page.click(`#models .mr-tab[data-pipeline="${id}"]`);
          await sleep(300);
          await shot(page, `models-${id}`);
        }
        await page.click('#models .mr-tab[data-pipeline="dev"]');
        await page.setViewportSize({ width: 1600, height: 1000 });
      }
      for (const [slot, v] of [['dev.rouge', ''], ['dev.vert', ''], ['dev.vert.complexe', '']]) await page.selectOption(`#models .mr-select[data-slot="${slot}"]`, v);
      await until(async () => !Object.keys((await api('/api/model-routing')).assignments).some(k => k.startsWith('dev.')), 5000);
      await page.click('#models .mr-card[data-step="vert"] .mr-vars > summary');
      await page.click('#models .mr-hist-btn');
      await page.keyboard.press('Escape');
      assert(await until(async () => (await hash(page)) === '#/' && !(await visible(page, '#models')), 3000), 'Échap ne revient pas au fil');
      return `13 onglets, ${nSelects} menus`;
    });

    // 0.41.0 — décisions utilisateur : NVIDIA / OpenRouter gardés (outillage en
    // construction, jugement seulement) ; phase 1 des pipelines = observation.
    await check(B, 'models-harness', 'Models par tâche : étapes « action » / « jugement » marquées ; NVIDIA et OpenRouter visibles mais « outillage en construction » sur une étape d’action, proposés sur une étape de jugement', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      await setHash(page, '#/models');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'vue');
      if (!(await page.locator('#models .mr-kind').count())) NA('distinction action / jugement absente de cet état du code');
      await page.click('#models .mr-tab[data-pipeline="dev"]');
      assert(await page.getAttribute('#models .mr-card[data-step="vert"]', 'data-kind') === 'action', '4b non marquée action');
      assert(await page.getAttribute('#models .mr-card[data-step="revue"]', 'data-kind') === 'judge', 'revue non marquée jugement');
      const g = (slot) => page.$eval(`#models .mr-select[data-slot="${slot}"]`, s => [...s.querySelectorAll('optgroup')].map(x => ({ p: x.dataset.provider, off: x.disabled, n: x.children.length, l: x.label })));
      const act = await g('dev.vert'), jug = await g('dev.revue');
      const nvA = act.find(x => x.p === 'nvidia'), nvJ = jug.find(x => x.p === 'nvidia');
      assert(nvA && nvA.off && /outillage en construction/.test(nvA.l) && nvA.n > 0, `étape d'action : ${JSON.stringify(nvA)}`);
      assert(nvJ && !nvJ.off && nvJ.n > 0, `étape de jugement : ${JSON.stringify(nvJ)}`);
      assert(/outillage en construction/.test(act.find(x => x.p === 'openrouter').l) || /clé non configurée/.test(act.find(x => x.p === 'openrouter').l), 'OpenRouter non signalé');
      assert(/outillage/.test(await page.textContent('#models .mr-legend')), 'légende sans l’outillage en construction');
      await page.selectOption('#models .mr-select[data-slot="dev.revue"]', 'nvidia|z-ai/glm-5.3');
      assert(await until(async () => /enregistré/.test(await page.textContent('#models [data-status="dev.revue"]')), 5000), 'NVIDIA non enregistré sur la revue');
      await page.selectOption('#models .mr-select[data-slot="dev.revue"]', '');
      await setHash(page, '#/');
    });
    await check(B, 'gaps-view', 'Lacunes proposées : badge dans la page Models et sur la pill, liste avec proposition et alternative, « Accepter » ajoute l’étape et ouvre sa case pour choisir le model, « Rejeter » la retire', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      const probe = await fetch(`${sb.url}/api/pipeline-gaps`, { headers: H });
      if (probe.status === 404) NA('lacunes absentes de cet état du code');
      const report = (body) => fetch(`${sb.url}/api/pipeline-gaps`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await report({ text: 'surveiller la santé de l’app après publication', why: 'aucune étape après « Livrer »',
        proposal: { kind: 'etape', pipeline: 'dev', after: 'livrer', id: 'surveiller', label: 'Surveiller', text: 'nouvelle étape « Surveiller » après 6 Livrer' } });
      await report({ text: 'lacune de recette à rejeter', proposal: { kind: 'variante', pipeline: 'dev', step: 'vert', id: 'arejeter', text: 'variante à rejeter' } });
      await setHash(page, '#/');
      await page.reload();
      assert(await until(async () => /⚑/.test(await page.textContent('#btn-models')), 10_000), 'pas de badge ⚑ sur la pill « Models »');
      await page.click('#btn-models');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'vue');
      assert(await until(async () => /Lacunes proposées \(\d+\)/.test(await page.textContent('#models .mr-gaps-btn')), 8000), 'compteur de lacunes absent');
      assert(await page.$eval('#models .mr-gaps-btn', b => b.classList.contains('has-gaps')), 'badge non mis en évidence');
      await page.click('#models .mr-gaps-btn');
      const card = page.locator('#models .mr-gap', { hasText: 'surveiller la santé' });
      assert(await until(async () => (await card.count()) === 1, 5000), 'lacune absente de la liste');
      assert(/nouvelle étape/.test(await card.textContent()) && (await card.locator('.mr-gap-accept').count()) >= 1 && (await card.locator('.mr-gap-reject').count()) === 1, 'proposition ou boutons absents');
      await card.locator('.mr-gap-accept[data-choice="primary"]').click();
      assert(await until(async () => (await page.locator('#models .mr-card[data-slot-card="dev.surveiller"]').count()) === 1, 8000), 'étape non ajoutée au pipeline');
      assert(await page.getAttribute('#models .mr-panel', 'data-pipeline') === 'dev', 'onglet du pipeline non ouvert');
      assert(await page.$eval('#models .mr-card[data-slot-card="dev.surveiller"]', c => c.classList.contains('is-new') && !!c.querySelector('.mr-custom')), 'nouvelle case non mise en évidence');
      assert(/choisissez son model/.test(await page.textContent('#models .mr-gaps')), 'message « choisissez son model » absent');
      await page.selectOption('#models .mr-select[data-slot="dev.surveiller"]', 'anthropic|claude-sonnet-5');
      assert(await until(async () => /enregistré/.test(await page.textContent('#models [data-status="dev.surveiller"]')), 5000), 'model non enregistré sur la nouvelle étape');
      await shot(page, 'lacunes');
      const rej = page.locator('#models .mr-gap', { hasText: 'lacune de recette à rejeter' });
      await rej.locator('.mr-gap-reject').click();
      assert(await until(async () => (await page.locator('#models .mr-gap', { hasText: 'lacune de recette à rejeter' }).count()) === 0, 5000), 'lacune rejetée toujours listée');
      const v = await api('/api/model-routing');
      assert(!v.slots.some(s => s.id === 'dev.vert.arejeter'), 'une lacune rejetée a ajouté une variante');
      fs.rmSync(path.join(sb.root, 'model-routing.json'), { force: true });
      await page.click('#models .mr-gaps-btn');
      await setHash(page, '#/');
    });
    await check(B, 'models-dual', 'Mode double model : deux menus par étape et par variante (Principal, Second optionnel), second actif seulement avec un principal, badge ×2 et estimation, avertissement si identiques, persistance au rechargement, retrait', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      await setHash(page, '#/models');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'vue');
      if (!(await page.locator('#models .mr-select2').count())) NA('mode double absent de cet état du code');
      await page.click('#models .mr-tab[data-pipeline="dev"]');
      const pairs = await page.$$eval('#models .mr-panel .mr-card:not(.mr-ref)', cs => cs.map(c => !!c.querySelector(':scope > .mr-sel-pair .mr-select') && !!c.querySelector(':scope > .mr-sel-pair .mr-select2')));
      assert(pairs.length && pairs.every(Boolean), 'une étape sans ses deux menus');
      await page.click('#models .mr-card[data-step="vert"] .mr-vars > summary');
      assert(await until(async () => (await page.locator('#models .mr-card[data-step="vert"] .mr-var .mr-select2[data-filled]').count()) === 5, 5000), 'variantes sans menu « second »');
      const s2 = '#models .mr-select2[data-slot="dev.vert"]';
      assert(await page.$eval(s2, s => s.disabled), 'second actif sans principal');
      assert(/aucun — exécution simple/.test(await page.$eval(`${s2} option`, o => o.textContent)), 'option « aucun » absente');
      await page.selectOption('#models .mr-select[data-slot="dev.vert"]', 'anthropic|claude-sonnet-5');
      assert(await until(async () => !(await page.$eval(s2, s => s.disabled)), 5000), 'second toujours inactif avec un principal');
      await page.selectOption(s2, 'openai|gpt-6-astra');
      assert(await until(async () => /enregistré \(second\)/.test(await page.textContent('#models [data-status="dev.vert"]')), 5000), 'second non enregistré');
      assert(await page.locator('#models .mr-card[data-step="vert"] [data-dualbadge="dev.vert"]:not([hidden])').count() === 1, 'badge ×2 absent');
      assert(/×2 :[\s\S]*parallèle[\s\S]*relit[\s\S]*×2,5/.test(await page.textContent('#models [data-dual="dev.vert"]')), 'estimation coût / durée absente');
      const srv = await api('/api/model-routing');
      assert(srv.assignments['dev.vert']?.second?.model === 'gpt-6-astra' && srv.assignments['dev.vert'].model === 'claude-sonnet-5', 'serveur : principal ou second non enregistré');
      await shot(page, 'models-dual');
      await page.reload();
      assert(await until(async () => (await page.inputValue(s2).catch(() => '')) === 'openai|gpt-6-astra', 10_000), 'second non relu après rechargement');
      await page.selectOption(s2, 'anthropic|claude-sonnet-5');
      assert(await until(async () => /identiques/.test(await page.textContent('#models [data-dual="dev.vert"]')), 5000), 'pas d’avertissement principal = second');
      await page.selectOption('#models .mr-select[data-slot="dev.vert"]', '');
      assert(await until(async () => !(await api('/api/model-routing')).assignments['dev.vert'], 5000), 'principal non retiré');
      assert(await until(async () => (await page.$eval(s2, s => s.disabled)) && (await page.inputValue(s2)) === '', 5000), 'le second n’a pas suivi le retrait du principal');
      await page.click('#models .mr-card[data-step="vert"] .mr-vars > summary');
      await setHash(page, '#/');
    });
    // 0.46.0 — demande : recommandation de l'étude comparative affichée EN
    // SUGGESTIONS sur chaque étape, sans toucher aux choix de l'utilisateur.
    await check(B, 'models-reco', 'Suggestions de l\'étude comparative : sur CHAQUE étape et variante (confiance, alternative, justification, source), date du rapport, « non tranché » signalé ; menus sans gpt-reserve ni gpt-5.5, avec claude-haiku-5-5, dominés atténués avec raison, annoncés non sélectionnables ; choix obsolète conservé et signalé ; rien de modifié sans clic ; Appliquer (confirmation, Annuler, historique) ; « étapes vides seulement » ne touche que les vides', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      const routingPath = path.join(sb.root, 'model-routing.json');
      fs.rmSync(routingPath, { force: true });
      // Avant d'ouvrir : un choix de l'utilisateur et un choix sur un model retiré.
      fs.writeFileSync(routingPath, JSON.stringify({ version: 2, updatedAt: '2026-10-01T00:00:00Z', history: [], assignments: {
        'dev.concevoir': { provider: 'openai', model: 'gpt-6-astra', at: '2026-10-01T00:00:00Z' },
        'maintenance.dette': { provider: 'openai', model: 'gpt-5.5', at: '2026-10-01T00:00:00Z' },
      } }));
      await page.reload();
      await page.locator('.brand').waitFor();
      await setHash(page, '#/models');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'vue');
      if (!(await until(async () => (await page.locator('#models .mr-reco-box').count()) > 0, 6000))) NA('suggestions absentes de cet état du code');
      const box = await page.textContent('#models .mr-reco-box');
      assert(/8 octobre 2026/.test(box) && /a8c5cc2/.test(box) && /102 cases sur 102/.test(box), `encadré : ${box.replace(/\s+/g, ' ').slice(0, 200)}`);
      // Sur CHAQUE pipeline, chaque étape et chaque variante a son bloc de suggestion.
      const tabs = await page.$$eval('#models .mr-tab', ts => ts.map(t => t.dataset.pipeline));
      let seen = 0;
      for (const id of tabs) {
        await page.click(`#models .mr-tab[data-pipeline="${id}"]`);
        await until(async () => (await page.getAttribute('#models .mr-panel', 'data-pipeline')) === id, 3000);
        const r = await page.$$eval('#models .mr-panel [data-reco]', bs => bs.map(b => ({ id: b.dataset.reco, ok: !b.hidden && !!b.querySelector('.mr-reco-main') && !!b.querySelector('.mr-reco-conf') && !!b.querySelector('.mr-reco-why') && !!b.querySelector('[data-reco-apply]') })));
        const bad = r.filter(x => !x.ok).map(x => x.id);
        assert(r.length && !bad.length, `${id} : bloc absent ou incomplet pour ${bad.join(', ')}`);
        seen += r.length;
      }
      assert(seen === 102, `${seen} blocs au lieu de 102`);
      await page.click('#models .mr-tab[data-pipeline="discussion"]');
      assert(await page.locator('#models .mr-panel .mr-reco-und').count() > 0, '« non tranché » non signalé (Discussion)');
      await page.click('#models .mr-tab[data-pipeline="dev"]');
      await until(async () => (await page.getAttribute('#models .mr-panel', 'data-pipeline')) === 'dev', 3000);
      await page.locator('#models [data-reco="dev.concevoir"] .mr-reco-why > summary').click();
      const why = await page.textContent('#models [data-reco="dev.concevoir"] .mr-reco-why');
      assert(/§2\.1/.test(why) && /Source : rapport du 2026-10-08/.test(why) && /architecture/.test(why), `justification / source absentes : ${why.slice(0, 160)}`);
      // Menus.
      const opts = await page.$$eval('#models .mr-select[data-slot="dev.comprendre"] option', os => os.map(o => ({ v: o.value, t: o.textContent, d: o.disabled, title: o.title, dom: o.dataset.dominated })));
      assert(!opts.some(o => /gpt-reserve|gpt-5\.5$/.test(o.v)), 'gpt-reserve ou gpt-5.5 dans un menu');
      assert(opts.some(o => o.v === 'anthropic|claude-haiku-5-5' && !o.d), 'claude-haiku-5-5 absent ou désactivé');
      const dom = opts.find(o => o.v === 'anthropic|claude-opus-5');
      assert(dom && dom.dom === '1' && /Dominé par claude-opus-5-5/.test(dom.title) && /source/.test(dom.title), `dominé : ${JSON.stringify(dom)}`);
      assert(opts.some(o => o.v === 'openai|gpt-6.1-sol' && o.d && /annoncé, pas encore disponible dans codex/.test(o.t)), 'gpt-6.1-sol non signalé « annoncé »');
      // Choix existants : intacts à l'ouverture ; l'obsolète est conservé et signalé.
      const a0 = (await api('/api/model-routing')).assignments;
      assert(a0['dev.concevoir'].model === 'gpt-6-astra' && a0['maintenance.dette'].model === 'gpt-5.5' && Object.keys(a0).length === 2, 'ouvrir la vue a modifié un choix');
      assert(await page.inputValue('#models .mr-select[data-slot="dev.concevoir"]') === 'openai|gpt-6-astra', 'choix utilisateur non affiché');
      assert(/votre choix est différent \(conservé\)/.test(await page.textContent('#models [data-reco="dev.concevoir"]')), 'écart avec la suggestion non signalé');
      await page.click('#models .mr-tab[data-pipeline="maintenance"]');
      assert(await until(async () => /obsolète/.test(await page.textContent('#models [data-obsolete-warn="maintenance.dette"]').catch(() => '')), 5000), 'choix obsolète non signalé');
      assert(/⚠ obsolète : gpt-5\.5/.test(await page.$eval('#models .mr-select[data-slot="maintenance.dette"] option:checked', o => o.textContent)), 'option obsolète non marquée');
      // Appliquer une case : confirmation, Annuler ne change rien, Confirmer applique.
      await page.click('#models .mr-tab[data-pipeline="dev"]');
      await page.click('#models [data-reco-apply="dev.concevoir"]');
      assert(await until(async () => /Remplacer votre choix/.test(await page.textContent('#models [data-reco="dev.concevoir"] .mr-reco-confirm').catch(() => '')), 5000), 'pas de confirmation');
      await page.click('#models [data-reco="dev.concevoir"] .mr-reco-cancel');
      await sleep(300);
      assert((await api('/api/model-routing')).assignments['dev.concevoir'].model === 'gpt-6-astra' && !(await page.locator('#models .mr-reco-confirm').count()), 'Annuler a modifié le choix');
      await page.click('#models [data-reco-apply="dev.concevoir"]');
      await page.locator('#models [data-reco="dev.concevoir"] .mr-reco-ok-btn:not([disabled])').click();
      assert(await until(async () => (await api('/api/model-routing')).assignments['dev.concevoir']?.model === 'claude-opus-5-5', 5000), 'suggestion non appliquée');
      assert(await until(async () => (await page.inputValue('#models .mr-select[data-slot="dev.concevoir"]')) === 'anthropic|claude-opus-5-5', 5000), 'menu non mis à jour');
      assert(/✓ suivie/.test(await page.textContent('#models [data-reco="dev.concevoir"]')), '« suivie » absent');
      // « Étapes vides seulement » : un choix utilisateur reste intact.
      await page.selectOption('#models .mr-select[data-slot="dev.livrer"]', 'openai|gpt-6-astra');
      assert(await until(async () => (await api('/api/model-routing')).assignments['dev.livrer']?.model === 'gpt-6-astra', 5000), 'choix utilisateur non enregistré');
      const before = (await api('/api/model-routing')).assignments;
      await page.click('#models .mr-reco-empty');
      assert(await until(async () => /case\(s\) vide\(s\) recevront la suggestion/.test(await page.textContent('#models .mr-reco-box .mr-reco-confirm').catch(() => '')), 5000), 'pas de confirmation globale');
      await shot(page, 'models-reco-confirmation');
      await page.click('#models .mr-reco-box .mr-reco-cancel');
      await sleep(300);
      assert(JSON.stringify((await api('/api/model-routing')).assignments) === JSON.stringify(before), 'Annuler a modifié des choix');
      await page.click('#models .mr-reco-empty');
      await page.locator('#models .mr-reco-box .mr-reco-ok-btn:not([disabled])').click();
      assert(await until(async () => /case\(s\) vide\(s\) remplie\(s\)/.test(await page.textContent('#models .mr-reco-wrap').catch(() => '')), 8000), 'pas de compte rendu');
      const after = (await api('/api/model-routing?history=500'));
      for (const [k, a] of Object.entries(before)) assert(after.assignments[k]?.model === a.model, `case déjà choisie modifiée : ${k}`);
      assert(after.assignments['dev.comprendre']?.model === 'claude-opus-5-5' && after.assignments['routage.lire']?.model === 'claude-haiku-5-5', 'cases vides non remplies');
      assert(!after.assignments['dev.comprendre.codebase'], 'variante qui hérite déjà remplie inutilement');
      assert(after.history.some(h => /cases vides/.test(h.by || '')) && after.history.some(h => h.task === 'dev.concevoir' && /suggestion du rapport/.test(h.by || '')), 'historique sans les suggestions');
      await shot(page, 'models-reco');
      fs.rmSync(routingPath, { force: true });
      await page.reload();
      await page.locator('.brand').waitFor();
      await setHash(page, '#/');
    });
    await check(B, 'api-keys-view', 'Clés API dans la page Models : NVIDIA et OpenRouter, état, champ masqué ; Enregistrer → « configurée », valeur jamais affichée ni gardée dans la page, groupe OpenRouter dégrisé pour le jugement ; Supprimer → « absente »', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      await setHash(page, '#/models');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'vue');
      if (!(await page.locator('#models .mr-keys-btn').count())) NA('clés API absentes de cet état du code');
      const VALUE = 'sk-or-v1-navigateur-0123456789abcdef-valid';
      await page.click('#models .mr-keys-btn');
      assert(await until(async () => (await page.locator('#models .mr-key').count()) === 2, 5000), 'deux clés attendues');
      const row = page.locator('#models .mr-key[data-key="openrouter"]');
      assert(/absente/.test(await row.textContent()), 'OpenRouter non « absente » au départ');
      assert(await page.getAttribute('#models .mr-key[data-key="openrouter"] .mr-key-input', 'type') === 'password', 'champ non masqué');
      await row.locator('.mr-key-input').fill(VALUE);
      await row.locator('.mr-key-save').click();
      assert(await until(async () => /configurée · acceptée/.test(await page.textContent('#models .mr-key[data-key="openrouter"]')), 8000), 'état « configurée » absent après Enregistrer');
      assert((await page.inputValue('#models .mr-key[data-key="openrouter"] .mr-key-input')) === '', 'la valeur reste dans le champ');
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      assert(!html.includes(VALUE) && !html.includes(VALUE.slice(0, 24)), 'la valeur apparaît dans la page');
      assert(new RegExp(`••••${VALUE.slice(-4)}`).test(await page.textContent('#models .mr-key[data-key="openrouter"]')), '4 derniers caractères absents');
      await page.click('#models .mr-tab[data-pipeline="dev"]');
      const degrise = await until(async () => {
        const og = await page.$eval('#models .mr-select[data-slot="dev.revue"] optgroup[data-provider="openrouter"]', g => ({ off: g.disabled, l: g.label })).catch(() => null);
        return og && !og.off && !/clé non configurée/.test(og.l);
      }, 8000);
      assert(degrise, 'OpenRouter encore grisé pour le jugement');
      await shot(page, 'cles-api');
      await page.locator('#models .mr-key[data-key="openrouter"] .mr-key-del').click();
      assert(await until(async () => /absente/.test(await page.textContent('#models .mr-key[data-key="openrouter"]')), 8000), 'Supprimer sans effet');
      // Le catalogue est relu juste après l'état de la clé : on attend le nouveau rendu.
      const regrise = await until(async () => /clé non configurée/.test(await page.$eval('#models .mr-select[data-slot="dev.revue"] optgroup[data-provider="openrouter"]', g => g.label).catch(() => '')), 8000);
      assert(regrise, 'OpenRouter non regrisé après suppression');
      await page.click('#models .mr-keys-btn');
      await setHash(page, '#/');
    });
    await check(B, 'observe-view', 'Pipelines, phase 1 : panneau « Observation » — classifications récentes (entrée, projet, pipeline, mode, inclassable = Discussion), mention « rien n’est encore imposé »', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      await setHash(page, '#/models');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'vue');
      if (!(await page.locator('#models .mr-obs-btn').count())) NA('observation absente de cet état du code');
      await page.click('#models .mr-obs-btn');
      assert(await until(async () => (await page.locator('#models .mr-obs-table tbody tr').count()) > 0, 8000), 'aucune classification affichée');
      const txt = await page.textContent('#models .mr-obs');
      assert(/rien n’est encore imposé/.test(txt) && /Inclassable = Discussion/.test(txt), 'explication de la phase absente');
      const rows = await page.$$eval('#models .mr-obs-table tbody tr', trs => trs.map(tr => ({ e: tr.dataset.entry, p: tr.dataset.pipeline, t: tr.textContent })));
      assert(rows.some(r => r.e === 'dashboard:chef'), `entrées : ${[...new Set(rows.map(r => r.e))].join(', ')}`);
      assert(rows.some(r => /inclassable → Discussion/.test(r.t) && r.p === 'discussion'), 'inclassable non affiché en Discussion');
      assert(await page.getAttribute('#models .mr-obs-btn', 'aria-expanded') === 'true', 'aria-expanded');
      await shot(page, 'observation');
      await page.click('#models .mr-obs-btn');
      await setHash(page, '#/');
      return `${rows.length} classifications affichées`;
    });

    await ctx.close();

    // ---------------- Lecture audio (0.35.0) — doublure de speechSynthesis ----------------
    // Edge headless n'a pas de voix fiables : on remplace speechSynthesis AVANT
    // le chargement par une doublure qui enregistre chaque énoncé et simule sa
    // fin (window.__tts.delay ms). On teste ainsi ce qui est réellement envoyé
    // au moteur, l'enchaînement des morceaux, la pause et l'arrêt.
    const TTS_MOCK = () => {
      window.__tts = { spoken: [], cancels: 0, delay: 40 };
      class U { constructor(t) { this.text = t; this.lang = ''; this.voice = null; this.rate = 1; } }
      const voices = [
        { name: 'Microsoft Hortense - French (France)', lang: 'fr-FR' },
        { name: 'Microsoft Denise Online (Natural) - French (France)', lang: 'fr-FR' },
        { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
      ];
      let cur = null;
      const synth = {
        speaking: false, paused: false,
        getVoices: () => voices,
        addEventListener() {}, removeEventListener() {},
        speak(u) {
          window.__tts.spoken.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name, rate: u.rate });
          cur = u; this.speaking = true;
          setTimeout(() => { if (cur !== u) return; cur = null; this.speaking = false; if (u.onend) u.onend({}); }, window.__tts.delay);
        },
        cancel() { window.__tts.cancels++; const u = cur; cur = null; this.speaking = false; if (u && u.onerror) u.onerror({ error: 'interrupted' }); },
        pause() {}, resume() {},
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
      window.SpeechSynthesisUtterance = U;
    };
    const tctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
    await tctx.addInitScript(TTS_MOCK);
    const tp = await tctx.newPage();
    wire(tp);
    const spoken = () => tp.evaluate(() => window.__tts.spoken);
    await check(B, 'tts', 'Lecture audio : 🔊 sur les bulles du chef, texte nettoyé et découpé, voix FR, pause / reprise / arrêt, Ctrl+Alt+L', async () => {
      await tp.goto(`${sb.url}/?token=${sb.token}`);
      await tp.locator('.brand').waitFor();
      if (!(await tp.evaluate(() => !!window.Tts))) NA('lecture audio absente de cet état du code');
      assert(await until(async () => (await tp.locator('#cv-scroll .cv-tts-btn').count()) > 0, 10_000), 'aucun bouton « écouter » sur les bulles du chef');
      const btn = tp.locator('#cv-scroll .cv-tts-btn').first();
      assert(/Écouter/.test(await btn.getAttribute('aria-label')), 'aria-label');
      // On fait défiler le FIL jusqu'à la première bulle, comme un utilisateur :
      // laissé à Playwright, le défilement automatique décale aussi les
      // conteneurs parents (overflow: hidden) et fausse les captures.
      await tp.evaluate(() => { document.getElementById('cv-scroll').scrollTop = 0; });
      await sleep(200);
      await btn.click();
      assert(await until(async () => (await spoken()).length > 0, 3000), 'rien envoyé au moteur');
      const first = (await spoken())[0];
      assert(/la flotte est calme/.test(first.text), `texte lu : ${first.text}`);
      assert(/^fr/.test(first.lang) && /Denise Online \(Natural\)/.test(first.voice || ''), `voix : ${first.voice} (${first.lang}) — la voix française « Natural » est attendue par défaut`);
      assert(await until(async () => !(await visible(tp, '#tts-bar')), 3000), 'barre restée visible après la fin');
      // Texte long en Markdown : nettoyé, découpé, enchaîné morceau par morceau.
      await tp.evaluate(() => { window.__tts.spoken = []; });
      const md = '## Bilan\n\n' + Array.from({ length: 14 }, (_, i) => `- Étape ${i} terminée avec succès, aucune erreur constatée dans les journaux.`).join('\n') +
        '\n\n\`\`\`bash\nrm -rf /secret\n\`\`\`\n\nCommit 5bf1dde sur https://github.com/StephaneHe/orchestrateur/commit/5bf1dde.';
      await tp.evaluate((t) => window.Tts.speak(t, 'test-long'), md);
      assert(await until(async () => { const sp = await spoken(); return sp.length >= 3 && !(await tp.evaluate(() => !!window.Tts.playing)); }, 8000), 'les morceaux ne s\'enchaînent pas');
      const all = (await spoken()).map(x => x.text);
      assert(all.every(t => t.length <= 220), 'morceau trop long');
      const joined = all.join(' ');
      assert(!/secret|rm -rf|5bf1dde|https?:/.test(joined) && /bloc de code/.test(joined) && /lien vers github\.com/.test(joined) && /Étape 13/.test(joined), `texte nettoyé : ${joined.slice(0, 300)}`);
      // Pause / reprise / arrêt (énoncés lents).
      await tp.evaluate(() => { window.__tts.delay = 60_000; window.__tts.spoken = []; });
      await btn.click();
      assert(await until(async () => visible(tp, '#tts-bar'), 3000), 'barre de lecture absente');
      assert((await btn.textContent()).includes('arrêter') && (await btn.getAttribute('aria-pressed')) === 'true', 'bouton pas en « arrêter »');
      await shot(tp, 'tts-lecture-desktop');
      const c0 = await tp.evaluate(() => window.__tts.cancels);
      await tp.click('#tts-bar [data-tts-act="pause"]');
      assert(/En pause/.test(await tp.textContent('#tts-bar .tts-prog')) && (await tp.evaluate(() => window.__tts.cancels)) > c0, 'pause sans effet');
      await tp.click('#tts-bar [data-tts-act="pause"]');
      assert(/Lecture/.test(await tp.textContent('#tts-bar .tts-prog')) && (await spoken()).length === 2, 'reprise : le morceau courant doit être relu');
      await tp.click('#tts-bar [data-tts-act="stop"]');
      assert(await until(async () => !(await visible(tp, '#tts-bar')), 2000) && (await btn.textContent()).includes('écouter'), 'arrêt sans effet');
      // Ctrl+Alt+L : dernière réponse, puis arrêt.
      await tp.evaluate(() => document.activeElement?.blur());
      await tp.keyboard.press('Control+Alt+l');
      assert(await until(async () => visible(tp, '#tts-bar'), 2000), 'Ctrl+Alt+L ne lance pas la lecture');
      await tp.keyboard.press('Control+Alt+l');
      assert(await until(async () => !(await visible(tp, '#tts-bar')), 2000), 'Ctrl+Alt+L n\'arrête pas');
      await tp.evaluate(() => { window.__tts.delay = 40; });
    });
    await check(B, 'tts-settings', 'Lecture audio : réglages (voix, vitesse), lecture automatique d\'une nouvelle réponse, désactivation à chaud', async () => {
      if (!(await tp.evaluate(() => !!window.Tts))) NA('lecture audio absente de cet état du code');
      await tp.click('#btn-tweaks');
      assert(await visible(tp, '#tts-settings'), 'réglages audio absents du panneau ⚙');
      assert(await tp.locator('#tts-voice optgroup[label="Français"] option').count() === 2, 'voix françaises non listées');
      await tp.selectOption('#tts-voice', 'Microsoft Hortense - French (France)');
      await tp.locator('#tts-rate').fill('1.3');
      await tp.check('#tts-auto');
      await shot(tp, 'tts-reglages-desktop');
      await tp.click('#btn-tweaks');
      await tp.evaluate(() => { window.__tts.spoken = []; });
      await tp.fill('#composer-input', 'Message pour la lecture automatique');
      await tp.click('#composer-send');
      assert(await until(async () => (await spoken()).some(x => /fake reply to/.test(x.text)), 45_000, 500), 'nouvelle réponse du chef non lue automatiquement');
      const u = (await spoken()).find(x => /fake reply to/.test(x.text));
      assert(/Hortense/.test(u.voice || '') && Math.abs(u.rate - 1.3) < 1e-9, `réglages non appliqués : ${u.voice} ×${u.rate}`);
      await tp.reload(); await tp.locator('.brand').waitFor();
      assert(await tp.evaluate(() => localStorage.getItem('tts.auto') === '1' && localStorage.getItem('tts.voice')?.includes('Hortense')), 'réglages non mémorisés');
      await tp.evaluate(() => { localStorage.removeItem('tts.auto'); localStorage.removeItem('tts.voice'); localStorage.removeItem('tts.rate'); });
      // Désactivation à chaud (config.json → ui.tts=false).
      const fc = path.join(sb.root, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(fc, 'utf8'));
      cfg.ui = { ...(cfg.ui || {}), tts: false };
      fs.writeFileSync(fc, JSON.stringify(cfg, null, 2) + '\n');
      assert(await until(async () => (await tp.locator('#cv-scroll .cv-tts-btn:not([hidden])').count()) === 0, 15_000), 'boutons toujours là avec ui.tts=false');
      cfg.ui = { ...(cfg.ui || {}), tts: true };
      fs.writeFileSync(fc, JSON.stringify(cfg, null, 2) + '\n');
      assert(await until(async () => (await tp.locator('#cv-scroll .cv-tts-btn:not([hidden])').count()) > 0, 15_000), 'boutons non rétablis');
      await tp.goto(`${sb.url}/?tts=0`); await tp.locator('.brand').waitFor(); await sleep(800);
      assert(await tp.locator('#cv-scroll .cv-tts-btn:not([hidden])').count() === 0, '?tts=0 sans effet');
      await tp.goto(`${sb.url}/?tts=1`); await tp.locator('.brand').waitFor();
      assert(await until(async () => (await tp.locator('#cv-scroll .cv-tts-btn').count()) > 0, 10_000), '?tts=1 ne rétablit pas');
    });
    await tctx.close();
    const tmctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
    await tmctx.addInitScript(TTS_MOCK);
    const tm = await tmctx.newPage();
    wire(tm);
    await check(B, 'tts-mobile', 'Lecture audio · mobile : bouton, barre de lecture (44 px), réglages ⚙ accessibles', async () => {
      await tm.goto(`${sb.url}/?token=${sb.token}`);
      await tm.locator('.brand').waitFor();
      if (!(await tm.evaluate(() => !!window.Tts))) NA('lecture audio absente de cet état du code');
      assert(await until(async () => (await tm.locator('#cv-scroll .cv-tts-btn').count()) > 0, 10_000), 'pas de bouton sur mobile');
      await tm.evaluate(() => { window.__tts.delay = 60_000; });
      await tm.locator('#cv-scroll .cv-tts-btn').last().click();
      assert(await until(async () => visible(tm, '#tts-bar'), 3000), 'barre absente');
      const hb = await tm.locator('#tts-bar [data-tts-act="stop"]').boundingBox();
      assert(hb && hb.height >= 44, `bouton stop de ${hb && hb.height}px`);
      assert(await tm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'débordement horizontal');
      await shot(tm, 'tts-lecture-mobile');
      await tm.click('#tts-bar [data-tts-act="stop"]');
      assert(await visible(tm, '#btn-tweaks'), '⚙ masqué sur mobile : réglages de voix inaccessibles');
      await tm.click('#btn-tweaks');
      assert(await until(async () => visible(tm, '#tts-settings'), 3000), 'réglages audio absents');
      await shot(tm, 'tts-reglages-mobile');
    });
    await tmctx.close();

    // ---------------- Autorisations interactives (0.45.0) ----------------
    // Après la lecture audio : chaque demande prévient le chef (une ligne de plus
    // dans son fil), ce qui décalerait la fenêtre de bulles qu'elle relit.
    const pctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
    const pp = await pctx.newPage();
    wire(pp);
    const clk = (pg, sel) => pg.click(sel, { timeout: 8000 }).catch(e => { throw new Error(`clic « ${sel} » : ${String(e.message).split('\n')[0]}`); });
    await pp.goto(`${sb.url}/?token=${sb.token}`);
    await pp.locator('.brand').waitFor();
    // 0.45.0 — exigence : « Je n'ai pas vu de moyen d'autoriser (1 fois, pour
    // toujours) … En clickant dessus je dois voir un overlay avec tous les details. »
    // Nettoyage entre parcours : aucun overlay ouvert ni demande en attente.
    const clearPerms = async (pg) => {
      await pg.evaluate(() => window.Permissions?.closeOverlay()).catch(() => {});
      for (const p of (await api('/api/permissions').catch(() => ({}))).pending || []) {
        await fetch(`${sb.url}/api/permission/${p.id}/decide`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'deny' }) });
      }
    };
    const readOmega = () => { try { return fs.readFileSync(path.join(sb.root, 'logs', 'omega.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
    await check(B, 'permission-card', 'Autorisation en attente : carte 🔐 (projet, outil, risque, compte à rebours), clic → overlay avec l\'entrée COMPLÈTE en diff, secrets masqués, raison, dernier message ; « Toujours » avec portée → règle listée et révocable ; « Autoriser une fois » sur la carte', async () => {
      if (!(await pp.locator('#perm-band').count())) NA('demandes interactives absentes de cet état du code');
      await pp.bringToFront();
      await setHash(pp, '#/');
      const SECRET = 'sk-ant-api03-NAVIGATEURSECRET123456';
      const content = `const cle = "${SECRET}";\n` + Array.from({ length: 80 }, (_, i) => `ligne ${i + 1}`).join('\n') + '\nDERNIERE-LIGNE';
      const done1 = permDispatch(sb, 'omega', `Write|${JSON.stringify({ file_path: path.join(sb.root, 'projects', 'omega', 'src', 'config.js'), content })}`);
      assert(await until(async () => visible(pp, '#perm-band .perm-card'), 15_000), 'carte absente');
      const card = await pp.textContent('#perm-band .perm-card');
      assert(/omega/.test(card) && /Write/.test(card) && /écriture/.test(card) && /\d:\d\d/.test(card), `carte incomplète : ${card}`);
      const t1 = await pp.textContent('#perm-band .pc-left');
      const t2 = await until(async () => { const x = await pp.textContent('#perm-band .pc-left'); return x !== t1 ? x : null; }, 4000);
      assert(t2, `compte à rebours figé sur ${t1}`);
      await shot(pp, 'permission-carte');
      await clk(pp, '#perm-band .pc-main');
      assert(await until(async () => visible(pp, '#perm-overlay .po-dialog .po-why'), 8000), 'overlay absent');
      const ov = await pp.textContent('#perm-overlay .po-dialog');
      assert(/DERNIERE-LIGNE/.test(ov) && /ligne 80/.test(ov), 'entrée incomplète dans l\'overlay');
      assert(!ov.includes(SECRET), 'secret en clair dans l\'overlay');
      assert(await pp.locator('#perm-overlay .pd-l.is-add').count() > 80, 'contenu non rendu en diff');
      assert(/Pourquoi cette demande/.test(ov) && /Je vais utiliser Write/.test(ov) && /Répertoire de travail/.test(ov) && /Étape du pipeline/.test(ov), 'raison, dernier message ou métadonnées absents');
      assert(await pp.getAttribute('#perm-overlay .po-dialog', 'role') === 'dialog', 'role=dialog');
      await shot(pp, 'permission-overlay');
      await pp.check('#perm-overlay input[name="po-rule"][value$="src/**)"]');
      await clk(pp, '#perm-overlay [data-po-always]');
      assert(await until(async () => !(await visible(pp, '#perm-overlay .po-dialog')), 5000), 'overlay non fermé après décision');
      assert(await done1 === 0, 'le tour ne s\'est pas terminé');
      assert(/PERM_RESULT: allow/.test(readOmega().filter(e => e.type === 'result').pop()?.result || ''), 'le tour n\'a pas continué');
      const rules = await api('/api/permission-rules');
      assert(rules.rules.omega?.some(r => r.rule === 'Write(src/**)'), `règle : ${JSON.stringify(rules.rules.omega)}`);
      assert(await until(async () => !(await visible(pp, '#perm-band')), 5000), 'bandeau toujours visible');
      // Règles listées et révocables (menu ⋮)
      await clk(pp, '#btn-menu');
      await clk(pp, '#topmenu [data-act="perm-rules"]');
      assert(await until(async () => (await pp.locator('#perm-overlay [data-rule-revoke="Write(src/**)"]').count()) === 1, 5000), 'règle non listée');
      await clk(pp, '#perm-overlay [data-rule-revoke="Write(src/**)"]');
      assert(await until(async () => !(await api('/api/permission-rules')).rules.omega, 5000), 'règle non révoquée');
      await pp.keyboard.press('Escape');
      // « Autoriser une fois » directement sur la carte
      const done2 = permDispatch(sb, 'omega', `Bash|${JSON.stringify({ command: 'npm install && npm run build' })}`);
      assert(await until(async () => visible(pp, '#perm-band [data-perm-once]'), 15_000), 'carte 2 absente');
      await clk(pp, '#perm-band [data-perm-once]');
      assert(await done2 === 0 && /PERM_RESULT: allow/.test(readOmega().filter(e => e.type === 'result').pop()?.result || ''), '« une fois » sans effet');
    });
    await check(B, 'permission-deny', 'Autorisation : « Refuser… » → champ motif dans l\'overlay, motif transmis au model ; carte de refus passée → « Toujours autoriser à l\'avenir »', async () => {
      if (!(await pp.locator('#perm-band').count())) NA('demandes interactives absentes de cet état du code');
      await clearPerms(pp);
      await pp.bringToFront();
      const done = permDispatch(sb, 'omega', `Bash|${JSON.stringify({ command: 'rm -rf dist && git push --force' })}`);
      const dcard = pp.locator('#perm-band .perm-card', { hasText: 'git push --force' });
      assert(await until(async () => dcard.isVisible().catch(() => false), 15_000), 'carte absente');
      assert(await pp.locator('#perm-band .perm-card').count() === 1, 'une carte déjà décidée est restée affichée');
      assert(/destructif/.test(await dcard.textContent()) && await dcard.getAttribute('data-level') === 'high', `risque élevé non signalé : ${await dcard.textContent()}`);
      await dcard.locator('[data-perm-deny]').click();
      assert(await until(async () => pp.evaluate(() => document.activeElement?.id === 'po-reason'), 8000), 'champ motif non proposé');
      await pp.fill('#po-reason', 'jamais de push forcé');
      await clk(pp, '#perm-overlay [data-po-deny]');
      assert(await done === 0, 'tour non terminé');
      assert(/Motif de l'utilisateur : jamais de push forcé/.test(readOmega().filter(e => e.type === 'result').pop()?.result || ''), 'motif non transmis');
      // L'ancienne carte de refus garde « ✓ Vu » et gagne « Toujours autoriser à l'avenir »
      await pp.evaluate(() => window.App.openMusician('omega'));
      assert(await until(async () => (await pp.locator('#dive .dive-denials [data-perm-forever]').count()) > 0, 8000), 'bouton « Toujours autoriser à l\'avenir » absent');
      assert(await pp.locator('#dive .dive-denials [data-ack-denial]').count() > 0, '« ✓ Vu » disparu');
      await pp.locator('#dive .dive-denials [data-perm-forever]').first().click();
      assert(await until(async () => visible(pp, '#perm-overlay [data-rule-add]'), 5000), 'dialogue de portée absent');
      await clk(pp, '#perm-overlay [data-rule-add]');
      assert(await until(async () => (await api('/api/permission-rules')).rules.omega?.length === 1, 5000), 'règle non créée depuis l\'ancien refus');
      await fetch(`${sb.url}/api/permission-rules`, { method: 'DELETE', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'omega', rule: (await api('/api/permission-rules')).rules.omega[0].rule }) });
      await clearPerms(pp);
      await setHash(pp, '#/');
    });
    await pctx.close();

    // ---------------------- Mobile ----------------------
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
    const m = await mctx.newPage();
    wire(m);
    await check(B, 'mobile', 'Mobile 390 px : ligne Pilotage → feuille du rail', async () => {
      await m.goto(`${sb.url}/?token=${sb.token}`);
      await m.locator('.brand').waitFor();
      assert(await until(async () => visible(m, '#mobile-pilot'), 8000), 'ligne Pilotage absente');
      await m.click('#mobile-pilot');
      assert(await until(async () => visible(m, '#rail'), 5000), 'feuille du rail');
      await m.keyboard.press('Escape');
    });
    await check(B, 'permission-mobile', 'Autorisation · mobile : carte lisible, boutons ≥ 44 px, overlay plein écran sans débordement, décision possible', async () => {
      if (!(await m.locator('#perm-band').count())) NA('demandes interactives absentes de cet état du code');
      const done = permDispatch(sb, 'omega', `Edit|${JSON.stringify({ file_path: path.join(sb.root, 'projects', 'omega', 'a.js'), old_string: 'x = 1', new_string: 'x = 2' })}`);
      assert(await until(async () => visible(m, '#perm-band .perm-card'), 15_000), 'carte absente');
      const minH = await m.$$eval('#perm-band .pc-btn', bs => Math.min(...bs.map(b => b.getBoundingClientRect().height)));
      assert(minH >= 44, `bouton de ${minH}px`);
      try {
        await m.locator('#perm-band .perm-card', { hasText: 'a.js' }).locator('.pc-main').click();
        const ok = await until(async () => (await m.locator('#perm-overlay .pd-l.is-del').count()) > 0, 8000);
        assert(ok, `overlay / diff absent : ${(await m.evaluate(() => document.querySelector('#perm-overlay')?.innerText || 'pas d\'overlay')).slice(0, 200)}`);
        const box = await m.locator('#perm-overlay .po-dialog').boundingBox();
        assert(box && box.width >= 389, `overlay de ${box && box.width}px`);
        assert(await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'débordement horizontal');
        await shot(m, 'permission-overlay-mobile');
        // Aucune notification ne recouvre les boutons de décision.
        await m.locator('#perm-overlay [data-po-deny]').scrollIntoViewIfNeeded();
        const covered = await m.evaluate(() => [...document.querySelectorAll('#perm-overlay .po-acts button')].filter(b => {
          const r = b.getBoundingClientRect();
          if (r.bottom < 0 || r.top > innerHeight) return false;
          const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(innerHeight - 1, r.top + r.height / 2));
          return !(hit && b.contains(hit));
        }).map(b => b.textContent));
        assert(!covered.length, `bouton(s) recouvert(s) : ${covered.join(', ')}`);
        await m.locator('#perm-overlay [data-po-once]').scrollIntoViewIfNeeded();
        await m.click('#perm-overlay [data-po-once]');
        assert(await done === 0, 'décision mobile sans effet');
      } finally {
        // Jamais d'overlay ni de demande laissés derrière (parcours suivants).
        await m.evaluate(() => window.Permissions?.closeOverlay());
        for (const p of (await api('/api/permissions')).pending || []) {
          await fetch(`${sb.url}/api/permission/${p.id}/decide`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'deny' }) });
        }
      }
    });
    await check(B, 'mobile-journal', 'Mobile : cadres dans la feuille Pilotage, journal plein écran, aucun débordement', async () => {
      if (!(await m.evaluate(() => !!window.Activite))) NA('fonction absente de cet état du code');
      await setHash(m, '#/');
      await m.click('#mobile-pilot');
      assert(await until(async () => (await m.locator('#rail .rail-card').count()) > 0, 8000), 'aucun cadre dans la feuille');
      const minH = await m.evaluate(() => Math.min(...[...document.querySelectorAll('#rail .rail-card')].map(c => c.getBoundingClientRect().height)));
      assert(minH >= 44, `cadre de ${minH}px`);
      await m.locator('#rail .rail-card[data-name="alpha"]').click();
      assert(await until(async () => (await m.locator('#dive .jt').count()) > 0, 8000), 'journal mobile vide');
      const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(over <= 0, `débordement horizontal ${over}px`);
      await shot(m, 'journal-mobile');
      const mlong = m.locator('#dive .jt', { hasText: 'Rapport détaillé' }).first();
      if (await mlong.locator('[data-jt-toggle]').count()) {
        const h = await mlong.locator('[data-jt-toggle]').boundingBox();
        assert(h && h.height >= 44, `contrôle de ${h && h.height}px (cible tactile < 44 px)`);
        if ((await mlong.locator('[data-jt-toggle]').getAttribute('aria-expanded')) !== 'true') await mlong.locator('[data-jt-toggle]').click();
        assert(await until(async () => mlong.locator('.jt-full').isVisible(), 3000), 'mobile : ne se déplie pas');
        await mlong.locator('.jt-full table').scrollIntoViewIfNeeded();
        const over2 = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(over2 <= 0, `mobile déplié : débordement horizontal ${over2}px`);
        await shot(m, 'journal-deplie-mobile');
      }
      await m.click('#dive .dive-back');
    });
    await check(B, 'text-size-mobile', 'Taille du texte · mobile : réglage dans la barre (≥ 44 px), 150 % et 85 % sans débordement', async () => {
      if (!(await m.locator('#text-size').count())) NA('réglage absent de cet état du code');
      await setHash(m, '#/');
      assert(await visible(m, '#text-size'), 'réglage masqué sur mobile');
      const hb = await m.locator('#text-size [data-ts="1"]').boundingBox();
      assert(hb && hb.height >= 44 && hb.width >= 44, `cible A+ ${hb && Math.round(hb.width)}×${hb && Math.round(hb.height)} px`);
      for (let i = 0; i < 6; i++) { const b = m.locator('#text-size [data-ts="1"]'); if (await b.isEnabled()) await b.click(); }
      assert(await rootPx(m) === 24, `150 % : ${await rootPx(m)} px`);
      await sleep(400);
      assert(await overflowX(m) <= 0, `débordement horizontal à 150 % : ${await overflowX(m)} px`);
      // Le html masque le débordement : on mesure les bords réels.
      const outside = await m.evaluate(() => [...document.querySelectorAll('.topbar button, .topbar .pill, #text-size')]
        .filter(e => e.offsetParent).map(e => ({ id: e.id || e.className, r: e.getBoundingClientRect().right }))
        .filter(x => x.r > window.innerWidth + 0.5).map(x => x.id));
      assert(!outside.length, `hors écran à 150 % : ${outside.join(', ')}`);
      await shot(m, 'texte-150-mobile');
      await m.click('#mobile-pilot');
      await sleep(500);
      assert(await overflowX(m) <= 0, 'feuille Pilotage : débordement à 150 %');
      await shot(m, 'texte-150-mobile-pilotage');
      await m.keyboard.press('Escape');
      for (let i = 0; i < 6; i++) { const b = m.locator('#text-size [data-ts="-1"]'); if (await b.isEnabled()) await b.click(); }
      assert(Math.abs(await rootPx(m) - 13.6) < 0.05, `85 % : ${await rootPx(m)} px`);
      await sleep(300);
      await shot(m, 'texte-85-mobile');
      await m.click('#text-size [data-ts="0"]');
      assert(await rootPx(m) === 16, 'retour à 100 %');
    });
    await check(B, 'projets-mobile', 'Projets · mobile : une colonne, aucun défilement horizontal, cibles ≥ 44 px', async () => {
      if (!(await m.locator('#btn-projects').count())) NA('vue absente de cet état du code');
      await setHash(m, '#/projets');
      assert(await until(async () => visible(m, '#projects'), 5000), 'vue');
      await sleep(1800);
      const g = await m.evaluate(() => {
        const tiles = [...document.querySelectorAll('.pv-item:not([hidden]) .pv-tile')].filter(t => t.offsetParent);
        return { xs: [...new Set(tiles.map(t => Math.round(t.getBoundingClientRect().left)))], minH: Math.min(...tiles.map(t => t.getBoundingClientRect().height)),
          overflow: document.documentElement.scrollWidth - window.innerWidth, n: tiles.length };
      });
      assert(g.xs.length === 1, `colonnes : ${g.xs}`);
      assert(g.overflow <= 0, `débordement horizontal ${g.overflow}px`);
      assert(g.minH >= 44, `tuile de ${g.minH}px`);
      await m.setViewportSize({ width: 390, height: 2200 });
      await sleep(300);
      return `${g.n} tuiles`;
    });
    await check(B, 'models-reco-mobile', 'Suggestions · mobile : encadré et blocs lisibles, boutons « Appliquer » ≥ 44 px, aucun débordement', async () => {
      if (!(await hasModels(m))) NA('vue absente de cet état du code');
      await m.setViewportSize({ width: 390, height: 844 });
      await setHash(m, '#/models');
      assert(await until(async () => (await m.locator('#models .mr-tab').count()) === 13, 10_000), 'onglets');
      if (!(await until(async () => (await m.locator('#models .mr-reco-box').count()) > 0, 6000))) NA('suggestions absentes de cet état du code');
      await m.click('#models .mr-tab[data-pipeline="dev"]');
      await sleep(300);
      const g = await m.evaluate(() => ({
        minBtn: Math.min(...[...document.querySelectorAll('#models .mr-reco-apply, #models .mr-reco-empty')].filter(b => b.offsetParent).map(b => b.getBoundingClientRect().height)),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        blocks: document.querySelectorAll('#models .mr-panel [data-reco] .mr-reco-main').length,
      }));
      assert(g.blocks > 0 && g.minBtn >= 44 && g.overflow <= 0, `mobile : ${JSON.stringify(g)}`);
      await m.locator('#models .mr-card[data-step="comprendre"] .mr-reco').first().scrollIntoViewIfNeeded();
      await shot(m, 'models-reco-mobile');
      await setHash(m, '#/');
    });
    await check(B, 'models-mobile', 'Models par tâche · mobile : onglets défilants, étapes et boucle empilées, aucun débordement, menus et onglets ≥ 44 px, lisible à 150 %', async () => {
      if (!(await hasModels(m))) NA('vue absente de cet état du code');
      await m.setViewportSize({ width: 390, height: 844 });
      await setHash(m, '#/models');
      assert(await until(async () => (await m.locator('#models .mr-tab').count()) === 13 && (await m.locator('#models .mr-panel .mr-card').count()) > 0, 10_000), 'onglets ou cartes');
      await m.click('#models .mr-tab[data-pipeline="dev"]');
      await sleep(300);
      const g = await m.evaluate(() => ({
        lefts: [...new Set([...document.querySelectorAll('#models .mr-flow > .mr-node > .mr-card, #models .mr-loop-flow .mr-card')].map(s => Math.round(s.getBoundingClientRect().left)))],
        minSel: Math.min(...[...document.querySelectorAll('#models .mr-card > .mr-select, #models .mr-card > .mr-sel-pair .mr-select')].map(s => s.getBoundingClientRect().height)),
        minTab: Math.min(...[...document.querySelectorAll('#models .mr-tab')].map(s => s.getBoundingClientRect().height)),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        tabsScroll: (() => { const t = document.querySelector('#models .mr-tabs'); return t.scrollWidth > t.clientWidth && getComputedStyle(t).overflowX === 'auto'; })(),
      }));
      assert(g.lefts.length <= 2, `étapes non empilées : ${g.lefts}`);
      assert(g.overflow <= 0, `débordement horizontal ${g.overflow}px`);
      assert(g.minSel >= 44 && g.minTab >= 44, `cibles : menu ${g.minSel}px, onglet ${g.minTab}px`);
      assert(g.tabsScroll, 'onglets non défilants');
      await shot(m, 'models-mobile');
      for (let i = 0; i < 6; i++) { const b = m.locator('#text-size [data-ts="1"]'); if (await b.isEnabled()) await b.click(); }
      await sleep(300);
      const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const wide = await m.evaluate(() => [...document.querySelectorAll('#models .mr-card')].filter(c => c.getBoundingClientRect().right > window.innerWidth + 0.5).length);
      await shot(m, 'models-mobile-150');
      await m.click('#text-size [data-ts="0"]');
      assert(over <= 0 && wide === 0, `à 150 % : débordement ${over}px, ${wide} carte(s) hors écran`);
      await setHash(m, '#/');
    });
    await mctx.close();

    // ---------------------- Pages hors salle ----------------------
    const nctx = await browser.newContext();
    const n = await nctx.newPage();
    await check(B, 'token-gate', 'Navigateur sans jeton : contrat du token gate de server.js', async () => {
      const r = await n.goto(`${sb.url}/`);
      if (sb.gateOn === false) { assert(r.status() === 200, `HTTP ${r.status()}`); return 'GATE DÉSACTIVÉ dans server.js : page servie sans jeton (comportement inchangé)'; }
      assert(r.status() === 401, `HTTP ${r.status()}`);
    });
    await check(B, 'downloads', 'Page /downloads (publique) : carte et lien APK', async () => {
      await n.goto(`${sb.url}/downloads`);
      assert((await n.textContent('body')).includes('Alpha App'), 'carte absente');
      assert(await n.locator('a[href*="/downloads/alpha/apk"]').count() >= 1, 'lien APK absent');
    });
    await nctx.close();

    // Captures de documentation : contextes NEUFS (aucune bande dépliée par
    // un parcours précédent), une fois la flotte stabilisée.
    if (shotsDir) {
      await check(B, 'captures', `Captures desktop + mobile → ${shotsDir}`, async () => {
        const made = [];
        for (const vp of [{ tag: 'desktop', viewport: { width: 1600, height: 1000 } },
                          { tag: 'mobile', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]) {
          const c = await browser.newContext({ locale: 'fr-FR', ...vp });
          const pg = await c.newPage();
          wire(pg);
          await pg.goto(`${sb.url}/?token=${sb.token}`);
          await until(async () => (await pg.textContent('#conn-status .conn-text')) === 'synchronisé' || vp.tag === 'mobile', 15_000);
          await sleep(1500);
          await shot(pg, `salle-${vp.tag}`); made.push(`salle-${vp.tag}`);
          if (await pg.evaluate(() => !!window.Activite)) {
            if (vp.tag === 'mobile') {
              await pg.click('#mobile-pilot');
              await sleep(600);
              await shot(pg, 'pilotage-mobile'); made.push('pilotage-mobile');
              await pg.keyboard.press('Escape');
            }
            await setHash(pg, '#/m/alpha');
            await until(async () => (await pg.locator('#dive .jt').count()) > 0, 8000);
            await sleep(400);
            await shot(pg, `journal-${vp.tag}`); made.push(`journal-${vp.tag}`);
            await setHash(pg, '#/');
            await sleep(300);
          }
          if (await pg.locator('#btn-projects').count()) {
            await setHash(pg, '#/projets');
            await until(async () => visible(pg, '#projects'), 5000);
            await sleep(1800);
            await shot(pg, `projets-${vp.tag}`); made.push(`projets-${vp.tag}`);
            if (vp.tag === 'desktop') {
              await pg.check('#projects .pv-details input');
              await sleep(300);
              await shot(pg, 'projets-desktop-details'); made.push('projets-desktop-details');
            } else {
              await pg.setViewportSize({ width: 390, height: 2300 });
              await sleep(400);
              await shot(pg, 'projets-mobile-long'); made.push('projets-mobile-long');
            }
          }
          await c.close();
        }
        return made.join(', ');
      });
    }

    await check(B, 'js-errors', 'Aucune erreur JavaScript non interceptée pendant les parcours', async () => {
      assert(!pageErrors.length, pageErrors.slice(0, 3).join(' | '));
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
