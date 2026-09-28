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
    await check(B, 'rail', 'Rail PILOTAGE : groupes En cours / À examiner, dépliage « Tous »', async () => {
      const txt = await page.textContent('#rail-body');
      assert(/En cours/.test(txt) && /À examiner/.test(txt), 'groupes absents');
      assert(await page.locator('.rail-row[data-name="eps"][data-state="live"]').count() >= 1, 'eps pas en cours');
      assert(await page.locator('.rail-row[data-name="gamma"][data-state="error"]').count() >= 1, 'gamma pas à examiner');
      await page.click('[data-fold="all"]');
      assert(await page.locator('.rail-row[data-name="kappa"]').count() >= 1, '« Tous les musiciens » ne se déplie pas');
      await page.click('[data-fold="all"]');
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
      await page.click('.rail-row[data-name="alpha"]');
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
      await page.fill('#overlay-search .psr-input', 'gam');
      await page.keyboard.press('Enter');
      assert(await until(async () => (await hash(page)) === '#/m/gamma' && await visible(page, '#dive'), 5000), 'volet gamma');
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
      for (const want of ['eps', 'Bash', 'rm -rf build && git push origin main', 'déjà dans ses outils']) assert(t.includes(want), `panneau sans « ${want} » : ${t}`);
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
      for (const n of ['alpha', 'lambda', 'beta', 'mu']) assert(g.rest.includes(n), `${n} pas au Repos`);
      assert(g.parked.length === 1 && g.parked[0] === 'zeta', `parqués : ${g.parked}`);
      return JSON.stringify(g);
    });
    await pv('tiles', 'tuiles : sorte, mot d\'état visible, badges, chips, aria-label', async () => {
      const k = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.pv-tile')].map(b => [b.dataset.name, {
        kind: b.dataset.kind, word: b.querySelector('.pv-word')?.textContent || '', aria: b.getAttribute('aria-label') || '', text: b.textContent }])));
      // alpha : son volet a été ouvert plus haut ⇒ marqué lu ⇒ « Prêt ».
      const want = { iota: 'dead', theta: 'stall', gamma: 'error', eta: 'question', eps: 'live', delta: 'chef', zeta: 'parked', alpha: 'idle', lambda: 'idle' };
      for (const [n, kind] of Object.entries(want)) assert(k[n]?.kind === kind, `${n} : ${k[n]?.kind} ≠ ${kind}`);
      for (const [n, x] of Object.entries(k)) assert(x.word.trim() && x.aria.startsWith(n), `${n} sans mot ou aria-label`);
      assert(/PARQUÉ/.test(k.eta.text), 'badge PARQUÉ sur eta');
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
      assert(hid.sort().join() === 'active,parked,rest', `masqués : ${hid}`);
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
    await ctx.close();

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
