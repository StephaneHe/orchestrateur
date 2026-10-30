// Review policy for documentation-only findings.
//
// A review that only reports documentation / comment / CHANGELOG / report
// findings (`delivery`) gets ONE correction round; after that those findings go
// to the delivery notes instead of blocking. Any code or test finding (`items`)
// keeps blocking everything, including the documentation findings of a mixed
// review (0.65.0: every defect blocks delivery).

export function applyDocFindingsPolicy(review, roundsDone) {
  const items = Array.isArray(review?.items) ? review.items : [];
  const delivery = Array.isArray(review?.delivery) ? review.delivery : [];
  const docOnly = !items.length && delivery.length > 0;
  const release = docOnly && roundsDone >= 1;
  const blocking = release ? { items: [], delivery: [] } : { items, delivery };
  blocking.verdict = blocking.items.length || blocking.delivery.length ? 'problemes' : 'ok';
  return { blocking, notes: release ? delivery : [] };
}
