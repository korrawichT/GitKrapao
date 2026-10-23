// Builds a fake but realistic Git repository for developing GitKrapao without
// touching real work repos: main/develop/feature/release/hotfix branches,
// pull-request merges, annotated tags, remote-tracking refs, several authors,
// English messages, and adds, edits, deletes, renames and a binary.
//
// usage: node scripts/mock-repo.mjs [outDir]    (default: .mock/demo-repo)
// The output is rebuilt on every run; the same input always gives the same history.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..', '.mock', 'demo-repo'));
const MARKER = path.join(out, '.git', 'gitkrapao-mock');
// lanes-mock: the marker written before the rename to GitKrapao.
if (existsSync(out) && readdirSync(out).length && !existsSync(MARKER) && !existsSync(path.join(out, '.git', 'lanes-mock'))) {
  console.error(`Refusing to delete ${out}: it exists and was not made by this script.`);
  process.exit(1);
}
// Retries: a git process (GitKrapao polling this repo, an editor) can hold the folder for a moment on Windows.
rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
mkdirSync(out, { recursive: true });
const git = (args, input) => execFileSync('git', ['-C', out, ...args], { input, stdio: ['pipe', 'pipe', 'inherit'] }).toString();
git(['init', '-q', '-b', 'main']);
// LF in the work tree whatever the global setting, so stashes hold only real edits.
git(['config', 'core.autocrlf', 'false']);

/* ---------- deterministic randomness and clock ---------- */
let seed = 20260301;
const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
let clock = Date.UTC(2026, 2, 2, 2, 0) / 1000;           // 2 Mar 2026, 09:00 in Bangkok
const tick = () => (clock += int(20, 9 * 60) * 60);

const PEOPLE = [
  ['Nattaya Kongsri', 'nattaya@example.com'], ['Somchai Prasert', 'somchai@example.com'],
  ['Alex Rivera', 'alex@example.com'], ['Pim Suwan', 'pim@example.com'],
  ['Jordan Lee', 'jordan@example.com'], ['Kamol Jaidee', 'kamol@example.com'],
];

/* ---------- fast-import stream ---------- */
const chunks = [];
let markSeq = 0;
const emit = s => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
const data = s => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'); emit(`data ${b.length}\n`); emit(b); emit('\n'); };
const quote = p => '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

const branches = new Map();   // name -> { mark, files: Map(path -> content), deleted: Set(path) }
const dropped = [];          // branches deleted after merging, removed once imported
function commitTo(name, msg, changes, { who = pick(PEOPLE), merge = [] } = {}){
  const b = branches.get(name);
  const files = new Map(b ? b.files : []), deleted = new Set(b ? b.deleted : []);
  const ops = [];
  for (const c of changes) {
    if (c.op === 'M') {
      const blob = ++markSeq;
      emit(`blob\nmark :${blob}\n`); data(c.content);
      ops.push(`M 100644 :${blob} ${c.path}\n`); files.set(c.path, c.content);
    } else if (c.op === 'D') { ops.push(`D ${quote(c.path)}\n`); files.delete(c.path); deleted.add(c.path); }
    else if (c.op === 'R') { ops.push(`R ${quote(c.from)} ${quote(c.to)}\n`); files.set(c.to, files.get(c.from)); files.delete(c.from); deleted.add(c.from); }
  }
  const mark = ++markSeq, t = tick();
  emit(`commit refs/heads/${name}\nmark :${mark}\n`);
  emit(`author ${who[0]} <${who[1]}> ${t} +0700\ncommitter ${who[0]} <${who[1]}> ${t} +0700\n`);
  data(msg);
  if (b) emit(`from :${b.mark}\n`);
  merge.forEach(m => emit(`merge :${m}\n`));
  ops.forEach(emit);
  emit('\n');
  branches.set(name, { mark, files, deleted });
  return mark;
}
const branchOff = (name, from) => { const b = branches.get(from); branches.set(name, { mark: b.mark, files: new Map(b.files), deleted: new Set(b.deleted) }); };
const drop = name => { branches.delete(name); dropped.push(name); };
const tagAt = (tag, mark, msg, t = clock) => { const w = PEOPLE[0]; emit(`tag ${tag}\nfrom :${mark}\ntagger ${w[0]} <${w[1]}> ${t} +0700\n`); data(msg); };
const remoteAt = (ref, mark) => emit(`reset refs/remotes/origin/${ref}\nfrom :${mark}\n\n`);

/* Merge `from` into `into`: the result takes every file that differs, and
   drops files that `from` deleted or renamed away. */
function mergeInto(into, from, msg, who){
  const a = branches.get(into).files, f = branches.get(from);
  const changes = [];
  for (const [p, c] of f.files) if (a.get(p) !== c) changes.push({ op: 'M', path: p, content: c });
  for (const p of a.keys()) if (!f.files.has(p) && f.deleted.has(p)) changes.push({ op: 'D', path: p });
  return commitTo(into, msg, changes, { who, merge: [f.mark] });
}

