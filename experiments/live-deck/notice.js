// What a page says when it cannot show the deck. Without this, a connection that never
// opens leaves an empty slide and no reason.

function box() { return document.getElementById('problem'); }

export function showProblem(title, detail) {
  const el = box();
  el.querySelector('strong').textContent = title;
  el.querySelector('p').textContent = detail;
  el.hidden = false;
}

export function clearProblem() {
  box().hidden = true;
}

/**
 * Called on every change of connection. A page already showing a slide keeps showing it,
 * and its own status line covers a dropped connection. Only a page with nothing to show
 * needs this.
 */
export function connectionNotice(status, hasSlide) {
  if (status === 'live' || hasSlide) { clearProblem(); return; }
  if (status === 'refused') {
    showProblem('The server refused this connection.', 'Reload the page. If this keeps happening, open the address on the slide directly, not through a proxy or a forwarded port.');
  } else if (status === 'down') {
    showProblem('Cannot reach the live deck. Still trying.', `This page came from ${location.host}, but its live connection failed. Check that the server is running. On a phone, join the same wifi as the laptop, or a hotspot if this network keeps devices apart.`);
  }
}
