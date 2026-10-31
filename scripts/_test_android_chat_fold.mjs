#!/usr/bin/env node
// User request (2026-10-31): « app Orchestrateur: je ne veux pas voir les messages
// techniques entre musiciens et le chef. uniquement les dialogues entre moi et chef
// doivent être ouverts. les autres doivent être collapse ». Android only: the chef
// thread folds relays, alerts, pause notices, [REPRISE] and the chef's [ANSWER]
// replies on one line. Static check, no Gradle: the pure rule lives in
// android/.../ui/fleet/ChatFold.kt, its behaviour on real chef-log messages is
// covered by the JVM test ChatFoldRuleTest (testDebugUnitTest).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };

const A = 'android/app/src/main/java/com/orchestrateur/ui/fleet/';
const rule = read(A + 'ChatFold.kt');
const vm = read(A + 'FleetViewModel.kt');
const pane = read(A + 'MainPane.kt');
const jvm = read('android/app/src/test/java/com/orchestrateur/ui/fleet/ChatFoldRuleTest.kt');

ok(/object ChatFoldRule/.test(rule) && /fun forUser\(text: String, source: String\?/.test(rule) && /fun forConductor\(text: String\)/.test(rule),
  'ChatFoldRule classifies a received message (text, source) and a chef reply');
ok(/SOURCE_TYPES\[source\]/.test(rule) && rule.indexOf('source != null') < rule.indexOf('NEEDS_CHEF_RE.find'),
  'the server source decides first, the protocol prefixes only without it');
for (const p of ['NEEDS_CHEF_INPUT_FROM', 'CALLBACK_WAKE', 'ALERTE', 'Ta réponse à la pause', 'REPRISE', 'ANSWER']) {
  ok(rule.includes(p), `prefix ${p} is recognised`);
}
ok(/val fold: ChatFold\? = null/.test(vm), 'ChatMsg carries the fold');
ok((vm.match(/ChatFoldRule\.forUser\(txt\)/g) || []).length >= 2, 'user bubbles get their fold live and from the history');
ok((vm.match(/ChatFoldRule\.forConductor\(txt\)/g) || []).length >= 2, 'chef bubbles get their fold live and from the history');
ok(/if \(fold != null && !expanded\) \{ FoldedLine\(/.test(pane) && /private fun FoldedLine\(/.test(pane),
  'a technical message is rendered folded on one line, expanded on tap');
ok(/clickable \{ expanded = false \}/.test(pane), 'an expanded technical message folds back from its label');
ok(/it\.role == ChatMsg\.Role\.conductor && it\.fold == null/.test(pane), 'auto-read never speaks a folded [ANSWER] reply');

ok(/fun userTypedMessagesStayOpen/.test(jvm) && /fun onlyAnswerRepliesOfTheChefFold/.test(jvm) && /fun relayFromMusicianFolds/.test(jvm),
  'JVM test ChatFoldRuleTest covers user messages, relays and [ANSWER] replies');
ok(jvm.includes('[NEEDS_CHEF_INPUT_FROM:projetA] Le musicien « projetA » te demande une décision') && jvm.includes('[ALERTE n=1]\\nLe serveur signale'),
  'JVM test replays real chef-log messages');

// App 1.3.1 — « cette partie devrait être collapse. Elle apparaît ouverte » : the
// « RÉSULTAT REÇU » card of a musician awaiting the chef folds too.
const rjvm = read('android/app/src/test/java/com/orchestrateur/ui/fleet/ResultFoldRuleTest.kt');
ok(/fun resultFolded\(item: ResultItem\)/.test(rule), 'ChatFoldRule.resultFolded classifies a result card');
ok(/val foldable = ChatFoldRule\.resultFolded\(item\)/.test(pane) && /mutableStateOf\(!foldable\)/.test(pane),
  'ResultCard starts folded for a musician → chef card, expanded on tap');
ok(/fun needsChefInputCardIsFoldedByDefault/.test(rjvm) && /fun ordinaryResultsStayOpen/.test(rjvm) && rjvm.includes('pause de PROCESSUS'),
  'JVM test ResultFoldRuleTest covers NEEDS_CHEF_INPUT / process-pause cards and ordinary results');
const row131 = read('docs/USER_REQUIREMENTS.md').split('\n').find(l => l.startsWith('| 2026-10-31') && l.includes('cette partie devrait être collapse. Elle apparaît ouverte'));
ok(!!row131 && row131.includes('suite:_test_android_chat_fold.mjs'), 'USER_REQUIREMENTS.md traces the 1.3.1 request verbatim');

const gradle = read('android/app/build.gradle.kts');
const vc = Number((gradle.match(/versionCode = (\d+)/) || [])[1]);
const vn = (gradle.match(/versionName = "([^"]+)"/) || [])[1] || '';
ok(vc >= 30 && /^1\.(\d+)\./.test(vn) && Number(vn.split('.')[1]) >= 3, `app version at least 1.3.0 / versionCode 30 (${vn} / ${vc})`);

const row = read('docs/USER_REQUIREMENTS.md').split('\n').find(l => l.startsWith('| 2026-10-31') && l.includes('je ne veux pas voir les messages techniques entre musiciens et le chef'));
ok(!!row && row.includes('suite:_test_android_chat_fold.mjs'), 'USER_REQUIREMENTS.md traces the request verbatim with suite:_test_android_chat_fold.mjs');

console.log(`\n${pass} ok, ${fail} ko`);
process.exit(fail ? 1 : 0);
