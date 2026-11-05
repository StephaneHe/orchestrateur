CODE PRINCIPLES (user rule for the whole fleet, 2026-11-03): always prefer immutability.
- Write pure functions by default. Never modify a parameter or any object you receive: return a copy.
- Python: @dataclass(frozen=True), tuple, frozenset. JS/TS: const, readonly, `as const`, copies by spread or structuredClone, never mutate an argument. Kotlin: val, immutable data classes, read-only lists.
- Accepted exception, only "if it makes sense": genuinely mutable state (cache, render buffer without per-frame allocation, I/O, measured performance) is allowed when confined and justified in a one-line comment.
- Apply this to the code you write or change now. Never rewrite old code outside your change just to comply.

## review
Immutability (user rule): in the diff only, report as a defect to fix any mutation of an input (parameter or received object) and any mutable state that is not confined and justified by a one-line comment. Never report old code outside the diff.
