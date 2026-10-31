// User requirement (2026-10-31): « ajoutes un lecteur pour lire dans l'App (il n'y en a pas)
// et dans le web s'il n'y en a pas déja ». Static check of the Android sources: a cited audio
// file is classified as AUDIO, the id-links scanner finds it, and a single-player rule exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = join(root, 'android/app/src/main/java/com/orchestrateur/data');
const AUDIO = ['wav', 'mp3', 'ogg', 'm4a', 'flac', 'opus'];

test('android: cited audio files get an inline player, one player at a time', () => {
  const media = readFileSync(join(data, 'MediaLinks.kt'), 'utf8');
  const idLinks = readFileSync(join(data, 'IdLinks.kt'), 'utf8');

  assert.match(media, /enum class MediaKind\s*\{[^}]*\bAUDIO\b/, 'MediaKind.AUDIO is missing');
  const audioSet = media.match(/AUDIO[A-Z_]*\s*=\s*setOf\(([^)]*)\)/i);
  assert.ok(audioSet, 'MediaLinks has no audio extension set');
  for (const ext of AUDIO) {
    assert.ok(audioSet[1].includes(`"${ext}"`), `MediaLinks does not list .${ext}`);
  }

  const fileExt = idLinks.match(/FILE_EXT\s*=\s*"([^"]*)"/);
  assert.ok(fileExt, 'IdLinks.FILE_EXT not found');
  const exts = fileExt[1].split('|');
  for (const ext of AUDIO) assert.ok(exts.includes(ext), `IdLinks.FILE_EXT does not scan .${ext}`);

  const sources = readFileSync(join(data, 'SinglePlayer.kt'), 'utf8');
  assert.match(sources, /class SinglePlayer\b/);
  for (const member of ['current', 'play(', 'stop(', 'stopAll(']) {
    assert.ok(sources.includes(member), `SinglePlayer lacks ${member}`);
  }
});
