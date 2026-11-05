// How a musician asks the user a question (user, 2026-11-05: « Ta question n'est pas
// claire et incomplete »). Single source of truth: data/question-rule.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'question-rule.md');

/** Block appended to the prompt of every musician turn and pipeline step. */
export function questionRule() {
  return `\n\n---\n${fs.readFileSync(FILE, 'utf8').trim()}`;
}
