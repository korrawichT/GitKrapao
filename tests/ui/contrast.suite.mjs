// Lane colors: text on colored fills picks the more readable of dark/white, each
// theme uses its own palette, and switching themes repaints rows, panel and card.
export const variants = [{ name: 'dark', theme: 'dark' }, { name: 'light', theme: 'light' }];
export const probe = `
const rgb = h => [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16));
const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const L = h => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = s => '#' + s.match(/\\d+/g).slice(0, 3).map(v => (+v).toString(16).padStart(2, '0')).join('');

run(async () => {
  const T = window.__gitkrapao;
  // Scrollbars follow the theme (they were white on the dark theme).
  const rs = getComputedStyle(document.documentElement), th = document.documentElement.dataset.theme;
  ok(rs.colorScheme === th, 'color-scheme follows the theme', rs.colorScheme + ' vs ' + th);
  const bar = getComputedStyle(document.querySelector('#wrap')).scrollbarColor;
  ok(bar === (th === 'dark' ? 'rgb(74, 82, 96) rgba(0, 0, 0, 0)' : 'rgb(195, 201, 210) rgba(0, 0, 0, 0)'), 'scrollbar thumb in theme colors, no track', bar);
  for (const h of T.PALETTE.concat(['#8a93a1', '#6e7786', '#ffffff', '#000000', '#808080'])) {
    const t = T.textOn(h), w = cr('#ffffff', h), d = cr('#15181d', h);
    ok(Math.abs(cr(t, h) - Math.max(w, d)) < 1e-9, 'textOn picks the more readable text on ' + h, t + ' white ' + w.toFixed(2) + ' dark ' + d.toFixed(2));
  }
  ['#19bfe6', '#62cc4a', '#25cfa4'].forEach(h => ok(T.textOn(h) === '#15181d', 'dark text on ' + h, T.textOn(h)));
  const head = document.querySelector('#body .pill.head'), hs = getComputedStyle(head);
  ok(cr(hex(hs.color), hex(hs.backgroundColor)) >= 4.25, 'head label readable', hs.color + ' on ' + hs.backgroundColor);
  let worst = 99, seen = new Set();
  for (const r of [...document.querySelectorAll('#body .row[data-i]')]) {
    r.click(); await wait(30);
    const av = document.querySelector('#detail .d-av'); if (!av) continue;
    const s = getComputedStyle(av), bg = hex(s.backgroundColor); seen.add(bg);
    worst = Math.min(worst, cr(hex(s.color), bg));
  }
  ok(seen.size >= 3 && worst >= 4.25, 'author avatars readable (' + seen.size + ' colors)', 'worst ' + worst.toFixed(2));

  const LIGHT = ['#0b8fb3','#3f7cf6','#a454f0','#e341c3','#f23f5f','#d46210','#a87d00','#3d9a2a','#13977a'];
  const DARK = ['#17abd4','#3f7cf6','#a454f0','#e341c3','#ff4d6a','#ff8c32','#f2c230','#62cc4a','#25cfa4'];
  const used = () => {
    const pills = [...document.querySelectorAll('#body .row .pill')].map(p => p.style.getPropertyValue('--c').trim().toLowerCase());
    const dots = [...document.querySelectorAll('#sideList .sb-dot:not(.off)')].map(d => hex(getComputedStyle(d).backgroundColor));
    const av = document.querySelector('#detail .d-av');
    return { pills, dots, av: av ? hex(getComputedStyle(av).backgroundColor) : null };
  };
  const allIn = (u, pal) => u.pills.length && u.dots.length && u.av && [...u.pills, ...u.dots, u.av].every(c => pal.includes(c));
  const themeNow = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  for (let k = 0; k < 2; k++) {
    document.querySelector('#body .row[data-i]').click(); await wait(30);
    const t = themeNow(), u = used();
    ok(allIn(u, t === 'dark' ? DARK : LIGHT), t + ' theme uses its palette', JSON.stringify(u));
    document.querySelector('#themeBtn').click(); await wait(80);
  }
  const u2 = used();
  ok(allIn(u2, themeNow() === 'dark' ? DARK : LIGHT), 'after toggling back, palette follows (card not re-clicked)', JSON.stringify(u2));
  ok(LIGHT.every(c => cr(c, '#f5f6f8') >= 3), 'light palette lines >= 3:1 on light bg');
});`;
