// Code principles injected by the engine, whatever the provider (user rule
// 2026-11-03). Single source of truth: data/code-principles.md (rule text, then a
// "## review" section holding the reviewer's criterion). No copy in any prompt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'code-principles.md');

/** Pipeline step ids whose turn WRITES code (a model delivery included). */
export const CODE_WRITING_STEPS = Object.freeze([
  'vert', 'rouge-vert', 'refactor', 'corriger-vert', 'corriger', 'contenir', 'tests-instables', 'dette', 'squelette', 'mvp', 'collecter', 'nettoyer', 'livrer', 'publication',
]);

export function writesCode(stepId) {
  return CODE_WRITING_STEPS.includes(String(stepId || '').replace(/^\d+-/, ''));
}

function sections() {
  const raw = fs.readFileSync(FILE, 'utf8').trim();
  const [rule, review = ''] = raw.split(/^## review\s*$/m);
  return { rule: rule.trim(), review: review.trim() };
}

/** Block appended to the prompt of a code-writing turn. */
export function codePrinciplesRule() {
  return `\n\n---\n${sections().rule}`;
}

/** Criterion added to the review prompt. */
export function reviewCriterion() {
  return sections().review;
}
