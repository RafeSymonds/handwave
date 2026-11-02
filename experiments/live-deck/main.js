// Picks the view. On the machine running the server, a bare link opens the
// presenter. From anywhere else it opens the phone page.

const params = new URLSearchParams(location.search);
const room = params.get('room') || 'main';
const info = await (await fetch(`/live-deck/info?room=${encodeURIComponent(room)}`)).json();

let role = params.get('role') ?? (info.canPresent ? 'presenter' : 'phone');
if (!['presenter', 'audience', 'phone'].includes(role)) role = 'audience';
if (role === 'presenter' && !info.canPresent) role = 'audience';

document.body.classList.add(role);
const start = role === 'phone' ? (await import('./phone.js')).startPhone : (await import('./screen.js')).startScreen;
window.app = await start({ role, room, info });
