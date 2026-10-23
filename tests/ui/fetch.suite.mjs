// Fetch button, ahead/behind in the toolbar and the Output drawer, against a
// fake __TAURI__ whose `fetch` stays pending until the probe resolves it.
// While a fetch runs nothing polls and Refresh is off; afterwards the graph
// syncs once. Text from git is never markup.
export const prodSafe = true;
export const budget = 90000;
export const variants = [{ name: 'remotes' }, { name: 'none' }];
export const setup = v => `<script>
(() => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40);
  const refs = { refs: [[A, 'refs/heads/main'], [A, 'refs/remotes/origin/main']], headRef: 'refs/heads/main', headSha: A };
  const log = A + '\\x1f' + B + '\\x1fT\\x1ft@t\\x1f1700000100\\x1f1700000100\\x1f\\x1ftwo\\x1e\\n'
            + B + '\\x1f\\x1fT\\x1ft@t\\x1f1700000000\\x1f1700000000\\x1f\\x1fone\\x1e';
  const f = window.__fake = {
    calls: [], fetch: null,
    remotes: ${v.name === 'none' ? '[]' : "['origin']"},
    track: [{ name: 'main', upstream: 'refs/remotes/origin/main', ahead: 2, behind: 5, gone: false }],
  };
  const answers = {
    open_repo: a => ({ path: a.path, name: 'demo', lockKey: a.path }),
    start_history: () => ({ gen: 1, remotes: f.remotes, fingerprint: 'fp', refs }),
    history_page: () => ({ log, more: false, capped: false }),
    repo_fingerprint: () => 'fp',
    branch_tracking: () => f.track,
    list_stashes: () => [],
    pull_requests: () => ({ repo: null, items: [] }),
    work_status: () => ({ files: [], total: 0 }),
    sync_history: () => ({ fingerprintBefore: 'fp', fingerprintAfter: 'fp', refs, log: '', over: false }),
    list_remotes: () => f.remotes,
    stop_history: () => null,
    commit_detail: () => ({ body: 'x', files: [], totalFiles: 0, add: 0, del: 0 }),
    fetch: () => new Promise(res => { f.fetch = res; }),
  };
  window.__TAURI__ = { core: { invoke: (cmd, args) => {
    f.calls.push(cmd);
    const a = answers[cmd];
    return a ? Promise.resolve(a(args || {})) : new Promise(() => {});
  } } };
  localStorage.setItem('lanes.last', JSON.stringify({ path: 'C:/fake/demo', name: 'demo' }));
})();
</script>`;
export const probe = `
run(async () => {
  const f = window.__fake, $ = s => document.querySelector(s);
  const btn = $('#fetchBtn'), count = c => f.calls.filter(x => x === c).length;
  const done = (extra = {}) => ({ ok: true, timedOut: false, cancelled: false, durationMs: 1200, exitCode: 0,
    command: 'git fetch --all --prune', stdout: '', stderr: '', summary: 'Fetched: already up to date.', ...extra });
  await wait(300);
  ok(!btn.hidden, 'fetch button shown in desktop mode');
  const r = $('.tb-mid').getBoundingClientRect(), mid = (r.left + r.right) / 2;
  ok(Math.abs(mid - innerWidth / 2) <= 1 && $('.tb-mid').contains(btn) && $('.tb-mid').contains($('#branchBtn')),
    'Fetch and Create branch in the middle of the toolbar', mid + ' vs ' + innerWidth / 2);
  const bs = getComputedStyle(btn);
  ok(bs.backgroundColor === 'rgba(0, 0, 0, 0)' && bs.borderTopColor === 'rgba(0, 0, 0, 0)', 'no background or border', bs.backgroundColor + ' / ' + bs.borderTopColor);
  ok(btn.textContent.trim() === '' && btn.getAttribute('aria-label') === 'Fetch' && btn.title === (f.remotes.length ? 'Fetch all remotes (Ctrl/⌘ Shift F)' : 'No remotes'),
    'icon only: name and tooltip', JSON.stringify([btn.textContent, btn.getAttribute('aria-label'), btn.title]));
  const theme = $('#themeBtn').getBoundingClientRect(), bar = $('.toolbar').getBoundingClientRect();
  ok(Math.abs(bar.right - 14 - theme.right) <= 1, 'the right group still ends at the right edge', theme.right + ' vs ' + bar.right);
  // About 1000px wide with long names: the left group shrinks (names end in
  // "…") instead of its items running over each other or the middle.
  const tb = $('.toolbar'), keep = [$('#repoName').textContent, $('#headName').textContent];
  tb.style.width = '1000px';
  $('#repoName').textContent = 'a-very-long-repository-name-for-testing';
  $('#headName').textContent = 'feature/a-very-long-branch-name-here';
  const kids = [...$('.tb-l').children].filter(e => e.getBoundingClientRect().width > 0).map(e => e.getBoundingClientRect());
  const overlap = kids.slice(1).some((k, i) => k.left < kids[i].right - 0.5)
    || $('#repoBtn').getBoundingClientRect().right > $('.tb-l .sep').getBoundingClientRect().left;   // the button reaches 7px past its box
  ok(!overlap && kids[kids.length - 1].right <= $('.tb-mid').getBoundingClientRect().left + 0.5 && Math.round($('#sideBtn').getBoundingClientRect().width) === 30,
    'narrow toolbar, long names: no overlap', JSON.stringify(kids.map(k => [Math.round(k.left), Math.round(k.right)])));
  tb.style.width = ''; [$('#repoName').textContent, $('#headName').textContent] = keep;
  ok(!$('#openBtn'), 'no Open repo button (the repo menu, Ctrl/⌘ O and the empty page open one)');

  if (!f.remotes.length) {
    ok(btn.getAttribute('aria-disabled') === 'true' && btn.title === 'No remotes', 'no remotes: disabled with "No remotes"', btn.title);
    btn.click(); await wait(50);
    ok(!count('fetch'), 'no remotes: clicking does nothing');
    ok($('#out').hidden, 'no remotes: no drawer');
    return;
  }

  const track = $('#headTrack');
  ok(!track.hidden && track.textContent === '↑2 ↓5', 'ahead/behind next to the branch', track.textContent);
  ok(track.title === '2 ahead, 5 behind origin/main', 'ahead/behind tooltip', track.title);
  ok(btn.getAttribute('aria-disabled') === 'false', 'enabled with a remote');
  ok($('#out').hidden, 'drawer hidden before any fetch');

  // 1: success. No polling while it runs; one sync afterwards.
  btn.click(); await wait(20);
  ok(count('fetch') === 1, 'click starts a fetch');
  ok(btn.classList.contains('running') && btn.getAttribute('aria-disabled') === 'true' && btn.getAttribute('aria-busy') === 'true', 'spinner and disabled while running');
  ok(btn.getAttribute('aria-label') === 'Fetching' && btn.title === 'Fetching all remotes…', 'icon only: name and tooltip while running', btn.getAttribute('aria-label') + ' | ' + btn.title);
  const fp = count('repo_fingerprint'), ws = count('work_status'), sync = count('sync_history');
  await wait(10000);
  ok(count('repo_fingerprint') === fp && count('work_status') === ws, 'no polling during the fetch', (count('repo_fingerprint') - fp) + ' polls');
  btn.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true }));
  await wait(20);
  ok(count('fetch') === 1, 'no second fetch while one runs');
  f.fetch(done({ stderr: 'From x\\n   1..2  main -> origin/main', summary: 'Fetched: 1 ref updated.' }));
  await wait(200);
  ok(!btn.classList.contains('running') && btn.getAttribute('aria-disabled') === 'false', 'button back after the fetch');
  ok(count('sync_history') === sync + 1, 'graph syncs once after the fetch', count('sync_history') - sync);
  ok($('#banner').hidden, 'no banner on success');
  ok(!$('#out').hidden && $('#outList').hidden, 'drawer appears collapsed');
  ok($('#outLast').textContent.includes('Fetched: 1 ref updated.'), 'drawer bar shows the last summary', $('#outLast').textContent);
  await wait(4000);
  ok(count('repo_fingerprint') > fp, 'polling resumes');

  // 2: Refresh is off during the fetch (button and Ctrl+R); afterwards one sync, no reload.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true }));
  await wait(20);
  ok(count('fetch') === 2, 'Ctrl+Shift+F fetches');
  const sh = count('start_history'), sy = count('sync_history');
  ok($('#refreshBtn').getAttribute('aria-disabled') === 'true', 'refresh is off during the fetch', $('#refreshBtn').title);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
  $('#refreshBtn').click();
  await wait(50);
  ok(count('start_history') === sh, 'no reload during the fetch');
  f.track = [];
  f.fetch(done());
  await wait(300);
  ok(count('start_history') === sh && count('sync_history') === sy + 1, 'the refresh was not kept for later: one sync only');
  ok(track.hidden, 'ahead/behind hidden without an upstream');
  ok($('#refreshBtn').getAttribute('aria-disabled') === 'false', 'refresh is back after the fetch');

  // 3: failure with markup in git's text.
  btn.click(); await wait(20);
  window.__pwned = false;
  f.fetch(done({ ok: false, exitCode: 128, summary: 'Authentication failed <b>x</b>',
    stderr: '<img src=x onerror="window.__pwned=true">fatal: Authentication failed' }));
  await wait(200);
  ok(!$('#banner').hidden && $('#bannerMsg').textContent === 'Authentication failed <b>x</b>', 'banner shows the summary as text');
  ok(!$('#outList').hidden && $('#outBar').getAttribute('aria-expanded') === 'true', 'drawer opens on failure');
  const last = $('#outList .out-item:last-child');
  ok(last.classList.contains('fail') && last.querySelector('.out-st').textContent === 'exit 128', 'failed entry shows its exit status');
  ok(last.querySelector('pre').textContent.startsWith('<img'), 'stderr shown as text');
  ok(!document.querySelector('#outList img, #banner b') && !window.__pwned, 'git text never becomes markup');

  // 4: the next successful fetch clears that error; a cancel shows none.
  btn.click(); await wait(20);
  f.fetch(done());
  await wait(200);
  ok($('#banner').hidden, 'a successful fetch clears the stale fetch error');
  btn.click(); await wait(20);
  f.fetch(done({ ok: false, cancelled: true, exitCode: null, durationMs: 0, summary: 'Fetch cancelled: the repository was not trusted.' }));
  await wait(200);
  ok($('#banner').hidden, 'cancel shows no banner');
  ok($('#outList .out-item:last-child .out-st').textContent === 'cancelled', 'cancel is logged');

  // 5: only the last 50 entries are kept.
  for (let i = 0; i < 55; i++) { btn.click(); await wait(5); f.fetch(done({ summary: 'n' + i })); await wait(30); }
  const items = document.querySelectorAll('#outList .out-item');
  ok(items.length === 50, 'keeps the last 50 entries', items.length);
  ok(items[49].querySelector('.out-sum').textContent === 'n54', 'newest last');

  $('#outBar').click(); await wait(20);
  ok($('#outList').hidden && $('#outBar').getAttribute('aria-expanded') === 'false', 'drawer collapses on click');
});`;
