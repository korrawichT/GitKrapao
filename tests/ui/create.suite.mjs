// Creating a branch or tag: right-click a commit row (or a label on it), then
// "Create branch here…" / "Create tag here…" opens a dialog that checks the
// name as it is typed. Create runs as one operation, like fetch and switch:
// the toolbar shows it, the repo's other actions are off meanwhile, the
// result goes to the Output drawer (a failure also to the banner) and the
// graph syncs once afterwards.
export const prodSafe = true;
export const budget = 60000;
export const setup = () => `<script>
(() => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
  const refs = { refs: [[A, 'refs/heads/main'], [A, 'refs/remotes/origin/main'], [C, 'refs/heads/feat'], [B, 'refs/tags/v1']],
                 headRef: 'refs/heads/main', headSha: A };
  const rec = (h, p, t, s) => h + '\\x1f' + p + '\\x1fT\\x1ft@t\\x1f' + t + '\\x1f' + t + '\\x1f\\x1f' + s + '\\x1e\\n';
  const log = rec(C, B, 1700000300, 'feat work') + rec(A, B, 1700000200, 'main work')
    + rec(B, '', 1700000000, 'root <img src=x onerror="window.__pwned=true">');
  const f = window.__fake = { calls: [], args: [], create: null };
  const answers = {
    open_repo: a => ({ path: a.path, name: 'demo', lockKey: a.path }),
    start_history: () => ({ gen: 1, remotes: ['origin'], fingerprint: 'fp', refs }),
    history_page: () => ({ log, more: false, capped: false }),
    repo_fingerprint: () => 'fp',
    branch_tracking: () => [],
    list_stashes: () => [],
    pull_requests: () => ({ repo: null, items: [] }),
    work_status: () => ({ files: [{ path: 'a.txt', oldPath: null, staged: '', unstaged: 'M', conflict: false }], total: 1 }),
    sync_history: () => ({ fingerprintBefore: 'fp', fingerprintAfter: 'fp', refs, log: '', over: false }),
    list_remotes: () => ['origin'],
    stop_history: () => null,
    commit_detail: () => ({ body: 'x', files: [], totalFiles: 0, add: 0, del: 0 }),
    create_branch: () => new Promise(res => { f.create = res; }),
    create_tag: () => new Promise(res => { f.create = res; }),
  };
  window.__TAURI__ = { core: { invoke: (cmd, args) => {
    f.calls.push(cmd); f.args.push([cmd, args]);
    const a = answers[cmd];
    return a ? Promise.resolve(a(args || {})) : new Promise(() => {});
  } } };
  localStorage.setItem('lanes.last', JSON.stringify({ path: 'C:/fake/demo', name: 'demo' }));
})();
</script>`;
export const probe = `
run(async () => {
  const f = window.__fake, $ = s => document.querySelector(s);
  const B = 'b'.repeat(40), C = 'c'.repeat(40);
  const count = c => f.calls.filter(x => x === c).length;
  const last = c => { const a = f.args.filter(([n]) => n === c).pop(); return a && JSON.stringify(a[1]); };
  const ctx = el => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 })); };
  const items = () => [...document.querySelectorAll('#ctxMenu .menu-item')];
  const labels = () => items().map(b => b.querySelector('.n').textContent + (b.disabled ? '(off)' : '')).join(',');
  const pick = name => { const b = items().find(b => b.querySelector('.n').textContent === name); if (b) b.click(); return !!b; };
  const key = (k, o = {}) => $('#cName').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
  const msg = subject => [...document.querySelectorAll('#body .row .col-msg')].find(m => m.textContent.startsWith(subject));
  const dlg = $('#createDlg'), name = $('#cName'), go = $('#cGo'), err = $('#cErr');
  const type = v => { name.value = v; name.dispatchEvent(new Event('input', { bubbles: true })); };
  const done = (summary, extra = {}) => ({ ok: true, timedOut: false, cancelled: false, durationMs: 120, exitCode: 0,
    command: 'git branch x', stdout: '', stderr: '', summary, ...extra });
  await wait(300);
  ok(!dlg.open, 'no dialog at start');

  // The WIP row is not a commit: nothing to create there.
  const wip = $('#body .wip-row');
  ok(!!wip, 'WIP row shown');
  ctx(wip); await wait(30);
  ok($('#ctxMenu').hidden || !labels().includes('Create'), 'no Create on the WIP row', labels());

  // Over text selected in a row, the WebView's own menu (Copy) stays; a
  // selection somewhere else does not take the Create menu away.
  const sel = el => { getSelection().removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); getSelection().addRange(r); };
  sel(msg('main work'));
  const over = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  msg('main work').dispatchEvent(over); await wait(30);
  ok(!over.defaultPrevented && $('#ctxMenu').hidden, 'selected row text: the WebView menu, not Create');
  sel(msg('feat work'));
  ctx(msg('main work')); await wait(30);
  ok(labels() === 'Create branch here…,Create tag here…', 'a selection elsewhere: Create menu', labels());
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(20);
  getSelection().removeAllRanges();

  // Right-click a commit row: it is selected, and the menu offers both.
  ctx(msg('root')); await wait(30);
  ok(labels() === 'Create branch here…,Create tag here…', 'commit row menu', labels());
  ok(msg('root').parentElement.classList.contains('sel'), 'the commit is selected');
  pick('Create branch here…'); await wait(30);
  ok(dlg.open && $('#cTitle').textContent === 'Create branch', 'branch dialog opens', $('#cTitle').textContent);
  ok($('#cHash').textContent === 'bbbbbbb', 'names the commit', $('#cHash').textContent);
  ok($('#cSubject').textContent.startsWith('root <img') && !dlg.querySelector('img') && !window.__pwned, 'subject shown as text');
  ok(document.activeElement === name && name.value === '', 'name box focused and empty');
  ok(go.disabled && err.textContent === '', 'Create off until a name is typed, no error yet');
  ok(!$('#cSwitchRow').hidden && $('#cSwitch').checked && $('#cMsgRow').hidden, 'switch box on by default; no tag message');

  type('a b');
  ok(go.disabled && /space/.test(err.textContent) && name.getAttribute('aria-invalid') === 'true', 'bad name: says why', err.textContent);
  type('Main');
  ok(go.disabled && err.textContent === 'A branch named main already exists.', 'taken name (another case)', err.textContent);
  type('feat/x');
  ok(go.disabled && err.textContent === 'Clashes with the branch feat', 'clash with a branch folder', err.textContent);
  type('topic');
  ok(!go.disabled && err.textContent === '' && name.getAttribute('aria-invalid') === 'false', 'good name: Create on');

  // Typing never drives the graph, and app shortcuts are off while it is open;
  // F5 still never reloads the page (nor refreshes the graph behind it).
  key('j'); key('k'); await wait(30);
  ok(msg('root').parentElement.classList.contains('sel'), 'j/k in the box leave the selection');
  key('F', { ctrlKey: true, shiftKey: true }); await wait(30);
  ok(count('fetch') === 0 && dlg.open, 'Ctrl Shift F does not fetch from the dialog');
  const loads = count('start_history'), f5 = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true });
  name.dispatchEvent(f5); await wait(30);
  ok(f5.defaultPrevented && dlg.open && count('start_history') === loads, 'F5 in the dialog: no reload, no refresh');

  go.click(); await wait(30);
  ok(!dlg.open, 'Create closes the dialog');
  ok(last('create_branch') === JSON.stringify({ path: 'C:/fake/demo', name: 'topic', at: B, checkout: true }), 'create_branch with the full hash', last('create_branch'));
  ok($('#headName').textContent === 'Switching…', 'switching: the toolbar says so', $('#headName').textContent);
  ok($('#fetchBtn').getAttribute('aria-disabled') === 'true' && $('#fetchBtn').title === 'Creating branch…', 'Fetch off meanwhile', $('#fetchBtn').title);
  ctx(msg('main work')); await wait(30);
  ok(labels() === 'Create branch here…(off),Create tag here…(off)', 'menu off while it runs', labels());
  const why = items().map(b => b.querySelector('.p')?.textContent).join(',');
  ok(why === 'Creating branch…,Creating branch…', 'says what is running', why);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(20);
  const featPill = [...document.querySelectorAll('#body .pill')].find(p => p.textContent.includes('feat'));
  ctx(featPill); await wait(30);
  const sw = items().find(b => b.querySelector('.n').textContent === 'Switch to feat');
  ok(sw && sw.disabled && sw.querySelector('.p').textContent === 'Creating branch…', 'Switch to is off with the same reason', sw && sw.querySelector('.p').textContent);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(20);
  const sync = count('sync_history');
  f.create(done('Created branch topic at bbbbbbb. Switched to topic.')); await wait(200);
  ok(count('sync_history') === sync + 1, 'graph syncs once afterwards');
  ok($('#outList .out-item:last-child .out-sum').textContent === 'Created branch topic at bbbbbbb. Switched to topic.', 'logged in Output');
  ok($('#banner').hidden, 'no banner on success');

  // Without switching.
  ctx(msg('main work')); await wait(30);
  pick('Create branch here…'); await wait(30);
  type('topic2'); $('#cSwitch').click();
  go.click(); await wait(30);
  ok(last('create_branch') === JSON.stringify({ path: 'C:/fake/demo', name: 'topic2', at: 'a'.repeat(40), checkout: false }), 'checkout false', last('create_branch'));
  ok($('#headName').textContent === 'main', 'not switching: branch name stays', $('#headName').textContent);
  f.create(done('Created branch topic2 at aaaaaaa.')); await wait(200);

  // A tag from a graph label's menu: "Switch to" stays first, Create comes last.
  const pill = [...document.querySelectorAll('#body .pill')].find(p => p.textContent.includes('feat'));
  ctx(pill); await wait(30);
  ok(labels() === 'Switch to feat,Hide,Copy branch name,Create branch here…,Create tag here…', 'label menu', labels());
  pick('Create tag here…'); await wait(30);
  ok(dlg.open && $('#cTitle').textContent === 'Create tag' && $('#cHash').textContent === 'ccccccc', 'tag dialog for the label commit');
  ok($('#cSwitchRow').hidden && !$('#cMsgRow').hidden && $('#cMsg').value === '', 'message box, no switch box');
  type('V1');
  ok(go.disabled && err.textContent === 'A tag named v1 already exists.', 'taken tag name', err.textContent);
  type('v2'); $('#cMsg').value = '   ';
  go.click(); await wait(30);
  ok(last('create_tag') === JSON.stringify({ path: 'C:/fake/demo', name: 'v2', at: C, message: null }), 'blank message: lightweight', last('create_tag'));
  ok($('#fetchBtn').title === 'Creating tag…' && $('#headName').textContent === 'main', 'tag: no switching', $('#fetchBtn').title);
  f.create(done('Created tag v2 at ccccccc.')); await wait(200);

  ctx(msg('root')); await wait(30);
  pick('Create tag here…'); await wait(30);
  type('v3'); $('#cMsg').value = '  Release 3 ';
  go.click(); await wait(30);
  ok(last('create_tag') === JSON.stringify({ path: 'C:/fake/demo', name: 'v3', at: B, message: 'Release 3' }), 'message: annotated', last('create_tag'));
  f.create(done('boom', { ok: false, exitCode: 128 })); await wait(200);
  ok(!$('#banner').hidden && $('#bannerMsg').textContent === 'boom', 'failure goes to the banner');
  $('#bannerClose').click();

  // Escape and Cancel close without creating anything.
  const made = count('create_branch') + count('create_tag');
  ctx(msg('root')); await wait(30);
  pick('Create branch here…'); await wait(30);
  type('never'); key('Escape'); await wait(30);
  ok(!dlg.open, 'Escape closes');
  ctx(msg('root')); await wait(30);
  pick('Create branch here…'); await wait(30);
  ok(name.value === '' && go.disabled, 'opens empty again');
  type('never'); $('#cCancel').click(); await wait(30);
  ok(!dlg.open && count('create_branch') + count('create_tag') === made, 'Cancel closes; nothing created');

  // A click on the backdrop closes it; one that only ends there (selecting
  // text in the box and letting go outside) does not.
  ctx(msg('root')); await wait(30);
  pick('Create branch here…'); await wait(30);
  type('drag');
  name.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  dlg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  ok(dlg.open && name.value === 'drag', 'a drag out of the dialog keeps it open');
  dlg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  dlg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  ok(!dlg.open && count('create_branch') + count('create_tag') === made, 'a backdrop click closes it; nothing created');

  // A dialog's 'close' event comes later, on an animation frame (never, in
  // this headless run): one left over from an earlier close that arrives
  // while the dialog is open again must not wipe it.
  ctx(msg('root')); await wait(30);
  pick('Create tag here…'); await wait(30);
  dlg.dispatchEvent(new Event('close'));
  type('V1');
  ok(dlg.open && err.textContent === 'A tag named v1 already exists.', 'a late close event leaves the open dialog alone', err.textContent);
  type('v9'); go.click(); await wait(30);
  ok(last('create_tag') === JSON.stringify({ path: 'C:/fake/demo', name: 'v9', at: B, message: null }), 'and creates', last('create_tag'));
  f.create(done('Created tag v9 at bbbbbbb.')); await wait(200);
});`;
