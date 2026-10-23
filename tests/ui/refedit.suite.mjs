// Rename a branch, delete a branch or tag, and Undo a delete. The menus:
// a local branch (panel leaf or graph label) gets "Rename branch…" and
// "Delete branch…" (Delete off on the checked-out branch); a tag label gets
// "Delete tag…" and "Copy tag name"; remote branches get nothing new. Rename
// reuses the create dialog. Each runs as one operation (toolbar text, other
// actions off, Output). The backend asks every confirmation itself, so the
// page invokes at once. A delete shows the Undo bar (its token goes back to
// restore_ref); it hides on ×, on the next operation and on a tab switch,
// survives a sync, and comes back when the restore was refused before
// anything was written. Hidden / solo entries follow a rename and drop a
// deleted branch for every tab of the repo (then a full reload); a result in
// a background tab updates the lists but shows no bar.
export const prodSafe = true;
export const budget = 120000;
export const setup = () => `<script>
(() => {
  const DEMO = 'C:/fake/demo', WT = 'C:/fake/demo-wt', OTHER = 'C:/fake/other';
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40), E = 'e'.repeat(40);
  const refs = { refs: [[A, 'refs/heads/main'], [A, 'refs/remotes/origin/main'], [C, 'refs/heads/feat'], [B, 'refs/remotes/origin/only'],
                        [D, 'refs/tags/v1'], [E, 'refs/heads/old'], [E, 'refs/heads/team/a']],
                 headRef: 'refs/heads/main', headSha: A };
  const rec = (h, p, t, s) => h + '\\x1f' + p + '\\x1fT\\x1ft@t\\x1f' + t + '\\x1f' + t + '\\x1f\\x1f' + s + '\\x1e\\n';
  const log = rec(C, B, 1700000300, 'feat work') + rec(A, B, 1700000200, 'main work') + rec(B, D, 1700000150, 'mid')
    + rec(D, E, 1700000120, 'tagged') + rec(E, '', 1700000100, 'root');
  const keys = { [DEMO]: DEMO, [WT]: DEMO, [OTHER]: OTHER };
  // op: resolves the operation running now (rename, delete, restore, fetch).
  const f = window.__fake = { calls: [], op: null, refs };
  const held = () => new Promise(res => { f.op = res; });
  const answers = {
    open_repo: a => ({ path: a.path, name: a.path.split('/').pop(), lockKey: keys[a.path] }),
    start_history: () => ({ gen: 1, remotes: ['origin'], fingerprint: 'fp', refs }),
    history_page: () => ({ log, more: false, capped: false }),
    repo_fingerprint: () => 'fp',
    branch_tracking: () => [],
    list_stashes: () => [],
    pull_requests: () => ({ repo: null, items: [] }),
    work_status: () => ({ files: [], total: 0 }),
    sync_history: () => ({ fingerprintBefore: 'fp', fingerprintAfter: 'fp', refs, log: '', over: false }),
    list_remotes: () => ['origin'],
    stop_history: () => null,
    commit_detail: () => ({ body: 'x', files: [], totalFiles: 0, add: 0, del: 0 }),
    rename_branch: held, delete_branch: held, delete_tag: held, restore_ref: held, fetch: held,
  };
  window.__TAURI__ = { core: { invoke: (cmd, args) => {
    f.calls.push([cmd, args || {}]);
    const a = answers[cmd];
    return a ? Promise.resolve(a(args || {})) : new Promise(() => {});
  } } };
  localStorage.setItem('lanes.tabs', JSON.stringify({ tabs: [DEMO, WT, OTHER].map(p => ({ path: p, name: p.split('/').pop() })), active: 0 }));
})();
</script>`;
export const probe = `
run(async () => {
  const f = window.__fake, $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const DEMO = 'C:/fake/demo', WT = 'C:/fake/demo-wt', OTHER = 'C:/fake/other';
  const count = (c, path) => f.calls.filter(([n, a]) => n === c && (!path || a.path === path)).length;
  const last = c => { const a = f.calls.filter(([n]) => n === c).pop(); return a && JSON.stringify(a[1]); };
  const ctx = el => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 })); };
  const items = () => $$('#ctxMenu .menu-item');
  const labels = () => items().map(b => b.querySelector('.n').textContent + (b.disabled ? '(off)' : '')).join(',');
  const reason = name => { const b = items().find(b => b.querySelector('.n').textContent === name); return b && b.querySelector('.p') ? b.querySelector('.p').textContent : ''; };
  const pick = name => { const b = items().find(b => b.querySelector('.n').textContent === name); if (b) b.click(); return !!b; };
  const esc = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(20); };
  const leaf = ref => $('#sideList .sb-leaf[data-ref="' + ref + '"]');
  const pill = name => $$('#body .row .pill').find(p => p.querySelector('.name').textContent === name);
  const msg = subject => $$('#body .row .col-msg').find(m => m.textContent.startsWith(subject));
  const tabs = () => $$('#tabs [role=tab]');
  const dlg = $('#createDlg'), name = $('#cName'), go = $('#cGo'), err = $('#cErr');
  const type = v => { name.value = v; name.dispatchEvent(new Event('input', { bubbles: true })); };
  const res = (summary, extra = {}) => ({ ok: true, timedOut: false, cancelled: false, durationMs: 120, exitCode: 0,
    command: 'git x', stdout: '', stderr: '', summary, ...extra });
  const del = (token, name, kind = 'branch', short = 'ccccccc', onOrigin = false) => ({ token, kind, name, short, onOrigin });
  const finish = async r => { const op = f.op; f.op = null; op(r); await wait(250); };
  const bar = $('#undoBar'), barMsg = () => $('#undoMsg').textContent;
  const lists = k => JSON.parse(localStorage.getItem(k) || '{}');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  await wait(300);

  // Each tab of the repo is opened once, so every one has its lock key.
  tabs()[1].click(); await wait(300);
  tabs()[0].click(); await wait(300);
  ok($('#repoName').textContent === 'demo', 'demo is active', $('#repoName').textContent);
  ok(!!bar && bar.hidden, 'no Undo bar at start');
  ok($('#undoClose').getAttribute('aria-label') === 'Dismiss' && $('#undoBtn').textContent === 'Undo', 'Undo bar buttons');

  // ---- menus ----
  ctx(leaf('refs/heads/feat')); await wait(30);
  ok(labels() === 'Switch to feat,Hide,Copy branch name,Rename branch…,Delete branch…', 'panel: local branch', labels());
  await esc();
  ctx(leaf('refs/heads/main')); await wait(30);
  ok(labels() === 'Switch to main(off),Hide(off),Copy branch name,Rename branch…,Delete branch…(off)', 'panel: checked-out branch', labels());
  ok(reason('Delete branch…') === 'The checked-out branch cannot be deleted', 'says why Delete is off', reason('Delete branch…'));
  await esc();
  ctx(leaf('refs/remotes/origin/only')); await wait(30);
  ok(labels() === 'Switch to origin/only,Hide,Copy branch name', 'panel: remote branch gets nothing new', labels());
  await esc();
  ctx(pill('feat')); await wait(30);
  ok(labels() === 'Switch to feat,Hide,Copy branch name,Rename branch…,Delete branch…,Create branch here…,Create tag here…', 'graph: local branch label', labels());
  await esc();
  ctx(pill('main')); await wait(30);
  ok(labels().includes('Delete branch…(off)') && reason('Delete branch…') === 'The checked-out branch cannot be deleted', 'graph: checked-out label', labels());
  await esc();
  ctx(pill('only')); await wait(30);
  ok(labels() === 'Switch to origin/only,Hide,Copy branch name,Create branch here…,Create tag here…', 'graph: remote-only label', labels());
  await esc();
  ctx(pill('v1')); await wait(30);
  ok(labels() === 'Delete tag…,Copy tag name,Create branch here…,Create tag here…', 'graph: tag label', labels());
  pick('Create tag here…'); await wait(30);
  ok(dlg.open && $('#cHash').textContent === 'ddddddd', 'tag label: Create acts on its commit', $('#cHash').textContent);
  await esc();

  // ---- rename dialog ----
  ctx(pill('feat')); await wait(30);
  pick('Rename branch…'); await wait(30);
  ok(dlg.open && $('#cTitle').textContent === 'Rename branch' && go.textContent === 'Rename', 'rename dialog', $('#cTitle').textContent + '/' + go.textContent);
  ok(name.value === 'feat' && name.selectionStart === 0 && name.selectionEnd === 4 && document.activeElement === name, 'old name filled in and selected');
  ok(dlg.querySelector('.c-at').hidden && $('#cMsgRow').hidden && $('#cSwitchRow').hidden, 'no commit, message or switch rows');
  ok(go.disabled && err.textContent === '', 'Rename off while the name is unchanged');
  type('Feat');
  ok(go.disabled && err.textContent === 'Only the letter case changes; Windows stores both names as one file.', 'case-only change refused', err.textContent);
  type('main');
  ok(go.disabled && err.textContent === 'A branch named main already exists.', 'taken name', err.textContent);
  type('team');
  ok(go.disabled && err.textContent === 'Clashes with the branch team/a', 'folder clash', err.textContent);
  type('a b');
  ok(go.disabled && /space/.test(err.textContent), 'bad name', err.textContent);
  type('feat/x');
  ok(!go.disabled && err.textContent === '', 'feat -> feat/x allowed (no clash with itself)', err.textContent);
  const syncs = count('sync_history'), loads = count('start_history');
  go.click(); await wait(30);
  ok(!dlg.open && last('rename_branch') === JSON.stringify({ path: DEMO, from: 'feat', to: 'feat/x' }), 'rename_branch called', last('rename_branch'));
  ok($('#fetchBtn').title === 'Renaming branch…', 'toolbar: Renaming branch…', $('#fetchBtn').title);
  ctx(leaf('refs/heads/old')); await wait(30);
  ok(reason('Rename branch…') === 'Renaming branch…' && reason('Delete branch…') === 'Renaming branch…', 'menu off meanwhile, says why', labels());
  await esc();
  await finish(res('Renamed branch feat to feat/x.'));
  ok(count('sync_history') === syncs + 1 && count('start_history') === loads, 'lists unchanged: one sync, no reload');
  ok(bar.hidden, 'no Undo bar after a rename');

  // The create dialog is itself again afterwards.
  ctx(msg('root')); await wait(30);
  pick('Create branch here…'); await wait(30);
  ok(dlg.open && $('#cTitle').textContent === 'Create branch' && go.textContent === 'Create branch' && name.value === '', 'create dialog after a rename');
  ok(!dlg.querySelector('.c-at').hidden && !$('#cSwitchRow').hidden && $('#cMsgRow').hidden, 'create rows back');
  type('feat');
  ok(go.disabled && err.textContent === 'A branch named feat already exists.', 'create: no self exclusion', err.textContent);
  await esc();

  // ---- delete branch, Undo ----
  ctx(leaf('refs/heads/feat')); await wait(30);
  pick('Delete branch…'); await wait(30);
  ok(!dlg.open && last('delete_branch') === JSON.stringify({ path: DEMO, name: 'feat' }), 'delete_branch called at once (the backend asks)', last('delete_branch'));
  ok($('#fetchBtn').title === 'Deleting branch…', 'toolbar: Deleting branch…', $('#fetchBtn').title);
  const s2 = count('sync_history');
  await finish(res('Deleted branch feat (was ccccccc).', { deleted: del(7, 'feat') }));
  ok(!bar.hidden && barMsg() === 'Deleted branch feat (ccccccc)', 'Undo bar', barMsg());
  ok(count('sync_history') === s2 + 1 && !bar.hidden, 'the bar survives the sync');
  $('#undoBtn').click(); await wait(30);
  ok(last('restore_ref') === JSON.stringify({ path: DEMO, token: 7 }), 'Undo sends the token', last('restore_ref'));
  ok(bar.hidden && $('#fetchBtn').title === 'Restoring…', 'bar hidden while restoring', $('#fetchBtn').title);
  // Refused before anything was written: the backend keeps the token, the bar comes back.
  await finish(res('A branch named feat already exists, so feat (' + 'c'.repeat(40) + ') was not restored.', { ok: false, exitCode: null }));
  ok(!bar.hidden && barMsg() === 'Deleted branch feat (ccccccc)', 'refused restore: the bar is back', barMsg());
  ok(!$('#banner').hidden && /already exists/.test($('#bannerMsg').textContent), 'and the banner says why');
  $('#bannerClose').click();
  $('#undoBtn').click(); await wait(30);
  ok(last('restore_ref') === JSON.stringify({ path: DEMO, token: 7 }), 'Undo again, same token');
  await finish(res('Restored branch feat at ccccccc.'));
  ok(bar.hidden, 'restored: no bar');

  // A tag, its push to origin failed: the banner and the bar both show.
  ctx(pill('v1')); await wait(30);
  pick('Delete tag…'); await wait(30);
  ok(last('delete_tag') === JSON.stringify({ path: DEMO, name: 'v1' }), 'delete_tag called', last('delete_tag'));
  ok($('#fetchBtn').title === 'Deleting tag…', 'toolbar: Deleting tag…', $('#fetchBtn').title);
  await finish(res('Deleted tag v1 (ddddddd) here; deleting it on origin failed: x', { ok: false, exitCode: 1, deleted: del(8, 'v1', 'tag', 'ddddddd') }));
  ok(!$('#banner').hidden && !bar.hidden && barMsg() === 'Deleted tag v1 (ddddddd)', 'push failed: banner and bar', barMsg());
  $('#bannerClose').click();
  $('#undoClose').click();
  ok(bar.hidden, '× hides the bar');

  // Deleted on origin too.
  ctx(pill('v1')); await wait(30);
  pick('Delete tag…'); await wait(30);
  await finish(res('Deleted tag v1 (ddddddd) here and on origin.', { deleted: del(9, 'v1', 'tag', 'ddddddd', true) }));
  ok(barMsg() === 'Deleted tag v1 (ddddddd) here and on origin. Undo restores it here only.', 'on origin: says Undo is local only', barMsg());

  // A new delete replaces the bar (hidden while it runs).
  ctx(pill('feat')); await wait(30);
  pick('Delete branch…'); await wait(30);
  ok(bar.hidden, 'the next operation hides the bar');
  await finish(res('Deleted.', { deleted: del(10, 'feat') }));
  ok(!bar.hidden && barMsg() === 'Deleted branch feat (ccccccc)', 'new bar', barMsg());
  // Any other operation hides it too.
  $('#fetchBtn').click(); await wait(30);
  ok(bar.hidden && count('fetch') === 1, 'fetch hides the bar');
  await finish(res('Fetched.'));
  ok(bar.hidden, 'and it stays hidden');

  // Cancelled in the native dialog: nothing deleted, no bar.
  ctx(pill('feat')); await wait(30);
  pick('Delete branch…'); await wait(30);
  await finish(res('Cancelled; nothing deleted.', { ok: false, cancelled: true, exitCode: null }));
  ok(bar.hidden && $('#banner').hidden, 'cancelled: no bar, no banner');

  // The newest token is the one Undo sends.
  ctx(pill('feat')); await wait(30);
  pick('Delete branch…'); await wait(30);
  await finish(res('Deleted.', { deleted: del(11, 'feat') }));
  $('#undoBtn').click(); await wait(30);
  ok(last('restore_ref') === JSON.stringify({ path: DEMO, token: 11 }), 'Undo sends the newest token', last('restore_ref'));
  await finish(res('Restored branch feat at ccccccc.'));

  // A tab switch hides it.
  ctx(pill('feat')); await wait(30);
  pick('Delete branch…'); await wait(30);
  await finish(res('Deleted.', { deleted: del(12, 'feat') }));
  ok(!bar.hidden, 'bar before the tab switch');
  tabs()[2].click(); await wait(300);
  ok(bar.hidden, 'a tab switch hides the bar');
  tabs()[0].click(); await wait(300);
  ok(bar.hidden, 'and it does not come back');

  // ---- hidden / solo follow ----
  localStorage.setItem('lanes.hidden', JSON.stringify({ [DEMO]: ['refs/heads/old', 'refs/heads/team/'], [WT]: ['refs/heads/old'], [OTHER]: ['refs/heads/old'] }));
  localStorage.setItem('lanes.solo', JSON.stringify({ [WT]: ['refs/heads/old', 'refs/heads/feat'] }));
  $('#refreshBtn').click(); await wait(300);
  ctx(leaf('refs/heads/old')); await wait(30);
  pick('Rename branch…'); await wait(30);
  ok(name.value === 'old', 'rename a hidden branch from the panel', name.value);
  type('new'); go.click(); await wait(30);
  ok(last('rename_branch') === JSON.stringify({ path: DEMO, from: 'old', to: 'new' }), 'rename_branch old -> new', last('rename_branch'));
  const s3 = count('sync_history'), l3 = count('start_history');
  await finish(res('Renamed branch old to new.'));
  const h = lists('lanes.hidden'), so = lists('lanes.solo');
  ok(same(h[DEMO], ['refs/heads/new', 'refs/heads/team/']), 'hidden entry follows; the folder stays', JSON.stringify(h[DEMO]));
  ok(same(h[WT], ['refs/heads/new']) && same(so[WT], ['refs/heads/new', 'refs/heads/feat']), 'the worktree tab follows too', JSON.stringify([h[WT], so[WT]]));
  ok(same(h[OTHER], ['refs/heads/old']), 'another repo is not touched', JSON.stringify(h[OTHER]));
  ok(count('start_history') === l3 + 1 && count('sync_history') === s3, 'lists changed: full reload instead of a sync');
  ok(last('start_history') === JSON.stringify({ path: DEMO, hidden: ['refs/heads/new', 'refs/heads/team/'], solo: [] }), 'reloaded with the new list', last('start_history'));

  // A delete drops the entry.
  ctx(pill('feat')); await wait(30);
  pick('Delete branch…'); await wait(30);
  await finish(res('Deleted.', { deleted: del(13, 'feat') }));
  ok(same(lists('lanes.solo')[WT], ['refs/heads/new']), 'deleted branch leaves the solo list', JSON.stringify(lists('lanes.solo')[WT]));
  $('#undoClose').click();

  // ---- background tab ----
  localStorage.setItem('lanes.hidden', JSON.stringify({ [DEMO]: ['refs/heads/feat', 'refs/heads/team/'] }));
  ctx(leaf('refs/heads/feat')); await wait(30);
  pick('Delete branch…'); await wait(30);
  tabs()[2].click(); await wait(300);
  ok($('#repoName').textContent === 'other', 'other tab active', $('#repoName').textContent);
  const l4 = count('start_history', DEMO), y4 = count('sync_history', DEMO);
  await finish(res('Deleted.', { deleted: del(14, 'feat') }));
  ok(bar.hidden, 'background result: no bar');
  ok(same(lists('lanes.hidden')[DEMO], ['refs/heads/team/']), 'background result: lists updated', JSON.stringify(lists('lanes.hidden')[DEMO]));
  ok(count('start_history', DEMO) === l4 && count('sync_history', DEMO) === y4, 'background result: nothing loaded');
  ok($('#outList .out-item:last-child .out-sum').textContent === 'Deleted.', 'logged in Output');
  tabs()[0].click(); await wait(300);
  ok(bar.hidden, 'back in the tab: no bar');

  // ---- HEAD names the branch in another letter case ----
  // On Windows HEAD "refs/heads/FEAT" resolves through the file of "feat":
  // that is the checked-out branch, so Delete is off for it.
  f.refs.headRef = 'refs/heads/FEAT'; f.refs.headSha = 'c'.repeat(40);
  $('#refreshBtn').click(); await wait(300);
  ctx(leaf('refs/heads/feat')); await wait(30);
  ok(reason('Delete branch…') === 'The checked-out branch cannot be deleted', 'panel: HEAD in another case, Delete off', labels());
  await esc();
  // The graph has no label "FEAT", so it shows HEAD first: feat is in the "+N" box.
  const cRef = msg('feat work').closest('.row').querySelector('.col-ref');
  cRef.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await wait(250);
  const popFeat = $$('#body .ref-pop:not([hidden]) .pill').find(p => p.querySelector('.name').textContent === 'feat');
  ok(!!popFeat, 'feat is in the label box');
  if (popFeat) ctx(popFeat); await wait(30);
  ok(reason('Delete branch…') === 'The checked-out branch cannot be deleted', 'graph: HEAD in another case, Delete off', labels());
  await esc();
});`;
