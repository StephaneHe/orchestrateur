#!/usr/bin/env node
// ============================================================================
// scripts/_test_network_guard.mjs — loopback + Tailscale only, LAN refused
// ============================================================================
//
// User decision (2026-10-09): "Protection puis redémarrage" — before restarting
// the server, access must really be limited to localhost + Tailscale, the home
// LAN (10.0.0.x) refused, with no portproxy.
//
// 1. the rule itself (deterministic addresses, IPv4/IPv6/mapped forms);
// 2. REAL connections from this machine's own interfaces: a request whose
//    source is the LAN address gets 403, loopback and the Tailscale address
//    get 200 (skipped, and said so, when an interface is absent);
// 3. server.js wiring: the guard is the first middleware and runs on the
//    WebSocket upgrade, whatever the token gate says.
//
//   node scripts/_test_network_guard.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createNetworkGuard, ipInCidr, allowedCidrs, normalizeAddr, DEFAULT_ALLOWED_CIDRS } from './network-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. La règle : boucle locale et Tailscale servis, tout le reste refusé');
{
  const g = createNetworkGuard({ env: {} });
  const yes = ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '100.113.178.120', '100.64.0.1', '100.127.255.254', '::ffff:100.101.1.2', 'fd7a:115c:a1e0::1234', 'FD7A:115C:A1E0:AB12::1'];
  const no = ['10.0.0.12', '10.0.0.1', '::ffff:10.0.0.12', '192.168.1.20', '172.16.4.5', '100.63.255.255', '100.128.0.1', '8.8.8.8', 'fe80::1', 'fd00::1', '2001:db8::1', '', null, 'n/a'];
  const badYes = yes.filter(a => !g.isAllowed(a));
  const badNo = no.filter(a => g.isAllowed(a));
  ok(!badYes.length, `servis : boucle locale, Tailscale IPv4 (100.64.0.0/10) et IPv6 (fd7a:115c:a1e0::/48)${badYes.length ? ` — refusés à tort : ${badYes}` : ''}`);
  ok(!badNo.length, `refusés : LAN 10.0.0.x, 192.168.x, 172.16.x, hors plage Tailscale, Internet, lien local, adresse vide${badNo.length ? ` — acceptés à tort : ${badNo}` : ''}`);
  ok(normalizeAddr('::ffff:10.0.0.12') === '10.0.0.12' && normalizeAddr('[::1]') === '::1' && normalizeAddr('fe80::1%12') === 'fe80::1', 'formes d’adresse normalisées (IPv4 mappée, crochets, zone)');
  ok(ipInCidr('100.64.0.0', '100.64.0.0/10') && !ipInCidr('100.128.0.0', '100.64.0.0/10'), 'bornes de 100.64.0.0/10');
  ok(allowedCidrs({ ORCH_ALLOW_CIDRS: '10.0.0.0/24, pas-un-cidr' }).join() === [...DEFAULT_ALLOWED_CIDRS, '10.0.0.0/24'].join(), 'ORCH_ALLOW_CIDRS élargit seulement (CIDR invalide ignoré), sans retirer les plages par défaut');
  ok(createNetworkGuard({ env: { ORCH_ALLOW_CIDRS: '10.0.0.0/24' } }).isAllowed('10.0.0.12') && !createNetworkGuard({ env: {} }).isAllowed('10.0.0.12'), 'LAN servi seulement si on l’ajoute explicitement');

  const logs = [];
  const g2 = createNetworkGuard({ env: {}, log: (m) => logs.push(m) });
  const fake = (addr) => { const res = { code: 200, status(c) { this.code = c; return this; }, type() { return this; }, end(b) { this.body = b; } }; let nexted = false; g2.middleware({ socket: { remoteAddress: addr }, method: 'GET', path: '/api/config' }, res, () => { nexted = true; }); return { ...res, nexted }; };
  const lan = fake('::ffff:10.0.0.12'), loop = fake('127.0.0.1'), ts = fake('100.113.178.120');
  ok(lan.code === 403 && !lan.nexted && /loopback and Tailscale/.test(lan.body), 'middleware : IP LAN → 403, aucune route atteinte');
  ok(loop.nexted && ts.nexted, 'middleware : boucle locale et Tailscale passent');
  fake('10.0.0.12');
  ok(logs.length === 1 && /refusé : 10\.0\.0\.12/.test(logs[0]), 'refus journalisé une seule fois par adresse');
  ok(g2.verifyUpgrade({ socket: { remoteAddress: '10.0.0.12' } }) === false && g2.verifyUpgrade({ socket: { remoteAddress: '100.101.1.2' } }) === true && g2.verifyUpgrade({ socket: { remoteAddress: '::1' } }) === true, 'WebSocket : LAN refusé, Tailscale et boucle locale acceptés');
}

