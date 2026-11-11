// Builds a fake but realistic Git repository for developing GitKrapao without
// touching real work repos. The history is scripted, so the graph is the same
// every time and reads well: several feature branches run side by side and
// merge back through pull requests, develop is merged into long-lived branches,
// releases and hotfixes merge into main and back, and a few branches are still
// open. It also has annotated tags, remote-tracking refs, six authors, English
// messages, one stash, and adds, edits, deletes, renames and a binary.
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
// LF in the work tree whatever the global setting, so the stash holds only real edits.
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

// name -> { mark, files: Map(path -> content), base: Map }. `base` is the tree the
// branch last shared with the branch it will merge into (where it was cut, or the
// last time it pulled that branch), so a merge takes only what the branch changed.
const branches = new Map();
const dropped = [];          // branches deleted after merging, removed once imported
function commitTo(name, msg, changes, { who = pick(PEOPLE), merge = [] } = {}){
  const b = branches.get(name);
  const files = new Map(b ? b.files : []);
  const ops = [];
  for (const c of changes) {
    if (c.op === 'M') {
      const blob = ++markSeq;
      emit(`blob\nmark :${blob}\n`); data(c.content);
      ops.push(`M 100644 :${blob} ${c.path}\n`); files.set(c.path, c.content);
    } else if (c.op === 'D') { ops.push(`D ${quote(c.path)}\n`); files.delete(c.path); }
    else if (c.op === 'R') { ops.push(`R ${quote(c.from)} ${quote(c.to)}\n`); files.set(c.to, files.get(c.from)); files.delete(c.from); }
  }
  const mark = ++markSeq, t = tick();
  emit(`commit refs/heads/${name}\nmark :${mark}\n`);
  emit(`author ${who[0]} <${who[1]}> ${t} +0700\ncommitter ${who[0]} <${who[1]}> ${t} +0700\n`);
  data(msg);
  if (b) emit(`from :${b.mark}\n`);
  merge.forEach(m => emit(`merge :${m}\n`));
  ops.forEach(emit);
  emit('\n');
  branches.set(name, { mark, files, base: b ? b.base : new Map() });
  return mark;
}
const branchOff = (name, from) => { const b = branches.get(from); branches.set(name, { mark: b.mark, files: new Map(b.files), base: new Map(b.files) }); };
const drop = name => { branches.delete(name); dropped.push(name); };
const tagAt = (tag, mark, msg, t = clock) => { const w = PEOPLE[0]; emit(`tag ${tag}\nfrom :${mark}\ntagger ${w[0]} <${w[1]}> ${t} +0700\n`); data(msg); };
const remoteAt = (ref, mark) => emit(`reset refs/remotes/origin/${ref}\nfrom :${mark}\n\n`);

/* What a merge changes: every file that `theirs` changed since `base` wins; a
   file that `ours` deleted stays deleted. */
function threeWay(ours, theirs, base){
  const changes = [];
  for (const p of new Set([...theirs.keys(), ...base.keys()])) {
    const t = theirs.get(p), o = ours.get(p), b = base.get(p);
    if (t === b || t === o) continue;
    if (o === undefined && b !== undefined) continue;
    changes.push(t === undefined ? { op: 'D', path: p } : { op: 'M', path: p, content: t });
  }
  return changes;
}
/* Merge `from` into `into` (a pull request, a release, a hotfix). */
const mergeInto = (into, from, msg, who) => {
  const f = branches.get(from);
  return commitTo(into, msg, threeWay(branches.get(into).files, f.files, f.base), { who, merge: [f.mark] });
};
/* A release branch is a full snapshot of develop, so main takes every file that
   differs, as a real merge would. */
const releaseInto = (into, from, msg, who) => {
  const a = branches.get(into).files, f = branches.get(from), changes = [];
  for (const [p, c] of f.files) if (a.get(p) !== c) changes.push({ op: 'M', path: p, content: c });
  for (const p of a.keys()) if (!f.files.has(p)) changes.push({ op: 'D', path: p });
  return commitTo(into, msg, changes, { who, merge: [f.mark] });
};
/* Merge `from` (develop) into a branch that is still open, so it catches up. */
const pullInto = (into, from, msg, who) => {
  const f = branches.get(from), i = branches.get(into);
  const mark = commitTo(into, msg, threeWay(i.files, f.files, i.base), { who, merge: [f.mark] });
  branches.get(into).base = new Map(f.files);
  return mark;
};

/* ---------- content helpers ---------- */
const edit = (files, p, line) => ({ op: 'M', path: p, content: (files.get(p) || '') + line + '\n' });
const png = n => { const b = Buffer.alloc(64 + n); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); for (let i = 8; i < b.length; i++) b[i] = Math.floor(rand() * 256); return b; };
const ts = name => `export function ${name.replace(/\W/g, '_')}() {\n  return '${name}';\n}\n`;

/* ---------- history ---------- */
const lead = PEOPLE[1];
const TEAM = [PEOPLE[0], PEOPLE[2], PEOPLE[3], PEOPLE[4], PEOPLE[5]];
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

