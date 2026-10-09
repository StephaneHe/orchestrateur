// ============================================================================
// scripts/network-guard.mjs — who may reach the dashboard (0.59.0)
// ============================================================================
//
// User decision (2026-10-09): "Protection puis redémarrage". The token gate is
// off since 2026-09-07 on the premise that the fleet is reached only over
// Tailscale, but the server binds 0.0.0.0 and the interface allowlist had been
// disabled (2026-05-13): anyone on the home LAN could drive every agent. This
// guard restores that premise: only loopback and Tailscale peers are served.
//
// The check is on the REMOTE address of each connection (HTTP and WebSocket
// upgrade alike): a LAN client connecting to the LAN interface has a LAN source
// address, a Tailscale peer a 100.64.0.0/10 (or fd7a:115c:a1e0::/48) one. No
// portproxy, no bind change: one rule, enforced before any route.
//
// Emergency widening only (never narrowing): ORCH_ALLOW_CIDRS="10.0.0.0/24,…".
// ============================================================================

export const DEFAULT_ALLOWED_CIDRS = Object.freeze([
  '127.0.0.0/8',          // loopback (dashboard on this PC, dispatch.mjs, notify.mjs)
  '::1/128',
  '100.64.0.0/10',        // Tailscale IPv4 (CGNAT range)
  'fd7a:115c:a1e0::/48',  // Tailscale IPv6
]);

export function normalizeAddr(addr) {
  if (!addr) return '';
  let a = String(addr).trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(a)) return a.slice(7);
  return a.toLowerCase();
}

function v4ToBig(ip) {
  const p = ip.split('.');
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((acc, x) => (acc << 8n) + BigInt(Number(x)), 0n);
}
function v6ToBig(ip) {
  if (!ip.includes(':')) return null;
  let s = ip;
  // Embedded IPv4 tail (::ffff:1.2.3.4 already normalised away; keep generic).
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const v4 = v4ToBig(m[1]);
    if (v4 == null) return null;
    s = s.slice(0, -m[1].length) + `${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
}

/** {family, base, bits} or null for an invalid CIDR. */
export function parseCidr(cidr) {
  const [ip, bitsTxt] = String(cidr || '').trim().split('/');
  const addr = normalizeAddr(ip);
  const v4 = v4ToBig(addr);
  const family = v4 != null ? 4 : 6;
  const val = v4 != null ? v4 : v6ToBig(addr);
  if (val == null) return null;
  const max = family === 4 ? 32 : 128;
  const bits = bitsTxt == null || bitsTxt === '' ? max : Number(bitsTxt);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { family, base: val & mask, mask };
}

export function ipInCidr(addr, cidr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!c) return false;
  const a = normalizeAddr(addr);
  const val = c.family === 4 ? v4ToBig(a) : v6ToBig(a);
  return val != null && (val & c.mask) === c.base;
}

/** Allowed ranges: the defaults plus ORCH_ALLOW_CIDRS (add-only). */
export function allowedCidrs(env = process.env) {
  const extra = String(env.ORCH_ALLOW_CIDRS || '').split(',').map(s => s.trim()).filter(Boolean).filter(c => parseCidr(c));
  return [...DEFAULT_ALLOWED_CIDRS, ...extra];
}

export function createNetworkGuard({ env = process.env, log = () => {} } = {}) {
  const cidrs = allowedCidrs(env).map(c => ({ text: c, parsed: parseCidr(c) }));
  const refusedOnce = new Set();
  const isAllowed = (addr) => cidrs.some(c => ipInCidr(addr, c.parsed));
  const noteRefusal = (addr, what) => {
    const a = normalizeAddr(addr);
    if (refusedOnce.has(a)) return;
    refusedOnce.add(a);
    log(`[network-guard] refusé : ${a || '?'} (${what}) — seuls la boucle locale et Tailscale sont servis`);
  };
  /** Express middleware: 403 for anything that is not loopback / Tailscale. */
  const middleware = (req, res, next) => {
    const addr = req.socket?.remoteAddress;
    if (isAllowed(addr)) return next();
    noteRefusal(addr, `${req.method} ${req.path}`);
    res.status(403).type('text/plain').end('Forbidden: only loopback and Tailscale clients are served');
  };
  /** WebSocket upgrade check (express-ws does not run the middleware chain). */
  const verifyUpgrade = (req) => {
    const addr = req?.socket?.remoteAddress;
    if (isAllowed(addr)) return true;
    noteRefusal(addr, 'websocket');
    return false;
  };
  return { isAllowed, middleware, verifyUpgrade, cidrs: cidrs.map(c => c.text) };
}
