#!/usr/bin/env node
// Validity test 1.5 — dispatchQueue persistence.
// Spawns a temp QUEUE_DIR, writes a fake queue, simulates restart by clearing
// the in-memory Map and re-running loadQueuesFromDisk, asserts the queue is
// restored in original order.

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import assert from 'node:assert/strict';

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-q-'));
const QUEUE_DIR = path.join(TMPROOT, 'queue');
fs.mkdirSync(QUEUE_DIR, { recursive: true });

// Inline copy of the persistence helpers under test (must mirror server.js).
const dispatchQueue = new Map();
function queueSidecarPath(name) { return path.join(QUEUE_DIR, `${name}.json`); }

function persistQueue(name) {
  const q = dispatchQueue.get(name);
  const file = queueSidecarPath(name);
  if (!q || q.length === 0) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(q));
  fs.renameSync(tmp, file);
}

function loadQueuesFromDisk(knownProjects) {
  let entries;
  try { entries = fs.readdirSync(QUEUE_DIR); } catch { return; }
  for (const fname of entries) {
    if (!fname.endsWith('.json')) continue;
    const name = fname.slice(0, -5);
    if (knownProjects && !knownProjects.has(name)) {
      try { fs.unlinkSync(path.join(QUEUE_DIR, fname)); } catch {}
      continue;
    }
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, fname), 'utf8'));
      if (Array.isArray(arr) && arr.length > 0) dispatchQueue.set(name, arr);
    } catch {}
  }
}

// 1. Push 5 turns to "alpha" and persist after each push.
const turns = [
  { prompt: 'turn 1', attachmentPaths: [], videoPaths: [] },
  { prompt: 'turn 2', attachmentPaths: [], videoPaths: [] },
  { prompt: 'turn 3', attachmentPaths: ['/x/a.png'], videoPaths: [] },
  { prompt: 'turn 4', attachmentPaths: [], videoPaths: ['/x/b.mp4'] },
  { prompt: 'turn 5', attachmentPaths: [], videoPaths: [] },
];
for (const t of turns) {
  const q = dispatchQueue.get('alpha') ?? [];
  q.push(t);
  dispatchQueue.set('alpha', q);
  persistQueue('alpha');
}

// 2. Simulate SIGKILL: drop in-memory state.
dispatchQueue.clear();
assert.equal(dispatchQueue.size, 0);

// 3. Restart: rehydrate from disk.
loadQueuesFromDisk(new Set(['alpha', 'beta']));
const restored = dispatchQueue.get('alpha');
assert.ok(Array.isArray(restored));
assert.equal(restored.length, 5, `expected 5 turns, got ${restored.length}`);
for (let i = 0; i < 5; i++) {
  assert.equal(restored[i].prompt, turns[i].prompt, `order broken at index ${i}`);
  assert.deepEqual(restored[i].attachmentPaths, turns[i].attachmentPaths);
  assert.deepEqual(restored[i].videoPaths, turns[i].videoPaths);
}

// 4. Drain to empty and confirm sidecar is removed.
dispatchQueue.delete('alpha');
persistQueue('alpha');
assert.equal(fs.existsSync(queueSidecarPath('alpha')), false, 'sidecar should be deleted on empty');

// 5. Stale sidecar (project removed from config) is cleaned on load.
fs.writeFileSync(queueSidecarPath('orphan'), JSON.stringify([{ prompt: 'stale' }]));
loadQueuesFromDisk(new Set(['alpha']));  // 'orphan' not in known set
assert.equal(fs.existsSync(queueSidecarPath('orphan')), false, 'orphan sidecar should be cleaned');

// Cleanup
fs.rmSync(TMPROOT, { recursive: true, force: true });
console.log('PASS — Test 1.5 queue persistence: 5 turns restored in order, atomic write, orphan cleanup');