// ---------------------------------------------------------------------------
section('2. Vraies connexions depuis les interfaces de cette machine');
{
  const app = express();
  const guard = createNetworkGuard({ env: {} });
  app.use(guard.middleware);
  app.get('/ping', (req, res) => res.json({ ok: true }));
  const srv = await new Promise(r => { const s = app.listen(0, '0.0.0.0', () => r(s)); });
  const port = srv.address().port;
  const get = (host) => new Promise((resolve) => {
    const req = http.request({ host, port, path: '/ping', localAddress: host === '127.0.0.1' ? undefined : host, timeout: 4000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (e) => resolve(`erreur ${e.code}`));
    req.on('timeout', () => { req.destroy(); resolve('délai'); });
    req.end();
  });
  const v4 = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  const lanIp = v4.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  const tsIp = v4.find(a => ipInCidr(a, '100.64.0.0/10'));
  ok(await get('127.0.0.1') === 200, 'boucle locale (127.0.0.1) → 200');
  if (lanIp) { const s = await get(lanIp); ok(s === 403, `IP LAN de cette machine (${lanIp}) → 403 (obtenu ${s})`); }
  else console.log('  — pas d’interface LAN sur cette machine : connexion LAN réelle non testée (règle couverte en 1)');
  if (tsIp) { const s = await get(tsIp); ok(s === 200, `IP Tailscale de cette machine (${tsIp}) → 200 (obtenu ${s})`); }
  else console.log('  — pas d’interface Tailscale sur cette machine : connexion Tailscale réelle non testée (règle couverte en 1)');
  await new Promise(r => srv.close(r));
}

// ---------------------------------------------------------------------------
section('3. server.js : premier middleware, et aussi sur la montée WebSocket');
{
  const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const appAt = SRC.indexOf('const app = express();');
  const useAt = SRC.indexOf('app.use(networkGuard.middleware);');
  const firstRoute = SRC.slice(appAt).search(/\napp\.(get|post|put|delete|use|ws)\((?!networkGuard)|\nmount\w+Routes\(app/);
  ok(useAt > appAt && useAt < appAt + firstRoute, 'app.use(networkGuard.middleware) avant toute route');
  ok(!/^\s*\/\/\s*app\.use\(\(req, res, next\) => \{\s*$/m.test(SRC), 'l’ancienne allowlist commentée n’est plus le seul garde-fou (code mort retiré)');
  const ws = SRC.slice(SRC.indexOf('function wsVerifyClient('), SRC.indexOf('function wsVerifyClient(') + 400);
  ok(ws.indexOf('networkGuard.verifyUpgrade(info.req)') >= 0 && ws.indexOf('networkGuard.verifyUpgrade') < ws.indexOf('if (!TOKEN_GATE_ENABLED) return true'), 'WebSocket : contrôle réseau AVANT le court-circuit du token gate coupé');
  ok(/httpServer\.listen\(PORT, '0\.0\.0\.0'/.test(SRC) && !/portproxy/i.test(SRC.replace(/\/\/.*$/gm, '')), 'aucun portproxy ; le bind reste 0.0.0.0, filtré par la règle');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