/* Feature work: a branch has one owner, and its commits follow a fixed story,
   so no branch repeats a subject. */
const STORY = [
  x => `Add ${x} component`, x => `Wire up ${x} API`, x => `Add tests for ${x}`,
  x => `Fix ${x} edge case when the list is empty`, x => `Polish ${x} styles`, x => `Refactor ${x} into hooks`,
  x => `Add Thai translations to ${x}`,
];
const BODIES = {
  1: 'Calls the new endpoint and keeps the last good result while loading.',
  2: 'Details:\n- check for empty values before calling the API\n- add a test for a user who is not signed in',
  4: 'Follow-up to the review comments.\n\nCo-authored-by: Pim Suwan <pim@example.com>',
};
const owner = new Map(), told = new Map();
let pr = 10, ownerN = 0;
const open = br => { branchOff(br, 'develop'); owner.set(br, TEAM[ownerN++ % TEAM.length]); told.set(br, 0); };
function work(br, n = 1){
  const x = br.split('/').pop();
  for (let k = 0; k < n; k++) {
    const files = branches.get(br).files, i = told.get(br); told.set(br, i + 1);
    const own = [...files.keys()].filter(p => p.includes(x)), changes = [];
    if (!own.length) changes.push({ op: 'M', path: `src/${x}/index.ts`, content: ts(x) });
    else if (i % 3 === 1) changes.push({ op: 'M', path: `src/${x}/${pick(['view', 'store', 'api'])}.ts`, content: ts(x + int(1, 99)) });
    else changes.push(edit(files, pick(own), `// ${x} ${int(1, 999)}`));
    if (i === 1) changes.push(edit(files, files.has('src/main-app.ts') ? 'src/main-app.ts' : 'src/app.ts', `import './${x}';`));
    if (i === 3) changes.push({ op: 'M', path: `docs/${x}.md`, content: `# ${x}\n\nNotes for the team\n` });
    const subject = STORY[i % STORY.length](x), body = BODIES[i];
    commitTo(br, body ? `${subject}\n\n${body}` : subject, changes, { who: rand() < 0.15 ? pick(PEOPLE) : owner.get(br) });
  }
}
const land = br => { mergeInto('develop', br, `Merge pull request #${++pr} from acme/${br}\n\n${br.split('/').pop()}`, lead); drop(br); };
const catchUp = br => pullInto(br, 'develop', `Merge branch 'develop' into ${br}`, owner.get(br));
const chore = (msg, who = pick(PEOPLE)) => commitTo('develop', msg, [edit(branches.get('develop').files, 'docs/CONTRIBUTING.md', `- ${msg}`)], { who });
const bump = v => ({ op: 'M', path: 'package.json', content: `{\n  "name": "acme-webapp",\n  "version": "${v}"\n}\n` });

/* A release branch is cut from develop, merged into main (tagged) and back
   into develop. `during` runs while it is open, so develop keeps moving. */
function release(minor, during = () => {}){
  const rel = `release/0.${minor}`, v = `0.${minor}.0`;
  branchOff(rel, 'develop');
  commitTo(rel, `Bump version to ${v}`, [bump(v)], { who: lead });
  during();
  commitTo(rel, `Update CHANGELOG for ${v}`, [edit(branches.get(rel).files, 'CHANGELOG.md', `## ${v}`)], { who: lead });
  tagAt(`v${v}`, releaseInto('main', rel, `Merge branch '${rel}'`, lead), `Release ${v}`);
  mergeInto('develop', rel, `Merge branch '${rel}' into develop`, lead);
  drop(rel);
}
/* A fix on main, tagged, and merged back into develop. */
function hotfix(slug, v, who, msg){
  const hf = `hotfix/${slug}`;
  branchOff(hf, 'main');
  commitTo(hf, msg, [edit(branches.get(hf).files, 'src/index.ts', `// guard ${slug}`)], { who });
  tagAt(`v${v}`, mergeInto('main', hf, `Merge branch '${hf}'`, lead), `Hotfix ${v}`);
  mergeInto('develop', hf, `Merge branch '${hf}' into develop`, lead);
  drop(hf);
}

// v0.2.0: three features side by side, one catches up with develop.
open('feature/auth'); open('feature/dashboard');
work('feature/auth'); work('feature/dashboard'); work('feature/auth');
open('feature/notifications');
work('feature/dashboard', 2); work('feature/notifications'); work('feature/auth');
land('feature/auth');
work('feature/dashboard'); work('feature/notifications');
catchUp('feature/notifications'); work('feature/notifications');
land('feature/dashboard'); land('feature/notifications');
release(2, () => { open('feature/dark-mode'); work('feature/dark-mode'); chore('Update dependencies'); });

