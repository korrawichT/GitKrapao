// Fetch and switch per tab: an operation in one tab leaves the others free
// (other tabs keep working, up to 3 operations app-wide); in its own tab every
// action is off; a tab whose repo is busy shows a placeholder and loads when the
// operation ends; a background result is logged without the banner, the drawer
// or a load, and a failure marks its tab. Worktrees of one repo share a lock key.
export const prodSafe = true;
export const budget = 120000;
export const setup = () => `<script>
(() => {
  const A = 'C:/fake/a', B = 'C:/fake/b', C = 'C:/fake/c', D = 'C:/fake/d', AWT = 'C:/fake/a-wt';
  const h = (ch, n) => ch.repeat(39) + n;
  const rec = (hash, parent, subj, t) => hash + '\\x1f' + parent + '\\x1fT\\x1ft@t\\x1f' + t + '\\x1f' + t + '\\x1f\\x1f' + subj + '\\x1e';
  // ch: the hex digit of the repo's hashes, also the start of its branch names and subjects.
  const repo = (ch, gen, key, name = ch) => ({ gen, key, name,
    refs: { refs: [[h(ch, '2'), 'refs/heads/' + ch + '-main'], [h(ch, '1'), 'refs/heads/' + ch + '-side']], headRef: 'refs/heads/' + ch + '-main', headSha: h(ch, '2') },
    log: rec(h(ch, '2'), h(ch, '1'), ch + '-two', 1700000200) + rec(h(ch, '1'), '', ch + '-one', 1700000100) });
  // a-wt is a linked worktree of a: another path, the same lock key.
  const repos = { [A]: repo('a', 1, A), [B]: repo('b', 2, B), [C]: repo('c', 3, C), [D]: repo('d', 4, D), [AWT]: repo('f', 5, A, 'a-wt') };
  // fetching[key]: the pending fetch or switch of that lock key; the backend answers 'busy' meanwhile.
  // Like the backend, every start_history gets a new gen; fail[path] makes the next loads of path fail.
  const f = window.__fake = { calls: [], fetching: {}, hold: {}, wait: {}, gen: 0, gens: {}, fail: {} };
  const byGen = g => f.gens[g];
  const keyOf = p => (repos[p] ? repos[p].key : p);
  f.pending = p => (f.fetching[keyOf(p)] ? 1 : 0);
  f.done = (p, r) => { const k = keyOf(p), res = f.fetching[k]; delete f.fetching[k]; if (res) res(r); };
  const gate = name => new Promise(res => (f.wait[name] = f.wait[name] || []).push(res));
  f.release = name => { f.hold[name] = false; (f.wait[name] || []).splice(0).forEach(r => r()); };
  const answers = {
    open_repo: a => {
      const r = repos[a.path];
      if (!r) throw a.path + ' is not inside a Git repository.';
      return { path: a.path, name: r.name, lockKey: r.key };
    },
    start_history: async a => {
      if (f.hold['start:' + a.path]) await gate('start:' + a.path);
      if (f.fetching[keyOf(a.path)]) throw 'busy';
      if (f.fail[a.path]) throw f.fail[a.path];
      const r = repos[a.path], gen = ++f.gen;
      f.gens[gen] = r;
      return { gen, remotes: ['origin'], fingerprint: 'fp', refs: r.refs };
    },
    history_page: a => ({ log: byGen(a.gen).log, more: false, capped: false }),
    sync_history: a => ({ fingerprintBefore: 'fp', fingerprintAfter: 'fp', refs: repos[a.path].refs, log: '', over: false }),
    fetch: a => {
      const k = keyOf(a.path);
      if (f.fetching[k]) throw 'busy';
      return new Promise(res => { f.fetching[k] = res; });
    },
    switch_branch: a => {
      const k = keyOf(a.path);
      if (f.fetching[k]) throw 'busy';
      return new Promise(res => { f.fetching[k] = res; });
    },
    repo_fingerprint: a => (f.fetching[keyOf(a.path)] ? null : 'fp'),
    branch_tracking: () => [],
    list_stashes: () => [],
    pull_requests: () => ({ repo: null, items: [] }),
    work_status: () => ({ files: [], total: 0 }),
    list_remotes: () => ['origin'],
    stop_history: () => null,
  };
  window.__TAURI__ = { core: { invoke: (cmd, args) => {
    f.calls.push([cmd, (args || {}).path]);
    const a = answers[cmd];
    return a ? Promise.resolve().then(() => a(args || {})) : new Promise(() => {});
  } } };
  localStorage.setItem('lanes.tabs', JSON.stringify({ tabs: [A, B, C, D, AWT].map(p => ({ path: p, name: repos[p].name })), active: 0 }));
})();
</script>`;
export const probe = `
run(async () => {
  const f = window.__fake, $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const A = 'C:/fake/a', B = 'C:/fake/b', C = 'C:/fake/c', D = 'C:/fake/d', AWT = 'C:/fake/a-wt';
  const FETCHING = 'Fetching… the history loads when it finishes';
  const CAP = '3 Git operations are already running; wait for one to finish';
  const SWITCHING = 'Switching branch… the history loads when it finishes';
  const WAIT = 'Wait for the Git operation in this repository to finish';
  const BUSY_MSG = 'Another Git operation is already running in this repository.';
  const tabs = () => $$('#tabs [role=tab]'), items = () => $$('#tabs .tab-item');
  const names = () => tabs().map(t => t.querySelector('.tab-name').textContent);
  const active = () => tabs().findIndex(t => t.getAttribute('aria-selected') === 'true');
  const rows = () => $('#body').textContent;
  const vis = s => { const e = $(s); return !!e && !e.hidden; };
  const spin = i => !!items()[i] && items()[i].classList.contains('running') && !!items()[i].querySelector('.tab-spin');
  const dot = i => !!items()[i] && !!items()[i].querySelector('.tab-dot');
  const fetchOff = () => $('#fetchBtn').getAttribute('aria-disabled') === 'true';
  const key = (k, o = {}, el = document) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
  const click = async (el, ms = 300) => { el.click(); await wait(ms); };
  const starts = from => f.calls.slice(from).filter(c => c[0] === 'start_history').length;
  const state = () => JSON.stringify({ names: names(), active: active() }) + ' | ' + rows();
  const res = (extra = {}) => ({ ok: true, timedOut: false, cancelled: false, durationMs: 5, exitCode: 0,
    command: 'git fetch --all --prune', stdout: '', stderr: '', summary: 'Fetched: already up to date.', ...extra });
  const fetchHere = async () => { $('#fetchBtn').click(); await wait(150); };

  ok(tabs().length === 5 && active() === 0 && rows().includes('a-two') && !fetchOff(), 'a loaded, Fetch enabled', state());

  // A fetch in a while a's graph is still on screen: hide/solo are off.
  await fetchHere();
  ok(f.pending(A) === 1 && spin(0), 'a: fetch running, its tab spins', f.pending(A) + ' ' + items()[0].outerHTML);
  ok(document.body.classList.contains('op-running') && $('#showAllBtn').disabled, 'a: eye/solo hidden and Show all off');
  const side = $('#sideList [data-kind="branch"][data-ref="refs/heads/a-side"]');
  const n0 = f.calls.length;
  side.focus(); key('h', {}, side); key('s', {}, side); await wait(150);
  ok(localStorage.getItem('lanes.hidden') === null && localStorage.getItem('lanes.solo') === null && !starts(n0), 'actions off: H and S on a branch do nothing',
    localStorage.getItem('lanes.hidden') + ' ' + localStorage.getItem('lanes.solo'));
  const r = side.getBoundingClientRect();
  side.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 })); await wait(50);
  const hide = $$('#ctxMenu .menu-item').find(b => b.textContent.startsWith('Hide'));
  const sw = $$('#ctxMenu .menu-item').find(b => b.textContent.startsWith('Switch to'));
  ok(hide && hide.disabled && hide.textContent.includes(WAIT) && sw && sw.disabled, 'actions off: menu Hide and Switch are off', $('#ctxMenu').innerHTML);
  key('Escape', {}, $('#ctxMenu')); await wait(30);

  // fetch A then work in B
  await click(tabs()[1]);
  ok(active() === 1 && rows().includes('b-two') && !rows().includes('a-'), 'fetch A then work in B: b shows its rows', state());
  ok(!fetchOff() && $('#fetchBtn').title === 'Fetch all remotes (Ctrl/⌘ Shift F)', 'fetch A then work in B: Fetch enabled in b', $('#fetchBtn').title);
  ok(spin(0) && !spin(1), 'fetch A then work in B: tab a spins', items()[0].className);
  ok(!document.body.classList.contains('op-running') && !$('#showAllBtn').disabled && $('#refreshBtn').getAttribute('aria-disabled') !== 'true', 'b: actions on');

  // placeholder while busy
  await click(tabs()[0]);
  ok(active() === 0 && vis('#tabBusy') && $('#tabBusy').textContent.trim() === FETCHING, 'placeholder while busy: copy', vis('#tabBusy') + ' ' + ($('#tabBusy') && $('#tabBusy').textContent));
  ok(!rows().includes('b-') && !rows().includes('a-') && !$$('#body .row[data-i]').length && !vis('#emptyState'), 'placeholder while busy: no rows, no empty state', rows());
  ok(!$('#sideList').textContent.includes('b-main') && $('#repoName').textContent === 'a' && $('#stats').textContent === '', 'placeholder while busy: panel cleared, toolbar names a',
    $('#sideList').textContent + ' | ' + $('#repoName').textContent + ' | ' + $('#stats').textContent);
  ok(fetchOff() && $('#fetchBtn').classList.contains('running'), 'placeholder while busy: Fetch shows it running');

  // actions off in the busy tab
  ok($('#refreshBtn').getAttribute('aria-disabled') === 'true' && $('#refreshBtn').title === WAIT, 'actions off: Refresh', $('#refreshBtn').title);
  const n1 = f.calls.length;
  key('r', { ctrlKey: true }); $('#refreshBtn').click(); await wait(150);
  ok(!starts(n1), 'actions off: Ctrl+R and the button load nothing', JSON.stringify(f.calls.slice(n1)));
  ok($('#showAllBtn').disabled && document.body.classList.contains('op-running'), 'actions off: Show all');
  localStorage.setItem('lanes.recent', JSON.stringify([{ path: 'C:/fake/e', name: 'e' }]));
  $('#repoBtn').click(); await wait(30);
  const n2 = f.calls.length;
  await click($('#recentMenu [data-path="C:/fake/e"]'));
  key('o', { ctrlKey: true }); await wait(100);
  ok(!f.calls.slice(n2).length && active() === 0 && names().length === 5, 'actions off: recent item and Ctrl+O do nothing', JSON.stringify(f.calls.slice(n2)) + ' ' + state());
  if (!$('#recentMenu').hidden) $('#repoBtn').click();
  const x = $$('#tabs .tab-x')[0];
  ok(x.getAttribute('aria-disabled') === 'true' && x.title === WAIT, 'actions off: x disabled with the reason', x.outerHTML);
  await click(x, 150);
  key('w', { ctrlKey: true }); await wait(150);
  ok(tabs().length === 5 && active() === 0, 'actions off: x and Ctrl+W keep 5 tabs', state());

  // loads when done
  f.done(A, res()); await wait(400);
  ok(!vis('#tabBusy') && rows().includes('a-two') && !spin(0) && !fetchOff(), 'loads when done', state());
  ok($('#refreshBtn').getAttribute('aria-disabled') !== 'true' && !$('#showAllBtn').disabled && $$('#tabs .tab-x')[0].getAttribute('aria-disabled') !== 'true', 'loads when done: actions back on');

  // A refresh already on its way when a fetch starts gets 'busy' from the backend:
  // the loaded graph stays, and the refresh runs once the fetch ends.
  f.hold['start:' + A] = true;
  key('r', { ctrlKey: true }); await wait(100);
  await fetchHere();
  const n5 = f.calls.length;
  f.release('start:' + A); await wait(300);
  ok(f.pending(A) === 1 && rows().includes('a-two') && !vis('#tabBusy') && !vis('#banner'), 'busy answer: the loaded graph stays', state() + ' | ' + $('#bannerMsg').textContent);
  f.done(A, res()); await wait(400);
  ok(starts(n5) === 1 && rows().includes('a-two') && !vis('#tabBusy'), 'busy answer: the refresh runs after the fetch', JSON.stringify(f.calls.slice(n5)));
  // 'busy' with no operation of ours to wait for: the banner says so.
  f.fetching[A] = () => {};
  key('r', { ctrlKey: true }); await wait(300);
  ok(vis('#banner') && $('#bannerMsg').textContent === BUSY_MSG && rows().includes('a-two'), 'busy answer with no operation: banner', $('#bannerMsg').textContent);
  delete f.fetching[A]; $('#bannerClose').click();

  // A switch: the placeholder says so.
  $('#sideList [data-kind="branch"][data-ref="refs/heads/a-side"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await wait(150);
  ok(f.pending(A) === 1 && spin(0) && $('#fetchBtn').title === 'Switching branch…', 'switch running in a', $('#fetchBtn').title);
  await click(tabs()[1]); await click(tabs()[0]);
  ok(vis('#tabBusy') && $('#tabBusy').textContent.trim() === SWITCHING && fetchOff() && $('#fetchBtn').title === 'Switching branch…',
    'placeholder while switching: copy', ($('#tabBusy') && $('#tabBusy').textContent) + ' | ' + $('#fetchBtn').title);
  f.done(A, res({ command: 'git switch --no-guess a-side', summary: 'Switched to a-side.' })); await wait(400);
  ok(!vis('#tabBusy') && rows().includes('a-two'), 'placeholder while switching: loads when done', state());

  // background failure is quiet
  await click(tabs()[1]);
  await fetchHere();
  ok(f.pending(B) === 1, 'b: fetch running');
  await click(tabs()[2]);
  const open0 = $('#outList').hidden;
  f.done(B, res({ ok: false, exitCode: 128, summary: 'Authentication failed for b' })); await wait(300);
  ok(open0 && !vis('#banner') && $('#outList').hidden && $('#outLast').textContent.includes('Authentication failed for b'),
    'background failure is quiet: no banner, drawer stays closed, bar shows it', $('#bannerMsg').textContent + ' | ' + $('#outLast').textContent);
  ok(active() === 2 && rows().includes('c-two') && dot(1) && !spin(1), 'background failure is quiet: b gets the error dot', state() + ' ' + items()[1].outerHTML);
  await click(tabs()[1]);
  ok(!dot(1) && rows().includes('b-two'), 'background failure is quiet: activating b clears the dot', items()[1].outerHTML);

  // A failure in the active tab that showed the placeholder: the load that follows keeps the banner.
  await fetchHere();
  await click(tabs()[2]); await click(tabs()[1]);
  ok(vis('#tabBusy') && f.pending(B) === 1, 'failure after the placeholder: b waits for its fetch', state());
  f.done(B, res({ ok: false, exitCode: 128, summary: 'Authentication failed for b' })); await wait(400);
  ok(!vis('#tabBusy') && rows().includes('b-two') && vis('#banner') && $('#bannerMsg').textContent === 'Authentication failed for b',
    'failure after the placeholder: the banner stays after the load', state() + ' | banner ' + vis('#banner') + ' ' + $('#bannerMsg').textContent);
  $('#bannerClose').click();

  // The load that runs after the placeholder fails: its error shows and nothing says it is still loading.
  await fetchHere();
  await click(tabs()[2]); await click(tabs()[1]);
  ok(vis('#tabBusy'), 'load fails after the placeholder: b waits', state());
  f.fail[B] = 'C:/fake/b is gone';
  f.done(B, res()); await wait(400);
  ok(!vis('#tabBusy') && vis('#banner') && $('#bannerMsg').textContent === 'C:/fake/b is gone' && $('#stats').textContent === '' && !$$('#body .row[data-i]').length,
    'load fails after the placeholder: banner, no "Loading history…"', state() + ' | ' + $('#bannerMsg').textContent + ' | stats ' + $('#stats').textContent);
  delete f.fail[B];
  $('#bannerClose').click();

  // cap of 3
  for (const i of [0, 1, 2]) { await click(tabs()[i]); await fetchHere(); }
  ok(f.pending(A) && f.pending(B) && f.pending(C) && spin(0) && spin(1) && spin(2), 'cap of 3: three fetches run');
  await click(tabs()[3]);
  ok(rows().includes('d-two') && fetchOff() && $('#fetchBtn').title === CAP, 'cap of 3: d Fetch off with the reason', $('#fetchBtn').title);
  const n3 = f.calls.length;
  key('F', { ctrlKey: true, shiftKey: true }); await wait(100);
  ok(!f.calls.slice(n3).some(c => c[0] === 'fetch'), 'cap of 3: Ctrl+Shift+F starts nothing');
  f.done(B, res()); await wait(300);
  ok(!fetchOff() && $('#fetchBtn').title !== CAP && active() === 3, 'cap of 3: one ends, d can fetch', $('#fetchBtn').title);
  f.done(A, res()); f.done(C, res()); await wait(300);

  // shared lockKey
  await click(tabs()[0]); await fetchHere();
  await click(tabs()[4], 400);
  ok(active() === 4 && vis('#tabBusy') && fetchOff() && spin(4) && spin(0), 'shared lockKey: a-wt waits for the fetch in a', state() + ' ' + items()[4].className);
  ok($$('#tabs .tab-x')[4].getAttribute('aria-disabled') === 'true', 'shared lockKey: a-wt cannot close');

  // switching tabs allowed while busy
  key('Tab', { ctrlKey: true }); await wait(300);
  ok(active() === 0 && vis('#tabBusy'), 'switching tabs allowed while busy: Ctrl+Tab', state());
  await click($('#tabNew'), 150);
  ok(tabs().length === 6 && active() === 5 && vis('#emptyState') && !vis('#tabBusy'), 'switching tabs allowed while busy: + opens an empty tab', state());
  const n4 = f.calls.length;
  f.done(A, res()); await wait(300);
  ok(!starts(n4) && !spin(0) && !spin(4) && vis('#emptyState'), 'a fetch ending under a New tab loads nothing', JSON.stringify(f.calls.slice(n4)));

  // From the empty state to a repo: the empty state goes while it loads.
  f.hold['start:' + D] = true;
  await click(tabs()[3], 150);
  ok(!vis('#emptyState') && !vis('#tabBusy') && $('#stats').textContent === 'Loading history…', 'empty state hidden while a repo loads', $('#stats').textContent);
  f.release('start:' + D); await wait(300);
  ok(rows().includes('d-two'), 'd loads', state());
  await click(tabs()[4]);
  ok(rows().includes('f-two') && !vis('#tabBusy'), 'a-wt loads once the fetch is over', state());
});`;