/* ---------- content helpers ---------- */
const edit = (files, p, line) => ({ op: 'M', path: p, content: (files.get(p) || '') + line + '\n' });
const png = n => { const b = Buffer.alloc(64 + n); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); for (let i = 8; i < b.length; i++) b[i] = Math.floor(rand() * 256); return b; };
const ts = name => `export function ${name.replace(/\W/g, '_')}() {\n  return '${name}';\n}\n`;

/* ---------- history ---------- */
const lead = PEOPLE[1];
commitTo('main', 'Initial commit', [
  { op: 'M', path: 'README.md', content: '# Acme Webapp\n\nSample project for trying out GitKrapao\n' },
  { op: 'M', path: 'package.json', content: '{\n  "name": "acme-webapp",\n  "version": "0.1.0"\n}\n' },
  { op: 'M', path: '.gitignore', content: 'node_modules/\ndist/\n' },
  { op: 'M', path: 'src/index.ts', content: ts('main') },
], { who: lead });
commitTo('main', 'Add project scaffolding and README', [edit(branches.get('main').files, 'README.md', '\n## Getting started\n\n    pnpm install\n'), { op: 'M', path: 'src/app.ts', content: ts('app') }], { who: lead });
commitTo('main', 'Set up CI pipeline', [{ op: 'M', path: '.github/workflows/ci.yml', content: 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n' }], { who: PEOPLE[4] });
commitTo('main', 'Add app logo and icons', [{ op: 'M', path: 'assets/logo.png', content: png(400) }], { who: PEOPLE[3] });
tagAt('v0.1.0', branches.get('main').mark, 'First tagged build');
branchOff('develop', 'main');

const FEATURES = ['auth', 'dashboard', 'notifications', 'dark-mode', 'export-csv', 'search', 'i18n-thai', 'payments', 'profile', 'audit-log', 'offline-mode', 'charts', 'onboarding', 'settings'];
const WORK = [
  x => `Add ${x} component`, x => `Wire up ${x} API`, x => `Fix ${x} edge case when the list is empty`,
  x => `Refactor ${x} into hooks`, x => `Add tests for ${x}`, x => `Polish ${x} styles`,
  x => `Speed up ${x} loading`, x => `Fix ${x} bug when there is no data`, x => `Add Thai translations to ${x}`,
];
const BODIES = [
  '', '', '',
  'The old version re-rendered on every keystroke.\n\n- debounce input by 150 ms\n- keep the cursor position',
  'Details:\n- check for empty values before calling the API\n- add a test for a user who is not signed in',
  'Follow-up to the review comments.\n\nCo-authored-by: Pim Suwan <pim@example.com>',
];
let pr = 10, minor = 1;
function featureCommit(br, x){
  const files = branches.get(br).files, roll = rand();
  const changes = [];
  const own = [...files.keys()].filter(p => p.includes(x));
  if (!own.length || roll < 0.3) changes.push({ op: 'M', path: `src/${x}/${pick(['index', 'view', 'store', 'api'])}.ts`, content: ts(x + int(1, 99)) });
  else changes.push(edit(files, pick(own), `// ${x} ${int(1, 999)}`));
  if (rand() < 0.35) changes.push(edit(files, files.has('src/main-app.ts') ? 'src/main-app.ts' : 'src/app.ts', `import './${x}';`));
  if (rand() < 0.15) changes.push({ op: 'M', path: `docs/${x}.md`, content: `# ${x}\n\nNotes for the team\n` });
  const subject = pick(WORK)(x), body = pick(BODIES);
  commitTo(br, body ? `${subject}\n\n${body}` : subject, changes);
}

for (let sprint = 0; sprint < 7; sprint++) {
  const active = [];
  for (let k = 0; k < int(2, 3); k++) {
    const n = sprint * 2 + k, x = FEATURES[n % FEATURES.length] + (n >= FEATURES.length ? '-v2' : ''), br = `feature/${x}`;
    if (branches.has(br)) continue;
    branchOff(br, 'develop');
    active.push({ br, x, left: int(2, 6) });
  }
  while (active.some(f => f.left > 0)) {
    if (rand() < 0.15) commitTo('develop', pick(['Update dependencies', 'Fix flaky date formatting test', 'Update CHANGELOG', 'Tidy lint warnings']),
      [edit(branches.get('develop').files, 'package.json', '')]);
    const f = pick(active.filter(a => a.left > 0));
    featureCommit(f.br, f.x); f.left--;
    if (f.left === 1 && rand() < 0.3) mergeInto(f.br, 'develop', `Merge branch 'develop' into ${f.br}`, pick(PEOPLE));
    if (f.left === 0) {
      mergeInto('develop', f.br, `Merge pull request #${++pr} from acme/${f.br}\n\n${f.x}`, lead);
      if (sprint < 6) drop(f.br);      // most merged branches get deleted
    }
  }
  // release
  const rel = `release/0.${++minor}`;
  branchOff(rel, 'develop');
  commitTo(rel, `Bump version to 0.${minor}.0`, [{ op: 'M', path: 'package.json', content: `{\n  "name": "acme-webapp",\n  "version": "0.${minor}.0"\n}\n` }], { who: lead });
  commitTo(rel, `Update CHANGELOG for 0.${minor}.0`, [edit(branches.get(rel).files, 'CHANGELOG.md', `## 0.${minor}.0\n- ${active.map(a => a.x).join(', ')}`)], { who: lead });
  tagAt(`v0.${minor}.0`, mergeInto('main', rel, `Merge branch '${rel}'`, lead), `Release 0.${minor}.0`);
  mergeInto('develop', rel, `Merge branch '${rel}' into develop`, lead);
  drop(rel);
  if (sprint === 1) {   // a rename and a delete land on develop
    const files = branches.get('develop').files;
    commitTo('develop', 'Rename app.ts to main-app.ts', [{ op: 'R', from: 'src/app.ts', to: 'src/main-app.ts' }]);
    if (files.has('.github/workflows/ci.yml')) commitTo('develop', 'Remove the old unused workflow', [{ op: 'D', path: '.github/workflows/ci.yml' }]);
  }
  if (sprint === 3 || sprint === 5) {   // hotfix on main
    const hf = `hotfix/login-crash-${sprint}`;
    branchOff(hf, 'main');
    commitTo(hf, 'Fix crash when session cookie is missing', [edit(branches.get(hf).files, 'src/index.ts', '// guard missing cookie')], { who: PEOPLE[2] });
    tagAt(`v0.${minor}.1`, mergeInto('main', hf, `Merge branch '${hf}'`, lead), `Hotfix 0.${minor}.1`);
    mergeInto('develop', hf, `Merge branch '${hf}' into develop`, lead);
    drop(hf);
  }
  if (sprint === 4) commitTo('develop', 'Update the logo', [{ op: 'M', path: 'assets/logo.png', content: png(520) }], { who: PEOPLE[3] });
}

// Work in progress at the end: open features, local branches ahead of origin.
const remote = {};
for (const x of ['reports', 'mobile-nav']) {
  const br = `feature/${x}`;
  branchOff(br, 'develop');
  for (let k = 0; k < 3; k++) { featureCommit(br, x); if (k === 1) remote[br] = branches.get(br).mark; }
}
remote.main = branches.get('main').mark;
remote.develop = branches.get('develop').mark;
commitTo('develop', 'WIP: unread badge in nav bar', [edit(branches.get('develop').files, 'src/main-app.ts', '// badge')], { who: PEOPLE[0] });
commitTo('develop', 'Make notification messages clearer', [edit(branches.get('develop').files, 'README.md', '- notifications')], { who: PEOPLE[5] });
for (const [ref, mark] of Object.entries(remote)) remoteAt(ref, mark);

/* ---------- write it ---------- */
const stream = Buffer.concat(chunks);
execFileSync('git', ['-C', out, 'fast-import', '--quiet', '--date-format=raw'], { input: stream, stdio: ['pipe', 'inherit', 'inherit'] });
git(['update-ref', '--stdin'], [...new Set(dropped)].filter(b => !branches.has(b)).map(b => `delete refs/heads/${b}\n`).join(''));
git(['symbolic-ref', 'HEAD', 'refs/heads/develop']);
git(['remote', 'add', 'origin', 'https://example.com/acme/webapp.git']);
git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
// Track the pushed branches, so the branch panel has ahead counts to show.
for (const b of Object.keys(remote)) git(['branch', '-q', `--set-upstream-to=origin/${b}`, b]);
git(['reset', '-q', '--hard']);

// Two stashes on develop: a plain WIP stash with an untracked file (-u), then a
// newer one with a message. Fixed identity and clock keep them identical
// across runs.
const stash = (when, edit, args) => {
  for (const [f, text] of edit) writeFileSync(path.join(out, f), text);
  const t = `${clock + when} +0700`;
  execFileSync('git', ['-C', out, '-c', 'core.autocrlf=false', '-c', 'user.name=Kamol Jaidee', '-c', 'user.email=kamol@example.com', 'stash', 'push', '-q', ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t }, stdio: ['ignore', 'ignore', 'inherit'],
  });
};
stash(3600, [['src/main-app.ts', '// draft: badge counter\n'], ['notes-draft.md', 'Scratch notes\n']], ['-u']);
stash(7200, [['README.md', '# acme-webapp\n\nTry a new theme color\n']], ['-m', 'Try a new theme color']);

writeFileSync(MARKER, 'Made by scripts/mock-repo.mjs; safe to delete.\n');
const count = git(['rev-list', '--count', '--branches', '--remotes', '--tags']).trim();
const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']).trim().split('\n');
console.log(`Mock repo: ${out}\n${count} commits; branches: ${refs.filter(r => !/^(v\d|origin)/.test(r)).join(', ')}; ${refs.filter(r => /^v\d/.test(r)).length} tags`);