// v0.3.0: four features, a hotfix on main in the middle.
work('feature/dark-mode'); open('feature/search'); work('feature/search', 2); work('feature/dark-mode');
hotfix('login-crash', '0.2.1', PEOPLE[2], 'Fix crash when session cookie is missing');
open('feature/export-csv'); work('feature/export-csv'); work('feature/search');
catchUp('feature/dark-mode'); work('feature/dark-mode'); land('feature/dark-mode');
open('feature/i18n-thai'); work('feature/i18n-thai', 2); work('feature/export-csv', 2);
land('feature/search');
work('feature/i18n-thai'); catchUp('feature/export-csv'); work('feature/export-csv');
land('feature/export-csv'); land('feature/i18n-thai');
commitTo('develop', 'Remove the old unused workflow', [{ op: 'D', path: '.github/workflows/ci.yml' }], { who: PEOPLE[4] });
release(3, () => chore('Tidy lint warnings', PEOPLE[5]));

// v0.4.0: a rename lands first, then four features and a second hotfix.
commitTo('develop', 'Rename app.ts to main-app.ts', [{ op: 'R', from: 'src/app.ts', to: 'src/main-app.ts' }], { who: PEOPLE[0] });
open('feature/payments'); open('feature/profile');
work('feature/payments'); work('feature/profile', 2);
open('feature/charts'); work('feature/charts'); work('feature/payments', 2);
land('feature/profile');
open('feature/onboarding'); work('feature/charts', 2); work('feature/onboarding');
catchUp('feature/payments'); work('feature/payments');
land('feature/charts');
work('feature/onboarding', 2);
hotfix('payment-rounding', '0.3.1', PEOPLE[2], 'Fix rounding error in payment totals');
land('feature/payments'); catchUp('feature/onboarding'); work('feature/onboarding'); land('feature/onboarding');
release(4, () => { chore('Add pull request template', PEOPLE[3]); chore('Document the release process', PEOPLE[3]); });
commitTo('develop', 'Update the logo', [{ op: 'M', path: 'assets/logo.png', content: png(520) }], { who: PEOPLE[3] });

// Now: two features land, release/0.5 is cut, three more are still open.
open('feature/settings'); open('feature/audit-log');
work('feature/settings'); work('feature/audit-log', 2); work('feature/settings');
open('feature/reports'); work('feature/reports');
catchUp('feature/audit-log'); work('feature/audit-log');
land('feature/settings');
open('feature/mobile-nav'); work('feature/reports'); work('feature/mobile-nav', 2);
land('feature/audit-log');
const remote = {};
branchOff('release/0.5', 'develop');
commitTo('release/0.5', 'Bump version to 0.5.0', [bump('0.5.0')], { who: lead });
work('feature/reports'); remote['feature/reports'] = branches.get('feature/reports').mark;
open('feature/offline-mode'); work('feature/offline-mode', 2);
remote['feature/offline-mode'] = branches.get('feature/offline-mode').mark; drop('feature/offline-mode');   // pushed, never checked out here
work('feature/mobile-nav'); catchUp('feature/mobile-nav'); work('feature/mobile-nav');
commitTo('release/0.5', 'Update CHANGELOG for 0.5.0', [edit(branches.get('release/0.5').files, 'CHANGELOG.md', '## 0.5.0')], { who: lead });
remote['release/0.5'] = branches.get('release/0.5').mark;
remote['feature/mobile-nav'] = branches.get('feature/mobile-nav').mark;
chore('Upgrade TypeScript to 5.9', PEOPLE[5]);
work('feature/reports');
commitTo('release/0.5', 'Fix typo in the release notes', [edit(branches.get('release/0.5').files, 'CHANGELOG.md', '- fixed a typo')], { who: lead });
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
for (const b of Object.keys(remote)) if (branches.has(b)) git(['branch', '-q', `--set-upstream-to=origin/${b}`, b]);
git(['reset', '-q', '--hard']);

// One stash on develop: work in progress with an untracked file (-u) and a
// message. Fixed identity and clock keep it identical across runs.
const stash = (when, edit, args) => {
  for (const [f, text] of edit) writeFileSync(path.join(out, f), text);
  const t = `${clock + when} +0700`;
  execFileSync('git', ['-C', out, '-c', 'core.autocrlf=false', '-c', 'user.name=Kamol Jaidee', '-c', 'user.email=kamol@example.com', 'stash', 'push', '-q', ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t }, stdio: ['ignore', 'ignore', 'inherit'],
  });
};
stash(3600, [['src/main-app.ts', '// draft: badge counter\n'], ['notes-draft.md', 'Scratch notes\n']], ['-u', '-m', 'WIP: unread badge counter']);

writeFileSync(MARKER, 'Made by scripts/mock-repo.mjs; safe to delete.\n');
const count = git(['rev-list', '--count', '--branches', '--remotes', '--tags']).trim();
const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']).trim().split('\n');
console.log(`Mock repo: ${out}\n${count} commits; branches: ${refs.filter(r => !/^(v\d|origin)/.test(r)).join(', ')}; ${refs.filter(r => /^v\d/.test(r)).length} tags`);
