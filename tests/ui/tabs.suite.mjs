// Repository tabs: the strip restores the saved tabs and loads only the active
// one; switching shows only that repo's data (late answers from the tab left
// behind are dropped, and nothing runs for it in the background); the selected
// commit comes back; New tab, opening into the active tab, closing, the
// shortcuts and what is saved in lanes.tabs / lanes.last.
export const budget = 120000;
export const variants = [{}, { name: 'migrate' }, { name: 'gone' }];
export const setup = v => `<script>
(() => {
  const A = 'C:/fake/a', B = 'C:/fake/b', C = 'C:/fake/c', GONE = 'C:/fake/gone';
  const h = (ch, n) => ch.repeat(39) + n;
  const rec = (hash, parent, subj, t) => hash + '\\x1f' + parent + '\\x1fT\\x1ft@t\\x1f' + t + '\\x1f' + t + '\\x1f\\x1f' + subj + '\\x1e';
  const repos = {
    [A]: { gen: 1, tip: h('a', '3'), branch: 'refs/heads/a-main', remotes: ['origin'],
           log: rec(h('a', '3'), h('a', '2'), 'a-three', 1700000300) + rec(h('a', '2'), h('a', '1'), 'a-two', 1700000200) + rec(h('a', '1'), '', 'a-one', 1700000100) },
    [B]: { gen: 2, tip: h('b', '2'), branch: 'refs/heads/b-main',
           log: rec(h('b', '2'), h('b', '1'), 'b-two', 1700000200) + rec(h('b', '1'), '', 'b-one', 1700000100) },
    // c has a second page, which the view asks for at once (prefetch).
    [C]: { gen: 3, tip: h('c', '2'), branch: 'refs/heads/c-main', more: true,
           log: rec(h('c', '2'), h('c', '1'), 'c-two', 1700000200),
           page2: rec(h('c', '1'), '', 'c-one', 1700000100) },
  };
  const refsOf = r => ({ refs: [[r.tip, r.branch]], headRef: r.branch, headSha: r.tip });
  const stashA = { sha: 'e'.repeat(40), parents: [h('a', '1'), 'f'.repeat(40)], name: 'stash@{0}', time: 1700000150, message: 'On a-main: a-stash' };
  // hold[name] makes the matching call wait until release(name, value).
  // Like the backend, every start_history gets a new gen; stops records each stop_history gen.
  const f = window.__fake = { calls: [], hold: {}, wait: {}, variant: '${v.name || ''}', gen: 0, gens: {}, genOf: {}, stops: [], fail: {}, wipB: false };
  const byGen = g => f.gens[g];
  const gate = name => new Promise(res => (f.wait[name] = f.wait[name] || []).push(res));
  f.release = (name, value) => { f.hold[name] = false; (f.wait[name] || []).splice(0).forEach(r => r(value)); };
  f.pending = name => (f.wait[name] || []).length;
  const answers = {
    open_repo: async a => {
      if (!repos[a.path]) throw a.path + ' is not inside a Git repository.';
      return { path: a.path, name: a.path.slice(-1), lockKey: a.path };
    },
    start_history: async a => {
      if (a.path === B && f.hold.startB) await gate('startB');
      const r = repos[a.path];
      if (!r) throw 'not a repo';
      if (f.fail[a.path]) throw f.fail[a.path];
      const gen = ++f.gen; f.gens[gen] = r; f.genOf[a.path] = gen;
      return { gen, remotes: r.remotes || [], fingerprint: 'fp', refs: refsOf(r) };
    },
    history_page: async a => {
      const r = byGen(a.gen);
      if (!a.start) return { log: r.log, more: !!r.more, capped: false };
      if (f.hold.page) await gate('page');
      return { log: r.page2 || '', more: false, capped: false };
    },
    sync_history: a => ({ fingerprintBefore: 'fp', fingerprintAfter: 'fp', refs: refsOf(repos[a.path]), log: '', over: false }),
    fetch: async () => {
      await gate('fetch');
      return { ok: true, timedOut: false, cancelled: false, durationMs: 1, exitCode: 0, command: 'git fetch', stdout: '', stderr: '', summary: 'Fetched.' };
    },
    repo_fingerprint: async a => (a.path === A && f.hold.fpA ? gate('fpA') : 'fp'),
    branch_tracking: () => [],
    list_stashes: async a => {
      if (a.path === A && f.hold.stashA) await gate('stashA');
      return a.path === A ? [stashA] : [];
    },
    pull_requests: () => ({ repo: null, items: [] }),
    work_status: async a => {
      if (a.path === A && f.hold.wipA) await gate('wipA');
      return a.path === B && f.wipB ? { files: [{ path: 'b.txt', oldPath: null, staged: '', unstaged: 'M', conflict: false }], total: 1 } : { files: [], total: 0 };
    },
    stop_history: a => { f.stops.push(a.gen); return null; },
    list_remotes: a => (repos[a.path] && repos[a.path].remotes) || [],
  };
  window.__TAURI__ = { core: { invoke: (cmd, args) => {
    f.calls.push([cmd, (args || {}).path]);
    const a = answers[cmd];
    return a ? Promise.resolve().then(() => a(args || {})) : new Promise(() => {});
  } } };
  ${v.name === 'migrate'
    ? "localStorage.setItem('lanes.last', JSON.stringify({ path: B, name: 'b', lockKey: 'not-trusted' }));"
    : v.name === 'gone'
    ? "localStorage.setItem('lanes.tabs', JSON.stringify({ tabs: [{ path: GONE, name: 'gone' }, { path: 5 }, null, { path: A, name: 'a', lockKey: 'x' }, { path: A, name: 'a' }], active: 0 }));"
    : "localStorage.setItem('lanes.tabs', JSON.stringify({ tabs: [{ path: A, name: 'a' }, { path: B, name: 'b' }], active: 0 }));"}
})();
</script>`;
export const probe = `
run(async () => {
  const f = window.__fake, $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const A = 'C:/fake/a', B = 'C:/fake/b';
  const tabs = () => $$('#tabs [role=tab]');
  const names = () => tabs().map(t => t.querySelector('.tab-name').textContent);
  const active = () => tabs().findIndex(t => t.getAttribute('aria-selected') === 'true');
  const rows = () => $('#body').textContent;
  const side = () => $('#sideList').textContent;
  const empty = () => !$('#emptyState').hidden;
  const banner = () => $('#banner').hidden ? '' : $('#bannerMsg').textContent;
  const callsFor = (p, from = 0) => f.calls.slice(from).filter(c => c[1] === p);
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
  const click = async (el, ms = 150) => { el.click(); await wait(ms); };
  const state = () => JSON.stringify({ names: names(), active: active() });
  const until = async (cond, ms = 5000) => { for (let t = 0; t < ms && !cond(); t += 20) await wait(20); return cond(); };
  // run() cleared localStorage after the boot; the empty state and the menu list recents from it.
  const seedRecent = () => localStorage.setItem('lanes.recent', JSON.stringify(['a', 'b', 'gone'].map(n => ({ path: 'C:/fake/' + n, name: n }))));

  if (f.variant === 'migrate') {
    ok(tabs().length === 1 && names()[0] === 'b' && active() === 0 && rows().includes('b-two'), 'migrated from lanes.last', state() + ' | ' + rows());
    return;
  }
  if (f.variant === 'gone') {
    ok(tabs().length === 2 && names().join() === 'gone,a' && active() === 0, 'invalid entries dropped', state());
    ok(banner().includes('not inside a Git repository') && empty() && !log.some(l => l.startsWith('ERR')),
      'missing repo tab', banner() + ' | empty=' + empty() + ' | ' + log.join(';'));
    ok(!callsFor(A).length, 'missing repo tab: a not touched at boot', JSON.stringify(f.calls));
    key('t', { ctrlKey: true }); await wait(100);
    ok(active() === 2 && empty() && !banner(), 'missing repo tab: the banner goes with Ctrl+T', state() + ' | ' + banner());
    await click(tabs()[1], 300);
    ok(active() === 1 && rows().includes('a-three') && !empty() && !banner(), 'missing repo tab: clicking tab 2 loads a', state() + ' | ' + rows() + ' | ' + banner());
    return;
  }

  ok(tabs().length === 2 && active() === 0 && tabs()[0].getAttribute('aria-selected') === 'true' && rows().includes('a-three'),
    'two tabs restored', state() + ' | ' + rows());
  ok(!callsFor(B).length, 'boot touches only the active tab', JSON.stringify(callsFor(B)));
  ok(!$('#tabs').hidden && !!$('#tabNew') && !!$('#tabMore'), 'strip, + and list buttons shown');

  await click(tabs()[1], 300);
  ok(active() === 1 && rows().includes('b-two') && !rows().includes('a-') && side().includes('b-main') && !side().includes('a-main') && !$('#sideList .sb-stash'),
    'b shows only its own data', state() + ' | ' + rows() + ' | ' + side());

  await click(tabs()[0], 300);
  ok(!!$('#sideList .sb-stash'), 'a shows its stash', side());
  const two = $$('#body .row[data-i]').find(r => r.textContent.includes('a-two'));
  await click(two, 50);
  const hashOf = r => r && window.__gitkrapao.S.commits[+r.dataset.i].hash;
  const picked = hashOf($('#body .row.sel'));
  await click(tabs()[1], 300);
  await click(tabs()[0], 400);
  ok(picked && hashOf($('#body .row.sel')) === picked, 'selection restored', picked + ' vs ' + hashOf($('#body .row.sel')));

  // a's stash list answers only after b is showing.
  await click(tabs()[1], 300);
  f.hold.stashA = true;
  await click(tabs()[0], 300);
  ok(f.pending('stashA') === 1, 'a: stash list pending', f.pending('stashA'));
  await click(tabs()[1], 300);
  f.release('stashA'); await wait(200);
  ok(rows().includes('b-two') && !$('#sideList .sb-stash') && !rows().includes('a-'), 'late results from A are dropped', rows() + ' | ' + side());

  // A poll of a that is still waiting for its fingerprint when b starts loading
  // must not go on to ask anything about a.
  await click(tabs()[0], 300);
  f.hold.fpA = true;
  ok(await until(() => f.pending('fpA') > 0), 'a: a poll is waiting for the fingerprint', f.pending('fpA'));
  await wait(4500);   // past the WIP interval, so a stray loadWip would call work_status
  f.hold.startB = true;
  await click(tabs()[1], 100);
  const n0 = f.calls.length;
  f.release('fpA', 'fp-moved'); await wait(300);
  ok(!callsFor(A, n0).length, 'a poll in flight leaves the tab it left alone', JSON.stringify(callsFor(A, n0)));
  // While b loads, nothing of a is on screen, and Refresh or a click on b cannot bring a back.
  ok(!rows().includes('a-') && !side().includes('a-main') && $('#repoName').textContent !== 'a' && !$('#sideList .sb-stash'),
    'while b loads nothing of a is shown', rows() + ' | ' + side() + ' | ' + $('#repoName').textContent);
  const loading = $('#tabLoading');
  ok(!loading.hidden && loading.textContent === 'Loading history…' && $('#emptyState').hidden && $('#tabBusy').hidden,
    'while b loads a spinner sits in the middle', loading.hidden + ' | ' + loading.textContent);
  const startsB = () => callsFor(B).filter(c => c[0] === 'start_history').length, sb = startsB(), n3 = f.calls.length;
  key('r', { ctrlKey: true }); await wait(100);
  $('#refreshBtn').click(); await wait(100);
  await click(tabs()[1], 100);
  ok(!callsFor(A, n3).length && startsB() === sb, 'while b loads Refresh and a click on b do not load a', JSON.stringify(f.calls.slice(n3)));
  f.release('startB'); await wait(300);
  ok(rows().includes('b-two') && active() === 1, 'b loads after the wait', rows());
  ok(loading.hidden, 'the spinner goes once b is shown');
  // A refresh keeps the graph on screen: no spinner over it.
  f.hold.startB = true;
  key('r', { ctrlKey: true }); await wait(100);
  ok(loading.hidden && rows().includes('b-two'), 'a refresh keeps the graph without the spinner', loading.hidden + ' | ' + rows());
  f.release('startB'); await wait(300);
  const n1 = f.calls.length;
  await wait(10000);
  ok(!callsFor(A, n1).length && callsFor(B, n1).some(c => c[0] === 'repo_fingerprint'), 'background tabs are idle', JSON.stringify(f.calls.slice(n1)));

  // New tab: the empty state with recents; picking a repo that is open already
  // goes to its tab and drops the empty one.
  seedRecent();
  const genB = f.genOf[B], st0 = f.stops.length;
  key('t', { ctrlKey: true }); await wait(100);
  ok(genB > 0 && f.stops.slice(st0).includes(genB), 'new tab stops the history stream of b', genB + ' ' + JSON.stringify(f.stops));
  ok(tabs().length === 3 && names()[2] === 'New tab' && active() === 2 && empty() && $$('#emptyRecent .recent-item').length === 3, 'new tab', state() + ' | empty=' + empty());
  await click($('#emptyRecent .recent-item[data-path="' + A + '"]'), 300);
  ok(tabs().length === 2 && names().join() === 'a,b' && active() === 0 && rows().includes('a-three') && !empty(), 'new tab: picking an open repo activates its tab', state());

  // The recent menu opens into the active tab; a repo that fails keeps its tab.
  await click(tabs()[1], 300);
  seedRecent();
  $('#repoBtn').click(); await wait(30);
  await click($('#recentMenu [data-path="C:/fake/gone"]'), 300);
  ok(banner().includes('not inside a Git repository') && names().join() === 'a,gone' && active() === 1 && empty(), 'recent menu replaces the active tab', state() + ' | ' + banner());
  ok(tabs()[1].title === 'C:/fake/gone', 'failed tab keeps the requested path', tabs()[1].title);
  await click($$('#tabs .tab-x')[1], 300);
  ok(names().join() === 'a' && active() === 0 && rows().includes('a-three') && !empty(), 'recent menu: the failed tab closes', state());

  // [a, b, New] -> close a while active -> b (its right neighbour).
  seedRecent();
  key('t', { ctrlKey: true }); await wait(100);
  await click($('#emptyRecent .recent-item[data-path="' + B + '"]'), 300);
  key('t', { ctrlKey: true }); await wait(100);
  ok(names().join() === 'a,b,New tab' && active() === 2, 'three tabs', state());
  await click(tabs()[0], 300);
  await click($$('#tabs .tab-x')[0], 300);
  ok(names().join() === 'b,New tab' && active() === 0 && rows().includes('b-two') && !empty(), 'close active picks right neighbour', state() + ' | ' + rows());
  const starts = () => f.calls.filter(c => c[0] === 'start_history').length, s0 = starts();
  await click($$('#tabs .tab-x')[1], 300);
  ok(names().join() === 'b' && active() === 0 && rows().includes('b-two') && starts() === s0, 'close background keeps active', state() + ' starts ' + s0 + '->' + starts());
  await click($$('#tabs .tab-x')[0], 300);
  const n2 = f.calls.length;
  await wait(4000);
  ok(!tabs().length && empty() && !$('#tabNew').hidden && !$$('#body .row[data-i]').length && f.calls.length === n2,
    'close last shows empty state', state() + ' | rows ' + $$('#body .row[data-i]').length + ' | calls ' + JSON.stringify(f.calls.slice(n2)));
  const rec = (JSON.parse(localStorage.getItem('lanes.recent')) || []).map(r => r.path);
  ok(rec.includes(A) && rec.includes(B), 'closing keeps recents', localStorage.getItem('lanes.recent'));

  // Shortcuts on [a, b, New].
  seedRecent();
  await click($('#emptyRecent .recent-item[data-path="' + A + '"]'), 300);
  ok(names().join() === 'a' && active() === 0 && rows().includes('a-three'), 'no tabs: opening creates one', state());
  key('t', { ctrlKey: true }); await wait(100);
  await click($('#emptyRecent .recent-item[data-path="' + B + '"]'), 300);
  key('t', { ctrlKey: true }); await wait(100);
  const seq = [];
  key('Tab', { ctrlKey: true }); await wait(300); seq.push(active());
  key('Tab', { ctrlKey: true, shiftKey: true }); await wait(300); seq.push(active());
  key('2', { ctrlKey: true }); await wait(300); seq.push(active());
  key('9', { ctrlKey: true }); await wait(300); seq.push(active());
  ok(seq.join() === '0,2,1,2', 'shortcuts: Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+2, Ctrl+9', seq.join());
  const saved = () => JSON.parse(localStorage.getItem('lanes.tabs'));
  const ab = [{ path: A, name: 'a' }, { path: B, name: 'b' }];
  ok(JSON.stringify(saved()) === JSON.stringify({ tabs: ab, active: 1 }), 'persisted: no empty tabs', localStorage.getItem('lanes.tabs'));
  key('w', { ctrlKey: true }); await wait(300);
  ok(names().join() === 'a,b' && active() === 1 && rows().includes('b-two'), 'shortcuts: Ctrl+W closes the active tab', state());
  key('1', { ctrlKey: true }); await wait(300);
  const last = JSON.parse(localStorage.getItem('lanes.last') || 'null');
  ok(JSON.stringify(saved()) === JSON.stringify({ tabs: ab, active: 0 }) && last && last.path === A && !('lockKey' in last),
    'persisted', localStorage.getItem('lanes.tabs') + ' | ' + localStorage.getItem('lanes.last'));

  // Keys inside the strip move focus; Enter activates; the list button lists every tab.
  tabs()[0].focus();
  tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  ok(document.activeElement === tabs()[1] && active() === 0, 'strip: ArrowRight moves focus only');
  tabs()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  ok(document.activeElement === tabs()[0], 'strip: ArrowRight wraps');
  await click($('#tabMore'), 50);
  const items = $$('#tabList .menu-item');
  ok(!$('#tabList').hidden && items.length === 2 && items[1].textContent.includes('b') && items[1].textContent.includes(B), 'tab list shows name and path', $('#tabList').textContent);
  const lr = $('#tabList').getBoundingClientRect(), mr = $('#tabMore').getBoundingClientRect();
  ok(lr.left >= 0 && lr.right <= document.documentElement.clientWidth && Math.abs(lr.right - mr.right) <= 1,
    'tab list stays inside the window, right edge under the ▾ button', JSON.stringify([lr.left, lr.right, mr.right, document.documentElement.clientWidth]));
  await click(items[1], 300);
  ok($('#tabList').hidden && active() === 1 && rows().includes('b-two'), 'tab list activates the tab', state());

  // A fetch in a: the load of a asked for meanwhile runs when it ends only if a's tab is active.
  const fetchedA = from => callsFor(A, from).filter(c => c[0] === 'start_history').length;
  await click(tabs()[0], 300);
  $('#fetchBtn').click(); await wait(100);
  ok(f.pending('fetch') === 1, 'a: fetch running', f.pending('fetch'));
  await click(tabs()[1], 300);
  const genB2 = f.genOf[B], st1 = f.stops.length;
  await click(tabs()[0], 300);   // a's load waits for the fetch
  ok(!rows().includes('a-') && !rows().includes('b-') && active() === 0, 'a: nothing of b shown while a waits for its fetch', rows());
  ok(genB2 > 0 && f.stops.slice(st1).includes(genB2), 'a tab waiting for its fetch stops the history stream of b', genB2 + ' ' + JSON.stringify(f.stops));
  await click(tabs()[1], 300);
  const n4 = f.calls.length;
  f.release('fetch'); await wait(400);
  ok(active() === 1 && rows().includes('b-two') && !fetchedA(n4), 'a fetch ending under another tab loads nothing there', rows() + ' | ' + JSON.stringify(f.calls.slice(n4)));
  await click(tabs()[0], 300);
  ok(rows().includes('a-three'), 'a loads once its fetch is over', rows());
  $('#fetchBtn').click(); await wait(100);
  await click(tabs()[1], 300);
  await click(tabs()[0], 300);
  const n5 = f.calls.length;
  f.release('fetch'); await wait(400);
  ok(active() === 0 && rows().includes('a-three') && fetchedA(n5) === 1, 'a fetch ending in the active tab runs its waiting load', rows());

  // A page of c still on its way when the last tab closes must not land in the empty state.
  localStorage.setItem('lanes.recent', JSON.stringify([{ path: 'C:/fake/c', name: 'c' }]));
  key('w', { ctrlKey: true }); await wait(300);
  key('w', { ctrlKey: true }); await wait(300);
  ok(!tabs().length && empty(), 'all tabs closed', state());
  f.hold.page = true;
  await click($('#emptyRecent .recent-item[data-path="C:/fake/c"]'), 300);
  // A redraw near the end asks for the next page. A theme change redraws at once (a scroll
  // waits for an animation frame, which headless Edge does not always deliver).
  $('#themeBtn').click(); $('#themeBtn').click();
  const prefetched = await until(() => f.pending('page') === 1);
  ok(rows().includes('c-two') && prefetched, 'c: second page pending', rows() + ' | ' + f.pending('page') + ' | more=' + window.__gitkrapao.S.more + ' loading=' + document.body.className);
  key('w', { ctrlKey: true }); await wait(200);
  f.release('page'); await wait(300);
  ok(!tabs().length && empty() && !$$('#body .row[data-i]').length && $('#stats').textContent === '' && document.title === 'GitKrapao' && !banner(),
    'a late page after closing the last tab is dropped', $$('#body .row[data-i]').length + ' rows | ' + $('#stats').textContent + ' | ' + document.title + ' | ' + banner());

  // WIP polls are per repo: a's work_status still on its way does not hold back b's.
  seedRecent();
  key('t', { ctrlKey: true }); await wait(100);   // the empty state lists the recents seeded just now
  await click($('#emptyRecent .recent-item[data-path="' + A + '"]'), 300);
  seedRecent();
  key('t', { ctrlKey: true }); await wait(100);
  await click($('#emptyRecent .recent-item[data-path="' + B + '"]'), 300);
  ok(names().join() === 'a,b' && active() === 1, 'wip: tabs a, b', state());
  f.hold.wipA = true;
  await click(tabs()[0], 300);
  ok(f.pending('wipA') === 1, 'wip: a status on its way', f.pending('wipA'));
  f.wipB = true;
  await click(tabs()[1], 300);
  const wipShown = () => !!$('#body .wip-row') && !$('#body .wip-row').hidden;
  ok(rows().includes('b-two') && wipShown(), 'wip: b shows its WIP row while a status is still on its way', rows() + ' | ' + JSON.stringify(f.calls.filter(c => c[0] === 'work_status')));
  f.release('wipA'); await wait(200);
  ok(active() === 1 && wipShown() && rows().includes('b-two'), 'wip: the late status of a changes nothing in b', rows());
  f.wipB = false;

  // A tab whose repo was deleted during the session (open_repo answered before):
  // the banner says so, nothing stays on screen and the recent list forgets it.
  await click(tabs()[0], 300);
  seedRecent();
  f.fail[B] = 'C:/fake/b is gone';
  await click(tabs()[1], 300);
  const recent = () => (JSON.parse(localStorage.getItem('lanes.recent')) || []).map(r => r.path);
  ok(banner() === 'C:/fake/b is gone' && empty() && !rows().includes('a-') && $('#stats').textContent === '', 'deleted repo: banner, empty state', banner() + ' | ' + rows() + ' | ' + $('#stats').textContent);
  ok(!recent().includes(B) && recent().includes(A), 'deleted repo: forgotten from recents', localStorage.getItem('lanes.recent'));
  delete f.fail[B];
});`;
