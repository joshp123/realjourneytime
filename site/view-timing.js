// One pair of User Timing entries per visible answer. Superseded work is ignored.
const active = new Map();

export function timeView(view, start = performance.now()) {
  const token = {start, marks: new Set()};
  active.set(view, token);
  document.body.dataset.busy = view;
  return phase => {
    if (active.get(view) !== token || token.marks.has(phase)) return;
    if (phase !== 'answer') delete document.body.dataset.busy;
    token.marks.add(phase);
    // The next frame after this one gives the browser a chance to paint the result.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (active.get(view) === token && document.body.dataset.page === view) {
        performance.measure(`rjt.${view}.${phase}`, {start, end: performance.now()});
      }
    }));
  };
}
