// Picks the view. On the machine running the server, a bare link opens the
// presenter. From anywhere else it opens the phone page.

import { showProblem } from './notice.js';

async function boot() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || 'main';
  const answer = await fetch(`/live-deck/info?room=${encodeURIComponent(room)}`).catch(() => null);
  // A server started before this backend existed, or one whose backend failed to load.
  if (!answer?.ok) {
    showProblem('The live deck\'s server is not answering.', `${location.host} ${answer ? `answered ${answer.status}` : 'could not be reached'}. Restart it with npm start, read what it prints, then reload this page.`);
    return;
  }
  const info = await answer.json();

  let role = params.get('role') ?? (info.canPresent ? 'presenter' : 'phone');
  if (!['presenter', 'audience', 'phone', 'replay'].includes(role)) role = 'audience';
  if (role === 'presenter' && !info.canPresent) role = 'audience';

  document.body.classList.add(role);
  const start = role === 'phone' ? (await import('./phone.js')).startPhone
    : role === 'replay' ? (await import('./replay.js')).startReplay
    : (await import('./screen.js')).startScreen;
  window.app = await start({ role, room, info });

  // A connection can hang without ever failing, which no status change reports.
  if (role !== 'replay') {
    setTimeout(() => {
      if (!window.app.state) showProblem('Still trying to reach the live deck.', `Nothing has come back from ${location.host}. Check that the server is running and that this device can reach it.`);
    }, 4000);
  }
}

boot().catch((err) => showProblem('The deck could not start.', `${err.message}. Reload the page, and if this keeps happening try a newer browser.`));
