// Rebuilds docs/screenshots/graph-{dark,light}.png for the README: the
// production bundle in headless Microsoft Edge, with a fake __TAURI__ that
// answers from .mock/demo-repo (run `pnpm run mock` first). The data comes
// from the same git commands the Rust backend runs, so the graph is the real
// one; nothing touches the app's own WebView data or a real repository.
//
// usage: node scripts/screenshots.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..'), repo = join(root, '.mock', 'demo-repo');
if (!existsSync(join(repo, '.git', 'gitkrapao-mock'))) { console.error('Run `pnpm run mock` first.'); process.exit(1); }
const edge = process.env.EDGE_PATH || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) { console.error('Microsoft Edge not found; set EDGE_PATH'); process.exit(2); }
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 << 20 }).toString();

/* ---------- what the backend would answer (lib.rs) ---------- */
const log = git('log', '--date-order', '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%x1f%s%x1e', '--branches', '--remotes', '--tags', 'HEAD');
const refs = git('for-each-ref', '--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags')
  .split('\n').filter(Boolean).map(l => l.split('\0')).flatMap(([o, t, p, pt, n]) => t === 'commit' ? [[o, n]] : pt === 'commit' ? [[p, n]] : []);
const headRef = git('symbolic-ref', 'HEAD').trim(), headSha = git('rev-parse', 'HEAD').trim();
const tracking = git('for-each-ref', '--format=%(refname:strip=2)%00%(upstream)%00%(upstream:track,nobracket)', 'refs/heads')
  .split('\n').filter(Boolean).map(l => l.split('\0')).filter(([, up]) => up).map(([name, upstream, track]) => ({
    name, upstream, gone: track === 'gone',
    ahead: +(/ahead (\d+)/.exec(track) || [0, 0])[1], behind: +(/behind (\d+)/.exec(track) || [0, 0])[1],
  }));
const stashes = git('stash', 'list', '--format=%H%x1f%P%x1f%gd%x1f%ct%x1f%gs%x1e').split('\x1e').map(r => r.replace(/^\n/, '').split('\x1f'))
  .filter(f => f.length === 5).map(([sha, p, name, time, message]) => ({ sha, parents: p.split(' ').filter(Boolean), name, time: +time, message }));
// The card of the checked-out commit, which the shot selects.
const nums = git('show', '--format=', '--numstat', headSha).split('\n').filter(Boolean).map(l => l.split('\t'));
const stat = new Map(git('show', '--format=', '--name-status', headSha).split('\n').filter(Boolean).map(l => l.split('\t')).map(([s, p]) => [p, s[0]]));
const files = nums.map(([a, d, p]) => ({ status: stat.get(p) || 'M', path: p, oldPath: null, add: a === '-' ? null : +a, del: d === '-' ? null : +d }));
const detail = { body: git('show', '-s', '--format=%B', headSha).trimEnd(), files, totalFiles: files.length,
  add: files.reduce((n, f) => n + (f.add || 0), 0), del: files.reduce((n, f) => n + (f.del || 0), 0) };
const data = { log, refs: { refs, headRef, headSha }, tracking, stashes, detail, headSha };

/* ---------- the page ---------- */
const out = mkdtempSync(join(tmpdir(), 'gitkrapao-shots-'));
const b = spawnSync(process.execPath, [join(root, 'scripts', 'web.mjs'), '--out', out], { stdio: 'inherit' });
if (b.status !== 0) process.exit(b.status || 1);
// Three tabs (only the active one loads); the checked-out commit selected.
const setup = theme => `<script>
(() => {
  const D = ${JSON.stringify(data)}, P = 'C:/work/demo-repo';
  const answers = {
    open_repo: a => ({ path: a.path, name: a.path.split('/').pop(), lockKey: a.path }),
    start_history: () => ({ gen: 1, remotes: ['origin'], fingerprint: 'fp', refs: D.refs }),
    history_page: a => ({ log: a.start ? '' : D.log, more: false, capped: false }),
    repo_fingerprint: () => 'fp', branch_tracking: () => D.tracking, list_stashes: () => D.stashes,
    pull_requests: () => ({ repo: null, items: [] }), work_status: () => ({ files: [], total: 0 }),
    list_remotes: () => ['origin'], stop_history: () => null,
    commit_detail: a => a.sha === D.headSha ? D.detail : { body: '', files: [], totalFiles: 0, add: 0, del: 0 },
  };
  window.__TAURI__ = { core: { invoke: (cmd, args) => { const f = answers[cmd]; return f ? Promise.resolve(f(args || {})) : new Promise(() => {}); } } };
  localStorage.setItem('lanes.theme', '${theme}');
  localStorage.setItem('lanes.tabs', JSON.stringify({ tabs: [{ path: P, name: 'demo-repo' }, { path: 'C:/work/acme-api', name: 'acme-api' },
    { path: 'C:/work/design-system', name: 'design-system' }], active: 0 }));
})();
</script>`;
const select = `<script>
setTimeout(() => { const h = document.querySelector('#body .pill.head'); if (h) h.closest('.row').click(); }, 1500);
</script>`;
const html = readFileSync(join(out, 'index.html'), 'utf8').replace('<head>', () => `<head><base href="${pathToFileURL(out).href}/">`);

for (const theme of ['dark', 'light']) {
  const page = join(out, `shot-${theme}.html`);
  writeFileSync(page, html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`)
    .replace('<script src="app.js"></script>', () => `${setup(theme)}<script src="app.js"></script>${select}`));
  const prof = mkdtempSync(join(tmpdir(), 'gitkrapao-shot-'));
  const png = join(root, 'docs', 'screenshots', `graph-${theme}.png`);
  const r = spawnSync(edge, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files',`--user-data-dir=${prof}`,
    '--virtual-time-budget=4000', '--window-size=1440,880', `--screenshot=${png}`, pathToFileURL(page).href], { encoding: 'utf8' });
  rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (r.status !== 0 || !existsSync(png)) { console.error(r.stderr); process.exit(1); }
  console.log(`wrote ${png}`);
}
rmSync(out, { recursive: true, force: true });
