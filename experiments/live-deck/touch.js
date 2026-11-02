// Every finger on a phone's canvas, in stage coordinates. The stage follows one
// pointer at a time, which is right for a drag and wrong for two thumbs.

/**
 * Calls onChange(held, event) with the list of fingers down whenever one lands,
 * moves or lifts. Returns a function that stops listening.
 */
export function pointers(canvas, stage, onChange) {
  const held = new Map();
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return stage.toStage(e.clientX - r.left, e.clientY - r.top);
  };
  const report = (e) => onChange([...held.values()], e);
  const down = (e) => { held.set(e.pointerId, at(e)); e.preventDefault(); report(e); };
  const move = (e) => { if (held.has(e.pointerId)) { held.set(e.pointerId, at(e)); report(e); } };
  const up = (e) => { if (held.delete(e.pointerId)) report(e); };
  // A phone that hides the page may never say the finger lifted.
  const hidden = () => { if (document.visibilityState === 'hidden' && held.size) { held.clear(); report(null); } };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    document.removeEventListener('visibilitychange', hidden);
  };
}
