// SSH/SFTP server for orchestrateur.
// Exposes I:\orchestrateur\builds\ as a read-only SFTP root on port 54782.
// Auth: Ed25519 public key only — keys stored in secrets/ssh_authorized_keys.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ssh2 is a CJS package; must import via default export in ESM context.
import ssh2pkg from 'ssh2';
const { Server, utils } = ssh2pkg;
const { STATUS_CODE } = utils.sftp;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SSH_PORT            = 54782;
const BUILDS_ROOT         = path.join(__dirname, 'builds');
const AUTHORIZED_KEYS     = path.join(__dirname, 'secrets', 'ssh_authorized_keys');
const HOST_KEY_PATH       = path.join(__dirname, 'secrets', 'ssh_host_ed25519_key');
const SSH_LOG             = path.join(__dirname, 'logs', 'ssh-auth.log');

function sshLog(...args) {
  const line = new Date().toISOString() + ' ' + args.join(' ') + '\n';
  console.log(...args);
  try { fs.appendFileSync(SSH_LOG, line); } catch {}
}

// ── Host key ─────────────────────────────────────────────────────────────────

function getOrCreateHostKey() {
  if (fs.existsSync(HOST_KEY_PATH)) return fs.readFileSync(HOST_KEY_PATH, 'utf8');
  const { private: priv } = utils.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(HOST_KEY_PATH), { recursive: true });
  fs.writeFileSync(HOST_KEY_PATH, priv, { mode: 0o600 });
  return priv;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function readAuthorizedKeys() {
  try {
    return fs.readFileSync(AUTHORIZED_KEYS, 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}

function isKeyAuthorized(keyDataBuf) {
  try {
    sshLog('[ssh-auth] key.data length:', keyDataBuf.length);
    sshLog('[ssh-auth] key.data base64:', keyDataBuf.toString('base64'));

    const incoming = utils.parseKey(keyDataBuf);
    if (!incoming || incoming instanceof Error) {
      sshLog('[ssh-auth] parseKey(incoming) ERROR:', incoming?.message || 'no result');
      return false;
    }
    sshLog('[ssh-auth] incoming type:', incoming.type);

    let incomingSsh;
    try {
      incomingSsh = incoming.getPublicSSH();
      sshLog('[ssh-auth] incoming getPublicSSH():', incomingSsh.toString('base64'));
    } catch (e) {
      sshLog('[ssh-auth] getPublicSSH(incoming) threw:', e.message);
      return false;
    }

    const lines = readAuthorizedKeys();
    sshLog('[ssh-auth] authorized_keys count:', lines.length);

    for (const line of lines) {
      sshLog('[ssh-auth] checking line:', line.substring(0, 80));
      try {
        const parsed = utils.parseKey(line);
        if (!parsed || parsed instanceof Error) {
          sshLog('[ssh-auth] parseKey(line) ERROR:', parsed?.message || 'no result');
          continue;
        }
        const storedSsh = parsed.getPublicSSH();
        sshLog('[ssh-auth] stored getPublicSSH():', storedSsh.toString('base64'));
        const match = storedSsh.equals(incomingSsh);
        sshLog('[ssh-auth] match:', match);
        if (match) return true;
      } catch (e) {
        sshLog('[ssh-auth] auth-key compare threw:', e.message, '— skipping line');
      }
    }

    sshLog('[ssh-auth] NO MATCH - rejecting');
    return false;
  } catch (e) {
    sshLog('[ssh-auth] isKeyAuthorized fatal:', e.message);
    return false;
  }
}

// ── Path resolution ───────────────────────────────────────────────────────────

// Maps an SFTP path to an absolute local path, confined to BUILDS_ROOT.
// Returns null if the path would escape the root.
function sftpToLocal(sftpPath) {
  const rel  = (sftpPath || '/').replace(/^\/+/, '');
  const local = path.resolve(BUILDS_ROOT, rel || '.');
  // Case-insensitive guard for Windows
  if (local.toLowerCase() !== BUILDS_ROOT.toLowerCase() &&
      !local.toLowerCase().startsWith(BUILDS_ROOT.toLowerCase() + path.sep)) {
    return null;
  }
  return local;
}

// ── SFTP session ──────────────────────────────────────────────────────────────

function statToAttrs(stat) {
  return {
    mode:  stat.mode,
    uid:   0,
    gid:   0,
    size:  stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function handleSftp(sftp, logger) {
  const handles   = new Map();
  let   nextId    = 0;

  function alloc(data) {
    const id  = nextId++;
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32BE(id, 0);
    handles.set(id, data);
    return buf;
  }
  function get(buf)  { return handles.get(buf.readUInt32BE(0)); }
  function free(buf) { handles.delete(buf.readUInt32BE(0)); }

  sftp.on('OPENDIR', (reqid, dirPath) => {
    const local = sftpToLocal(dirPath);
    if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    try {
      const entries = fs.readdirSync(local);
      sftp.handle(reqid, alloc({ type: 'dir', local, entries, index: 0 }));
    } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); }
  });

  sftp.on('READDIR', (reqid, handle) => {
    const h = get(handle);
    if (!h || h.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.index >= h.entries.length) return sftp.status(reqid, STATUS_CODE.EOF);
    const batch = h.entries.slice(h.index, h.index + 20);
    h.index += batch.length;
    const names = batch.map(name => {
      try {
        const stat = fs.statSync(path.join(h.local, name));
        const t    = stat.isDirectory() ? 'd' : '-';
        return {
          filename: name,
          longname: `${t}rw-r--r-- 1 orchestre orchestre ${stat.size} Jan  1  2024 ${name}`,
          attrs:    statToAttrs(stat),
        };
      } catch { return null; }
    }).filter(Boolean);
    sftp.name(reqid, names);
  });

  sftp.on('LSTAT', (reqid, filePath) => {
    const local = sftpToLocal(filePath);
    if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    try { sftp.attrs(reqid, statToAttrs(fs.lstatSync(local))); }
    catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); }
  });

  sftp.on('STAT', (reqid, filePath) => {
    const local = sftpToLocal(filePath);
    if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    try { sftp.attrs(reqid, statToAttrs(fs.statSync(local))); }
    catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); }
  });

  sftp.on('OPEN', (reqid, filename, flags) => {
    const local = sftpToLocal(filename);
    if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    // Reject any flag other than READ (0x01)
    if (flags & ~0x01) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    try {
      const fd = fs.openSync(local, 'r');
      sftp.handle(reqid, alloc({ type: 'file', fd }));
    } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); }
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = get(handle);
    if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    const buf = Buffer.allocUnsafe(length);
    try {
      const n = fs.readSync(h.fd, buf, 0, length, offset);
      if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.slice(0, n));
    } catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
  });

  sftp.on('CLOSE', (reqid, handle) => {
    const h = get(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.type === 'file') try { fs.closeSync(h.fd); } catch {}
    free(handle);
    sftp.status(reqid, STATUS_CODE.OK);
  });

  // Explicitly deny write operations
  for (const ev of ['WRITE', 'REMOVE', 'RENAME', 'MKDIR', 'RMDIR', 'SETSTAT', 'SYMLINK']) {
    sftp.on(ev, (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED));
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

export function startSshServer(logger = console) {
  fs.mkdirSync(BUILDS_ROOT, { recursive: true });
  const hostKey = getOrCreateHostKey();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // Log at TCP level (before SSH handshake) so we can distinguish
    // "TCP never arrives" from "SSH handshake fails".
    const remoteAddr = client._sock?.remoteAddress
      ?? client.socket?.remoteAddress
      ?? '?';
    const remotePort = client._sock?.remotePort
      ?? client.socket?.remotePort
      ?? '?';
    sshLog(`[ssh] TCP connection from ${remoteAddr}:${remotePort}`);

    client.on('authentication', (ctx) => {
      try {
        sshLog('[ssh-auth] method:', ctx.method, 'user:', ctx.username, 'algo:', ctx.key?.algo);
        if (ctx.method !== 'publickey') return ctx.reject(['publickey']);

        if (!isKeyAuthorized(ctx.key.data)) {
          sshLog('[ssh-auth] rejected unknown key (' + ctx.key.algo + ')');
          return ctx.reject();
        }

        if (ctx.signature) {
          let verified = false;
          try {
            const parsed = utils.parseKey(ctx.key.data);
            if (parsed && !(parsed instanceof Error)) {
              verified = parsed.verify(ctx.blob, ctx.signature, ctx.key.algo);
            }
          } catch (e) {
            logger.log(`[ssh] verify threw: ${e.message}`);
          }
          if (!verified) {
            logger.log('[ssh] signature verification failed');
            return ctx.reject();
          }
        }

        ctx.accept();
      } catch (e) {
        logger.log(`[ssh] authentication handler fatal: ${e.message}`);
        try { ctx.reject(); } catch {}
      }
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        let session;
        try { session = accept(); }
        catch (e) { logger.log(`[ssh] session accept threw: ${e.message}`); return; }
        if (!session) return;
        // Defense-in-depth: any error event on the session must not bubble
        // up to uncaughtException. ssh2's Session inherits EventEmitter;
        // unhandled 'error' on EE = throw.
        session.on('error', (err) => logger.log(`[ssh] session error: ${err.message}`));

        session.on('sftp', (accept) => {
          let sftp;
          try {
            sftp = accept();
            logger.log('[ssh] SFTP session opened');
          } catch (e) {
            logger.log(`[ssh] sftp accept threw: ${e.message}`);
            return;
          }
          if (!sftp) return;
          sftp.on('error', (err) => logger.log(`[ssh] sftp error: ${err.message}`));
          try { handleSftp(sftp, logger); }
          catch (e) { logger.log(`[ssh] handleSftp threw: ${e.message}`); }
        });

        // Deny shell and exec
        session.on('shell', (_accept, reject) => { try { reject(); } catch {} });
        session.on('exec',  (_accept, reject) => { try { reject(); } catch {} });
        session.on('pty',   (_accept, reject) => { try { reject(); } catch {} });
      });
    });

    client.on('error', (err) => logger.log(`[ssh] client error: ${err.code || err.message}`));
    client.on('end',   ()    => logger.log('[ssh] client disconnected'));
    client.on('close', ()    => {});
  });

  server.on('error', (err) => logger.error(`[ssh] server error: ${err.message}`));
  server.listen(SSH_PORT, '0.0.0.0', () => {
    logger.log(`[ssh] SFTP server listening on port ${SSH_PORT} (root: builds/)`);
  });

  return server;
}
