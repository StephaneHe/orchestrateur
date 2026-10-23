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
import { pathToFileURL } from 'node:url';
import { serverEnv, REPO } from './_regression_sandbox.mjs';

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
      // The fixture's old exchange can fall out of the 60-message window once the
      // HTTP stage has added many result cards: re-seed the same kind of exchange
      // in the chef log, then RELOAD — the assertion is still "history comes back".
      const ts = new Date().toISOString();
      fs.appendFileSync(path.join(sb.root, 'logs', 'chef.jsonl'), [
        { type: 'user_prompt', text: 'Fais le point sur la flotte (historique)', timestamp: ts },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Bonjour — la flotte est calme, rien à signaler.' }] }, timestamp: ts },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, duration_api_ms: 800, result: 'Bonjour — la flotte est calme, rien à signaler.', timestamp: ts },
      ].map(e => JSON.stringify(e)).join('\n') + '\n');
      await page.reload();
      await page.locator('.brand').waitFor({ timeout: 10_000 });
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
    // ---------------- Side panel + TODO (0.75.0) ----------------
    const todoState = (pg) => pg.evaluate(() => {
      const sp = document.getElementById('side-panel');
      const r = sp && sp.getBoundingClientRect();
      const bar = document.querySelector('header.topbar').getBoundingClientRect();
      return {
        open: !!sp && sp.classList.contains('is-open') && r.left < innerWidth - 10,
        top: r ? Math.round(r.top) : null, bottom: r ? Math.round(r.bottom) : null, width: r ? Math.round(r.width) : null,
        barBottom: Math.round(bar.bottom), vh: innerHeight, vw: innerWidth,
        secs: [...document.querySelectorAll('#side-panel .todo-sec')].map(s => s.dataset.sec),
        items: [...document.querySelectorAll('#side-panel .todo-item')].map(li => ({ id: li.dataset.id, status: li.dataset.status, added: li.dataset.added, project: li.dataset.project,
          by: li.querySelector('.ti-by')?.textContent.trim() || null, box: li.querySelector('.ti-box'), disabled: li.querySelector('.ti-box')?.disabled, checked: li.querySelector('.ti-box')?.checked }))
          .map(({ box, ...x }) => x),
      };
    });
    await check(B, 'todo-panel', 'Panneau à bascule pleine hauteur + TODO des musiciens : pill, touche t, onglet du bord, Échap ; non faits en haut puis faits, chacun du plus récent au plus ancien ; nom du musicien à côté de chaque fait ; cases en lecture seule ; mémorisé ; ?todo=0', async () => {
      if (!(await page.locator('#btn-todo').count())) NA('panneau absent de cet état du code');
      await page.goto(`${sb.url}/?token=${sb.token}`); await page.locator('.brand').waitFor();
      assert(await until(async () => visible(page, '#btn-todo'), 8000), 'pill ☑ TODO absente');
      assert(await until(async () => /\d/.test(await page.textContent('#btn-todo [data-sp-badge]') || ''), 8000), 'compteur des non faits absent de la pill');
      await page.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {});
      await page.keyboard.press('t');
      assert(await until(async () => (await todoState(page)).open, 4000), 'touche t : panneau fermé');
      assert(await until(async () => (await todoState(page)).items.length >= 9, 8000), 'items absents');
      const s = await todoState(page);
      assert(Math.abs(s.top - s.barBottom) <= 2 && Math.abs(s.bottom - s.vh) <= 2, `pas pleine hauteur sous la barre : ${s.top}-${s.bottom} (barre ${s.barBottom}, fenêtre ${s.vh})`);
      // 0.76.2: open items on top, done ones below (user request replacing "done first").
      assert(s.secs.join() === 'open,done', `sections : ${s.secs.join()}`);
      const k = s.items.findIndex(i => i.status === 'done');
      const openPart = s.items.slice(0, k), donePart = s.items.slice(k);
      assert(k > 0 && openPart.every(i => i.status !== 'done') && donePart.every(i => i.status === 'done'), 'non faits pas en haut');
      for (const part of [openPart, donePart]) part.forEach((x, n) => assert(n === 0 || part[n - 1].added >= x.added, `ordre par date d’entrée : ${part.map(i => i.added).join(' ')}`));
      assert(donePart.every(i => i.by && /^✓ /.test(i.by)), 'un fait sans nom affiché à côté');
      assert(s.items.find(i => i.id === 't-a10001')?.by === '✓ alpha', `nom du musicien : ${JSON.stringify(s.items.find(i => i.id === 't-a10001'))}`);
      assert(openPart.every(i => !i.by), 'un non fait porte un nom');
      assert(s.items.every(i => i.disabled) && donePart.every(i => i.checked) && openPart.every(i => !i.checked), 'cases non désactivées ou mal cochées');
      await page.evaluate(() => document.querySelector('#side-panel .todo-item[data-status="todo"] .ti-box')?.click());
      assert((await todoState(page)).items.filter(i => i.checked).length === donePart.length, 'une case a pu être cochée');
      assert(await overflowX(page) <= 0, `débordement horizontal ${await overflowX(page)} px`);
      await shot(page, 'todo-panel-desktop');
      await page.reload(); await page.locator('.brand').waitFor();
      assert(await until(async () => (await todoState(page)).open, 6000), 'ouverture non mémorisée au rechargement');
      await page.keyboard.press('Escape');
      assert(await until(async () => !(await todoState(page)).open, 3000), 'Échap ne ferme pas');
      assert(await visible(page, '#sp-edge'), 'onglet du bord absent quand fermé');
      await page.click('#sp-edge');
      assert(await until(async () => (await todoState(page)).open, 3000), 'onglet du bord n’ouvre pas');
      await page.click('#side-panel .sp-close');
      assert(await until(async () => !(await todoState(page)).open, 3000), '✕ ne ferme pas');
      await page.click('#btn-todo');
      assert(await until(async () => (await todoState(page)).open && (await page.getAttribute('#btn-todo', 'aria-pressed')) === 'true', 3000), 'pill n’ouvre pas');
      await page.click('#btn-todo');
      assert(await until(async () => !(await todoState(page)).open, 3000), 'pill ne referme pas');
      await page.goto(`${sb.url}/?token=${sb.token}&todo=0`); await page.locator('.brand').waitFor();
      await page.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {});
      await page.keyboard.press('t');
      await sleep(400);
      assert(!(await visible(page, '#btn-todo')) && !(await visible(page, '#sp-edge')) && !(await todoState(page)).open, '?todo=0 : panneau encore accessible');
      await page.goto(`${sb.url}/?token=${sb.token}&todo=1`); await page.locator('.brand').waitFor();
      assert(await until(async () => visible(page, '#btn-todo'), 6000), '?todo=1 ne rétablit pas');
      // Leave the page as the next checks expect it: plain URL, rail filled.
      await page.goto(`${sb.url}/?token=${sb.token}`); await page.locator('.brand').waitFor();
      await until(async () => /À examiner/.test(await page.textContent('#rail-body') || ''), 15_000);
      return `${s.items.length} items : ${k} non faits puis ${s.items.length - k} faits (avec nom), ordre par date d’entrée, panneau ${s.width}px × pleine hauteur`;
    });
    // ---------------- Git graph tab (0.76.0) ----------------
    const gitState = (pg) => pg.evaluate(() => {
      const pane = document.querySelector('#side-panel [data-sp-pane="git"]');
      return {
        open: !!document.querySelector('#side-panel.is-open'), visible: !!pane && !pane.hidden,
        project: pane?.querySelector('.gg-project')?.value || null,
        rows: pane ? pane.querySelectorAll('.gg-row').length : 0, dots: pane ? pane.querySelectorAll('.gg-dot').length : 0,
        edges: pane ? pane.querySelectorAll('.gg-edge').length : 0,
        refs: pane ? [...pane.querySelectorAll('.gg-ref')].map(r => r.textContent.trim()) : [],
        summary: pane?.querySelector('.gg-summary')?.textContent || '',
        buttons: pane ? [...pane.querySelectorAll('button, a, input:not([type=hidden])')].map(b => b.className || b.tagName) : [],
      };
    });
    await check(B, 'git-panel', 'Arbre git des musiciens dans le même panneau que la TODO : pill ⎇ Git, choix du musicien (dépôts seulement), un point par commit, branches, tags et HEAD affichés, lignes de l’historique ; aucune action git possible ; bascule entre onglets TODO / Git', async () => {
      if (!(await page.locator('#btn-git').count())) NA('onglet Git absent de cet état du code');
      assert(await until(async () => visible(page, '#btn-git'), 6000), 'pill ⎇ Git absente');
      await page.click('#btn-git');
      assert(await until(async () => (await gitState(page)).open && (await gitState(page)).visible, 4000), 'onglet Git non ouvert');
      await page.selectOption('#side-panel .gg-project', 'omega');
      assert(await until(async () => (await gitState(page)).rows > 0, 10_000), 'graphe omega vide');
      const s = await gitState(page);
      assert(s.project === 'omega' && s.dots === s.rows && /omega · HEAD/.test(s.summary), `rendu : ${JSON.stringify({ p: s.project, rows: s.rows, dots: s.dots, sum: s.summary })}`);
      assert(s.refs.some(r => /^HEAD → /.test(r)), `HEAD non signalé : ${s.refs.join(' | ')}`);
      assert(await page.evaluate(() => [...document.querySelectorAll('#side-panel .gg-project option')].some(o => o.disabled && /pas de dépôt git/.test(o.textContent))), 'les projets sans dépôt ne sont pas signalés');
      assert(s.buttons.every(b => /gg-more-btn|gg-project/.test(b)), `élément d’action inattendu : ${s.buttons.join(', ')}`);
      assert(await overflowX(page) <= 0, `débordement horizontal ${await overflowX(page)} px`);
      await shot(page, 'git-panel-desktop');
      await page.click('#side-panel [data-sp-tab="todo"]');
      assert(await until(async () => (await page.locator('#side-panel [data-sp-pane="todo"]').isVisible()) && !(await gitState(page)).visible, 3000), 'bascule vers TODO');
      await page.click('#side-panel [data-sp-tab="git"]');
      assert(await until(async () => (await gitState(page)).visible && (await gitState(page)).project === 'omega', 3000), 'retour à Git (musicien mémorisé)');
      await page.keyboard.press('Escape');
      assert(await until(async () => !(await gitState(page)).open, 3000), 'Échap ne ferme pas');
      return `omega : ${s.rows} commits, ${s.edges} trait(s), refs ${s.refs.slice(0, 4).join(' · ')}`;
    });
    // 0.97.0 — user request (2026-10-14): « Je dois voir comme TODO ou GIT, une
    // liste qui augmente au fur et a mesure et qui conduira a la release note en
    // fonction de ce qui est pret ».
    await check(B, 'release-panel', 'Onglet « 📰 Release » du panneau (comme TODO et Git) : par musicien, la liste de ce qui est en cours et prêt, qui s’allonge quand le CHANGELOG grandit ; la release note ne reprend que le « prêt », avec Copier et Télécharger .md ; lecture seule', async () => {
      if (!(await page.locator('#btn-release').count())) NA('onglet Release absent de cet état du code');
      const cl = path.join(sb.root, 'projects', 'alpha', 'CHANGELOG.md');
      const V = (v, line) => `## [${v}] - 2026-10-1${v.at(-1)}\n\n### Added\n\n- ${line}\n`;
      const write = (...b) => fs.writeFileSync(cl, ['# Changelog', '', ...b].join('\n') + '\n');
      const rl = () => page.evaluate(() => {
        const pane = document.querySelector('#side-panel [data-sp-pane="release"]');
        return { visible: !!pane && pane.offsetParent !== null, project: pane?.querySelector('.rl-project')?.value || '',
          ready: pane ? pane.querySelectorAll('.rl-item[data-state="ready"]').length : 0, progress: pane ? pane.querySelectorAll('.rl-item[data-state="progress"]').length : 0,
          note: pane?.querySelector('.rl-note')?.textContent || '', copy: pane?.querySelector('.rl-copy')?.textContent || '',
          summary: pane?.querySelector('.rl-summary')?.textContent || '' };
      });
      write('## [Unreleased]\n\n### Fixed\n\n- NAV-EN-COURS\n', V('1.0.0', 'NAV-PRET-1'));
      try {
        assert(await until(async () => visible(page, '#btn-release'), 6000), 'pill 📰 Release absente');
        await page.click('#btn-release');
        assert(await until(async () => (await rl()).visible, 4000), 'onglet Release non ouvert');
        await page.selectOption('#side-panel .rl-project', 'alpha');
        assert(await until(async () => (await rl()).ready === 1, 8000), `liste : ${JSON.stringify(await rl())}`);
        let s = await rl();
        assert(s.progress === 1 && /aucune release repérée/.test(s.summary) && s.note.includes('NAV-PRET-1') && !s.note.includes('NAV-EN-COURS'), `départ : ${JSON.stringify(s)}`);
        write('## [Unreleased]\n\n### Fixed\n\n- NAV-EN-COURS\n', V('1.1.0', 'NAV-PRET-2'), V('1.0.0', 'NAV-PRET-1'));
        await page.evaluate(() => window.ReleasePanel.reload());
        assert(await until(async () => (await rl()).ready === 2, 8000), 'la liste ne s’est pas allongée');
        s = await rl();
        assert(s.note.includes('NAV-PRET-1') && s.note.includes('NAV-PRET-2') && !s.note.includes('NAV-EN-COURS'), `release note : ${s.note}`);
        await page.click('#side-panel .rl-copy');
        assert(await until(async () => /Copié/.test((await rl()).copy), 3000), 'Copier sans effet');
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#side-panel .rl-download')]);
        const body = fs.readFileSync(await dl.path(), 'utf8');
        assert(/^alpha-release-1\.1\.0\.md$/.test(dl.suggestedFilename()) && body === s.note, `téléchargement : ${dl.suggestedFilename()}`);
        assert(await overflowX(page) <= 0, `débordement horizontal ${await overflowX(page)} px`);
        await shot(page, 'release-panel-desktop');
        return `alpha : ${s.ready} prêts, ${s.progress} en cours ; note copiée et téléchargée (${body.length} car.)`;
      } finally {
        fs.rmSync(cl, { force: true });
        await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate(() => { if (window.SidePanel?.isOpen()) window.SidePanel.close(); });
      }
    });
    // 0.131.0 — knowledge graph phase 1 (« vas y », 2026-10-22), exit criterion « navigateur kg-tab ».
    const kgState = (p) => p.evaluate(() => {
      const pane = document.querySelector('#side-panel [data-sp-pane="kg"]');
      const n = (sel) => pane ? pane.querySelectorAll(sel).length : 0;
      return { open: !!pane && pane.offsetParent !== null, facts: n('.kg-item[data-kind="fact"]'), conflicts: n('.kg-item[data-kind="conflict"]'), cards: n('.kg-card'),
        notice: pane?.querySelector('.kg-notice')?.textContent || '', text: pane?.innerText || '', pill: !!document.getElementById('btn-kg'),
        band: (() => { const b = document.getElementById('kg-band'); return b && !b.hidden ? Number(b.dataset.ndCount) : 0; })() };
    });
    await check(B, 'kg-tab', 'Onglet « 🧠 Mémoire » (bureau) : absent tant que kg.ui est coupé, apparaît à chaud ; revue des faits proposés avec leurs quatre questions, Valider, Rejeter avec motif, Ouvrir la source (Échap ferme la fenêtre, pas le panneau), Corriger la source (message au chef, rien réécrit) ; bandeau « contradictions entre règles » avec « celle-ci vaut » ; Règles en vigueur et Statistiques', async () => {
      const fxFile = path.join(sb.root, 'tests', 'kg-fixture.mjs');
      if (!fs.existsSync(fxFile)) NA('onglet Mémoire absent de cet état du code');
      const FX = await import(pathToFileURL(fxFile).href);
      const fx = await FX.seedKg(sb.root);
      if (!fx) NA('onglet Mémoire absent de cet état du code');
      try {
        await sleep(6000);
        assert(!(await kgState(page)).pill, 'pill 🧠 présente alors que kg.ui est coupé');
        fx.ui(true);
        assert(await until(async () => visible(page, '#btn-kg'), 15_000), 'pill 🧠 Mémoire absente après kg.ui on (à chaud)');
        assert(await until(async () => (await kgState(page)).band >= 1, 10_000), 'bandeau des contradictions absent');
        await page.click('#btn-kg');
        assert(await until(async () => { const s = await kgState(page); return s.open && s.facts === 2; }, 10_000), `revue : ${JSON.stringify(await kgState(page))}`);
        let s = await kgState(page);
        assert(s.cards >= 2 && /Ce que nous savons/.test(s.text) && /Pourquoi/.test(s.text) && /Depuis quand/.test(s.text) && /Où cela s’applique/.test(s.text), 'fiche à quatre questions absente');
        await page.click('#side-panel .kg-item[data-kind="fact"] .kg-act[data-action="validate"]');
        assert(await until(async () => { const x = await kgState(page); return x.facts === 1 && /Enregistré/.test(x.notice); }, 8000), `validation : ${JSON.stringify(await kgState(page))}`);
        await page.click('#side-panel .kg-item[data-kind="fact"] .kg-ask[data-action="reject"]');
        await page.fill('#side-panel .kg-form .kg-in', 'lien faux (recette)');
        await page.click('#side-panel .kg-form button[type="submit"]');
        assert(await until(async () => (await kgState(page)).facts === 0, 8000), 'rejet avec motif sans effet');
        await page.click('#side-panel .kg-item[data-kind="conflict"] .kg-open-src');
        assert(await until(async () => visible(page, '#kg-source-overlay .kgo-hit'), 6000), 'fenêtre de la source absente');
        await page.keyboard.press('Escape');
        assert(await until(async () => !(await visible(page, '#kg-source-overlay .kgo-box')), 3000) && (await kgState(page)).open, 'Échap : la fenêtre ne se ferme pas, ou le panneau se ferme');
        const before = (await kgState(page)).band;
        await page.click('#kg-band .kg-keep');
        assert(await until(async () => (await kgState(page)).band < before, 8000), '« celle-ci vaut » du bandeau sans effet');
        await page.click('#side-panel .kg-fix-src');
        assert(await until(async () => /Corriger la source d’un fait de la mémoire/.test(await page.inputValue('#composer-input')), 4000), 'Corriger la source : message au chef non préparé');
        await page.fill('#composer-input', '');
        await page.click('#btn-kg');
        await page.click('#side-panel [data-kg-tab="rules"]');
        assert(await until(async () => /Liens validés par vous \(1\)/.test((await kgState(page)).text), 8000), 'Règles en vigueur : le lien validé manque');
        await page.click('#side-panel [data-kg-tab="stats"]');
        assert(await until(async () => (await page.locator('#side-panel .kg-stat').count()) > 0, 8000), 'Statistiques : aucune case');
        await page.click('#side-panel .kg-stat');
        assert(await until(async () => visible(page, '#side-panel .kg-stat-detail'), 6000), 'détail d’une case absent');
        assert(await overflowX(page) <= 0, `débordement horizontal ${await overflowX(page)} px`);
        await shot(page, 'kg-tab-desktop');
        s = await kgState(page);
        await page.click('#side-panel [data-kg-tab="review"]');
        return `pill à chaud, 2 faits proposés (1 validé, 1 rejeté), source ouverte, contradiction tranchée depuis le bandeau, règles et statistiques`;
      } finally {
        FX.clearKg(fx);
        await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate(() => { if (window.SidePanel?.isOpen()) window.SidePanel.close(); });
        await until(async () => !(await kgState(page)).pill, 15_000);
      }
    });
    // 0.98.0 — user request (2026-10-14): « Dans RELEASE, les items doivent
    // etre regroupes par release, et chaque release est clickable et ouvrir une
    // fenetre qui montre les details de chaque items ».
    await check(B, 'release-groups', 'Onglet Release : les éléments sont regroupés par release (en cours d’abord, puis chaque version, la plus récente en haut) ; chaque release est cliquable (clic ou clavier) et ouvre une fenêtre qui montre le détail complet de chacun de ses éléments ; Échap, ✕ ou clic hors zone la ferment, l’onglet reste ouvert', async () => {
      if (!(await page.locator('#btn-release').count())) NA('onglet Release absent de cet état du code');
      if (!(await page.evaluate(() => !!window.ReleasePanel?.openDetail))) NA('regroupement par release absent de cet état du code');
      const cl = path.join(sb.root, 'projects', 'alpha', 'CHANGELOG.md');
      fs.writeFileSync(cl, ['# Changelog', '', '## [Unreleased]', '', '### Fixed', '', '- GRP-EN-COURS', '',
        '## [1.1.0] - 2026-10-11', '', '### Added', '', '- GRP-A', '- GRP-B première ligne', '  - GRP-B-SOUS-POINT', '', '### Fixed', '', '- GRP-C', '',
        '## [1.0.0] - 2026-10-10', '', '### Added', '', '- GRP-D', ''].join('\n') + '\n');
      const groups = () => page.evaluate(() => [...document.querySelectorAll('#side-panel [data-sp-pane="release"] .rl-group')].map(g => ({ key: g.dataset.key, state: g.dataset.state, n: g.querySelectorAll('.rl-item').length, head: g.querySelector('.rl-group-head')?.textContent.replace(/\s+/g, ' ').trim() })));
      const ovs = () => page.evaluate(() => { const o = document.getElementById('release-overlay'); return { open: !!o && !o.hidden, title: o?.querySelector('.rlo-title')?.textContent || '', meta: o?.querySelector('.rlo-meta')?.textContent || '', items: o ? [...o.querySelectorAll('.rlo-item')].map(i => i.textContent.replace(/\s+/g, ' ').trim()) : [] }; });
      try {
        if (!(await page.evaluate(() => window.SidePanel?.isOpen()))) await page.click('#btn-release');
        await page.click('#side-panel [data-sp-tab="release"]').catch(() => {});
        await page.selectOption('#side-panel .rl-project', 'alpha');
        await page.evaluate(() => window.ReleasePanel.reload());
        assert(await until(async () => (await groups()).length === 3, 8000), `groupes : ${JSON.stringify(await groups())}`);
        const g = await groups();
        assert(g.map(x => x.key).join() === 'progress,v:1.1.0,v:1.0.0' && g.map(x => x.n).join() === '1,3,1', `ordre et contenu des groupes : ${JSON.stringify(g)}`);
        assert(/En cours/.test(g[0].head) && /1\.1\.0/.test(g[1].head) && /3 éléments/.test(g[1].head), `en-têtes : ${g.map(x => x.head).join(' | ')}`);
        await page.click('#side-panel .rl-group-head[data-rl-group="v:1.1.0"]');
        assert(await until(async () => (await ovs()).open, 3000), 'fenêtre de détail non ouverte');
        let o = await ovs();
        assert(/release 1\.1\.0/.test(o.title) && /3 éléments/.test(o.meta) && /Added, Fixed/.test(o.meta), `titre / méta : ${o.title} — ${o.meta}`);
        assert(o.items.length === 3 && o.items.some(t => /GRP-B première ligne/.test(t) && /GRP-B-SOUS-POINT/.test(t)) && !o.items.some(t => /GRP-D|GRP-EN-COURS/.test(t)), `éléments de la fenêtre : ${JSON.stringify(o.items)}`);
        await shot(page, 'release-groups-detail');
        await page.keyboard.press('Escape');
        assert(await until(async () => !(await ovs()).open, 3000) && await page.evaluate(() => window.SidePanel.isOpen()), 'Échap : la fenêtre doit se fermer, l’onglet rester ouvert');
        await page.focus('#side-panel .rl-group-head[data-rl-group="progress"]');
        await page.keyboard.press('Enter');
        assert(await until(async () => (await ovs()).open, 3000), 'Entrée sur une release : fenêtre non ouverte');
        o = await ovs();
        assert(/en cours/.test(o.title) && o.items.length === 1 && /GRP-EN-COURS/.test(o.items[0]), `en cours : ${JSON.stringify(o)}`);
        await page.click('#release-overlay .rlo-backdrop', { position: { x: 5, y: 5 } });
        assert(await until(async () => !(await ovs()).open, 3000), 'clic hors zone : fenêtre non fermée');
        return `3 groupes (en cours, 1.1.0, 1.0.0) ; fenêtre 1.1.0 : ${o.items.length ? 3 : 0} éléments complets ; Échap, Entrée, clic hors zone`;
      } finally {
        fs.rmSync(cl, { force: true });
        await page.evaluate(() => { window.ReleasePanel?.closeDetail?.(); if (window.SidePanel?.isOpen()) window.SidePanel.close(); });
      }
    });
    // 0.100.0 — user request (2026-10-14): « Je parle de voir comment une
    // requete utilisateur a ete decoupee en taches atomiques, et voir le
    // progres de ces taches, meme detachees ».
    const requestFx = async () => {
      const f = path.join(sb.root, 'tests', 'request-fixture.mjs');
      return fs.existsSync(f) ? import(pathToFileURL(f).href) : null;
    };
    const rqState = (pg, run) => pg.evaluate((run) => {
      const pane = document.querySelector('#side-panel [data-sp-pane="requests"]');
      const req = pane?.querySelector(`.rq-request[data-run="${run}"]`);
      const box = (el) => { const r = el?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
      return { visible: !!pane && pane.offsetParent !== null, runs: pane ? [...pane.querySelectorAll('.rq-request')].map(r => r.dataset.run) : [],
        tasks: req ? [...req.querySelectorAll('.rq-task')].map(t => ({ n: +t.dataset.n, state: t.dataset.state, level: +t.closest('.rq-col').dataset.level, text: t.textContent.replace(/\s+/g, ' '), box: box(t) })) : [],
        links: req ? req.querySelectorAll('.rq-links .rq-link').length : 0, linksShown: req ? getComputedStyle(req.querySelector('.rq-links')).display !== 'none' : false,
        head: req?.querySelector('.rq-head')?.textContent.replace(/\s+/g, ' ') || '' };
    }, run);
    const rqOv = (pg) => pg.evaluate(() => { const o = document.getElementById('requests-overlay'); return { open: !!o && !o.hidden, title: o?.querySelector('.rqo-title')?.textContent || '', text: o?.querySelector('.rqo-body')?.textContent.replace(/\s+/g, ' ') || '', tasks: o ? o.querySelectorAll('.rqo-task').length : 0 }; });
    await check(B, 'requests-panel', 'Onglet « 🧭 Requêtes » : chaque requête au chef avec la carte de son découpage en tâches atomiques (une colonne par niveau de dépendance, un trait vers la tâche attendue, une couleur par état) et l’état de chacune, même détachée, mis à jour en direct ; clic sur une tâche ou la requête : détail complet ; Échap ferme la fenêtre, pas l’onglet ; requêtes sans tâche masquées par défaut ; lecture seule', async () => {
      if (!(await page.locator('#btn-requests').count())) NA('onglet Requêtes absent de cet état du code');
      const FX = await requestFx();
      if (!FX) NA('jeu de données des requêtes absent de cet état du code');
      const logsDir = path.join(sb.root, 'logs'), chefDir = path.join(sb.root, 'projects', 'chef');
      FX.writeRequestFixture({ logsDir, chefDir });
      try {
        await page.evaluate(() => localStorage.removeItem('requests.all'));
        assert(await until(async () => visible(page, '#btn-requests'), 6000), 'pill 🧭 Requêtes absente');
        await page.click('#btn-requests');
        assert(await until(async () => (await rqState(page, FX.REQ_RUN)).tasks.length === 7, 10_000), `carte absente : ${JSON.stringify(await rqState(page, FX.REQ_RUN))}`);
        let s = await rqState(page, FX.REQ_RUN);
        const bad = Object.entries(FX.EXPECTED).filter(([n, e]) => { const t = s.tasks.find(x => x.n === +n); return !t || t.state !== e.state || t.level !== e.level; });
        assert(!bad.length, `états / colonnes : ${s.tasks.map(t => `${t.n}:${t.state}/L${t.level}`).join(' ')}`);
        assert(s.links >= 2 && s.linksShown, `traits de dépendance : ${s.links}`);
        const t1 = s.tasks.find(t => t.n === 1), t2 = s.tasks.find(t => t.n === 2);
        assert(t2.box.x > t1.box.x + t1.box.w, 'la tâche 2 (après 1) doit être à droite de la tâche 1');
        assert(/2\/5/.test(s.tasks.find(t => t.n === 7).text) && /détachée/.test(t2.text) && /REQ-FIX-REQUEST/.test(s.head), 'progression du pipeline, marque « détachée » ou requête absentes');
        assert(!s.runs.includes(FX.NOTASK_RUN) && !s.runs.includes(FX.RELAY_RUN) && !s.runs.includes(FX.CALLBACK_RUN), `requêtes sans tâche affichées par défaut : ${s.runs.join(' ')}`);
        await page.check('#side-panel .rq-all');
        assert(await until(async () => (await rqState(page, FX.REQ_RUN)).runs.includes(FX.NOTASK_RUN), 3000), '« tout afficher » sans effet');
        assert(!(await rqState(page, FX.REQ_RUN)).runs.includes(FX.CALLBACK_RUN), 'un réveil du chef est affiché comme une requête');
        await page.uncheck('#side-panel .rq-all');
        await page.click(`#side-panel .rq-task[data-run="${FX.REQ_RUN}"][data-n="5"]`);
        assert(await until(async () => (await rqOv(page)).open, 3000), 'détail de la tâche non ouvert');
        let o = await rqOv(page);
        assert(/Tâche 5/.test(o.title) && /code 65/.test(o.text) && /REQ-FIX tâche 5/.test(o.text), `détail tâche 5 : ${o.title} — ${o.text.slice(0, 300)}`);
        await page.click('#requests-overlay .rqo-chip[data-rqo-task="7"]');
        assert(await until(async () => /Tâche 7/.test((await rqOv(page)).title) && /liste-tests/.test((await rqOv(page)).text), 3000), 'navigation vers la tâche 7');
        await shot(page, 'requests-panel-detail');
        await page.keyboard.press('Escape');
        assert(await until(async () => !(await rqOv(page)).open, 3000) && await page.evaluate(() => window.SidePanel.isOpen()), 'Échap : la fenêtre doit se fermer, l’onglet rester ouvert');
        await page.click(`#side-panel .rq-head[data-rq-request="${FX.REQ_RUN}"]`);
        assert(await until(async () => (await rqOv(page)).open, 3000), 'détail de la requête non ouvert');
        o = await rqOv(page);
        assert(/REQ-FIX-REQUEST/.test(o.text) && /REQ-FIX-SENS/.test(o.text) && o.tasks === 7, `détail de la requête : ${o.tasks} tâches`);
        await page.click('#requests-overlay .rqo-backdrop', { position: { x: 5, y: 5 } });
        assert(await until(async () => !(await rqOv(page)).open, 3000), 'clic hors zone : fenêtre non fermée');
        // The detached task finishes: the map follows it without reopening.
        fs.appendFileSync(path.join(logsDir, `${FX.MUS_B}.jsonl`), JSON.stringify({ orch_turn: 't-fix-2', type: 'result', subtype: 'success', num_turns: 2, duration_api_ms: 40, result: 'REQ-FIX-DONE-2', timestamp: new Date().toISOString() }) + '\n');
        assert(await until(async () => { await page.evaluate(() => window.RequestsPanel.reload()); return (await rqState(page, FX.REQ_RUN)).tasks.find(t => t.n === 2)?.state === 'terminee'; }, 12_000), 'la tâche détachée ne passe pas à « terminée »');
        assert(await overflowX(page) <= 0, `débordement horizontal ${await overflowX(page)} px`);
        await shot(page, 'requests-panel-desktop');
        s = await rqState(page, FX.REQ_RUN);
        return `${FX.REQ_RUN} : ${s.tasks.map(t => `${t.n} ${t.state}`).join(', ')} ; ${s.links} traits ; détail, Échap, mise à jour en direct`;
      } finally {
        FX.removeRequestFixture({ logsDir, chefDir });
        await page.evaluate(() => { localStorage.removeItem('requests.all'); window.RequestsPanel?.closeDetail?.(); if (window.SidePanel?.isOpen()) window.SidePanel.close(); });
      }
    });
    // User report (2026-10-13): « le pan git et vide, et sa liste de musiciens
    // aussi ». Cause: a server started on an older version serves the new front
    // from disk but not its routes (404). The panel must list every musician
    // with its git state, and say plainly when the server needs a restart.
    await check(B, 'git-panel-musicians', 'Panneau Git : la liste des musiciens contient TOUS les projets de /api/git-graph avec leur état git (dépôt sélectionnable, sans dépôt grisé) ; serveur pas encore redémarré (routes en 404) : message clair avec les deux versions et le redémarrage, jamais un panneau ni une liste vides (Git et TODO)', async () => {
      if (!(await page.locator('#btn-git').count())) NA('onglet Git absent de cet état du code');
      const api = await (await fetch(`${sb.url}/api/git-graph`, { headers: H })).json();
      assert(api.projects.length > 1, `projets : ${api.projects.length}`);
      await page.click('#btn-git');
      assert(await until(async () => (await gitState(page)).rows > 0, 10_000), 'graphe vide');
      const opts = await page.evaluate(() => [...document.querySelectorAll('#side-panel .gg-project option')].map(o => ({ v: o.value, d: o.disabled })));
      assert(opts.length === api.projects.length, `liste : ${opts.length} musicien(s) sur ${api.projects.length}`);
      for (const p of api.projects) {
        const o = opts.find(x => x.v === p.name);
        assert(o && o.d === !p.repo, `${p.name} : ${o ? (o.d ? 'grisé' : 'sélectionnable') : 'absent'} (dépôt : ${p.repo})`);
      }
      await page.keyboard.press('Escape');
      const ctx404 = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
      try {
        const p4 = await ctx404.newPage();
        await p4.route(/\/api\/(git-graph|todo)(\/|\?|$)/, r => r.fulfill({ status: 404, contentType: 'text/html', body: '<pre>Cannot GET</pre>' }));
        await p4.route(/\/api\/version(\?|$)/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '0.74.3', repoVersion: '0.76.4', restartRequired: true }) }));
        await p4.goto(`${sb.url}/?token=${sb.token}`); await p4.locator('.brand').waitFor();
        await p4.click('#btn-git');
        assert(await until(async () => (await p4.locator('#side-panel .gg-unavailable').count()) > 0, 8000), 'aucun message quand les routes manquent');
        const msg = await p4.textContent('#side-panel .gg-unavailable');
        assert(/v0\.74\.3/.test(msg) && /v0\.76\.4/.test(msg) && /redémarrage/.test(msg), `message Git : ${msg}`);
        const sel = await p4.evaluate(() => [...document.querySelectorAll('#side-panel .gg-project option')].map(o => o.textContent));
        assert(sel.length === 1 && /indisponible/.test(sel[0]), `liste Git : ${JSON.stringify(sel)}`);
        await p4.click('#side-panel [data-sp-tab="todo"]');
        assert(await until(async () => (await p4.locator('#side-panel .todo-unavailable').count()) > 0, 8000), 'TODO : aucun message quand la route manque');
        const tmsg = await p4.textContent('#side-panel .todo-unavailable');
        assert(/v0\.74\.3/.test(tmsg) && /redémarrage/.test(tmsg), `message TODO : ${tmsg}`);
        return `${opts.length} musiciens (${api.projects.filter(p => p.repo).length} dépôts) ; serveur ancien : « ${msg.slice(0, 70)}… »`;
      } finally { await ctx404.close(); }
    });
    // User report (2026-10-13): « le pan todo et vide, et sa liste de musiciens
    // aussi ». Same cause as the Git tab (server not restarted, /api/todo 404).
    await check(B, 'todo-panel-musicians', 'Panneau TODO : la liste des musiciens contient chaque musicien de /api/todo, et choisir un musicien montre exactement ses items ; serveur pas encore redémarré (route en 404) : la liste des musiciens dit « indisponible » et le panneau explique le redémarrage, jamais vide', async () => {
      if (!(await page.locator('#btn-todo').count())) NA('panneau TODO absent de cet état du code');
      const api = await (await fetch(`${sb.url}/api/todo`, { headers: H })).json();
      assert(api.lists.length > 1 && api.items.length > 0, `listes : ${api.lists.length}, items : ${api.items.length}`);
      await page.click('#btn-todo');
      assert(await until(async () => (await todoState(page)).items.length > 0, 8000), 'panneau TODO vide');
      const opts = await page.evaluate(() => [...document.querySelectorAll('#side-panel .todo-project option')].map(o => o.value));
      assert(opts.length === api.lists.length + 1 && opts[0] === '', `liste : ${JSON.stringify(opts)}`);
      for (const l of api.lists) {
        assert(opts.includes(l.project), `${l.project} absent de la liste`);
        await page.selectOption('#side-panel .todo-project', l.project);
        const want = api.items.filter(i => i.project === l.project).map(i => i.id).sort();
        assert(await until(async () => {
          const got = (await todoState(page)).items;
          return got.every(i => i.project === l.project) && got.map(i => i.id).sort().join() === want.join();
        }, 4000), `${l.project} : items affichés ≠ ${want.length} items de l’API`);
      }
      await page.selectOption('#side-panel .todo-project', '');
      assert(await until(async () => (await todoState(page)).items.length === api.items.length, 4000), 'retour à « Tous les projets »');
      await page.keyboard.press('Escape');
      const ctx404 = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
      try {
        const p4 = await ctx404.newPage();
        await p4.route(/\/api\/todo(\/|\?|$)/, r => r.fulfill({ status: 404, contentType: 'text/html', body: '<pre>Cannot GET</pre>' }));
        await p4.route(/\/api\/version(\?|$)/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '0.74.3', repoVersion: '0.76.5', restartRequired: true }) }));
        await p4.goto(`${sb.url}/?token=${sb.token}`); await p4.locator('.brand').waitFor();
        await p4.click('#btn-todo');
        assert(await until(async () => (await p4.locator('#side-panel .todo-unavailable').count()) > 0, 8000), 'aucun message quand la route manque');
        const msg = await p4.textContent('#side-panel .todo-unavailable');
        assert(/v0\.74\.3/.test(msg) && /v0\.76\.5/.test(msg) && /redémarrage/.test(msg), `message : ${msg}`);
        const sel = await p4.evaluate(() => [...document.querySelectorAll('#side-panel .todo-project option')].map(o => o.textContent));
        assert(sel.length === 1 && /indisponible/.test(sel[0]), `liste des musiciens : ${JSON.stringify(sel)}`);
        return `${api.lists.length} musiciens, items de chacun vérifiés ; serveur ancien : liste « ${sel[0]} »`;
      } finally { await ctx404.close(); }
    });
    // User request (2026-10-13), part 1/5: « chaque item doit être clickable et
    // afficher une overlay qui présente l'item complet ».
    const ovState = (pg) => pg.evaluate(() => {
      const o = document.getElementById('todo-overlay');
      const d = o?.querySelector('.tov-dialog');
      const r = d?.getBoundingClientRect();
      const close = o?.querySelector('.tov-close')?.getBoundingClientRect();
      return {
        open: !!o && !o.hidden, id: d?.dataset.id || null, role: d?.getAttribute('role'), modal: d?.getAttribute('aria-modal'),
        title: o?.querySelector('.tov-title')?.textContent || '', status: o?.querySelector('.tov-status')?.textContent || '',
        added: o?.querySelector('.tov-added')?.textContent || '', by: o?.querySelector('.tov-by')?.textContent || '',
        detail: o?.querySelector('.tov-detail')?.textContent || '', more: o?.querySelector('.tov-more')?.textContent || '',
        actionsHidden: o?.querySelector('.tov-actions')?.hidden ?? null, actions: [...(o?.querySelectorAll('.tov-action') || [])].map(b => b.textContent),
        focusClose: document.activeElement === o?.querySelector('.tov-close'), focusId: document.activeElement?.closest?.('.todo-item')?.dataset.id || null,
        rect: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
        closeSize: close ? Math.round(Math.min(close.width, close.height)) : 0, vw: innerWidth, vh: innerHeight,
      };
    });
    await check(B, 'todo-item-overlay', 'Panneau TODO : chaque item est cliquable (clic, Entrée, Espace) et ouvre une overlay avec l’item COMPLET (titre, statut, projet, dates, détail entier non tronqué, lignes de suite) ; fermeture par ✕, Échap (le panneau reste ouvert) et clic hors zone ; barre d’actions prête pour les parties suivantes ; plein écran sur mobile', async () => {
      if (!(await page.locator('#btn-todo').count())) NA('panneau TODO absent de cet état du code');
      const api = await (await fetch(`${sb.url}/api/todo`, { headers: H })).json();
      const long = api.items.find(i => i.project === 'chef' && /beta — analyse/.test(i.title));
      const doneItem = api.items.find(i => i.id === 't-a10001');
      if (!long?.detailFull) NA('API sans item complet (detailFull) dans cet état du code');
      await page.selectOption('#side-panel .todo-project', '').catch(() => {});
      if (!(await todoState(page)).open) await page.click('#btn-todo');
      assert(await until(async () => (await todoState(page)).items.length > 0, 8000), 'panneau TODO vide');
      const li = `#side-panel .todo-item[data-id="${long.id}"]`;
      assert(/item complet/.test(await page.getAttribute(li, 'title') || '') && (await page.getAttribute(li, 'tabindex')) === '0', 'item non signalé comme cliquable');
      await page.click(`${li} .ti-title`);
      assert(await until(async () => (await ovState(page)).open, 3000), 'le clic n’ouvre pas l’overlay');
      let o = await ovState(page);
      assert(o.id === long.id && o.role === 'dialog' && o.modal === 'true', `overlay : ${JSON.stringify({ id: o.id, role: o.role })}`);
      assert(o.title === long.title, `titre : ${o.title}`);
      assert(o.detail === long.detailFull && /FIN-DU-DETAIL-COMPLET$/.test(o.detail) && !o.detail.endsWith('…'), `détail tronqué ou absent (${o.detail.length} car.)`);
      assert(o.more === long.more, `lignes de suite : ${JSON.stringify(o.more)}`);
      assert(/En cours/.test(o.status) && o.added === '14/09/26 00:00', `statut / date : ${o.status} · ${o.added}`);
      assert(o.focusClose, 'le focus n’est pas sur ✕ à l’ouverture');
      assert(o.actionsHidden === false && o.actions.join() === 'Envoyer au chef…,💬 Discuter avec le chef…,Rejeter l’item…', `barre d’actions : ${JSON.stringify(o.actions)} (0.79.0 : « Envoyer au chef… » ; 0.96.0 : « 💬 Discuter avec le chef… » ; 0.85.0 : « Rejeter l’item… » sur un item ouvert)`);
      await page.keyboard.press('Escape');
      assert(await until(async () => !(await ovState(page)).open, 3000), 'Échap ne ferme pas l’overlay');
      o = await ovState(page);
      assert((await todoState(page)).open, 'Échap a aussi fermé le panneau');
      assert(o.focusId === long.id, `focus non rendu à l’item : ${o.focusId}`);
      await page.keyboard.press('Enter');
      assert(await until(async () => (await ovState(page)).open, 3000), 'Entrée sur l’item n’ouvre pas l’overlay');
      await page.mouse.click(8, Math.round((await ovState(page)).vh / 2));
      assert(await until(async () => !(await ovState(page)).open, 3000), 'clic hors zone ne ferme pas');
      await page.focus(`#side-panel .todo-item[data-id="${doneItem.id}"]`);
      await page.keyboard.press(' ');
      assert(await until(async () => (await ovState(page)).id === doneItem.id && (await ovState(page)).open, 3000), 'Espace n’ouvre pas l’item fait');
      o = await ovState(page);
      assert(/Fait/.test(o.status) && o.by === 'alpha' && o.title === doneItem.title, `item fait : ${JSON.stringify({ s: o.status, by: o.by })}`);
      await page.click('#todo-overlay .tov-close');
      assert(await until(async () => !(await ovState(page)).open, 3000), '✕ ne ferme pas');
      // The action bar used by the next parts (notes, reject, send to the chef).
      await page.evaluate(() => { window.__tovTest = true; TodoPanel.registerAction({ id: 'regress-test', label: 'Essai', when: () => window.__tovTest, run: (i, h) => { window.__tovRan = i.id; h.close(); } }); });
      await page.click(`${li} .ti-title`);
      assert(await until(async () => (await ovState(page)).actions.includes('Essai'), 3000), `action non affichée : ${(await ovState(page)).actions}`);
      await page.click('#todo-overlay [data-tov-action="regress-test"]');
      assert(await until(async () => !(await ovState(page)).open && (await page.evaluate(() => window.__tovRan)) === long.id, 3000), 'action non exécutée sur l’item');
      await page.evaluate(() => { window.__tovTest = false; });
      assert(await overflowX(page) <= 0, `débordement horizontal ${await overflowX(page)} px`);
      await page.keyboard.press('Escape');
      const mctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
      try {
        const m = await mctx2.newPage();
        await m.goto(`${sb.url}/?token=${sb.token}`); await m.locator('.brand').waitFor();
        await m.evaluate(() => SidePanel.open('todo'));
        await m.locator(`#side-panel .todo-item[data-id="${long.id}"] .ti-title`).waitFor({ timeout: 8000 });
        await m.tap(`#side-panel .todo-item[data-id="${long.id}"] .ti-title`);
        assert(await until(async () => (await ovState(m)).open, 3000), 'mobile : le toucher n’ouvre pas l’overlay');
        const mo = await ovState(m);
        assert(mo.rect.x === 0 && mo.rect.y === 0 && mo.rect.w === mo.vw && mo.rect.h === mo.vh, `mobile : overlay pas en plein écran ${JSON.stringify(mo.rect)}`);
        assert(mo.closeSize >= 44 && mo.detail === long.detailFull, `mobile : ✕ ${mo.closeSize} px, détail complet ${mo.detail === long.detailFull}`);
        if (t.shots) await m.screenshot({ path: path.join(path.resolve(t.shots), 'todo-overlay-mobile.png') });
      } finally { await mctx2.close(); }
      return `item « ${long.title} » : ${long.detailFull.length} car. de détail + ${long.more.split('\n').length} ligne(s) de suite ; clic, Entrée, Espace ; ✕, Échap, hors zone ; action essai OK ; mobile plein écran`;
    });
    // User request (2026-10-13), part 4/5: « Possilité aussi de lancer le
    // contenu de l'item au chef, pour lancer l'execution ».
    await check(B, 'todo-send-chef', 'Overlay d’un item TODO : « Envoyer au chef… » demande une confirmation qui montre le message exact (item complet, notes s’il y en a), annulable ; confirmé, le message est placé dans la saisie au chef (brouillon remplacé seulement après avertissement) et part par le même canal que tout message au chef — le panneau lui-même n’envoie rien', async () => {
      if (!(await page.evaluate(() => !!window.TodoPanel?.chefMessage))) NA('envoi au chef absent de cet état du code');
      const api = await (await fetch(`${sb.url}/api/todo`, { headers: H })).json();
      const long = api.items.find(i => i.project === 'chef' && /beta — analyse/.test(i.title));
      const chefLog = () => { try { return fs.readFileSync(path.join(sb.root, 'logs', 'chef.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
      const sentBefore = chefLog().filter(e => e.type === 'user_prompt' && /Item de la TODO de chef/.test(e.text || '')).length;
      await page.evaluate(() => window.TodoPanel?.closeItem());
      try {
      // Notes are part of the message when the item has some (part 2/5).
      const withNotes = await page.evaluate(() => TodoPanel.chefMessage({ project: 'p', id: 't-x1', line: 3, title: 'T', status: 'todo', detail: 'd', notes: [{ at: '2026-10-13T10:00', text: 'note A' }] }));
      assert(/Notes de l’utilisateur :\n- \(13\/10\/26 10:00\) note A/.test(withNotes), `notes absentes du message : ${withNotes}`);
      await page.fill('#composer-input', 'brouillon en cours');
      if (!(await todoState(page)).open) await page.click('#btn-todo');
      const li = `#side-panel .todo-item[data-id="${long.id}"]`;
      await page.locator(li).waitFor({ timeout: 8000 });
      await page.click(`${li} .ti-title`);
      await page.locator('#todo-overlay [data-tov-action="send-chef"]').waitFor({ timeout: 4000 });
      await page.click('#todo-overlay [data-tov-action="send-chef"]');
      const conf = () => page.evaluate(() => { const b = document.querySelector('#todo-overlay .tov-confirm'); return { shown: !!b && !b.hidden, msg: b?.querySelector('.tov-confirm-msg')?.textContent || '', draft: b?.querySelector('.tov-confirm-draft')?.hidden === false ? b.querySelector('.tov-confirm-draft').textContent : '' }; });
      let c = await conf();
      assert(c.shown && c.msg.startsWith('Item de la TODO de chef à exécuter : beta — analyse') && c.msg.includes(long.detailFull) && c.msg.includes(long.more) && c.msg.includes(long.id), `confirmation : ${JSON.stringify(c).slice(0, 300)}`);
      assert(/brouillon actuel au chef \(18 caractères\) sera remplacé/.test(c.draft), `avertissement de brouillon : ${c.draft}`);
      await page.click('#todo-overlay .tov-confirm-cancel');
      c = await conf();
      assert(!c.shown && (await page.inputValue('#composer-input')) === 'brouillon en cours', 'Annuler a touché la saisie');
      await page.click('#todo-overlay [data-tov-action="send-chef"]');
      await page.keyboard.press('Escape');
      assert(!(await conf()).shown && (await page.evaluate(() => TodoPanel.isItemOpen())), 'Échap doit annuler la confirmation, pas fermer l’item');
      await page.click('#todo-overlay [data-tov-action="send-chef"]');
      await page.click('#todo-overlay .tov-confirm-ok');
      assert(await until(async () => !(await page.evaluate(() => TodoPanel.isItemOpen())) && !(await todoState(page)).open, 4000), 'overlay ou panneau encore ouverts');
      const input = await page.inputValue('#composer-input');
      assert(input === c.msg || input.startsWith('Item de la TODO de chef à exécuter : beta — analyse'), `saisie : ${input.slice(0, 120)}`);
      assert(await page.evaluate(() => document.activeElement?.id === 'composer-input'), 'le focus n’est pas dans la saisie');
      const ctx = await page.textContent('#composer-context').catch(() => '');
      assert(/Item TODO de chef/.test(ctx) && /Entrée ou ➤/.test(ctx), `contexte du composer : ${ctx}`);
      assert(/À : CHEF/.test(await page.textContent('#composer-target')), 'la saisie ne vise pas le chef');
      await sleep(500);
      assert(chefLog().filter(e => e.type === 'user_prompt' && /Item de la TODO de chef/.test(e.text || '')).length === sentBefore, 'envoyé avant le geste de l’utilisateur');
      await page.press('#composer-input', 'Enter');
      assert(await until(() => chefLog().filter(e => e.type === 'user_prompt' && /Item de la TODO de chef à exécuter : beta — analyse/.test(e.text || '') && (e.text || '').includes('FIN-DU-DETAIL-COMPLET')).length === sentBefore + 1, 45_000), 'le chef n’a pas reçu le message');
      // Leave the instance as found: the chef turn this message started must
      // be over before the next checks read the rail order.
      const afterPrompt = () => { const ev = chefLog(); const k = ev.map(e => e.type === 'user_prompt' && /Item de la TODO de chef/.test(e.text || '')).lastIndexOf(true); return k >= 0 && ev.slice(k + 1).some(e => e.type === 'result'); };
      assert(await until(async () => afterPrompt(), 45_000), 'le tour du chef lancé par l’envoi ne s’est pas terminé');
      await page.evaluate(() => window.App.pollPupitre());
      await sleep(800);
      return `confirmation (message exact, brouillon annoncé), Annuler et Échap sans effet, puis saisie au chef et envoi par Entrée → reçu par le chef (${long.detailFull.length} car. de détail)`;
      } finally {
        // Never leave an open overlay, panel or draft to the next checks — nor
        // the pointer over the rail, which freezes its order (railState.hovered).
        await page.evaluate(() => { window.TodoPanel?.closeItem(); if (window.SidePanel?.isOpen()) window.SidePanel.close(); });
        await page.fill('#composer-input', '').catch(() => {});
        await page.mouse.move(5, 5);
        await sleep(1700);
        await page.evaluate(() => window.App.pollPupitre());
        await sleep(500);
      }
    });
    // 0.96.0 — user request (2026-10-14): « Orchestrateur-dev: liste des todo,
    // on devrait pouvoir envoyer au chef, pas pour lancer mais en discuter, si
    // j'ai besoin de reponse. »
    await check(B, 'todo-discuss-chef', 'Overlay d’un item TODO : « 💬 Discuter avec le chef… », distinct de « Envoyer au chef… », confirme puis place dans la saisie au chef un message de DISCUSSION (/chef-discussion) ; envoyé, le chef répond dans le fil par son Routage en mode discussion, et rien n’est dispatché', async () => {
      if (!(await page.evaluate(() => !!window.TodoPanel?.discussMessage))) NA('discussion avec le chef absente de cet état du code');
      const api = await (await fetch(`${sb.url}/api/todo`, { headers: H })).json();
      const long = api.items.find(i => i.project === 'chef' && /beta — analyse/.test(i.title));
      const chefLog = () => { try { return fs.readFileSync(path.join(sb.root, 'logs', 'chef.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
      const n0 = chefLog().length;
      await page.evaluate(() => window.TodoPanel?.closeItem());
      try {
        await page.fill('#composer-input', '');
        if (!(await todoState(page)).open) await page.click('#btn-todo');
        const li = `#side-panel .todo-item[data-id="${long.id}"]`;
        await page.locator(li).waitFor({ timeout: 8000 });
        await page.click(`${li} .ti-title`);
        await page.locator('#todo-overlay [data-tov-action="discuss-chef"]').waitFor({ timeout: 4000 });
        const labels = await page.$$eval('#todo-overlay [data-tov-action]', bs => bs.map(b => b.textContent));
        assert(labels.includes('💬 Discuter avec le chef…') && labels.includes('Envoyer au chef…'), `actions : ${labels}`);
        await page.click('#todo-overlay [data-tov-action="discuss-chef"]');
        const c = await page.evaluate(() => { const b = document.querySelector('#todo-overlay .tov-confirm'); return { shown: !!b && !b.hidden, h: b?.querySelector('.tov-confirm-h')?.textContent || '', hint: b?.querySelector('.tov-confirm-hint')?.textContent || '', msg: b?.querySelector('.tov-confirm-msg')?.textContent || '' }; });
        assert(c.shown && /Discuter de cet item/.test(c.h) && /rien n’est lancé/.test(c.hint) && c.msg.startsWith('/chef-discussion\n') && c.msg.includes('à DISCUTER (ne pas le lancer) : beta — analyse') && c.msg.includes(long.detailFull), `confirmation : ${JSON.stringify(c).slice(0, 300)}`);
        await page.click('#todo-overlay .tov-confirm-ok');
        assert(await until(async () => !(await page.evaluate(() => TodoPanel.isItemOpen())), 4000), 'overlay encore ouvert');
        const ctx = await page.textContent('#composer-context').catch(() => '');
        assert(/Discussion \(rien ne sera lancé\)/.test(ctx), `contexte du composer : ${ctx}`);
        await page.fill('#composer-input', `${await page.inputValue('#composer-input')}QUESTION-DISCUSSION : faut-il le faire maintenant ?`);
        await page.press('#composer-input', 'Enter');
        const turn = () => { const ev = chefLog().slice(n0); const k = ev.findIndex(e => e.type === 'user_prompt' && e.pipeline?.mode === 'discussion' && /QUESTION-DISCUSSION/.test(e.text || '')); return k < 0 ? null : { up: ev[k], after: ev.slice(k + 1) }; };
        assert(await until(async () => turn()?.after.some(e => e.type === 'result'), 60_000), 'pas de tour du chef en mode discussion terminé');
        const t = turn();
        const run = t.up.pipeline.run;
        assert(!fs.existsSync(path.join(sb.root, 'chef', '.orchestrateur', 'runs', run, 'dispatch.json')), 'un dispatch.json a été écrit');
        assert(t.after.some(e => e.type === 'assistant'), 'aucune réponse du chef dans le fil');
        return `discussion ${run} : Lire → Discuter → Rapporter, réponse dans le fil, aucun dispatch`;
      } finally {
        await page.evaluate(() => { window.TodoPanel?.closeItem(); if (window.SidePanel?.isOpen()) window.SidePanel.close(); });
        await page.fill('#composer-input', '').catch(() => {});
        await page.mouse.move(5, 5);
        await sleep(1700);
        await page.evaluate(() => window.App.pollPupitre());
        await sleep(500);
      }
    });
    // 0.78.1 — user report (2026-10-13): « A partir du moment où quelque chose
    // tourne, attaché à un projet, et que ça empêche le projet d'avancer (en
    // l'occurence le musicien est affiché comme Prêt), alors c'est un problème ».
    await check(B, 'busy-not-ready', 'Musicien dont le tour a écrit son result mais dont le processus vit encore : la carte du Pilotage dit « En cours » (jamais Prêt ni Terminé) et ce qui tourne ; le processus arrêté, son état revient', async () => {
      if (!(await page.evaluate(() => !!window.TurnCore?.reconcileBusy))) NA('correction absente de cet état du code');
      const pidFile = path.join(sb.root, 'logs', 'alpha.pid');
      const card = () => page.evaluate(() => {
        const c = document.querySelector('#rail-body .rail-card[data-name="alpha"]');
        return c ? { state: c.dataset.state, word: c.querySelector('.rr-state')?.textContent.trim() || '', line: c.querySelector('.rc-line')?.textContent.trim() || '', model: window.App.musicians.get('alpha')?.state } : null;
      });
      const before = await card();
      assert(before && before.state !== 'live', `carte alpha au départ : ${JSON.stringify(before)}`);
      const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
      let during;
      try {
        fs.writeFileSync(pidFile, String(keep.pid));
        await page.evaluate(() => window.App.pollPupitre());
        assert(await until(async () => { const c = await card(); return c?.state === 'live' && /processus encore actif/.test(c.line); }, 15_000), `carte jamais passée « En cours » : ${JSON.stringify(await card())}`);
        during = await card();
        assert(/En cours/.test(during.word) && !/Prêt|Terminé/.test(during.word) && during.model === 'live', `carte : ${JSON.stringify(during)}`);
        await shot(page, 'busy-not-ready');
      } finally {
        keep.kill();
        for (let i = 0; i < 20 && fs.existsSync(pidFile); i++) { try { fs.unlinkSync(pidFile); } catch { await sleep(150); } }
      }
      await page.evaluate(() => window.App.pollPupitre());
      assert(await until(async () => { const c = await card(); return c && c.state === before.state; }, 15_000), `état non revenu : ${JSON.stringify(await card())}`);
      // The rail settles its order 1.5 s after a change, never under the pointer.
      await page.mouse.move(5, 5);
      await sleep(1700);
      await page.evaluate(() => window.App.pollPupitre());
      await sleep(500);
      return `alpha : « ${before.word} » → « ${during.word} » (${during.line.slice(0, 60)}…) → « ${(await card()).word} »`;
    });
    // User request (2026-10-13), part 2/5: « Possibilité d'y ajouter des notes ».
    const notesState = (pg) => pg.evaluate(() => {
      const o = document.getElementById('todo-overlay');
      return {
        open: !!o && !o.hidden, id: o?.querySelector('.tov-dialog')?.dataset.id || null,
        notes: [...(o?.querySelectorAll('.tov-note .tov-note-body') || [])].map(n => n.textContent),
        count: o?.querySelector('.tov-notes-n')?.textContent || '', empty: !!o?.querySelector('.tov-notes-empty'),
        draft: o?.querySelector('.tov-note-text')?.value ?? null, msg: o?.querySelector('.tov-note-msg')?.textContent || '',
        msgError: !!o?.querySelector('.tov-note-msg.is-error'),
      };
    });
    await check(B, 'todo-item-notes', 'Overlay d’un item TODO : ajouter des notes (bouton ou Ctrl+Entrée), enregistrées par le serveur et réaffichées après rechargement de la page ; compteur ✎ sur l’item de la liste ; note vide refusée ; brouillon jamais effacé par le rafraîchissement ni en changeant d’item', async () => {
      if (!(await page.locator('#btn-todo').count())) NA('panneau TODO absent de cet état du code');
      const api = await (await fetch(`${sb.url}/api/todo`, { headers: H })).json();
      const it = api.items.find(i => i.project === 'beta' && i.title === 'Écrire la doc');
      const other = api.items.find(i => i.id === 't-a10004');
      if (!it || !('notes' in it)) NA('API sans notes dans cet état du code');
      const before = it.notes.length;
      await page.selectOption('#side-panel .todo-project', '').catch(() => {});
      if (!(await todoState(page)).open) await page.click('#btn-todo');
      const li = `#side-panel .todo-item[data-id="${it.id}"]`;
      await page.locator(li).waitFor({ timeout: 8000 });
      await page.click(`${li} .ti-title`);
      assert(await until(async () => (await notesState(page)).open, 3000), 'overlay non ouverte');
      let n = await notesState(page);
      assert(n.notes.length === before && (before || n.empty), `notes au départ : ${JSON.stringify(n)}`);
      await page.click('#todo-overlay .tov-note-add');
      n = await notesState(page);
      assert(n.msgError && /vide/.test(n.msg) && n.notes.length === before, `note vide : ${n.msg}`);
      await page.fill('#todo-overlay .tov-note-text', 'Note du navigateur');
      await page.evaluate(() => TodoPanel.reload());
      await sleep(600);
      assert((await notesState(page)).draft === 'Note du navigateur', 'le rafraîchissement a effacé le brouillon');
      await page.click('#todo-overlay .tov-note-add');
      assert(await until(async () => (await notesState(page)).notes.length === before + 1, 5000), `note non ajoutée : ${(await notesState(page)).msg}`);
      n = await notesState(page);
      assert(n.notes[before] === 'Note du navigateur' && n.draft === '' && !n.msgError && n.count === `(${before + 1})`, `après ajout : ${JSON.stringify(n)}`);
      await page.fill('#todo-overlay .tov-note-text', 'Deuxième note\nsur deux lignes');
      await page.press('#todo-overlay .tov-note-text', 'Control+Enter');
      assert(await until(async () => (await notesState(page)).notes.length === before + 2, 5000), 'Ctrl+Entrée n’enregistre pas');
      assert((await notesState(page)).notes[before + 1] === 'Deuxième note\nsur deux lignes', 'saut de ligne perdu');
      // Draft kept per item: type, switch to another item, come back.
      await page.fill('#todo-overlay .tov-note-text', 'brouillon gardé');
      await page.keyboard.press('Escape');
      await page.click(`#side-panel .todo-item[data-id="${other.id}"] .ti-title`);
      assert(await until(async () => (await notesState(page)).id === other.id, 3000), 'autre item non ouvert');
      assert((await notesState(page)).draft === '', 'le brouillon d’un item est passé sur un autre');
      await page.keyboard.press('Escape');
      await page.click(`${li} .ti-title`);
      assert(await until(async () => (await notesState(page)).draft === 'brouillon gardé', 3000), 'brouillon perdu en changeant d’item');
      await page.fill('#todo-overlay .tov-note-text', '');
      await page.keyboard.press('Escape');
      assert(await until(async () => (await page.textContent(`${li} .ti-notes`).catch(() => '')) === `✎ ${before + 2}`, 4000), 'compteur ✎ absent de la liste');
      // Kept by the server: a reload of the page shows them again.
      await page.reload(); await page.locator('.brand').waitFor();
      if (!(await todoState(page)).open) await page.click('#btn-todo');
      await page.locator(li).waitFor({ timeout: 8000 });
      await page.click(`${li} .ti-title`);
      assert(await until(async () => (await notesState(page)).notes.length === before + 2, 5000), 'notes perdues au rechargement');
      n = await notesState(page);
      assert(n.notes.slice(before).join('|') === 'Note du navigateur|Deuxième note\nsur deux lignes', `après rechargement : ${JSON.stringify(n.notes)}`);
      const srv = (await (await fetch(`${sb.url}/api/todo?project=beta`, { headers: H })).json()).items.find(i => i.id === it.id);
      assert(srv?.notes?.length === before + 2, 'le serveur n’a pas les notes');
      assert(await overflowX(page) <= 0, `débordement horizontal ${await overflowX(page)} px`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      return `« ${it.title} » : 2 notes (bouton, Ctrl+Entrée) gardées au rechargement, ✎ ${before + 2} dans la liste ; vide refusée ; brouillon gardé (rafraîchissement, changement d’item)`;
    });
    // User request (2026-10-13), part 5/5: « Chaque item est drag & dropable, et
    // les positions doivent persister. »
    await check(B, 'todo-item-drag', 'Panneau TODO : chaque item se déplace par glisser-déposer ; l’ordre obtenu est enregistré par le serveur et revient après rechargement de la page ; le glisser n’ouvre pas l’overlay, le clic simple l’ouvre toujours ; Alt+↑/↓ au clavier ; un item ne quitte jamais sa partie (non faits en haut, faits en bas) ; poignée de 44 px sur mobile', async () => {
      if (!(await page.evaluate(() => !!window.TodoPanel?.isDragging))) NA('glisser-déposer absent de cet état du code');
      const reset = () => fetch(`${sb.url}/api/order/todo`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [] }) });
      const keysIn = (pg, sec) => pg.evaluate((s) => [...document.querySelectorAll(`#side-panel .todo-sec[data-sec="${s}"] .todo-item`)].map(li => li.dataset.key), sec);
      const serverOpen = async () => (await (await fetch(`${sb.url}/api/todo`, { headers: H })).json()).items.filter(i => i.status !== 'done').map(i => `${i.project}/${i.id}`);
      const overlayOpen = (pg) => pg.evaluate(() => !!window.TodoPanel?.isItemOpen());
      const dragTo = async (pg, fromSel, toSel, where = 'top') => {
        const box = async (sel) => {
          const l = pg.locator(sel);
          await l.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await l.scrollIntoViewIfNeeded().catch(() => {});
          const bb = await l.boundingBox();
          if (!bb) throw new Error(`élément invisible : ${sel} (onglet du panneau : ${await pg.evaluate(() => document.querySelector('#side-panel [aria-selected="true"]')?.textContent || '?')}, panneau ouvert : ${await pg.evaluate(() => !!document.querySelector('#side-panel.is-open'))})`);
          return bb;
        };
        let a = await box(fromSel); const b = await box(toSel);
        a = (await pg.locator(fromSel).boundingBox()) || a;   // the second scroll may have moved it
        await pg.mouse.move(a.x + a.width / 2, a.y + 8);
        await pg.mouse.down();
        const ty = where === 'top' ? b.y + 3 : b.y + b.height - 3;
        for (let k = 1; k <= 8; k++) await pg.mouse.move(a.x + a.width / 2, a.y + 8 + (ty - a.y - 8) * k / 8);
        await pg.mouse.up();
      };
      try {
        await reset();
        await page.evaluate(() => { try { localStorage.removeItem('todo.filter.project'); } catch {} });
        // Another tab (Git) may be the one left open: open the TODO tab itself.
        await page.evaluate(() => SidePanel.open('todo'));
        await page.selectOption('#side-panel .todo-project', '').catch(() => {});
        await page.evaluate(() => window.TodoPanel.reload());
        assert(await until(async () => (await keysIn(page, 'open')).length >= 3, 8000), 'moins de 3 items non faits');
        const open0 = await keysIn(page, 'open');
        const li = (k) => `#side-panel .todo-item[data-key="${k}"]`;
        // 1. Drag the third open item above the first one.
        await dragTo(page, `${li(open0[2])} .ti-title`, li(open0[0]), 'top');
        const want = [open0[2], open0[0], open0[1], ...open0.slice(3)];
        assert(await until(async () => (await keysIn(page, 'open')).join(' ') === want.join(' '), 3000), `ordre affiché : ${(await keysIn(page, 'open')).join(' ')}`);
        await sleep(500);
        assert(!(await overlayOpen(page)), 'le glisser a ouvert l’overlay');
        assert(await until(async () => (await serverOpen()).join(' ') === want.join(' '), 5000), `ordre du serveur : ${(await serverOpen()).join(' ')}`);
        // 2. Persisted: back after a page reload.
        await page.reload(); await page.locator('.brand').waitFor();
        await page.evaluate(() => SidePanel.open('todo'));
        assert(await until(async () => (await keysIn(page, 'open')).join(' ') === want.join(' '), 8000), `après rechargement : ${(await keysIn(page, 'open')).join(' ')}`);
        // 3. A simple click still opens the overlay.
        await page.click(`${li(want[1])} .ti-title`);
        assert(await until(() => overlayOpen(page), 3000), 'le clic simple n’ouvre plus l’overlay');
        await page.keyboard.press('Escape');
        // 4. Keyboard: Alt+↓ moves the focused item one place down, saved.
        await page.focus(li(want[0]));
        await page.keyboard.press('Alt+ArrowDown');
        const want2 = [want[1], want[0], ...want.slice(2)];
        assert(await until(async () => (await serverOpen()).join(' ') === want2.join(' '), 5000), `Alt+↓ : ${(await serverOpen()).join(' ')}`);
        assert(await page.evaluate((k) => document.activeElement?.dataset?.key === k, want[0]), 'focus perdu après Alt+↓');
        // 5. A done item dragged into the open part stays among the done ones.
        const done0 = await keysIn(page, 'done');
        if (done0.length) {
          await dragTo(page, `${li(done0[0])} .ti-title`, li(want2[0]), 'top');
          await sleep(500);
          assert((await keysIn(page, 'open')).join(' ') === want2.join(' ') && (await keysIn(page, 'done')).includes(done0[0]), 'un fait est passé parmi les non faits');
          assert(!(await overlayOpen(page)), 'le glisser d’un fait a ouvert l’overlay');
        }
        await shot(page, 'todo-drag');
        // 6. Mobile: a 44 px grip (a finger drags from it, the list still scrolls).
        const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
        try {
          const m = await mctx.newPage();
          await m.goto(`${sb.url}/?token=${sb.token}`); await m.locator('.brand').waitFor();
          await m.evaluate(() => SidePanel.open('todo'));
          await m.locator('#side-panel .todo-item .ti-grip').first().waitFor({ timeout: 8000 });
          // The list may be re-rendered between waitFor and the measure (the old node is then
          // detached: null); measure the grip that is in the page. The 44 px criterion is unchanged.
          const g = await until(async () => m.locator('#side-panel .todo-item .ti-grip').first().boundingBox(), 5000, 200);
          // boundingBox() returns layout floats (43.99998 seen for a 44 px rule): allow
          // 0.01 px of sub-pixel rounding only, so a real 43 px grip still fails.
          // User agreement 2026-10-18 (« oui »), see docs/USER_REQUIREMENTS.md.
          const GRIP_MIN_PX = 44, SUBPIXEL_EPS_PX = 0.01;
          const gripOk = px => px >= GRIP_MIN_PX - SUBPIXEL_EPS_PX;
          assert(gripOk(43.99998) && !gripOk(43.98) && !gripOk(43), 'tolérance de la poignée trop large');
          assert(g && gripOk(g.width) && gripOk(g.height), `poignée mobile ${JSON.stringify(g)}`);
          assert((await keysIn(m, 'open')).join(' ') === want2.join(' '), 'mobile : ordre enregistré non repris');
        } finally { await mctx.close(); }
        return `glisser : ${open0[2]} en tête, enregistré, revenu après rechargement ; clic simple → overlay ; Alt+↓ ; un fait reste en bas ; poignée mobile 44 px`;
      } finally {
        await reset();
        await page.evaluate(() => window.TodoPanel?.reload()).catch(() => {});
        if ((await todoState(page)).open) await page.keyboard.press('Escape').catch(() => {});
      }
    });
    // User request (2026-10-13), part 3/5, and the user's choice: « le rejet est
    // marqué dans le TODO_LIST.md du musicien. Dans l'UI passe le dans la liste
    // des "faits" mais barre, avec une marque « rejeté (date) par l'utilisateur » ».
    await check(B, 'todo-item-reject', 'Overlay d’un item TODO ouvert : « Rejeter l’item… » demande une confirmation (annulable par le bouton ou Échap) ; confirmé, le rejet est écrit dans le TODO_LIST.md du musicien et l’item passe dans les « faits », barré, avec « rejeté (date) par l’utilisateur » ; l’action disparaît pour un item fermé', async () => {
      if (!(await page.evaluate(() => typeof window.TodoPanel?.registerAction === 'function'))) NA('panneau TODO absent de cet état du code');
      const listFile = path.join(sb.root, 'projects', 'alpha', 'TODO_LIST.md');
      const before = fs.readFileSync(listFile, 'utf8');
      const li = '#side-panel .todo-item[data-key="alpha/t-a10004"]';
      const st = () => page.evaluate(() => {
        const o = document.getElementById('todo-overlay');
        const x = document.querySelector('#side-panel .todo-item[data-key="alpha/t-a10004"]');
        const t = x?.querySelector('.ti-title');
        return {
          open: !!o && !o.hidden, confirm: !!o && !o.querySelector('.tov-reject')?.hidden,
          actions: [...(o?.querySelectorAll('.tov-actions [data-tov-action]') || [])].map(b => b.dataset.tovAction),
          status: o?.querySelector('.tov-status')?.textContent || '', rejectedLine: o?.querySelector('.tov-rejected')?.textContent || '',
          sec: x?.closest('.todo-sec')?.dataset.sec || null, rejected: x?.classList.contains('is-rejected'),
          struck: t ? getComputedStyle(t).textDecorationLine : '', meta: x?.querySelector('.ti-rejected')?.textContent || '',
        };
      });
      try {
        await page.evaluate(() => SidePanel.open('todo'));
        await page.selectOption('#side-panel .todo-project', '').catch(() => {});
        await page.evaluate(() => window.TodoPanel.reload());
        await page.locator(li).waitFor({ timeout: 8000 });
        assert((await st()).sec === 'open', 'item pas dans les non faits au départ');
        await page.click(`${li} .ti-title`);
        assert(await until(async () => (await st()).open, 3000), 'overlay non ouvert');
        assert((await st()).actions.includes('reject'), `action absente : ${(await st()).actions}`);
        // Cancel first: nothing is written.
        await page.click('#todo-overlay [data-tov-action="reject"]');
        assert((await st()).confirm, 'pas de confirmation');
        await page.keyboard.press('Escape');
        let s = await st();
        assert(!s.confirm && s.open, 'Échap : la confirmation doit se fermer, l’overlay rester ouvert');
        await page.click('#todo-overlay [data-tov-action="reject"]');
        await page.click('#todo-overlay .tov-reject-cancel');
        assert(!(await st()).confirm && fs.readFileSync(listFile, 'utf8') === before, 'Annuler a écrit quelque chose');
        // Confirm.
        await page.click('#todo-overlay [data-tov-action="reject"]');
        await page.click('#todo-overlay .tov-reject-ok');
        assert(await until(async () => (await st()).sec === 'done', 8000), `l’item n’est pas passé dans les faits (${(await st()).sec})`);
        s = await st();
        assert(s.rejected && /line-through/.test(s.struck) && /^✕ rejeté \(\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}\) par l’utilisateur$/.test(s.meta), `affichage : ${JSON.stringify(s)}`);
        assert(/Rejeté/.test(s.status) && /^rejeté \(.+\) par l’utilisateur$/.test(s.rejectedLine) && !s.actions.includes('reject'), `overlay après rejet : ${JSON.stringify(s)}`);
        assert(/Nettoyer les logs → rejeté \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) par l'utilisateur <!-- id:t-a10004 -->/.test(fs.readFileSync(listFile, 'utf8')), 'rejet absent du TODO_LIST.md du musicien');
        await shot(page, 'todo-reject');
        return `alpha/t-a10004 : confirmation, Échap et Annuler sans écriture ; rejeté → faits, barré, « ${s.meta} »`;
      } finally {
        fs.writeFileSync(listFile, before);
        await page.evaluate(() => window.TodoPanel?.closeItem()).catch(() => {});
        await page.evaluate(() => window.TodoPanel?.reload()).catch(() => {});
        await page.evaluate(() => SidePanel.close()).catch(() => {});
      }
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
    // User report (2026-10-22): « [projet] est toujours marqué avec "votre réponse attendue" ».
    await check(B, 'question-superseded', 'Bulle de question du fil : dès qu’un tour du musicien démarre après elle (reprise par l’utilisateur ou le chef), plus de « votre décision » ni de bouton de réponse', async () => {
      if (!(await page.evaluate(() => !!window.TurnCore?.questionOpen))) NA('règle absente de cet état du code');
      const sel = '.cv-bubble.is-question';
      const asked = await page.evaluate(() => {
        const ts = Date.now() - 60_000;
        App.chat.push({ role: 'question', source: 'alpha', text: 'Recette : reprendre les items ?', ts });
        App.renderChat();
        return ts;
      });
      const open = page.locator(sel, { hasText: 'Recette : reprendre les items ?' });
      assert(await until(async () => (await open.count()) === 1, 5000), 'bulle absente');
      const before = (await open.textContent()).replace(/\s+/g, ' ');
      assert(/votre décision/.test(before) && await open.locator('[data-via-chef]').count() === 1, `bulle ouverte : ${before}`);
      // The musician's run resumes: the same SSE event the server streams.
      await page.evaluate((t) => {
        const m = App.musicians.get('alpha');
        window.__qsSaved = { state: m.state, turnStartMs: m.turnStartMs, ringLen: m.ring.length, stopped: m.stopped, heldState: m.heldState, lastAssistantText: m.lastAssistantText };
        const raw = { type: 'system', subtype: 'pipeline_start', timestamp: new Date(t + 30_000).toISOString(), text: 'reprise de l’exécution' };
        m.transition(raw);
        App.renderChat();
      }, asked);
      assert(await until(async () => /plus de réponse attendue/.test(await open.textContent()), 5000), 'bulle toujours ouverte après la reprise');
      const after = (await open.textContent()).replace(/\s+/g, ' ');
      assert(!/votre décision/.test(after) && await open.locator('button').count() === 0, `bulle reprise : ${after}`);
      // Put alpha back as it was: the following walks read its real state.
      await page.evaluate(() => {
        const m = App.musicians.get('alpha'), s = window.__qsSaved;
        m.ring.length = s.ringLen; m.turnStartMs = s.turnStartMs; m.stopped = s.stopped; m.heldState = s.heldState; m.lastAssistantText = s.lastAssistantText; m.setState(s.state);
        App.chat = App.chat.filter(b => b.text !== 'Recette : reprendre les items ?'); App.renderChat();
      });
      return after.slice(0, 120);
    });
    // User report (2026-10-22): « a l'instant je ne vois dans pilotage sur
    // l'application : 1 en cours » / « après avoir relancé l'application je vois
    // bien les 2 tâches en cours ». A missed live event is corrected by the snapshot.
    await check(B, 'snapshot-live', 'Événement manqué (sommeil, coupure du flux) : le relevé /api/pupitre remet le cadre « en cours » sans recharger, et la fin manquée au 2ᵉ relevé', async () => {
      if (!(await page.evaluate(() => !!window.TurnCore?.snapshotState))) NA('règle absente de cet état du code');
      const r = await page.evaluate(() => {
        const m = App.musicians.get('alpha');
        const saved = { state: m.state, turnStartMs: m.turnStartMs, heldState: m.heldState, snap: App.pupitreSnapshot };
        const row = (state, start) => ({ ...(saved.snap?.fleet || []).find(x => x.name === 'alpha'), name: 'alpha', state, lingering: null, lastTurnStartAt: start });
        const apply = (state, start) => { App.pupitreSnapshot = { ...(saved.snap || {}), fleet: [row(state, start)] }; App.applyPupitreToCards(); return m.state; };
        m.setState('idle'); m.turnStartMs = Date.now() - 600_000; m._snapStreak = 0; m._snapDisagree = null;
        const rail = () => document.querySelector('.rail-row[data-name="alpha"]')?.getAttribute('data-state') || null;
        const start = Date.now() - 1000;
        const s1 = apply('live', start), rail1 = rail();
        const s2 = apply('unread', start), s3 = apply('unread', start);
        m._snapStreak = 0; m._snapDisagree = null; m.heldState = saved.heldState; m.turnStartMs = saved.turnStartMs;
        App.pupitreSnapshot = saved.snap; m.setState(saved.state); App.applyPupitreToCards();
        return { s1, rail1, s2, s3 };
      });
      assert(r.s1 === 'live', `départ manqué non rattrapé : ${r.s1}`);
      assert(r.rail1 === null || r.rail1 === 'live', `rail : ${r.rail1}`);
      assert(r.s2 === 'live' && r.s3 === 'unread', `fin manquée : ${r.s2} → ${r.s3}`);
      return JSON.stringify(r);
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
    // User request (2026-10-13): « Les éléments de la file d'attente doivent
    // être clickable pour voir leurs détails » (detail part, read-only).
    await check(B, 'queue-item-detail', 'File d’un musicien : chaque élément est cliquable (clic, Entrée, Espace) et ouvre une vue de détail en lecture seule avec l’entrée COMPLÈTE (identifiant, date d’ajout, texte intégral jamais tronqué, model/provider, pipeline/mode, callback, session neuve, position) ; « Retirer » n’ouvre pas le détail ; fermeture par ✕, Échap (le volet reste ouvert) et clic hors zone ; barre d’actions prête pour l’édition ; plein écran sur mobile', async () => {
      if (!(await page.evaluate(() => !!window.Salle?.openQueueDetail))) NA('détail de la file absent de cet état du code');
      const longText = 'Tâche de recette du détail de file.\n\nPremière consigne : <b>ne pas interpréter</b> ce balisage.\n' +
        'Deuxième ligne détaillée. '.repeat(30) + '\nFIN-DU-TEXTE-COMPLET';
      const post = await fetch(`${sb.url}/api/dispatch`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'eps', prompt: longText, queueIfBusy: true, callback: 'chef', model: 'claude-sonnet-5',
          provider: 'claude', newSession: true, pipeline: 'dev', pipelineMode: 'complet' }) });
      const pj = await post.json();
      assert(post.status === 202 && pj.queued === true, `mise en file : ${post.status} ${JSON.stringify(pj)}`);
      const ovState = (p) => p.evaluate(() => {
        const ov = document.getElementById('queue-overlay');
        const d = ov && ov.querySelector('.qdv');
        const r = d && d.getBoundingClientRect();
        const q = (s) => ov?.querySelector(s)?.textContent || '';
        return {
          open: !!ov && !ov.hidden, text: ov?.querySelector('.qdv-text')?.textContent ?? null,
          pos: q('dd.qdv-pos'), id: q('dd.qdv-id'), when: q('dd.qdv-when'), model: q('dd.qdv-model'), pipeline: q('dd.qdv-pipeline'),
          callback: q('dd.qdv-callback'), fresh: q('dd.qdv-newsession'), bold: !!ov?.querySelector('.qdv-text b'),
          actionsHidden: ov?.querySelector('.qdv-actions')?.hidden, actions: [...(ov?.querySelectorAll('.qdv-action') || [])].map(b => b.textContent), focusIn: !!ov && ov.contains(document.activeElement),
          rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
          vw: innerWidth, vh: innerHeight, closeSize: Math.round(ov?.querySelector('.qdv-close')?.getBoundingClientRect().height || 0),
          diveOpen: !document.getElementById('dive').hidden,
        };
      });
      try {
        await setHash(page, '#/m/eps');
        const row = `#dive .dq-item[data-queue-open="${pj.id}"]`;
        assert(await until(async () => (await page.locator(row).count()) === 1, 10_000), 'nouvelle entrée absente du volet');
        assert(await page.getAttribute(row, 'role') === 'button' && await page.getAttribute(row, 'tabindex') === '0', 'ligne non focalisable');
        await page.click(row);
        assert(await until(async () => (await ovState(page)).open, 3000), 'le clic n’ouvre pas le détail');
        const s = await ovState(page);
        assert(s.text === longText, `texte tronqué ou altéré (${s.text?.length} / ${longText.length} car.)`);
        assert(!s.bold, 'balisage interprété');
        assert(s.id === pj.id && /^2 sur 2$/.test(s.pos), `identifiant/position : ${s.id} / ${s.pos}`);
        assert(/\d{2}\/\d{2}\/\d{4}/.test(s.when), `date d’ajout : ${s.when}`);
        assert(/claude-sonnet-5/.test(s.model) && /claude/.test(s.model), `model : ${s.model}`);
        assert(/dev/.test(s.pipeline) && /complet/.test(s.pipeline), `pipeline : ${s.pipeline}`);
        assert(/chef/.test(s.callback) && /^oui/.test(s.fresh), `callback / session neuve : ${s.callback} / ${s.fresh}`);
        // 0.89.0: the edit part of the same request adds « Modifier la demande… ».
        assert(s.focusIn && (s.actions.length ? s.actionsHidden === false && s.actions.join() === 'Modifier la demande…' : s.actionsHidden === true), `barre d’actions ${JSON.stringify(s.actions)} (masquée : ${s.actionsHidden}), ou focus hors du détail`);
        await page.keyboard.press('Escape');
        let a = await ovState(page);
        assert(!a.open && a.diveOpen, `Échap : détail ${a.open ? 'ouvert' : 'fermé'}, volet ${a.diveOpen ? 'ouvert' : 'fermé'}`);
        assert(await page.evaluate((id) => document.activeElement?.dataset?.queueOpen === id, pj.id), 'focus non rendu à la ligne');
        await page.keyboard.press('Enter');
        assert(await until(async () => (await ovState(page)).open, 3000), 'Entrée n’ouvre pas le détail');
        await page.click('#queue-overlay .qdv-close');
        assert(!(await ovState(page)).open, '✕ ne ferme pas');
        await page.focus(row);
        await page.keyboard.press(' ');
        assert(await until(async () => (await ovState(page)).open, 3000), 'Espace n’ouvre pas le détail');
        await page.mouse.click(5, 500);
        a = await ovState(page);
        assert(!a.open && a.diveOpen, 'clic hors zone ne ferme pas (ou ferme le volet)');
        // Ready for the edit part: an action registered later shows in the bar.
        await page.evaluate(() => Salle.registerQueueAction({ id: 'regress-test', label: 'Essai', run: (e, c) => { window.__qdvRan = e.id; c.close(); } }));
        await page.click(row);
        await page.locator('#queue-overlay [data-qdv-action="regress-test"]').click();
        assert(await until(async () => !(await ovState(page)).open && (await page.evaluate(() => window.__qdvRan)) === pj.id, 3000), 'action non exécutée sur l’entrée');
        await page.evaluate(() => Salle.registerQueueAction({ id: 'regress-test', label: 'Essai', when: () => false, run: () => {} }));
        // « Retirer » keeps its own behaviour and never opens the detail.
        await page.evaluate(() => { window.__qdvConfirm = window.confirm; window.confirm = () => false; });
        await page.locator(`${row} .dq-rm`).click();
        await page.waitForTimeout(300);
        await page.evaluate(() => { window.confirm = window.__qdvConfirm; });
        assert(!(await ovState(page)).open, '« Retirer » ouvre le détail');
        assert((await api('/api/queue/eps')).count === 2, 'Retirer annulé a quand même retiré');
        await shot(page, 'queue-detail');
        const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
        try {
          const m = await mctx.newPage();
          await m.goto(`${sb.url}/?token=${sb.token}#/m/eps`); await m.locator('.brand').waitFor();
          await m.locator(row).waitFor({ timeout: 10_000 });
          await m.tap(`${row} .dq-head`);
          assert(await until(async () => (await ovState(m)).open, 3000), 'mobile : le toucher n’ouvre pas le détail');
          const mo = await ovState(m);
          assert(mo.rect.x === 0 && mo.rect.y === 0 && mo.rect.w === mo.vw && mo.rect.h === mo.vh, `mobile : pas en plein écran ${JSON.stringify(mo.rect)}`);
          assert(mo.closeSize >= 44 && mo.text === longText, `mobile : ✕ ${mo.closeSize} px, texte complet ${mo.text === longText}`);
          const ox = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          assert(ox <= 0, `mobile : débordement horizontal ${ox} px`);
          if (t.shots) await m.screenshot({ path: path.join(path.resolve(t.shots), 'queue-detail-mobile.png') });
        } finally { await mctx.close(); }
        return `entrée ${pj.id} : ${longText.length} car. sur ${longText.split('\n').length} lignes, tous les champs ; clic, Entrée, Espace ; ✕, Échap, hors zone ; action prête ; mobile plein écran`;
      } finally {
        await page.evaluate(() => window.Salle?.closeQueueDetail?.()).catch(() => {});
        await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(pj.id)}`, { method: 'DELETE', headers: H }).catch(() => {});
        await page.click('#dive .dive-back').catch(() => {});
      }
    });
    // User request (2026-10-13): « tant qu'ils ne sont pas traités ils sont éditables ».
    await check(B, 'queue-edit', 'File d’un musicien : depuis le détail, « Modifier la demande… » ouvre le texte en édition ; Enregistrer (ou Ctrl+Entrée) le remplace dans la file du serveur ; Échap annule sans fermer le détail ; une tâche partie pendant l’édition n’est plus modifiable (enregistrement désactivé, texte gardé pour copie)', async () => {
      if (!(await page.evaluate(() => typeof window.Salle?.openQueueDetail === 'function')) || !fs.readFileSync(path.join(sb.root, 'public', 'salle.js'), 'utf8').includes('saveQueueEdit')) NA('modification d’une entrée de file absente de cet état du code');
      const ORIG = 'Recette d’édition de file : texte d’origine';
      const NEW = 'Recette d’édition de file : texte MODIFIÉ\ndeuxième ligne';
      const add = async (t) => (await (await fetch(`${sb.url}/api/dispatch`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'eps', prompt: t, queueIfBusy: true }) })).json()).id;
      // The pane reloads its queue when the queue LENGTH changes (snapshot
      // depth); the previous check added then removed one entry, so two are
      // added here to make the length differ from what the pane last saw.
      const id = await add(ORIG);
      const filler = await add('Recette d’édition de file : entrée de remplissage');
      const row = `#dive .dq-item[data-queue-open="${id}"]`;
      const st = () => page.evaluate(() => {
        const ov = document.getElementById('queue-overlay');
        return { open: !!ov && !ov.hidden, text: ov?.querySelector('.qdv-text')?.textContent ?? null, editing: !!ov?.querySelector('.qdv-edit'),
          value: ov?.querySelector('.qdv-edit')?.value ?? null, saveDisabled: ov?.querySelector('.qdv-save')?.disabled ?? null,
          msg: ov?.querySelector('.qdv-edit-msg')?.textContent || '', edited: ov?.querySelector('dd.qdv-edited')?.textContent || '',
          actions: [...(ov?.querySelectorAll('.qdv-action') || [])].map(b => b.textContent), focusEdit: document.activeElement?.classList?.contains('qdv-edit') };
      });
      try {
        // The previous check leaves through « ← » (history.back, asynchronous):
        // let it land, then (re)open the pane until the new entry shows.
        await page.waitForTimeout(400);
        let tries = 0;
        assert(await until(async () => {
          if ((await page.locator(row).count()) === 1) return true;
          if (tries++ % 6 === 0) await setHash(page, tries > 1 ? '#/' : '#/m/eps').then(() => tries > 1 && setHash(page, '#/m/eps'));
          return false;
        }, 15_000), `entrée absente du volet (hash ${await page.evaluate(() => location.hash)}, file serveur ${(await api('/api/queue/eps')).entries.map(e => e.id).join()})`);
        await page.click(row);
        assert(await until(async () => (await st()).open, 3000), 'détail non ouvert');
        assert((await st()).actions.includes('Modifier la demande…'), `action absente : ${JSON.stringify((await st()).actions)}`);
        await page.locator('#queue-overlay [data-qdv-action="edit"]').click();
        let s = await st();
        assert(s.editing && s.value === ORIG && s.focusEdit && !s.actions.length, `édition : ${JSON.stringify(s).slice(0, 200)}`);
        // Escape cancels the edit, the detail stays open, nothing is sent.
        await page.fill('#queue-overlay .qdv-edit', 'brouillon abandonné');
        await page.keyboard.press('Escape');
        s = await st();
        assert(s.open && !s.editing && s.text === ORIG, `Échap : ${JSON.stringify(s).slice(0, 200)}`);
        assert((await api('/api/queue/eps')).entries.find(e => e.id === id)?.text === ORIG, 'Échap a modifié la file');
        // Edit and save with Ctrl+Enter.
        await page.locator('#queue-overlay [data-qdv-action="edit"]').click();
        await page.fill('#queue-overlay .qdv-edit', NEW);
        await page.keyboard.press('Control+Enter');
        assert(await until(async () => { const x = await st(); return !x.editing && x.text === NEW; }, 5000), `enregistrement : ${JSON.stringify(await st()).slice(0, 240)}`);
        assert((await api('/api/queue/eps')).entries.find(e => e.id === id)?.text === NEW, 'la file du serveur ne porte pas le texte modifié');
        assert(/\d{2}\/\d{2}\/\d{4}/.test((await st()).edited), `« Modifiée » absent : ${(await st()).edited}`);
        // The entry leaves the queue while it is being edited: no longer editable.
        await page.locator('#queue-overlay [data-qdv-action="edit"]').click();
        await page.fill('#queue-overlay .qdv-edit', 'texte qui arrive trop tard');
        await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(id)}`, { method: 'DELETE', headers: H });
        // Whichever comes first: the live refresh sees it gone, or the save gets 409.
        await page.locator('#queue-overlay .qdv-save').click().catch(() => {});
        assert(await until(async () => { const x = await st(); return x.saveDisabled === true && /n'est plus modifiable/.test(x.msg); }, 15_000), `tâche partie : ${JSON.stringify(await st()).slice(0, 260)}`);
        s = await st();
        assert(s.value === 'texte qui arrive trop tard', 'le texte saisi est perdu');
        await shot(page, 'queue-edit');
        return `entrée ${id} : édition, Échap sans effet, enregistrement (Ctrl+Entrée) dans la file du serveur, tâche partie : enregistrement désactivé, texte gardé`;
      } finally {
        await page.evaluate(() => window.Salle?.closeQueueDetail?.()).catch(() => {});
        await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(id)}`, { method: 'DELETE', headers: H }).catch(() => {});
        await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(filler)}`, { method: 'DELETE', headers: H }).catch(() => {});
        await page.click('#dive .dive-back').catch(() => {});
      }
    });
    // User request (2026-10-13): « il faut pouvoir drag & drop les éléments de la
    // file d'attente, et que celà ai un impacte sur l'ordre de traitement ».
    await check(B, 'queue-drag', 'File d’un musicien : les éléments en attente se réordonnent par glisser-déposer (souris ; poignée de 44 px sur mobile) ou Alt+↑/↓ ; le nouvel ordre est celui de la file du serveur (ordre de lancement) ; le glisser n’ouvre pas le détail, le clic simple l’ouvre toujours ; « Retirer » ne lance pas de glisser', async () => {
      if (!(await page.evaluate(() => typeof window.Salle?.openQueueDetail === 'function')) || !fs.readFileSync(path.join(sb.root, 'public', 'salle.js'), 'utf8').includes('saveQueueOrder')) NA('glisser-déposer de la file absent de cet état du code');
      const add = async (t) => (await (await fetch(`${sb.url}/api/dispatch`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'eps', prompt: t, queueIfBusy: true }) })).json()).id;
      const mine = [];
      const domIds = () => page.evaluate(() => [...document.querySelectorAll('#dive .dive-queue > .dq-item')].map(r => r.dataset.queueOpen));
      const srvIds = async () => (await api('/api/queue/eps')).entries.map(e => e.id);
      try {
        mine.push(await add('Tâche glissée n° 1'), await add('Tâche glissée n° 2'));
        await setHash(page, '#/m/eps');
        assert(await until(async () => (await domIds()).length >= 3, 10_000), `éléments affichés : ${(await domIds()).length}`);
        const d0 = await domIds();
        const row = (id) => `#dive .dq-item[data-queue-open="${id}"]`;
        // 1. Mouse drag: the last row to the top.
        const a = await page.locator(`${row(d0[d0.length - 1])} .dq-head`).boundingBox();
        const b = await page.locator(row(d0[0])).boundingBox();
        await page.mouse.move(a.x + 20, a.y + a.height / 2);
        await page.mouse.down();
        for (let k = 1; k <= 8; k++) await page.mouse.move(a.x + 20, a.y + a.height / 2 + (b.y + 2 - a.y - a.height / 2) * k / 8);
        await page.mouse.up();
        const want = [d0[d0.length - 1], ...d0.slice(0, -1)];
        assert(await until(async () => (await srvIds()).join() === want.join(), 6000), `ordre du serveur : ${(await srvIds()).join()} (attendu ${want.join()})`);
        assert((await domIds()).join() === want.join(), 'ordre affiché différent');
        await sleep(400);
        assert(!(await page.evaluate(() => window.Salle.queueDetailId)), 'le glisser a ouvert le détail');
        // 2. Keyboard: Alt+↓ moves the focused row one place down.
        await page.focus(row(want[0]));
        await page.keyboard.press('Alt+ArrowDown');
        const want2 = [want[1], want[0], ...want.slice(2)];
        assert(await until(async () => (await srvIds()).join() === want2.join(), 6000), `Alt+↓ : ${(await srvIds()).join()}`);
        // 3. A simple click still opens the detail; « Retirer » never starts a drag.
        await page.click(`${row(want2[0])} .dq-head`);
        assert(await until(async () => !!(await page.evaluate(() => window.Salle.queueDetailId)), 3000), 'le clic simple n’ouvre plus le détail');
        await page.keyboard.press('Escape');
        await page.evaluate(() => { window.__qdConfirm = window.confirm; window.confirm = () => false; });
        await page.locator(`${row(want2[1])} .dq-rm`).click();
        await page.evaluate(() => { window.confirm = window.__qdConfirm; });
        assert((await srvIds()).join() === want2.join() && !(await page.evaluate(() => window.Salle.queueDetailId)), '« Retirer » annulé a changé la file ou ouvert le détail');
        await shot(page, 'queue-drag');
        // 4. Mobile: a 44 px grip (a finger drags from it, the pane still scrolls).
        const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
        try {
          const m = await mctx.newPage();
          await m.goto(`${sb.url}/?token=${sb.token}#/m/eps`); await m.locator('.brand').waitFor();
          await m.locator('#dive .dq-item .dq-grip').first().waitFor({ timeout: 10_000 });
          const g = await m.locator('#dive .dq-item .dq-grip').first().boundingBox();
          assert(g && g.width >= 44 && g.height >= 44, `poignée mobile ${JSON.stringify(g)}`);
        } finally { await mctx.close(); }
        return `glisser : dernier en tête, ordre du serveur suivi ; Alt+↓ ; clic simple → détail ; « Retirer » sans glisser ; poignée mobile 44 px`;
      } finally {
        for (const id of mine) await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(id)}`, { method: 'DELETE', headers: H }).catch(() => {});
        await page.evaluate(() => window.Salle?.closeQueueDetail?.()).catch(() => {});
        await page.click('#dive .dive-back').catch(() => {});
      }
    });
    // User report (2026-10-13): « A partir du moment où quelque chose tourne,
    // attaché à un projet, et que ça empêche le projet d'avancer […] » — the
    // queue held by a lingering process is visible on the card and in the pane.
    await check(B, 'queue-held', 'File retenue par un processus vivant après le result : pastille « ⏸ n retenue » sur le cadre du musicien et bandeau explicatif dans sa file (PID, depuis quand, la suite partira seule, comment débloquer) ; rien n’est tué', async () => {
      if (!fs.existsSync(path.join(sb.root, 'scripts', 'queue-hold.mjs'))) NA('détection absente de cet état du code');
      const pidFile = path.join(sb.root, 'logs', 'alpha.pid');
      const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
      let qid = null;
      try {
        fs.writeFileSync(pidFile, String(keep.pid));
        await until(async () => (await api('/api/pupitre')).fleet.find(r => r.name === 'alpha' && r.lingering) || null, 8000);
        const d = await fetch(`${sb.url}/api/dispatch`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'alpha', prompt: 'tâche retenue (navigateur)', queueIfBusy: true }) });
        qid = (await d.json()).id;
        assert(qid, 'mise en file impossible');
        await page.evaluate(() => window.App.pollPupitre());
        if (!(await page.locator('#rail-body .rail-card').count()) && await page.locator('#rail-body [data-fold="cards"]').count()) await page.click('#rail-body [data-fold="cards"]');
        const chip = '#rail-body .rail-card[data-name="alpha"] [data-queue-held]';
        assert(await until(async () => (await page.locator(chip).count()) > 0, 10_000), 'pastille « retenue » absente du cadre');
        assert(/1 retenue/.test(await page.locator(chip).first().textContent()), 'texte de la pastille');
        await setHash(page, '#/m/alpha');
        assert(await until(async () => (await page.locator('#dive .dq-held').count()) === 1, 10_000), 'bandeau absent de la file');
        const txt = await page.textContent('#dive .dq-held');
        assert(new RegExp(`PID ${keep.pid}`).test(txt) && /partira d'elle-même/.test(txt) && /kill-stalled\.mjs alpha/.test(txt), `bandeau : ${txt}`);
        await shot(page, 'queue-held');
        assert(keep.exitCode === null, 'le processus a été tué');
        return `alpha : pastille et bandeau (PID ${keep.pid})`;
      } finally {
        if (qid) await fetch(`${sb.url}/api/queue/alpha/${encodeURIComponent(qid)}`, { method: 'DELETE', headers: H }).catch(() => {});
        keep.kill();
        for (let i = 0; i < 20 && fs.existsSync(pidFile); i++) { try { fs.unlinkSync(pidFile); } catch { await sleep(150); } }
        await page.click('#dive .dive-back').catch(() => {});
      }
    });
    // User rule (2026-10-20): « si aucune activite de ma part depuis plus de 15
    // minutes, et qu'un process attend quelque chose de moi, et que je ne reponds
    // pas dans les 5 minutes, opus 5.5 est charge et autorise a repondre a ma
    // place. Un point de retours est cree si possible. Sinon il faut avancer »
    // + « Ces gardes fous sont tres importants, garde les ».
    await check(B, 'auto-answer', 'Réponse automatique : interrupteur visible dans la barre du haut (ON/OFF, à chaud), overlay avec les garde-fous en lecture seule, résumé au retour des décisions prises à votre place avec raison et point de retour, « Annuler » (le dépôt revient au point de retour) et « ✓ Vu »', async () => {
      if (!fs.existsSync(path.join(sb.root, 'public', 'auto-answer.js'))) NA('réponse automatique absente de cet état du code');
      const AA = await import(pathToFileURL(path.join(sb.root, 'scripts', 'auto-answer.mjs')).href);
      const { execFileSync } = await import('node:child_process');
      const logs = path.join(sb.root, 'logs');
      const repo = path.join(sb.root, 'auto-answer-repo');
      const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      fs.mkdirSync(repo, { recursive: true });
      git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 'recette');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n'); git('add', '-A'); git('commit', '-qm', 'init');
      const id = AA.newId();
      const recovery = AA.makeRecoveryPoint({ id, logsDir: logs, repo });
      AA.upsertDecision(logs, { id, key: `log:lambda:0:${id}`, kind: 'question', project: 'lambda', lane: 0, at: new Date().toISOString(),
        question: 'Je fais A ou B ? Je recommande A.', status: 'applied', model: AA.AUTO_MODEL, answer: 'A, comme recommandé.', reason: 'recommandation suivie', recovery, guardrails: { hits: [] } });
      try {
        await page.evaluate(() => window.AutoAnswer.load());
        const pill = async () => ({ on: await page.getAttribute('#btn-auto', 'data-on').catch(() => null), label: (await page.getAttribute('#btn-auto', 'aria-label').catch(() => '')) || '' });
        assert(await until(async () => (await pill()).on === '0' && /COUPÉE/.test((await pill()).label) && await visible(page, '#btn-auto'), 8000), 'interrupteur absent de la barre du haut');
        const bar = await page.evaluate(() => { const t = document.querySelector('.topbar').getBoundingClientRect(); const b = document.querySelector('#btn-auto').getBoundingClientRect(); return { h: t.height, top: b.top, bottom: b.bottom, tTop: t.top, tBottom: t.bottom }; });
        assert(bar.top >= bar.tTop && bar.bottom <= bar.tBottom && bar.h < 90, `barre du haut sur deux lignes : ${JSON.stringify(bar)}`);
        const item = `#auto-band .aa-item[data-aa-id="${id}"]`;
        assert(await until(async () => await visible(page, item), 8000), 'résumé au retour absent');
        const band = await page.textContent('#auto-band');
        assert(/prises? à votre place/.test(band) && /A, comme recommandé\./.test(band) && /recommandation suivie/.test(band) && /Point de retour/.test(band), `résumé : ${band.slice(0, 400)}`);
        await shot(page, 'auto-answer-band');
        fs.writeFileSync(path.join(repo, 'b.txt'), 'après\n'); git('add', '-A'); git('commit', '-qm', 'après la réponse');
        await page.click(`${item} [data-aa-undo]`);
        const undone = await until(async () => (await api('/api/auto-answer')).decisions.find(d => d.id === id)?.undone || null, 10_000);
        assert(undone && git('rev-parse', 'HEAD') === recovery.git.head, `annulation : ${JSON.stringify(undone)}`);
        assert(await until(async () => /annulée/.test(await page.textContent(item).catch(() => '')), 8000), 'annulation non affichée');
        await page.click('#auto-band [data-aa-seen]');
        assert(await until(async () => !(await visible(page, '#auto-band')), 8000), '« ✓ Vu » ne vide pas le résumé');
        await page.click('#btn-auto');
        assert(await until(async () => await visible(page, '#auto-overlay'), 5000), 'overlay absent');
        const guards = await page.locator('#auto-overlay .aa-guards > li').count();
        assert(guards >= 5 && (await page.locator('#auto-overlay .aa-guards input, #auto-overlay .aa-guards button').count()) === 0, `garde-fous : ${guards}, modifiables ?`);
        assert(/toujours actifs/.test(await page.textContent('#auto-overlay')), 'garde-fous non présentés comme obligatoires');
        await page.check('#aa-enabled');
        assert(await until(async () => (await api('/api/auto-answer')).settings.enabled === true && (await pill()).on === '1' && /ACTIVE/.test((await pill()).label), 8000), 'interrupteur : activation sans effet');
        await page.uncheck('#aa-enabled');
        assert(await until(async () => (await api('/api/auto-answer')).settings.enabled === false && (await pill()).on === '0', 8000), 'interrupteur : coupure sans effet');
        await page.keyboard.press('Escape');
        assert(await until(async () => !(await visible(page, '#auto-overlay')), 4000), 'Échap ne ferme pas l’overlay');
        return `pill ON/OFF, résumé de ${id}, annulation (HEAD ${recovery.git.head.slice(0, 7)}), Vu, ${guards} garde-fous en lecture seule`;
      } finally {
        await fetch(`${sb.url}/api/auto-answer/settings`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => {});
        // Never leave the summary band open for the walks that follow (mobile layouts).
        await fetch(`${sb.url}/api/auto-answer/seen`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate(() => window.AutoAnswer?.load()).catch(() => {});
      }
    });
    // User report (2026-10-20): « j'ai vu les notifications de demande que je ne
    // voyais pas avant. Par contre le probleme, c'est qu'elles prennent toute la
    // page, et ne donnent pas la possibilite de voir quoique ce soit d'autre »
    await check(B, 'notif-dock', 'Zone compacte des demandes : avec 30 demandes en attente, la zone reste sous sa hauteur maximale (défilement interne), le reste du dashboard reste visible et cliquable, « N demandes en attente » repliable, « Tout réduire », repli mémorisé après rechargement ; pareil sur mobile', async () => {
      if (!fs.existsSync(path.join(sb.root, 'public', 'notif-dock.js'))) NA('zone compacte absente de cet état du code (avant 0.123.0)');
      const AA = await import(pathToFileURL(path.join(sb.root, 'scripts', 'auto-answer.mjs')).href);
      const logs = path.join(sb.root, 'logs');
      const mine = [];
      for (let i = 0; i < 30; i++) {
        const id = AA.newId();
        mine.push(id);
        AA.upsertDecision(logs, { id, key: `log:lambda:0:dock-${i}`, kind: i % 3 ? 'question' : 'gap', gapKey: `recette-${i}`, project: 'lambda', lane: 0, at: new Date().toISOString(),
          question: `Demande de recette n° ${i} : ${'texte long '.repeat(20)}`, status: 'applied', decision: i % 3 ? null : 'reject', model: AA.AUTO_MODEL,
          answer: `Réponse ${i}`, reason: 'recommandation suivie', waitedMin: 30, inactivity: { lastAt: new Date().toISOString(), lastKind: 'message', idleMin: 16, thresholdMin: 15 }, guardrails: { hits: [] } });
      }
      const measure = (p) => p.evaluate(() => {
        const d = document.getElementById('notif-dock').getBoundingClientRect();
        const cv = document.getElementById('conductor-view').getBoundingClientRect();
        const body = document.querySelector('#notif-dock .nd-body');
        const x = cv.left + cv.width / 2, y = Math.min(cv.bottom - 20, cv.top + cv.height / 2);
        const hit = document.elementFromPoint(x, y);
        return { dockH: d.height, vh: innerHeight, cvH: cv.height, cvTop: cv.top, scroll: body ? body.scrollHeight > body.clientHeight : false,
          hitInside: !!hit && !!hit.closest('#conductor-view'), items: document.querySelectorAll('#auto-band .aa-item').length,
          head: document.querySelector('#notif-dock .nd-count')?.textContent || '' };
      });
      // A frozen page (endless MutationObserver loop, first 0.123.0 draft) must fail, not hang the run.
      const alive = (p, ms = 10_000) => Promise.race([p.evaluate(() => 1), sleep(ms).then(() => { throw new Error('page figée (le script de la page ne rend plus la main)'); })]);
      try {
        await page.evaluate(() => { localStorage.removeItem('notif.collapsed'); window.AutoAnswer.load(); });
        await sleep(1500);
        await alive(page);
        assert(await until(async () => (await measure(page)).items >= 30, 10_000), 'les 30 décisions ne sont pas dans la zone');
        await alive(page);
        let m = await measure(page);
        assert(m.dockH <= 0.45 * m.vh && m.scroll, `zone trop haute ou sans défilement interne : ${JSON.stringify(m)}`);
        assert(m.cvH >= 0.3 * m.vh && m.hitInside, `le reste du dashboard n’est plus visible ou cliquable : ${JSON.stringify(m)}`);
        assert(/\d+ demandes? en attente/.test(m.head), `tête de la zone : ${m.head}`);
        assert(!(await page.evaluate(() => [...document.querySelectorAll('.notif-dock, .auto-band, .perm-band')].some(e => getComputedStyle(e).position === 'fixed'))), 'zone en position fixe (par-dessus la page)');
        await shot(page, 'notif-dock-30');
        // Collapse by the head line, remembered across a reload.
        await page.click('#notif-dock .nd-toggle');
        assert(await until(async () => !(await visible(page, '#notif-dock .nd-body')), 3000), 'repli sans effet');
        // Remembered: a fresh load (second tab of the same browser) opens collapsed.
        // Never reload the shared page: later walks rely on its in-memory state.
        const p2 = await page.context().newPage();
        try {
          await p2.goto(`${sb.url}/?token=${sb.token}`); await p2.locator('.brand').waitFor();
          assert(await until(async () => await visible(p2, '#notif-dock .nd-toggle'), 10_000), 'zone absente au rechargement');
          await sleep(800);
          assert(!(await visible(p2, '#notif-dock .nd-body')) && (await p2.getAttribute('#notif-dock .nd-toggle', 'aria-expanded')) === 'false', 'repli non mémorisé au rechargement');
        } finally { await p2.close(); }
        await page.click('#notif-dock .nd-toggle');
        assert(await until(async () => await visible(page, '#notif-dock .nd-body'), 3000), 'dépli sans effet');
        await page.locator('#auto-band [data-aa-detail]').first().click();
        assert(await until(async () => await visible(page, '#auto-band .aa-more:not([hidden])'), 3000), '« Détail » n’ouvre pas l’élément');
        await page.click('#notif-dock .nd-collapse-all');
        assert(await until(async () => !(await visible(page, '#notif-dock .nd-body')), 3000), '« Tout réduire » sans effet');
        // Mobile: same bounds.
        const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
        try {
          const mp = await mctx.newPage();
          await mp.goto(`${sb.url}/?token=${sb.token}`); await mp.locator('.brand').waitFor();
          assert(await until(async () => (await measure(mp)).items >= 30, 10_000), 'mobile : décisions absentes');
          const mm = await measure(mp);
          assert(mm.dockH <= 0.5 * mm.vh && mm.scroll && mm.cvH >= 0.25 * mm.vh, `mobile : zone trop haute ou page masquée : ${JSON.stringify(mm)}`);
          await shot(mp, 'notif-dock-mobile');
        } finally { await mctx.close(); }
        return `30 décisions : zone ${Math.round(m.dockH)} px sur ${m.vh} (défilement interne), fil ${Math.round(m.cvH)} px cliquable ; repli mémorisé ; Tout réduire ; mobile borné`;
      } finally {
        await fetch(`${sb.url}/api/auto-answer/dismiss`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: mine, confirm: true }) }).catch(() => {});
        await page.evaluate(() => { localStorage.removeItem('notif.collapsed'); window.AutoAnswer?.load(); window.NotifDock?.sync(); }).catch(() => {});
      }
    });
    // User request (2026-10-20): « La partie "Garde-fous — obligatoires, toujours
    // actifs" est trop importante. Trouve un moyen de la faire plus discrete. Il
    // faut pouvoir aussi discard des notifications qui ne sont plus utiles une
    // fois acceptee ou annulee ou obsoletes »
    await check(B, 'auto-answer-dismiss', 'Menu des réponses automatiques : garde-fous repliés sur une ligne « 🔒 5 garde-fous actifs » (toujours là, non modifiables) ; « Écarter » retire une décision traitée et la garde dans l’historique ; une décision obsolète est marquée ; « Écarter tout ce qui est traité ou obsolète » ; la notification dit quoi, sur quel élément (lien) et pourquoi inactif', async () => {
      if (!fs.existsSync(path.join(sb.root, 'public', 'notif-dock.js'))) NA('écarter absent de cet état du code (avant 0.123.0)');
      const AA = await import(pathToFileURL(path.join(sb.root, 'scripts', 'auto-answer.mjs')).href);
      const logs = path.join(sb.root, 'logs');
      const base = { project: 'lambda', lane: 0, at: new Date().toISOString(), model: AA.AUTO_MODEL, guardrails: { hits: [] }, waitedMin: 14032,
        inactivity: { lastAt: new Date().toISOString(), lastKind: 'message', lastSource: 'dashboard', idleMin: 15, thresholdMin: 15 } };
      const handled = AA.newId(), obsolete = AA.newId();
      AA.upsertDecision(logs, { ...base, id: handled, key: 'gap:recette-dismiss', kind: 'gap', gapKey: 'recette-dismiss', status: 'applied', decision: 'reject', answer: 'Rattachement par mots-clés refusé', question: 'Lacune proposée : recette' });
      AA.upsertDecision(logs, { ...base, id: obsolete, key: 'perm:p-000000000000', kind: 'permission', permissionId: 'p-000000000000', status: 'submitted', question: 'Autoriser Bash : echo' });
      try {
        await page.evaluate(() => window.AutoAnswer.load());
        const item = (id) => `#auto-band .aa-item[data-aa-id="${id}"]`;
        assert(await until(async () => await visible(page, item(handled)), 8000), 'décision absente de la zone');
        const line = await page.textContent(item(handled));
        assert(/lacune rejetée/.test(line) && /lacune « recette-dismiss »/.test(line) && /Pourquoi à votre place/.test(line) && /seuil de 15 min/.test(line) && /10 jours/.test(line), `notification incomplète : ${line.slice(0, 500)}`);
        assert(await page.locator(`${item(handled)} a[data-aa-goto="gaps"]`).count() === 1, 'pas de lien vers l’élément (lacune)');
        assert((await page.getAttribute(item(obsolete), 'data-phase')) === 'obsolete', 'décision obsolète non marquée');
        await page.click(`${item(handled)} [data-aa-dismiss]`);
        assert(await until(async () => !(await visible(page, item(handled))), 8000), '« Écarter » ne retire pas la décision');
        let v = await api('/api/auto-answer');
        assert(!v.decisions.some(d => d.id === handled) && v.history.some(d => d.id === handled), 'écartée mais pas dans l’historique');
        await page.click('#btn-auto');
        assert(await until(async () => await visible(page, '#auto-overlay'), 5000), 'overlay absent');
        const g = await page.evaluate(() => { const d = document.querySelector('#auto-overlay details.aa-guards-d'); return d ? { open: d.open, summary: d.querySelector('summary').textContent, n: d.querySelectorAll('.aa-guards > li').length, h: d.getBoundingClientRect().height } : null; });
        assert(g && !g.open && /🔒 \d+ garde-fous actifs/.test(g.summary) && g.n >= 5 && g.h < 60, `garde-fous non repliés : ${JSON.stringify(g)}`);
        assert(!(await page.locator('#auto-overlay h3', { hasText: 'Garde-fous' }).count()), 'grande section « Garde-fous » encore présente');
        assert((await api('/api/auto-answer')).guardrails.filter(x => x.mandatory).length === 5, 'garde-fous plus actifs');
        assert(/Historique : \d+ décision/.test(await page.textContent('#auto-overlay')), 'historique des écartées absent');
        await page.click('#aa-dismiss-handled');
        assert(await until(async () => !(await api('/api/auto-answer')).decisions.some(d => d.id === obsolete), 8000), '« Écarter tout ce qui est traité ou obsolète » laisse l’obsolète');
        await shot(page, 'auto-answer-dismiss');
        return `garde-fous : « ${g.summary.trim()} » (${g.n}, repliés) ; ${handled} écartée → historique ; ${obsolete} obsolète → écartée en lot`;
      } finally {
        await fetch(`${sb.url}/api/auto-answer/dismiss`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [handled, obsolete], confirm: true }) }).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate(() => window.AutoAnswer?.load()).catch(() => {});
      }
    });
    // User request (2026-10-20): « Je ne vois pas que le test de non regression
    // est en cours sur orchestrateur-dev. C'est un probleme. »
    await check(B, 'regression-live', 'Non-régression en cours visible : bande (projet, progression, KO, lanceur), pastille 🧪 sur le cadre, entrée du journal d’activité ; à la fin, résultat et lien vers le rapport', async () => {
      if (!fs.existsSync(path.join(sb.root, 'public', 'regress-live.js'))) NA('suivi absent de cet état du code');
      const F = await import(pathToFileURL(path.join(REPO, 'tests', 'regress-live-fixture.mjs')).href);
      const beta = path.join(sb.root, 'projects', 'beta');
      try {
        const run = F.writeRunning(beta);
        await page.evaluate(() => window.RegressLive.poll());
        const row = '#regress-band .rg-row[data-project="beta"][data-regress="running"]';
        assert(await until(async () => (await page.locator(row).count()) === 1, 12_000), 'bande absente');
        const txt = await page.textContent(row);
        assert(/suites 3\/10/.test(txt) && /1 KO/.test(txt) && /script du chef \(recette\)/.test(txt) && /rapport à la fin/.test(txt), `bande : ${txt}`);
        await page.evaluate(() => window.App.pollPupitre());
        if (!(await page.locator('#rail-body .rail-card').count()) && await page.locator('#rail-body [data-fold="cards"]').count()) await page.click('#rail-body [data-fold="cards"]');
        const chip = '#rail-body .rail-card[data-name="beta"] .rc-chip-regress[data-regress="running"]';
        assert(await until(async () => (await page.locator(chip).count()) > 0, 10_000), 'pastille absente du cadre');
        assert(/NR 3\/10 · 1 KO/.test(await page.locator(chip).first().textContent()), 'texte de la pastille');
        await setHash(page, '#/m/beta');
        assert(await until(async () => (await page.locator(`#dive article.jt-regress[data-regress-id="${run.id}"]`).count()) === 1, 12_000), 'entrée absente du journal d’activité');
        await shot(page, 'regression-live');
        // The run ends red: the band keeps the result with the report link.
        F.clearRuns(beta);
        const fin = F.writeFinished(beta);
        await page.evaluate(() => new Promise(r => setTimeout(r, 2200)));
        await page.evaluate(() => window.RegressLive.poll());
        const done = `#regress-band .rg-row[data-project="beta"][data-regress="ko"]`;
        assert(await until(async () => (await page.locator(done).count()) === 1, 12_000), 'résultat final absent de la bande');
        const href = await page.getAttribute(`${done} a.rg-report`, 'href');
        assert(href === `/api/regressions/beta/report/${fin.id}`, `lien du rapport : ${href}`);
        const rep = await page.evaluate(async (u) => (await fetch(u)).json(), href);
        assert(rep.at === fin.reportAt, 'le lien ne mène pas au rapport');
        assert(await until(async () => (await page.locator(`#dive article.jt-regress[data-regress-id="${fin.id}"][data-regress="ko"]`).count()) === 1, 12_000), 'résultat absent du journal');
        return `bande, pastille, journal, puis ✕ et ${href}`;
      } finally {
        F.clearRuns(beta);
        await page.evaluate(() => window.RegressLive?.poll()).catch(() => {});
        await page.click('#dive .dive-back').catch(() => {});
      }
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
    // User requirement 2026-10-16 (0.108.0): « Acceptes les mkv et les fichiers jusqu'à 500Mo ».
    await check(B, 'attach-mkv', 'Pièce jointe : .mkv accepté (même sans type), > 500 Mo et type inconnu refusés avec un message clair', async () => {
      if (!(await page.evaluate(() => typeof AttachPolicy === 'object'))) return 'NA';
      // Windows browsers often give .mkv no MIME type: the extension must decide.
      await page.setInputFiles('#composer-file', { name: 'reunion.mkv', mimeType: '', buffer: Buffer.from('\x1aE\xdf\xa3 recette', 'latin1') });
      assert(await until(async () => (await page.locator('#composer-image-strip .cis-thumb--video').count()) > 0, 5000), 'vignette vidéo absente pour le .mkv');
      const mt = await page.evaluate(() => App.composer.images.map(i => i.mediaType));
      assert(mt.includes('video/x-matroska'), `type envoyé : ${mt.join(', ')}`);
      await page.evaluate(() => App._addAttachFiles([{ name: 'enorme.mkv', type: 'video/x-matroska', size: AttachPolicy.MAX_BYTES + 1 }]));
      let err = await page.textContent('#composer-error');
      assert(/trop volumineux/.test(err) && /500 Mo/.test(err), `message de taille : ${err}`);
      await page.setInputFiles('#composer-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
      err = await page.textContent('#composer-error');
      assert(/MKV/.test(err) && /500 Mo/.test(err) && /notes\.txt/.test(err), `message de type : ${err}`);
      assert((await page.evaluate(() => App.composer.images.length)) === 1, 'un fichier refusé a été ajouté');
      await page.click('#composer-image-strip .cis-del');
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
    // ---------------- Models par tâche (0.39.0 → 0.40.0 : 14 pipelines depuis 0.110.0) ----------------
    // Exigences utilisateur : une vue claire de l'enchaînement des tâches, un
    // model par tâche (menu groupé Anthropic / OpenAI / NVIDIA / OpenRouter) ;
    // puis « tous les pipelines », lisibles, boucles comprises, et le travail
    // images / vidéo / audio avec les models spécialisés et les outils locaux.
    const hasModels = async (pg) => (await pg.locator('#btn-models').count()) > 0;
    // Pipelines phase 1: the generics « Opérations » and « Fichiers » come last (an older state of the code has 14 tabs);
    // knowledge graph phase 1 (0.131.0) adds « Mémoire (graphe) » after them (16 tabs before).
    // The Exploitation lane (0.141.0) comes before « Mémoire (graphe) » (17 tabs before it).
    const TABS = 'Développement,Discussion,Routage (chef),Incident,Recherche,Audit sécurité,Maintenance,Nouveau projet,Données,Rédaction,Compte rendu de réunion,Images,Vidéo,Audio,Opérations,Fichiers,Exploitation,Mémoire (graphe)';
    const TABS_17 = 'Développement,Discussion,Routage (chef),Incident,Recherche,Audit sécurité,Maintenance,Nouveau projet,Données,Rédaction,Compte rendu de réunion,Images,Vidéo,Audio,Opérations,Fichiers,Mémoire (graphe)';
    const TABS_16 = 'Développement,Discussion,Routage (chef),Incident,Recherche,Audit sécurité,Maintenance,Nouveau projet,Données,Rédaction,Compte rendu de réunion,Images,Vidéo,Audio,Opérations,Fichiers';
    const TABS_OLD = 'Développement,Discussion,Routage (chef),Incident,Recherche,Audit sécurité,Maintenance,Nouveau projet,Données,Rédaction,Compte rendu de réunion,Images,Vidéo,Audio';
    await check(B, 'models-view', 'Models par tâche : 18 onglets de pipeline (17 avant l’exploitation, 16 avant la mémoire, 14 avant les génériques), bandeau, légende, chaque étape a titre + quand/quoi + exemple + menu (variantes repliables), boucles et retours dessinés, étape optionnelle distincte, renvois, menus par capacité (outils locaux), conseils, choix enregistré puis relu après rechargement, historique', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      await setHash(page, '#/');
      await page.click('#btn-models');
      assert(await until(async () => (await hash(page)) === '#/models' && await visible(page, '#models'), 5000), 'la pill n\'ouvre pas la vue');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'onglets absents');
      if (!(await page.locator('#models .mr-tab').count())) NA('structure en pipelines absente de cet état du code');
      assert(!(await visible(page, '#rail')) && !(await visible(page, '#conductor-view')), 'le fil ou le rail reste affiché');
      const tabs = await page.$$eval('#models .mr-tab', els => els.map(e => e.textContent.replace(/\d+\/\d+/, '').replace(/^\W+/u, '').trim()));
      assert(tabs.length === 18 || tabs.length === 17 || tabs.length === 16 || tabs.length === 14, `${tabs.length} onglets : ${tabs.join(', ')}`);
      assert(tabs.join(',') === TABS || tabs.join(',') === TABS_17 || tabs.join(',') === TABS_16 || tabs.join(',') === TABS_OLD, `onglets : ${tabs.join(',')}`);
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
          // A step done by the program (phase 1): no menu, its badge says so.
          const code = c.classList.contains('mr-code');
          const menu = ref ? !!c.querySelector('.mr-goto') : code ? !!c.querySelector('.mr-kind[data-kind="code"]') && !c.querySelector('.mr-select') : !!c.querySelector(':scope > .mr-select, :scope > .mr-sel-pair .mr-select');
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
      // 0.47.0 : outillés (harnais codex) → proposés aussi sur une étape d'action.
      const harnessOn = (await api('/api/model-routing')).agentHarness?.nvidia === true;
      if (harnessOn) {
        assert(nvA && !nvA.off && !/outillage/.test(nvA.l) && nvA.n > 0, `étape d'action, NVIDIA outillé : ${JSON.stringify(nvA)}`);
        assert(!/outillage en construction/.test(act.find(x => x.p === 'openrouter').l), 'OpenRouter encore « en construction »');
        assert(!/outillage en construction/.test(await page.textContent('#models .mr-legend')), 'légende : « en construction » alors que tout est outillé');
      } else {
        assert(nvA && nvA.off && /outillage en construction/.test(nvA.l) && nvA.n > 0, `étape d'action : ${JSON.stringify(nvA)}`);
        assert(/outillage en construction/.test(act.find(x => x.p === 'openrouter').l) || /clé non configurée/.test(act.find(x => x.p === 'openrouter').l), 'OpenRouter non signalé');
        assert(/outillage/.test(await page.textContent('#models .mr-legend')), 'légende sans l’outillage en construction');
      }
      assert(nvJ && !nvJ.off && nvJ.n > 0, `étape de jugement : ${JSON.stringify(nvJ)}`);
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
      assert(/8 octobre 2026/.test(box) && /a8c5cc2/.test(box) && /(109 cases sur 109|122 cases sur 122|123 cases sur 123|125 cases sur 125|126 cases sur 126)/.test(box), `encadré : ${box.replace(/\s+/g, ' ').slice(0, 200)}`);
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
      assert(seen === 126 || seen === 109 || seen === 122 || seen === 123 || seen === 125, `${seen} blocs au lieu de 126 (125 avant l’exploitation, 123 avant la mémoire, 122 avant routage.chef, 109 avant les génériques)`);
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
    await check(B, 'observe-view', 'Panneau « Observation » — entrées récentes (entrée, projet, choix explicite ou « à classer (model) »), mention « aucun classement par mots-clés » (0.66.0)', async () => {
      if (!(await hasModels(page))) NA('vue absente de cet état du code');
      await setHash(page, '#/models');
      assert(await until(async () => (await page.locator('#models .mr-tab').count()) > 0, 10_000), 'vue');
      if (!(await page.locator('#models .mr-obs-btn').count())) NA('observation absente de cet état du code');
      await page.click('#models .mr-obs-btn');
      assert(await until(async () => (await page.locator('#models .mr-obs-table tbody tr').count()) > 0, 8000), 'aucune classification affichée');
      const txt = await page.textContent('#models .mr-obs');
      // 0.66.0: the panel says no keyword classification is done any more.
      assert(/Aucun classement par mots-clés/.test(txt) || (/rien n’est encore imposé/.test(txt) && /Inclassable = Discussion/.test(txt)), 'explication du panneau absente');
      const rows = await page.$$eval('#models .mr-obs-table tbody tr', trs => trs.map(tr => ({ e: tr.dataset.entry, p: tr.dataset.pipeline, t: tr.textContent })));
      assert(rows.some(r => r.e === 'dashboard:chef'), `entrées : ${[...new Set(rows.map(r => r.e))].join(', ')}`);
      assert(rows.some(r => r.t.includes('à classer (model)')) || rows.some(r => /inclassable → Discussion/.test(r.t) && r.p === 'discussion'), 'entrée sans choix explicite non affichée « à classer (model) »');
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
      // Bulle de référence remise en fin de fil : le fil ne montre que les 60
      // derniers messages, et les notices du serveur au chef (lacunes, réveils,
      // autorisations) en ajoutent au fil de la recette — la fixture d'origine
      // pouvait sortir de la fenêtre selon la durée du parcours.
      appendLog('chef', [
        { type: 'user_prompt', text: 'Fais le point sur la flotte (recette lecture audio)' },
        { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Bonjour — la flotte est calme, rien à signaler.' }] } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 2000, duration_api_ms: 1500, result: 'Bonjour — la flotte est calme, rien à signaler.' },
      ]);
      await tp.goto(`${sb.url}/?token=${sb.token}`);
      await tp.locator('.brand').waitFor();
      if (!(await tp.evaluate(() => !!window.Tts))) NA('lecture audio absente de cet état du code');
      const refBubble = tp.locator('#cv-scroll .cv-bubble.is-conductor', { hasText: 'la flotte est calme' }).last();
      assert(await until(async () => (await refBubble.locator('.cv-tts-btn').count()) > 0, 10_000), 'aucun bouton « écouter » sur les bulles du chef');
      const btn = refBubble.locator('.cv-tts-btn');
      assert(/Écouter/.test(await btn.getAttribute('aria-label')), 'aria-label');
      // On fait défiler le FIL jusqu'à la bulle, comme un utilisateur :
      // laissé à Playwright, le défilement automatique décale aussi les
      // conteneurs parents (overflow: hidden) et fausse les captures.
      await refBubble.evaluate((el) => { const s = document.getElementById('cv-scroll'); s.scrollTop = Math.max(0, el.offsetTop - 20); });
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
    // 0.105.0 — user request (2026-10-16): « il faut qu'elles soient au format
    // html (et que le client web soit capables de les afficher correctemetn) ».
    await check(B, 'html-output', 'Sorties HTML des models : une réponse HTML du chef est rendue en HTML (titre, liste, tableau, lien), assainie (script, onerror, javascript:, style, iframe refusés, rien n’est exécuté), les anciennes réponses Markdown restent rendues, la lecture audio ne lit aucune balise', async () => {
      if (!(await tp.evaluate(() => !!window.HtmlRender))) NA('rendu HTML absent de cet état du code');
      const html = '<h2>HTML-OUT bilan</h2><p>Suite <strong>verte</strong> &amp; livrée, voir <a href="https://example.org/doc">la doc</a>.</p>'
        + '<ul><li>HTML-OUT un</li><li>deux</li></ul><table><tr><th>Suite</th><th>État</th></tr><tr><td>a</td><td>ok</td></tr></table>'
        + '<script>window.__xss = 1</script><img src="x" onerror="window.__xss = 2"><p onclick="window.__xss = 3" style="position:fixed;inset:0">HTML-OUT clic</p>'
        + '<a href="javascript:window.__xss = 4">HTML-OUT piège</a><iframe src="about:blank"></iframe></div></div>';
      appendLog('chef', [
        { type: 'user_prompt', text: 'Recette sortie HTML' },
        { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
        { type: 'assistant', message: { content: [{ type: 'text', text: html }] } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, duration_api_ms: 800, result: html },
        { type: 'user_prompt', text: 'Recette sortie Markdown' },
        { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
        { type: 'assistant', message: { content: [{ type: 'text', text: '## MD-OUT titre\n\n- **MD-OUT gras**\n- `code`' }] } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, duration_api_ms: 800, result: '## MD-OUT titre' },
      ]);
      await tp.goto(`${sb.url}/?token=${sb.token}`);
      await tp.locator('.brand').waitFor();
      const bubble = tp.locator('#cv-scroll .cv-bubble.is-conductor', { hasText: 'HTML-OUT bilan' }).last();
      assert(await until(async () => (await bubble.count()) > 0, 10_000), 'bulle HTML absente');
      const r = await bubble.evaluate((el) => {
        const body = el.querySelector('.cv-body');
        return {
          h2: body.querySelector('h2')?.textContent, li: body.querySelectorAll('li').length, th: body.querySelectorAll('th').length,
          strong: body.querySelector('strong')?.textContent, link: body.querySelector('a[href="https://example.org/doc"]')?.getAttribute('rel'),
          danger: body.querySelectorAll('script, img, iframe, style, [onclick], [onerror], [style]').length,
          jsLinks: [...body.querySelectorAll('a')].filter((a) => /^\s*javascript:/i.test(a.getAttribute('href') || '')).length,
          text: body.textContent,
        };
      });
      assert(r.h2 === 'HTML-OUT bilan' && r.li === 2 && r.th === 2 && r.strong === 'verte', `rendu HTML : ${JSON.stringify(r)}`);
      assert(/noopener/.test(r.link || ''), 'lien https sans rel=noopener');
      assert(r.danger === 0 && r.jsLinks === 0, `éléments dangereux restés : ${JSON.stringify(r)}`);
      assert(!/<h2>|<script|&lt;h2/.test(r.text) && /HTML-OUT clic/.test(r.text) && /HTML-OUT piège/.test(r.text), `balises affichées en texte : ${r.text.slice(0, 200)}`);
      await bubble.getByText('HTML-OUT piège').click().catch(() => {});
      assert(!(await tp.evaluate(() => window.__xss)), 'du code injecté s’est exécuté');
      assert(await tp.evaluate(() => document.querySelectorAll('#cv-scroll .cv-bubble.is-conductor').length > 0 && !!document.getElementById('cv-scroll')), 'le fil a été cassé par le fragment');
      const md = tp.locator('#cv-scroll .cv-bubble.is-conductor', { hasText: 'MD-OUT titre' }).last();
      const m = await md.evaluate((el) => ({ h2: el.querySelector('.cv-body h2')?.textContent, strong: el.querySelector('.cv-body strong')?.textContent }));
      assert(m.h2 === 'MD-OUT titre' && m.strong === 'MD-OUT gras', `ancienne réponse Markdown : ${JSON.stringify(m)}`);
      await tp.evaluate(() => { window.__tts.spoken = []; });
      await bubble.evaluate((el) => { const s = document.getElementById('cv-scroll'); s.scrollTop = Math.max(0, el.offsetTop - 20); });
      await bubble.locator('.cv-tts-btn').click();
      assert(await until(async () => (await spoken()).length > 0, 3000), 'lecture audio : rien envoyé');
      await tp.click('#tts-bar [data-tts-act="stop"]').catch(() => {});
      const said = (await spoken()).map((x) => x.text).join(' ');
      assert(/HTML-OUT bilan/.test(said) && !/<|&amp;|__xss/.test(said), `lecture audio : « ${said} »`);
      await shot(tp, 'html-output-desktop');
      return `bulle HTML rendue et assainie, Markdown inchangé, lu : « ${said.slice(0, 60)}… »`;
    });
    // 0.107.0 — user request (2026-10-16): « il faut que toutes references a un
    // identifiant quelconque soit un lien qui ouvre un overlay qui decrit ou
    // explique ce qu'est cet identifiant ».
    await check(B, 'id-links', 'Identifiants cliquables : dans une réponse du chef (HTML ou Markdown), un identifiant balisé [[…]] ou reconnu (item TODO, case de la page Models) est un lien ; un clic ouvre un overlay qui décrit ce qu’il désigne (données du serveur), « Identifiant inconnu » avec un message clair sinon ; Échap le ferme sans fermer le reste ; « Ouvrir dans le panneau TODO » mène à l’item', async () => {
      if (!(await tp.evaluate(() => !!window.IdLinks))) NA('identifiants cliquables absents de cet état du code');
      const html = '<p>IDREF bilan : item [[t-a10001]] coché, case routage.classifier réglée, [[t-ffffff]] introuvable.</p><ul><li>IDREF suite</li></ul>';
      appendLog('chef', [
        { type: 'user_prompt', text: 'Recette identifiants' },
        { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
        { type: 'assistant', message: { content: [{ type: 'text', text: html }] } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, duration_api_ms: 800, result: html },
        { type: 'user_prompt', text: 'Recette identifiants Markdown' },
        { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'IDREF-MD : voir **[[t-a10001]]** et `t-a10001`.' }] } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, duration_api_ms: 800, result: 'IDREF-MD' },
      ]);
      await tp.goto(`${sb.url}/?token=${sb.token}`);
      await tp.locator('.brand').waitFor();
      const bubble = tp.locator('#cv-scroll .cv-bubble.is-conductor', { hasText: 'IDREF bilan' }).last();
      assert(await until(async () => (await bubble.count()) > 0, 10_000), 'bulle absente');
      await until(async () => (await bubble.locator('a.idref[data-idref="routage.classifier"]').count()) > 0, 5000);
      const refs = await bubble.evaluate((el) => [...el.querySelectorAll('a.idref')].map((a) => a.dataset.idref));
      assert(refs.includes('t-a10001') && refs.includes('t-ffffff') && refs.includes('routage.classifier'), `liens : ${JSON.stringify(refs)}`);
      assert(!/\[\[/.test(await bubble.locator('.cv-body').textContent()), 'crochets affichés');
      const md = await tp.locator('#cv-scroll .cv-bubble.is-conductor', { hasText: 'IDREF-MD' }).last().evaluate((el) => el.querySelectorAll('a.idref[data-idref="t-a10001"]').length);
      assert(md === 2, `réponse Markdown : ${md} lien(s) au lieu de 2 (gras et code)`);
      await bubble.evaluate((el) => { const s = document.getElementById('cv-scroll'); s.scrollTop = Math.max(0, el.offsetTop - 20); });
      await bubble.locator('a.idref[data-idref="t-a10001"]').click();
      assert(await until(async () => (await tp.locator('#idref-overlay .idov-dialog[data-known="1"]').count()) > 0, 5000), 'overlay non rempli pour t-a10001');
      const known = await tp.evaluate(() => ({ kind: document.querySelector('.idov-kind').textContent, title: document.querySelector('.idov-title').textContent,
        body: document.querySelector('.idov-body').textContent, role: document.querySelector('.idov-dialog').getAttribute('role') }));
      assert(known.kind === 'Item de TODO list' && known.title && known.title !== 't-a10001' && /alpha/.test(known.body) && known.role === 'dialog', `overlay : ${JSON.stringify(known)}`);
      await shot(tp, 'id-links-known');
      await tp.keyboard.press('Escape');
      assert(await until(async () => !(await visible(tp, '#idref-overlay')), 2000), 'Échap ne ferme pas l’overlay');
      assert(await tp.evaluate(() => !!document.getElementById('cv-scroll')), 'le fil a disparu');
      await bubble.locator('a.idref[data-idref="t-ffffff"]').click();
      assert(await until(async () => (await tp.locator('#idref-overlay .idov-dialog[data-known="0"] .idov-unknown').count()) > 0, 5000), 'inconnu non signalé');
      const msg = await tp.locator('#idref-overlay .idov-msg').textContent();
      assert(/t-ffffff/.test(msg) && /ne le trouve pas/.test(msg), `message de l’inconnu : ${msg}`);
      await tp.click('#idref-overlay .idov-close');
      assert(await until(async () => !(await visible(tp, '#idref-overlay')), 2000), '✕ ne ferme pas');
      await bubble.locator('a.idref[data-idref="routage.classifier"]').click();
      assert(await until(async () => (await tp.locator('#idref-overlay .idov-dialog[data-kind="case"][data-known="1"]').count()) > 0, 5000), 'case de la page Models non expliquée');
      await tp.click('#idref-overlay .idov-backdrop', { position: { x: 5, y: 5 } });
      assert(await until(async () => !(await visible(tp, '#idref-overlay')), 2000), 'clic hors zone ne ferme pas');
      let todoOk = 'panneau TODO absent';
      if (await tp.evaluate(() => !!window.TodoPanel)) {
        await bubble.locator('a.idref[data-idref="t-a10001"]').click();
        await tp.locator('#idref-overlay .idov-link', { hasText: 'panneau TODO' }).click();
        assert(await until(async () => tp.evaluate(() => window.TodoPanel.isItemOpen() && document.querySelector('#todo-overlay .tov-dialog')?.dataset.id === 't-a10001'), 6000), '« Ouvrir dans le panneau TODO » ne mène pas à l’item');
        await tp.keyboard.press('Escape');
        todoOk = 'item ouvert dans le panneau TODO';
        await tp.evaluate(() => window.SidePanel?.close());
      }
      return `liens ${refs.join(', ')} ; connu, inconnu et case expliqués ; ${todoOk}`;
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
    // User request (2026-10-13, 0.78.0): « une demande d'autorisation donne la
    // commande à autoriser. Il faut aussi donner une explication de celle-ci ».
    await check(B, 'permission-explain', 'Autorisation : la carte 🔐 et l’overlay donnent, EN PLUS de la commande, une explication en français (ce que fait chaque étape, la description donnée par le musicien, son dernier message) ; secrets masqués', async () => {
      if (!(await pp.locator('#perm-band').count())) NA('demandes interactives absentes de cet état du code');
      await clearPerms(pp);
      await pp.bringToFront();
      await setHash(pp, '#/');
      const SECRET = 'sk-ant-api03-EXPLAINSECRET1234567890';
      const cmd = `cd outils; sleep 5; tail -n +1 -f .regress/ciblee.log | grep -E "KO|^===" ; curl -H "Authorization: Bearer ${SECRET}" https://api.example.com/x`;
      const done = permDispatch(sb, 'omega', `Bash|${JSON.stringify({ command: cmd, description: 'Surveille la non-régression jusqu’à sa fin' })}`);
      // Whatever fails below, never leave a pending card or an open overlay
      // to the next checks.
      try {
      const card = pp.locator('#perm-band .perm-card', { hasText: 'tail -n +1' });
      assert(await until(async () => card.isVisible().catch(() => false), 15_000), 'carte absente');
      const explain = await card.locator('.pc-explain').textContent().catch(() => '');
      assert(/se place dans outils, puis attend 5 s, puis suit en continu \.regress\/ciblee\.log, puis garde seulement les lignes qui correspondent à un motif, puis fait une requête réseau vers api\.example\.com/.test(explain), `carte sans explication : ${explain}`);
      assert(await card.locator('.pc-preview').count() === 1, 'la commande n’est plus montrée sur la carte');
      await card.locator('.pc-main').click();
      assert(await until(async () => visible(pp, '#perm-overlay .po-explain'), 8000), 'overlay sans explication');
      const box = await pp.textContent('#perm-overlay .po-explain');
      assert(/Ce que fait cette opération/.test(box) && box.includes(explain.trim()), `explication de l’overlay : ${box}`);
      assert(/Le musicien la décrit ainsi : « Surveille la non-régression jusqu’à sa fin »/.test(box), 'description du musicien absente');
      assert(/Pourquoi, d'après son dernier message : « Je vais utiliser Bash\. »/.test(box), 'pourquoi absent');
      const ov = await pp.textContent('#perm-overlay .po-dialog');
      assert(!ov.includes(SECRET) && !(await card.textContent()).includes(SECRET), 'secret en clair');
      assert(await pp.evaluate(() => { const e = document.querySelector('#perm-overlay .po-explain'), w = document.querySelector('#perm-overlay .po-why'); return !!e && !!w && !!(e.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'l’explication n’est pas en tête de l’overlay');
      await shot(pp, 'permission-explication');
      await clk(pp, '#perm-overlay [data-po-once]');
      assert(await done === 0, 'tour non terminé');
      return `carte : « ${explain.trim().slice(0, 90)}… » ; overlay : explication, description, pourquoi ; aucun secret`;
      } finally {
        await clearPerms(pp);
        await done.catch(() => {});
        await setHash(pp, '#/');
      }
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
    await check(B, 'todo-panel-mobile', 'Panneau TODO · mobile : ouvert par l’onglet du bord, plein écran, ✕ et filtre ≥ 44 px, aucun débordement, fermeture', async () => {
      if (!(await m.locator('#sp-edge').count())) NA('panneau absent de cet état du code');
      await setHash(m, '#/');
      assert(await until(async () => visible(m, '#sp-edge'), 6000), 'onglet du bord absent sur mobile');
      await m.click('#sp-edge');
      assert(await until(async () => (await todoState(m)).open && (await todoState(m)).items.length > 0, 8000), 'panneau mobile vide ou fermé');
      const s = await todoState(m);
      assert(s.top <= 1 && Math.abs(s.width - s.vw) <= 1 && Math.abs(s.bottom - s.vh) <= 2, `pas plein écran : top ${s.top}, ${s.width}/${s.vw} px, bas ${s.bottom}/${s.vh}`);
      const close = await m.locator('#side-panel .sp-close').boundingBox();
      const sel = await m.locator('#side-panel .todo-project').boundingBox();
      assert(close.height >= 44 && close.width >= 44 && sel.height >= 44, `cibles : ✕ ${close.width}×${close.height}, filtre ${sel.height}`);
      assert(await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'débordement horizontal');
      await shot(m, 'todo-panel-mobile');
      await m.click('#side-panel .sp-close');
      assert(await until(async () => !(await todoState(m)).open, 3000), 'ne se ferme pas');
    });
    await check(B, 'git-panel-mobile', 'Arbre git · mobile : onglet Git du panneau plein écran, graphe lisible, choix ≥ 44 px, aucun débordement', async () => {
      if (!(await m.locator('#btn-git').count())) NA('onglet Git absent de cet état du code');
      await m.click('#sp-edge');
      assert(await until(async () => (await gitState(m)).open, 4000), 'panneau fermé');
      await m.click('#side-panel [data-sp-tab="git"]');
      await m.selectOption('#side-panel .gg-project', 'omega');
      assert(await until(async () => (await gitState(m)).rows > 0, 10_000), 'graphe vide sur mobile');
      const sel = await m.locator('#side-panel .gg-project').boundingBox();
      assert(sel.height >= 44, `choix du musicien : ${sel.height}px`);
      assert(await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'débordement horizontal');
      await shot(m, 'git-panel-mobile');
      await m.click('#side-panel [data-sp-tab="todo"]');
      await m.click('#side-panel .sp-close');
      assert(await until(async () => !(await gitState(m)).open, 3000), 'ne se ferme pas');
    });
    await check(B, 'requests-panel-mobile', 'Requêtes · mobile : onglet du panneau plein écran, colonnes empilées avec « après n° k » (pas de traits), tâches et fenêtre ≥ 44 px, aucun débordement', async () => {
      if (!(await m.locator('#btn-requests').count())) NA('onglet Requêtes absent de cet état du code');
      const FX = await requestFx();
      if (!FX) NA('jeu de données des requêtes absent de cet état du code');
      const logsDir = path.join(sb.root, 'logs'), chefDir = path.join(sb.root, 'projects', 'chef');
      FX.writeRequestFixture({ logsDir, chefDir });
      try {
        await setHash(m, '#/');
        await m.click('#sp-edge');
        await m.click('#side-panel [data-sp-tab="requests"]');
        assert(await until(async () => (await rqState(m, FX.REQ_RUN)).tasks.length === 7, 10_000), 'carte absente sur mobile');
        const s = await rqState(m, FX.REQ_RUN);
        const t1 = s.tasks.find(t => t.n === 1), t2 = s.tasks.find(t => t.n === 2);
        assert(Math.abs(t1.box.x - t2.box.x) <= 1 && t2.box.y > t1.box.y && /après n° 1/.test(t2.text), `colonnes non empilées : ${JSON.stringify([t1.box, t2.box])}`);
        assert(!s.linksShown, 'traits affichés sur mobile');
        assert(s.tasks.every(t => t.box.h >= 44), `cibles < 44 px : ${s.tasks.map(t => t.box.h).join(',')}`);
        assert(await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'débordement horizontal');
        await shot(m, 'requests-panel-mobile');
        await m.click(`#side-panel .rq-task[data-run="${FX.REQ_RUN}"][data-n="3"]`);
        assert(await until(async () => (await rqOv(m)).open, 3000), 'détail non ouvert sur mobile');
        const close = await m.locator('#requests-overlay .rqo-close').boundingBox();
        assert(close.height >= 44 && close.width >= 44, `✕ : ${close.width}×${close.height}`);
        await m.click('#requests-overlay .rqo-close');
        assert(await until(async () => !(await rqOv(m)).open, 3000), 'fenêtre non fermée');
      } finally {
        FX.removeRequestFixture({ logsDir, chefDir });
        await m.evaluate(() => { window.RequestsPanel?.closeDetail?.(); if (window.SidePanel?.isOpen()) window.SidePanel.close(); });
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
    await check(B, 'kg-tab-mobile', 'Onglet « 🧠 Mémoire » (mobile 390 px) : panneau plein écran, revue lisible, boutons ≥ 44 px, validation possible, fenêtre de la source plein écran, aucun débordement', async () => {
      const fxFile = path.join(sb.root, 'tests', 'kg-fixture.mjs');
      if (!fs.existsSync(fxFile)) NA('onglet Mémoire absent de cet état du code');
      const FX = await import(pathToFileURL(fxFile).href);
      const fx = await FX.seedKg(sb.root);
      if (!fx) NA('onglet Mémoire absent de cet état du code');
      try {
        fx.ui(true);
        await setHash(m, '#/');
        assert(await until(async () => (await kgState(m)).pill, 15_000), 'onglet Mémoire non annoncé (kg.ui on)');
        assert(await until(async () => visible(m, '#sp-edge'), 6000), 'onglet du bord absent');
        await m.click('#sp-edge');
        await m.click('#side-panel [data-sp-tab="kg"]');
        assert(await until(async () => { const s = await kgState(m); return s.open && s.facts === 2; }, 10_000), `revue mobile : ${JSON.stringify(await kgState(m))}`);
        const minH = await m.$$eval('#side-panel .kg-item .kg-btn, #side-panel .kg-tab', bs => Math.min(...bs.filter(b => b.offsetParent).map(b => b.getBoundingClientRect().height)));
        assert(minH >= 44, `bouton de ${minH}px`);
        assert(await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'débordement horizontal');
        await shot(m, 'kg-tab-mobile');
        await m.click('#side-panel .kg-item[data-kind="fact"] .kg-act[data-action="validate"]');
        assert(await until(async () => (await kgState(m)).facts === 1, 8000), 'validation mobile sans effet');
        await m.click('#side-panel .kg-item[data-kind="conflict"] .kg-open-src');
        assert(await until(async () => visible(m, '#kg-source-overlay .kgo-hit'), 6000), 'fenêtre de la source absente');
        const box = await m.locator('#kg-source-overlay .kgo-box').boundingBox();
        assert(box && box.width >= 389, `fenêtre de ${box && box.width}px`);
        await m.click('#kg-source-overlay .kgo-close');
        return `plein écran, ${minH}px min., validation et source`;
      } finally {
        FX.clearKg(fx);
        await m.evaluate(() => { window.KgPanel?.closeSource(); if (window.SidePanel?.isOpen()) window.SidePanel.close(); });
        await until(async () => !(await kgState(m)).pill, 15_000);
      }
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
      assert(await until(async () => [14, 16, 17, 18].includes(await m.locator('#models .mr-tab').count()), 10_000), 'onglets');
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
      assert(await until(async () => [14, 16, 17, 18].includes(await m.locator('#models .mr-tab').count()) && (await m.locator('#models .mr-panel .mr-card').count()) > 0, 10_000), 'onglets ou cartes');
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

    // 0.48.0 — pipelines, phase 3 : la frise d'une exécution dans le journal.
    await check(B, 'run-timeline', 'Pipeline : frise des étapes dans le journal (model de chaque case, ✓ critère vérifié, ✕ refus motivé, ⚠ défaut du projet, ⏸ limite), un seul tour', async () => {
      const js = await (await fetch(`${sb.url}/activite.js`, { headers: H })).text();
      if (!/jt-pipeline/.test(js)) NA('frise absente de cet état du code');
      const run = 'p-20261009T120000-f1a2b3';
      const steps = [
        { id: 'rouge', title: '4a Rouge', slot: 'dev.rouge', model: 'claude-opus-5-5', provider: 'claude', source: 'pipeline' },
        { id: 'vert', title: '4b Vert', slot: 'dev.vert', model: 'claude-sonnet-5-5', provider: 'claude', source: 'pipeline' },
        { id: 'revue', title: '5 Revue', slot: 'dev.revue.code', model: null, provider: null, source: 'project-default' },
      ];
      const done = (k, id, model, status, extra = {}) => ({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: id, key: k }, model, served: model, modelSource: model ? 'pipeline' : 'project-default', status, durationMs: 42_000, ...extra });
      appendLog('zeta', [
        { type: 'user_prompt', text: 'Ajoute une fonction double', pipeline: { run, pipeline: 'dev', mode: 'leger', kind: 'simple', steps } },
        { type: 'system', subtype: 'pipeline_warning', pipeline: { run, step: 'revue' }, text: '⚠ 5 Revue : aucune case affectée (dev.revue.code) — défaut du projet' },
        done('01-rouge', 'rouge', 'claude-opus-5-5', 'ok'),
        done('02-vert', 'vert', 'claude-sonnet-5-5', 'refused', { why: 'fichiers de test modifiés (interdit à cette étape) : test/pipe.test.mjs', pipeline: { run, step: 'vert', key: '02-vert', attempt: 1 } }),
        done('03-vert', 'vert', 'claude-sonnet-5-5', 'ok', { pipeline: { run, step: 'vert', key: '03-vert', attempt: 2 } }),
        { type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: 'revue' }, limit: 'review', value: 2, text: '⏸ Limite atteinte — zeta · Développement léger · 5 Revue : 2 tours de revue' },
        { type: 'system', subtype: 'pipeline_summary', pipeline: { run, status: 'paused' }, totalMs: 300_000 },
        { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: '⏸ Limite atteinte\n\nNEEDS_USER_INPUT: Que faire ?' }] } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 300_000, duration_api_ms: 200_000, result: '⏸ Limite atteinte\n\nNEEDS_USER_INPUT: Que faire ?' },
      ]);
      const rctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
      const rp = await rctx.newPage();
      wire(rp);
      try {
        await rp.goto(`${sb.url}/?token=${sb.token}#/m/zeta`);
        await rp.locator('.brand').waitFor();
        const box = await until(async () => (await rp.locator(`#dive .jt-pipeline[data-run="${run}"]`).count()) ? true : null, 10_000);
        assert(box, 'frise absente du journal');
        const txt = await rp.textContent(`#dive .jt-pipeline[data-run="${run}"]`);
        for (const want of ['Développement léger', 'opus-5-5', 'sonnet-5-5', 'fichiers de test modifiés', 'essai 2', 'Limite atteinte']) assert(txt.includes(want), `frise sans « ${want} » : ${txt.slice(0, 400)}`);
        assert(await rp.locator(`#dive .jt-pipeline[data-run="${run}"] .jt-step[data-step-status="refused"]`).count() === 1, 'refus non marqué');
        assert(/défaut du projet/.test(txt), 'avertissement « défaut du projet » absent');
        assert(await rp.locator('#dive .jt-pipeline').count() === 1, 'l’exécution doit rester UN tour');
        await shot(rp, 'pipeline-frise');
      } finally { await rctx.close(); }
      return 'frise rendue : 3 étapes, refus motivé, défaut du projet, limite';
    });

    // 0.49.0 — phase 4 : la frise du Développement complet (items, 4c sautée, montée).
    await check(B, 'run-tdd-timeline', 'Pipeline complet : frise avec l’item traité par chaque 4a/4b/4c, « ↷ sautée », items cochés, montée léger → complet annoncée', async () => {
      const js = await (await fetch(`${sb.url}/activite.js`, { headers: H })).text();
      if (!/jt-escalate/.test(js)) NA('Développement complet absent de cet état du code');
      const run = 'p-20261009T130000-c0ffee';
      const st = (k, id, item, extra = {}) => ({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: id, key: k, item }, model: 'claude-sonnet-5-5', served: 'claude-sonnet-5-5', modelSource: 'pipeline', status: 'ok', durationMs: 20_000, ...extra });
      appendLog('zeta', [
        { type: 'user_prompt', text: 'Ajoute une fonction double', pipeline: { run, pipeline: 'dev', mode: 'leger', kind: 'simple', steps: [{ id: 'rouge', title: '4a Rouge' }, { id: 'vert', title: '4b Vert' }, { id: 'refactor', title: '4c Refactor', loop: true }, { id: 'revue', title: '5 Revue' }] } },
        st('01-rouge', 'rouge', undefined), st('02-vert', 'vert', undefined),
        { type: 'system', subtype: 'pipeline_escalate', pipeline: { run, from: 'leger', to: 'complet' }, text: '⇧ périmètre dépassé (5 fichiers) : l’exécution monte en Développement complet' },
        st('03-liste-tests', 'liste-tests', undefined),
        st('04-rouge', 'rouge', 2), st('05-vert', 'vert', 2),
        { ...st('06-refactor', 'refactor', 2), status: 'skipped', why: '4b n’a changé que 1 ligne(s) (seuil 10)' },
        { type: 'system', subtype: 'pipeline_item_done', pipeline: { run, item: 2 }, text: '✓ item 2 coché' },
        { type: 'system', subtype: 'pipeline_summary', pipeline: { run, status: 'done' }, totalMs: 200_000 },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 6, duration_ms: 200_000, duration_api_ms: 150_000, result: '✓ zeta — pipeline Développement complet terminé.' },
      ]);
      const rctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
      const rp = await rctx.newPage();
      wire(rp);
      try {
        await rp.goto(`${sb.url}/?token=${sb.token}#/m/zeta`);
        await rp.locator('.brand').waitFor();
        const sel = `#dive .jt-pipeline[data-run="${run}"]`;
        assert(await until(async () => (await rp.locator(sel).count()) ? true : null, 10_000), 'frise absente');
        const txt = await rp.textContent(sel);
        for (const want of ['Développement complet', 'monte en Développement complet', 'item 2', '↷ sautée', '1 item(s) cochés']) assert(txt.includes(want), `frise sans « ${want} » : ${txt.slice(0, 400)}`);
        assert(await rp.locator(`${sel} .jt-step[data-step-status="skipped"]`).count() === 1, '4c sautée non marquée');
        await shot(rp, 'pipeline-frise-complet');
      } finally { await rctx.close(); }
      return 'frise complète : items, 4c sautée, montée annoncée';
    });

    // 0.51.0 — langue de discussion : réglage, badge « ⚠ langue », table des models.
    {
      const lctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
      const lp = await lctx.newPage();
      wire(lp);
      const hasLang = async () => (await (await fetch(`${sb.url}/api/language`, { headers: H })).status) === 200;
      await check(B, 'lang-settings', 'Langue de discussion : réglage global et exception par projet dans le panneau ⚙, enregistrés côté serveur', async () => {
        if (!(await hasLang())) NA('réglage de langue absent de cet état du code');
        await lp.goto(`${sb.url}/?token=${sb.token}`);
        await lp.locator('.brand').waitFor();
        await lp.click('#btn-tweaks');
        assert(await until(async () => (await lp.locator('#lang-default option').count()) >= 2, 8000), 'menu des langues absent');
        assert(await lp.inputValue('#lang-default') === 'fr', 'langue par défaut ≠ français');
        await lp.selectOption('#lang-default', 'en');
        assert(await until(async () => (await api('/api/language')).default === 'en', 5000), 'langue globale non enregistrée');
        await lp.selectOption('#lang-settings .lang-add-project', 'omega');
        await lp.selectOption('#lang-settings .lang-add-lang', 'es');
        await lp.click('#lang-settings .lang-add-btn');
        assert(await until(async () => (await api('/api/language')).projects.omega === 'es', 5000), 'exception de projet non enregistrée');
        assert(await until(async () => (await lp.locator('#lang-settings [data-lang-project="omega"]').count()) === 1, 3000), 'exception non affichée');
        await shot(lp, 'langue-reglage');
        await lp.click('#lang-settings [data-lang-del="omega"]');
        await lp.selectOption('#lang-default', 'fr');
        assert(await until(async () => { const v = await api('/api/language'); return v.default === 'fr' && !v.projects.omega; }, 5000), 'retour au français impossible');
        await lp.click('#btn-tweaks');
        return 'fr → en → fr, exception omega → es puis retirée';
      });
      await check(B, 'lang-badge', 'Réponse du chef reformulée : badge « ⚠ langue » et « voir l’original », en direct et au rechargement', async () => {
        if (!(await hasLang())) NA('langue de discussion absente de cet état du code');
        const orig = 'I am waiting for the two background runs to finish, then I will commit everything to the main branch.';
        const fixed = 'J’attends la fin des deux exécutions en arrière-plan, puis je commiterai tout sur la branche principale.';
        appendLog('chef', [
          { type: 'user_prompt', text: 'Où en es-tu ? (recette langue)' },
          { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
          { type: 'assistant', message: { content: [{ type: 'text', text: orig }] } },
          { type: 'system', subtype: 'language_mismatch', lang: { target: 'fr', detected: 'en', reason: 'mismatch', reformulated: true, by: 'claude-haiku-5-5' }, text: '⚠ langue' },
          { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: fixed }] }, lang: { target: 'fr', detected: 'en', reason: 'mismatch', reformulated: true, by: 'claude-haiku-5-5', original: orig } },
          { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 2000, duration_api_ms: 1500, result: fixed, lang: { target: 'fr', detected: 'en', reformulated: true } },
        ]);
        await lp.goto(`${sb.url}/?token=${sb.token}`);
        await lp.locator('.brand').waitFor();
        const bubble = lp.locator('#cv-scroll .cv-bubble.is-conductor', { hasText: 'J’attends la fin des deux exécutions' }).last();
        assert(await until(async () => (await bubble.count()) > 0, 10_000), 'bulle reformulée absente');
        assert(await bubble.locator('.cv-langtag').count() === 1, 'badge « ⚠ langue » absent');
        assert(!(await bubble.locator('.cv-body').textContent()).includes('I am waiting'), 'le texte affiché doit être la version reformulée');
        await bubble.locator('.cv-lang-orig summary').click();
        assert((await bubble.locator('.cv-lang-orig').textContent()).includes('I am waiting'), 'original non consultable');
        await shot(lp, 'langue-badge');
        return 'badge + original au rechargement';
      });
      await check(B, 'models-langs', 'Page Models : table « models × langues fiables » éditable (valeurs prudentes, case cochée enregistrée)', async () => {
        if (!(await hasLang())) NA('table des langues absente de cet état du code');
        fs.writeFileSync(path.join(sb.root, 'model-routing.json'), JSON.stringify({ version: 2, assignments: { 'dev.vert': { provider: 'nvidia', model: 'nvidia/nemotron-mini-4b' }, 'dev.rouge': { provider: 'anthropic', model: 'claude-opus-5-5' } }, history: [] }));
        await lp.goto(`${sb.url}/?token=${sb.token}#/models`);
        await lp.locator('.mr-langs-btn').waitFor();
        await lp.click('.mr-langs-btn');
        const row = lp.locator('[data-ml-row="nvidia/nemotron-mini-4b"]');
        assert(await until(async () => (await row.count()) === 1, 8000), 'model absent de la table');
        assert(await row.locator('[data-ml-lang="fr"]').isChecked() === false && await row.locator('[data-ml-lang="en"]').isChecked(), 'model inconnu : anglais seulement attendu');
        assert(await lp.locator('[data-ml-row="claude-opus-5-5"] [data-ml-lang="fr"]').isChecked(), 'Claude : français attendu');
        await row.locator('[data-ml-lang="fr"]').check();
        assert(await until(async () => (await api('/api/model-languages')).models.find(m => m.model === 'nvidia/nemotron-mini-4b')?.langs.includes('fr'), 5000), 'case cochée non enregistrée');
        assert(await row.locator('[data-ml-test]').count() === 1, 'bouton « Tester la langue » absent');
        await shot(lp, 'models-langues');
        await fetch(`${sb.url}/api/model-languages/${encodeURIComponent('nvidia/nemotron-mini-4b')}`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ langs: null }) });
        fs.rmSync(path.join(sb.root, 'model-routing.json'), { force: true });
        return 'nemotron : en → en+fr ; Claude : toutes langues';
      });
      // 0.56.0 — phase 7 : relevé de la mise en service visible dans le dashboard (page Models).
      await check(B, 'health-view', 'Page Models : « 📈 Mise en service » — relevé par jour et par projet, jours sans contournement, critère des 7 jours', async () => {
        await lp.goto(`${sb.url}/?token=${sb.token}#/models`);
        await lp.locator('.mr-back').waitFor();
        if (!(await lp.locator('.mr-health-btn').count())) NA('relevé absent de cet état du code');
        fs.writeFileSync(path.join(sb.root, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, history: [], enforcement: { projects: ['omega'], pipelines: ['discussion', 'dev'], generalSince: new Date(Date.now() - 2 * 86400_000).toISOString() } }));
        try {
          await lp.click('.mr-health-btn');
          assert(await until(async () => (await lp.locator('.mr-health [data-health-streak]').count()) === 1, 8000), 'résumé du relevé absent');
          assert(await lp.getAttribute('.mr-health-btn', 'aria-expanded') === 'true', 'aria-expanded');
          assert(await lp.locator('.mr-health .mr-health-days').count() === 1 && await lp.locator('.mr-health .mr-health-projects').count() === 1, 'tableaux par jour / par projet absents');
          assert(/critère/.test(await lp.textContent('.mr-health [data-health-summary]')), 'critère non affiché');
          await shot(lp, 'mise-en-service');
          await lp.click('.mr-health-btn');
          return `relevé affiché : ${(await lp.textContent('.mr-health [data-health-summary]')).replace(/\s+/g, ' ').trim().slice(0, 120)}`;
        } finally { fs.rmSync(path.join(sb.root, 'model-routing.json'), { force: true }); }
      });
      // 0.52.0 — pipelines, phase 5 : le composer choisit le pipeline (demande du 2026-10-09).
      await check(B, 'composer-pipeline', 'Composer : sélecteur de pipeline (auto, Discussion, Dév. léger, Dév. complet, Réunion) — le choix part avec la demande, puis revient à « auto » ; utilisable sur mobile', async () => {
        if (!(await lp.goto(`${sb.url}/?token=${sb.token}`).then(() => lp.locator('#composer-pipeline').count()))) NA('sélecteur absent de cet état du code');
        await lp.locator('.brand').waitFor();
        const sent = [];
        await lp.route('**/api/dispatch', async (route) => {
          sent.push(JSON.parse(route.request().postData() || '{}'));
          await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, project: 'chef', ticket: null }) });
        });
        try {
          const opts = await lp.locator('#composer-pipeline option').evaluateAll(os => os.map(o => o.value));
          assert(opts.join() === 'auto,discussion,dev:leger,dev:complet,reunion', `options : ${opts}`);
          assert(await lp.getAttribute('#composer-pipeline', 'aria-label'), 'aria-label absent');
          await lp.selectOption('#composer-pipeline', 'dev:complet');
          await lp.fill('#composer-input', 'ajoute une page de statistiques (recette sélecteur)');
          await lp.press('#composer-input', 'Enter');
          assert(await until(async () => sent.length > 0, 5000), 'aucun envoi');
          assert(sent[0].pipeline === 'dev' && sent[0].pipelineMode === 'complet' && sent[0].project === 'chef', `charge envoyée : ${JSON.stringify(sent[0])}`);
          assert(await lp.inputValue('#composer-pipeline') === 'auto', 'le sélecteur doit revenir à « auto »');
          await lp.fill('#composer-input', 'pourquoi ? (recette sélecteur auto)');
          await lp.press('#composer-input', 'Enter');
          assert(await until(async () => sent.length > 1, 5000) && !('pipeline' in sent[1]), `« auto » ne doit rien imposer : ${JSON.stringify(sent[1])}`);
          await lp.setViewportSize({ width: 390, height: 844 });
          const sel = await lp.locator('#composer-pipeline').boundingBox();
          const ta = await lp.locator('#composer-input').boundingBox();
          assert(sel && sel.height >= 40 && ta && ta.width >= 120 && sel.x + sel.width <= 390, `mobile : sélecteur ${JSON.stringify(sel)}, saisie ${JSON.stringify(ta)}`);
          await shot(lp, 'composer-pipeline-mobile');
          return `dev/complet envoyé puis retour à auto ; mobile : sélecteur ${Math.round(sel.height)} px, saisie ${Math.round(ta.width)} px`;
        } finally {
          await lp.unroute('**/api/dispatch');
          await lp.setViewportSize({ width: 1600, height: 1000 });
        }
      });
      await lctx.close();
    }

    await check(B, 'js-errors', 'Aucune erreur JavaScript non interceptée pendant les parcours', async () => {
      assert(!pageErrors.length, pageErrors.slice(0, 3).join(' | '));
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
