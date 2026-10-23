import { Syntax } from './highlight';
import type { Token } from './highlight';
import type { CommitDetail } from './bindings/CommitDetail';
import type { GitResult } from './bindings/GitResult';
import type { DeletedRef } from './bindings/DeletedRef';
import type { FileChange } from './bindings/FileChange';
import type { FileDiff } from './bindings/FileDiff';
import type { DiffKind } from './ipc';
import { invoke, NATIVE } from './ipc';
import type { AppState, Card, Commit, Edge, Layout, RawCommit, RefGroup, Shown } from './types';
import type { Refs } from './bindings/Refs';
import type { RepoInfo } from './bindings/RepoInfo';
import type { Stash } from './bindings/Stash';
import type { PullRequest } from './bindings/PullRequest';
import type { Track } from './bindings/Track';
import type { WorkFile } from './bindings/WorkFile';
import type { WorkStatus } from './bindings/WorkStatus';
import type { Tab, Tabs } from './tabs';
import { NEW_TAB, afterClose, baseName, cycle, indexOfPath, loadTabs, nth, saveTabs } from './tabs';
import type { RefKind } from './refname';
import { nameClash, nameProblem } from './refname';

(() => {
'use strict';
const ROW_H = 38, LANE_W = 30, PAD = 16, R = 11, DOT = 5.5;   // ROW_H = --rowh in app.css
// History loads a page at a time; the next page is fetched once the viewport
// gets within PREFETCH rows of the end of what is loaded.
const PAGE = 5000, PREFETCH = 2000, POLL_MS = 3000;
const HEAD_H = 30, OVERSCAN = 6, TILE = 256;
const NODE_FONT = "600 9px system-ui,-apple-system,'Segoe UI','Noto Sans Thai','Leelawadee UI',Roboto,sans-serif";
// Lane colors; each theme sets its own in the CSS token --lanes (readTheme).
// The light theme uses darker shades so lines stand out from a white page.
let PALETTE = ['#17abd4','#3f7cf6','#a454f0','#e341c3','#ff4d6a','#ff8c32','#f2c230','#62cc4a','#25cfa4'];
const laneCol = (i: number) => PALETTE[i % PALETTE.length]!;
const lx = (l: number) => PAD + R + l * LANE_W;
const ry = (r: number) => r * ROW_H + ROW_H / 2;
// Only used for elements that are in index.html.
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const ESC: Record<string, string> = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, ch => ESC[ch]!);
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
const lsDel = (k: string) => { try { localStorage.removeItem(k); } catch (e) {} };
// JSON.parse(null) is null, so a missing key falls back to d like a broken value does.
const lsJSON = <T>(k: string, d: T): T => { try { return JSON.parse(lsGet(k)!) ?? d; } catch (e) { return d; } };


const luminance = (hex: string) => {   // WCAG relative luminance of #rrggbb
  const n = parseInt(hex.slice(1), 16), ch = (v: number) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
// Dark or white text, whichever contrasts more with the fill.
function textOn(hex: string){
  const l = luminance(hex) + 0.05;
  return l / (luminance('#15181d') + 0.05) >= 1.05 / l ? '#15181d' : '#ffffff';
}
function initials(name: string){
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  const a = [...p[0]!];
  if (p.length === 1) return (a[0]! + (a[1] || '')).toUpperCase();
  return (a[0]! + [...p[p.length-1]!][0]).toUpperCase();
}
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function rel(t: number){
  const d = t - Date.now()/1000, a = Math.abs(d);
  if (a < 60) return 'just now';
  if (a < 3600) return rtf.format(Math.round(d/60), 'minute');
  if (a < 86400) return rtf.format(Math.round(d/3600), 'hour');
  if (a < 86400*30) return rtf.format(Math.round(d/86400), 'day');
  return new Date(t*1000).toLocaleDateString('en', { year:'numeric', month:'short', day:'numeric' });
}
const pad2 = (n: number) => String(n).padStart(2, '0');
// yyyy-MM-dd HH:mm:ss, local time
function absDate(t: number){
  const d = new Date(t*1000);
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const ICON = {
  laptop:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 13h13"/></svg>',
  cloud:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.6 12.5h6.9a2.8 2.8 0 0 0 .3-5.6 4 4 0 0 0-7.6.9 2.4 2.4 0 0 0 .4 4.7z"/></svg>',
  tag:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2.5h5l7 7-4.5 4.5-7-7z"/><circle cx="5.2" cy="5.7" r="1" fill="currentColor"/></svg>',
  check:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 8.5l3 3 7-7"/></svg>',
  pencil:'<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10.5 2.5l3 3L5 14H2v-3z"/></svg>',
  solo:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  eye:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.2 3.8A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.5M10.4 11.9A6 6 0 0 1 8 12.5C3.9 12.5 1.5 8 1.5 8a11.2 11.2 0 0 1 2.7-3.1M2 2l12 12"/></svg>',
  stash:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="2.5" width="13" height="3.5" rx="1"/><path d="M2.5 6v7.5h11V6M6.5 9h3"/></svg>',
  pr:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="12.5" r="1.8"/><path d="M4 5.3v5.4M12 10.7V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6"/></svg>',
  repo:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 13.5V3a1.5 1.5 0 0 1 1.5-1.5h7.5v9.5H5a1.5 1.5 0 0 0-1.5 1.5 1.5 1.5 0 0 0 1.5 1.5h7.5"/><path d="M6 4.5h4"/></svg>',
  x:'<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>'
};

/* ---------- sample repository (browser mode only) ---------- */
function buildSample(){
  let seed = 7;
  const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const people = [
    ['Nattaya Kongsri','nattaya@example.com'], ['Somchai Prasert','somchai@example.com'],
    ['Alex Rivera','alex@example.com'], ['Pim Suwan','pim@example.com'], ['Jordan Lee','jordan@example.com']
  ];
  // heads[b] is set by commit()/branch() before any later call reads it.
  // Commits get their row fields from prepCommit/layoutRows once loaded.
  const list: Commit[] = [], heads: Record<string, string> = {}, deco: Record<string, string[]> = {}; let t = 0;
  const hex = () => { let s = ''; for (let i = 0; i < 40; i++) s += '0123456789abcdef'[Math.floor(rand()*16)]; return s; };
  const mk = (parents: string[], subject: string, who: number) => { t += 1 + Math.floor(rand()*4); const c = { hash: hex(), parents, author: people[who]![0]!, email: people[who]![1]!, time: t, subject, dec: '' } as Commit; list.push(c); return c.hash; };
  const commit = (b: string, s: string, w: number) => { const h = heads[b]; heads[b] = mk(h ? [h] : [], s, w); };
  const branch = (nb: string, from: string) => { heads[nb] = heads[from]!; };
  const merge = (into: string, from: string, s: string | null, w: number) => { heads[into] = mk([heads[into]!, heads[from]!], s || `Merge branch '${from}' into ${into}`, w); };
  const mark = (hash: string, ref: string) => { (deco[hash] = deco[hash] || []).push(ref); };

  commit('main','Initial commit',1);
  commit('main','Add project scaffolding and README',1);
  commit('main','Set up CI pipeline',4);
  mark(heads.main!,'tag: v0.1.0');
  branch('develop','main');
  commit('develop','Add client-side router',0);
  branch('feature/auth','develop');
  commit('feature/auth','Add login form component',2);
  branch('feature/dashboard','develop');
  commit('feature/dashboard','Scaffold dashboard layout',3);
  commit('feature/auth','Wire up JWT session handling',2);
  commit('develop','Fix lint errors in router',0);
  commit('feature/dashboard','Add KPI summary cards',3);
  branch('hotfix/login-crash','main');
  commit('hotfix/login-crash','Fix crash when session cookie is missing',1);
  commit('feature/auth','Add auth unit tests',2);
  merge('main','hotfix/login-crash',null,1);
  mark(heads.main!,'tag: v0.1.1');
  merge('develop','feature/auth','Merge pull request #12 from feature/auth',0);
  commit('feature/dashboard','Refactor chart widgets into hooks',3);
  merge('develop','main',null,0);
  commit('feature/dashboard','Add date range filter',3);
  merge('develop','feature/dashboard','Merge pull request #15 from feature/dashboard',4);
  branch('release/0.2','develop');
  commit('release/0.2','Bump version to 0.2.0',4);
  commit('develop','Start notifications module',0);
  commit('release/0.2','Update CHANGELOG for 0.2.0',4);
  merge('main','release/0.2',null,4);
  mark(heads.main!,'tag: v0.2.0');
  merge('develop','release/0.2',null,4);
  branch('feature/notifications','develop');
  branch('feature/dark-mode','develop');
  commit('feature/notifications','Add push notification service',2);
  commit('feature/dark-mode','Introduce theme tokens',3);
  commit('develop','Update dependencies',0);
  commit('feature/notifications','Subscribe to websocket events',2);
  const originNotif = heads['feature/notifications']!;
  commit('feature/dark-mode','Add theme toggle to header',3);
  const originDevelop = heads.develop!;
  commit('develop','Fix flaky date formatting test',0);
  commit('feature/notifications','WIP: unread badge in nav bar',2);

  mark(heads.main!,'main'); mark(heads.main!,'origin/main');
  mark(heads.develop!,'HEAD -> develop'); mark(originDevelop,'origin/develop');
  mark(heads['feature/notifications']!,'feature/notifications'); mark(originNotif,'origin/feature/notifications');
  mark(heads['feature/dark-mode']!,'feature/dark-mode'); mark(heads['feature/dark-mode']!,'origin/feature/dark-mode');
  mark(list[0]!.hash,'origin/HEAD');

  const now = Date.now()/1000, last = t;
  list.forEach(c => { c.time = Math.round(now - 1500 - (last - c.time) * 3600 * 1.6); c.dec = (deco[c.hash] || []).join(', '); });
  return list.reverse();
}

/* ---------- parsing ----------
   Desktop output uses 0x1f between fields and 0x1e after each commit.
   Pasted output (browser mode) uses "|~|" and one commit per line. */
function parseLog(text: string){
  const native = text.includes('\x1f');
  const FS = native ? '\x1f' : '|~|';
  const records = native ? text.split('\x1e') : text.split(/\r?\n/);
  const out: Commit[] = [], bad: number[] = [];
  records.forEach((rec, i) => {
    const line = rec.replace(/^[\r\n]+/, '');
    if (!line.trim()) return;
    const f = line.split(FS);
    // Desktop records carry the committer time before the (empty) decoration.
    if (f.length < (native ? 8 : 7)) { bad.push(i+1); return; }
    // The length check above guarantees the first five fields.
    const [hash, parents, an, ae, at, ...more] = f as [string, string, string, string, string, ...string[]];
    const [ct, dec, ...rest] = native ? more : [at, ...more];
    const h = hash.trim().replace(/^["']/, '');
    if (!/^[0-9a-f]{7,64}$/i.test(h)) { bad.push(i+1); return; }
    let subject = rest.join(FS);
    if (!native) subject = subject.replace(/["']$/, '');
    // Row fields are added by prepCommit/layoutRows once the commit is loaded.
    out.push({ hash: h, parents: parents.trim() ? parents.trim().split(/\s+/) : [], author: an, email: ae, time: +at || 0, ctime: +ct! || +at || 0, dec: dec || '', subject: subject.replace(/[\r\n]+$/, '') } as Commit);
  });
  return { commits: out, bad };
}

function groupRefs(dec: string, remotes: Set<string>): RefGroup[]{
  const map = new Map<string, RefGroup>(), tags: RefGroup[] = []; let detached = false;
  dec.split(',').map(s => s.trim()).filter(Boolean).forEach(r => {
    if (r === 'HEAD') { detached = true; return; }
    let head = false;
    if (r.startsWith('HEAD -> ')) { head = true; r = r.slice(8); }
    if (r.startsWith('tag: ')) { tags.push({ kind:'tag', name: r.slice(5), local:false, remotes:[], head:false }); return; }
    const s = r.indexOf('/'); let remote: string | null = null, name = r;
    if (s > 0 && remotes.has(r.slice(0, s))) { remote = r.slice(0, s); name = r.slice(s+1); if (name === 'HEAD') return; }
    const g: RefGroup = map.get(name) || { kind:'branch', name, local:false, remotes:[], head:false };
    if (remote) g.remotes.push(remote); else g.local = true;
    if (head) g.head = true;
    map.set(name, g);
  });
  const list = [...map.values()].sort((a,b) => (+b.head - +a.head) || (+b.local - +a.local) || a.name.localeCompare(b.name));
  if (detached && !list.some(g => g.head)) list.unshift({ kind:'branch', name:'HEAD (detached)', local:true, remotes:[], head:true });
  return list.concat(tags);
}

function topoOrder<T extends RawCommit>(list: T[]): T[]{
  const map = new Map<string, T>(); list.forEach(c => { if (!map.has(c.hash)) map.set(c.hash, c); });
  const uniq = [...map.values()];
  const kids = new Map(uniq.map(c => [c.hash, 0]));
  uniq.forEach(c => c.parents.forEach(p => { if (kids.has(p)) kids.set(p, kids.get(p)! + 1); }));
  const ready = uniq.filter(c => kids.get(c.hash) === 0).sort((a,b) => a.time - b.time);
  const out: T[] = [], seen = new Set<string>();
  while (ready.length) {
    const c = ready.pop()!; out.push(c); seen.add(c.hash);
    c.parents.forEach(p => {
      if (!kids.has(p)) return;
      const k = kids.get(p)! - 1; kids.set(p, k);
      if (k === 0) { const pc = map.get(p)!; let lo = 0, hi = ready.length; while (lo < hi) { const m = (lo+hi) >> 1; if (ready[m]!.time < pc.time) lo = m + 1; else hi = m; } ready.splice(lo, 0, pc); }
    });
  }
  if (out.length < uniq.length) uniq.forEach(c => { if (!seen.has(c.hash)) out.push(c); });
  return out;
}

/* ---------- lane layout ----------
   Incremental: rows are placed top-down, so appending a page never moves a
   row already placed. An edge whose parent is not loaded yet stays open
   (to = -1, drawn to the bottom) until that parent's row is laid out.
   idx must already map every hash in `commits`, including the new rows. */
function newLayout(): Layout { return { lanes: [], laneColor: [], seq: 0, maxLane: 0, open: new Map() }; }
// laneColor[L] is set whenever lane L is taken, so reading it for a taken lane is safe.
function layoutRows(st: Layout, commits: Commit[], start: number, idx: Map<string, number>, edges: Edge[]){
  const { lanes, laneColor } = st;
  const free = () => { let i = lanes.indexOf(null); if (i < 0) { i = lanes.length; lanes.push(null); } return i; };
  const link = (e: Edge, row: number) => { const p = commits[row]!; e.to = row; e.toLane = p.lane; p.children.push(e.from); };
  for (let row = start; row < commits.length; row++) {
    const c = commits[row]!;
    if (c.stashRow) { c.row = row; c.children = []; continue; }   // placed afterwards by laneStashes
    let L = -1;
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) { if (L < 0) L = i; else lanes[i] = null; }
    if (L < 0) { L = free(); laneColor[L] = st.seq++; }
    c.row = row; c.lane = L; c.color = laneColor[L]!; c.children = [];
    lanes[L] = null;
    const waiting = st.open.get(c.hash);
    if (waiting) { st.open.delete(c.hash); waiting.forEach(e => link(e, row)); }
    c.parents.forEach((p, k) => {
      let T: number;
      if (k === 0) T = L;
      else { T = lanes.indexOf(p); if (T < 0) { T = free(); laneColor[T] = st.seq++; } }
      lanes[T] = p;
      const e: Edge = { from: row, fromLane: L, lane: T, to: -1, toLane: T, color: laneColor[T]! };
      edges.push(e);
      const at = idx.get(p);
      if (at !== undefined && at < row) link(e, at);   // parent listed above its child (malformed input)
      else { const w = st.open.get(p); if (w) w.push(e); else st.open.set(p, [e]); }
      if (T > st.maxLane) st.maxLane = T;
    });
    if (L > st.maxLane) st.maxLane = L;
    while (lanes.length && lanes[lanes.length-1] === null) lanes.pop();
  }
}

/* ---------- refs & incremental sync (desktop) ----------
   Labels come from the backend's ref snapshot, formatted the way git's %D
   would show them so groupRefs reads both this and pasted logs. */
function decFromRefs(r: Refs){
  const m = new Map<string, string[]>(), add = (sha: string, s: string) => { const a = m.get(sha); if (a) a.push(s); else m.set(sha, [s]); };
  const onBranch = r.headRef && r.headRef.startsWith('refs/heads/') && r.refs.some(([, n]) => n === r.headRef);
  if (r.headSha && !onBranch) add(r.headSha, 'HEAD');
  r.refs.forEach(([sha, name]) => {
    if (name.startsWith('refs/heads/')) add(sha, (name === r.headRef ? 'HEAD -> ' : '') + name.slice(11));
    else if (name.startsWith('refs/remotes/')) add(sha, name.slice(13));
    else if (name.startsWith('refs/tags/')) add(sha, 'tag: ' + name.slice(10));
  });
  const out = new Map<string, string>();
  m.forEach((a, sha) => out.set(sha, a.join(', ')));
  return out;
}
function tipsOf(r: Refs){
  const t = new Set(r.refs.map(([sha]) => sha));
  if (r.headSha) t.add(r.headSha);
  return t;
}

/* Decides how to apply a ref change without re-reading the history.
   cur: { commits, idx, tips, more }; fresh: commits git reports as new (reachable
   now, not from cur.tips). Returns { full: reason } whenever it cannot prove
   the result matches a fresh load; the caller then reloads. */
/* refs: the refs the walk starts from (tips); labels: what gets labelled
   (defaults to refs; solo adds tags that are not part of the walk). */
interface SyncFrom { commits: Commit[]; idx: Map<string, number>; tips: Set<string>; more?: boolean }
function planSync(cur: SyncFrom, refs: Refs, fresh: Commit[], labels: Refs = refs){
  const tips = tipsOf(refs);
  const added = fresh.filter(c => !cur.idx.has(c.hash));
  const removed = [...cur.tips].filter(t => !tips.has(t));
  if (removed.some(t => !cur.idx.has(t))) return { full: 'a ref below the loaded rows moved' };
  if (removed.length) {
    // Loaded rows are a prefix of a children-first order, so every child of
    // a loaded commit is loaded too. Walking parents inside the loaded set
    // therefore finds exactly the loaded commits that are still reachable.
    const seen = new Uint8Array(cur.commits.length), stack: number[] = [];
    cur.commits.forEach((c, i) => { if (c.stashRow) seen[i] = 1; });   // stash rows hang off refs/stash, not branches
    const reach = (h: string) => { const i = cur.idx.get(h); if (i !== undefined && !seen[i]) { seen[i] = 1; stack.push(i); } };
    tips.forEach(reach);
    added.forEach(c => c.parents.forEach(reach));
    while (stack.length) cur.commits[stack.pop()!]!.parents.forEach(reach);
    if (seen.includes(0)) return { full: 'history was rewritten' };
  }
  const order = mergeNew(added, cur.commits, cur.idx);
  // A new commit older than every loaded row belongs somewhere in the part
  // not loaded yet; only a reload can put it in the right place.
  if (cur.more && added.length && added.includes(order[order.length - 1]!)) return { full: 'new commits below the loaded rows' };
  return { tips, added, removed, order, dec: decFromRefs(labels), refs };
}

/* Places new commits among the loaded ones the way `git log --date-order`
   would: newest committer time first, but every new commit above its
   parents. New commits are never parents of old ones. */
function mergeNew(added: Commit[], old: Commit[], idx: Map<string, number>): Commit[]{
  if (!added.length) return old;
  const need = new Map<string, number>();   // old hash -> last new commit that must precede it
  added.forEach((c, k) => c.parents.forEach(p => { if (idx.has(p)) need.set(p, k); }));
  const out: Commit[] = []; let k = 0;
  // Sync only runs on desktop, whose records always carry ctime.
  for (const o of old) {
    const must = need.has(o.hash) ? need.get(o.hash)! : -1;
    while (k < added.length && (k <= must || added[k]!.ctime! >= o.ctime!)) out.push(added[k++]!);
    out.push(o);
  }
  while (k < added.length) out.push(added[k++]!);
  return out;
}

/* Y maps a content y to canvas y; it clamps so an edge spanning thousands of
   rows never hands the canvas huge coordinates. */
function traceEdge(ctx: CanvasRenderingContext2D, e: Edge, n: number, Y: (y: number) => number){
  const rr = 8, x1 = lx(e.fromLane), y1 = ry(e.from), xT = lx(e.lane);
  const y2 = e.to >= 0 ? ry(e.to) : n * ROW_H + 6, x2 = lx(e.toLane);
  ctx.moveTo(x1, Y(y1));
  if (xT !== x1) { const s = Math.sign(xT - x1); ctx.lineTo(xT - s*rr, Y(y1)); ctx.quadraticCurveTo(xT, Y(y1), xT, Y(y1 + rr)); }
  if (e.to >= 0 && x2 !== xT) { const s = Math.sign(x2 - xT); ctx.lineTo(xT, Y(y2 - rr)); ctx.quadraticCurveTo(xT, Y(y2), xT + s*rr, Y(y2)); ctx.lineTo(x2, Y(y2)); }
  else ctx.lineTo(xT, Y(y2));
}

/* ---------- state ---------- */
let S: AppState = { commits: [], idx: new Map(), edges: [], maxLane: 0, repo: '', sample: false, note: '' };
let sel = -1, matches: number[] = [], matchPtr = -1, matchSet: Set<number> | null = null;
const wrap = $('#wrap'), grid = $('#grid'), body = $('#body'), detail = $('#detail');
const tabBusy = $('#tabBusy');   // in place of the graph while the repo waits for its operation (waitForOp)
const tabLoading = $('#tabLoading');   // a spinner in the middle while a repo that is not on screen yet loads
/* Column widths in px. graph null = wide enough for every lane, but at most a
   third of the window (a repo with many branches would push the message and
   date off screen; the lanes beyond fade at the edge); msg null = fill the
   space left over. Saved per viewer. */
interface Cols { ref: number; graph: number | null; msg: number | null; date: number }
type ColKey = keyof Cols;
const COLS = {
  ref:   { min: 90, max: 600,  reset: () => (window.innerWidth < 600 ? 130 : 210) },
  graph: { min: 40, max: 8000, reset: () => null },
  msg:   { min: 140, max: 4000, reset: () => null },
  date:  { min: 60, max: 320,  reset: () => 160 },
} satisfies Record<ColKey, { min: number; max: number; reset: () => number | null }>;
const cols: Cols = { ref: +lsGet('lanes.refw')! || COLS.ref.reset(), graph: null, msg: null, date: 160, ...lsJSON<Partial<Cols>>('lanes.cols', {}) };
// 120 was the default for the old relative date ("3 days ago"), too narrow for yyyy-MM-dd HH:mm:ss
if (cols.date === 120) cols.date = COLS.date.reset();
for (const k of Object.keys(COLS) as ColKey[]) {
  // Saved widths come from localStorage, so check each one; ref/date reset to a number.
  const all = cols as Record<ColKey, number | null>, v = all[k];
  if (v !== null && !(Number.isFinite(v) && v >= COLS[k].min && v <= COLS[k].max)) all[k] = COLS[k].reset();
}
const saveCols = () => lsSet('lanes.cols', JSON.stringify(cols));
const graphColW = () => cols.graph || Math.min(S.graphW || 0, Math.max(COLS.graph.min, Math.floor(window.innerWidth / 3)));
window.addEventListener('resize', () => { if (!cols.graph) applyCols(); });   // the default follows the window
function applyCols(){
  grid.style.setProperty('--refw', cols.ref + 'px');
  grid.style.setProperty('--graphw', graphColW() + 'px');
  grid.style.setProperty('--datew', cols.date + 'px');
  grid.style.setProperty('--msgw', (cols.msg || COLS.msg.min) + 'px');
  grid.classList.toggle('msg-fixed', !!cols.msg);
  scheduleDraw();
}

/* Virtualized view: only rows near the viewport exist as DOM nodes, and the
   graph is painted onto one viewport-sized canvas. */
const canvas = document.createElement('canvas');
canvas.className = 'graph';
canvas.setAttribute('aria-hidden', 'true');
const moreRow = document.createElement('div');
moreRow.className = 'more-row';
moreRow.textContent = 'Loading more commits…';
moreRow.hidden = true;
const pool = new Map<number, HTMLDivElement>();      // row index -> row element currently in the DOM
let tiles: Edge[][] = [];    // tiles[t] = edges touching rows [t*TILE, (t+1)*TILE)
interface Theme { stroke: string; ring: string; muted: string }
// Read by render() before anything is drawn.
let stamp = 0, drawQueued = false, theme: Theme | null = null;
let ON_COL = PALETTE.map(textOn);

/* Returns true when the lane palette changed (rows, panel and card then need redrawing). */
function readTheme(){
  const cs = getComputedStyle(document.documentElement);
  theme = { stroke: cs.getPropertyValue('--node-stroke').trim(), ring: cs.getPropertyValue('--text').trim(), muted: cs.getPropertyValue('--text-3').trim() };
  const lanes = cs.getPropertyValue('--lanes').split(',').map(s => s.trim().toLowerCase());
  if (lanes.length !== PALETTE.length || !lanes.every(c => /^#[0-9a-f]{6}$/.test(c)) || lanes.join() === PALETTE.join()) return false;
  PALETTE = lanes; ON_COL = PALETTE.map(textOn);
  return true;
}
// Theme switched: the canvas repaints on its own; DOM built with lane colors is rebuilt.
function applyTheme(){
  if (readTheme()) {
    closeRefPop();
    for (const el of pool.values()) el.remove();
    pool.clear();
    renderSide();
    if (detailFor && !detailFor.card) renderDetail(detailFor);
    else if (detailFor && (detailFor.card === 'stash' || detailFor.card === 'pr')) refreshCard();
    draw();   // now, so the rows are never missing for a frame
  } else scheduleDraw();
}

function nodeR(c: Commit){ return c.parents.length > 1 ? DOT : R; }

// k: the label's index in its commit's groups (graph labels; the branch menu reads it).
function pill(g: RefGroup, col: string, k?: number){
  const isHead = g.head;
  const style = isHead ? `--c:${col};background:${col};color:${textOn(col)}` : `--c:${col};background:${col}2e`;
  const icons = g.kind === 'tag' ? ICON.tag : (g.local ? ICON.laptop : '') + (g.remotes.length ? ICON.cloud : '');
  const title = g.kind === 'tag' ? `Tag ${g.name}` : [isHead ? 'HEAD' : '', g.local ? `Local ${g.name}` : '', ...g.remotes.map(r => `${r}/${g.name}`)].filter(Boolean).join(', ');
  return `<span class="pill${isHead ? ' head' : ''}" style="${style}" title="${esc(title)}"${k === undefined ? '' : ` data-g="${k}"`}>${isHead ? ICON.check : ''}<span class="name">${esc(g.name)}</span><span class="ic">${icons}</span></span>`;
}

/* opts.remotes: real remote names from `git remote` (desktop); otherwise guessed.
   opts.keep: preserve selection and scroll position (used by auto-refresh). */
function guessRemotes(raws: RawCommit[]){
  const remotes = new Set(['origin','upstream']);
  raws.forEach(c => c.dec.split(',').forEach(r => { const m = r.trim().match(/^([^\s/]+)\/HEAD$/); if (m) remotes.add(m[1]!); }));
  return remotes;
}

/* Browser mode has no ref listing; rebuild one from the %D labels so both
   modes label, list and hide branches the same way. */
function refsFromDec(raws: RawCommit[], remotes: Set<string>): Refs{
  const refs: [string, string][] = []; let headRef: string | null = null, headSha: string | null = null;
  raws.forEach(c => c.dec.split(',').map(s => s.trim()).filter(Boolean).forEach(d => {
    if (d === 'HEAD') { headSha = c.hash; return; }
    if (d.startsWith('HEAD -> ')) { d = d.slice(8); headRef = 'refs/heads/' + d; headSha = c.hash; }
    if (d.startsWith('tag: ')) { refs.push([c.hash, 'refs/tags/' + d.slice(5)]); return; }
    const s = d.indexOf('/');
    refs.push([c.hash, (s > 0 && remotes.has(d.slice(0, s)) ? 'refs/remotes/' : 'refs/heads/') + d]);
  }));
  return { refs, headRef, headSha };
}

interface DataOpts {
  remotes?: string[]; refs?: Refs; hidden?: string[]; solo?: string[]; keep?: boolean;
  ordered?: boolean; note?: string; more?: boolean; capped?: boolean;
}
function setData(raws: Commit[], repo: string, sample: boolean, opts: DataOpts = {}){
  const remotes = opts.remotes ? new Set(opts.remotes) : guessRemotes(raws);
  // Labels and sync tips come from the refs left after hiding; the panel
  // lists them all (S.refs).
  const walk = opts.refs ? walkRefs(opts.refs, opts.hidden || [], opts.solo || []) : null;
  const labels = opts.refs ? labelRefs(opts.refs, opts.hidden || [], opts.solo || []) : null;
  // `git log --date-order` already lists children before parents; only
  // pasted logs (browser mode) need sorting.
  const commits = opts.ordered ? raws : topoOrder(raws);
  const keepHash = opts.keep ? S.commits[sel]?.hash ?? null : null;
  const anchor = scrollAnchor(), left = wrap.scrollLeft, top = wrap.scrollTop;
  const track = opts.keep ? S.track : null;   // upstream counts until branch_tracking answers again
  S = { commits: [], idx: new Map(), edges: [], maxLane: 0, lay: newLayout(), remotes,
        repo, sample, note: opts.note || '', more: !!opts.more, capped: !!opts.capped, bad: 0,
        // desktop only: labels and tips from the ref snapshot
        refDec: labels ? decFromRefs(labels) : null, tips: walk ? tipsOf(walk) : new Set(),
        refs: opts.refs || null, track };
  appendCommits(commits);
  placeStashes({ render: false });   // stashes already known for this repo (reload, sync fallback)
  render(keepHash, opts.keep ? { top: anchoredTop(anchor, top), left } : null);
}

/* Keeps the same commit at the top of the view across reloads and syncs,
   even when rows were added or removed above it. At the very top the view
   stays at the top, so new commits show up there. */
function scrollAnchor(){
  const top = wrap.scrollTop - rowOff, i = Math.min(Math.floor(top / ROW_H), S.commits.length - 1);
  return top > 0 && i >= 0 ? { hash: S.commits[i]!.hash, off: top - i * ROW_H } : null;
}
function anchoredTop(anchor: { hash: string; off: number } | null, fallback: number){
  if (!anchor) return 0;
  const i = S.idx.get(anchor.hash);
  return i === undefined ? fallback : rowOff + i * ROW_H + anchor.off;
}

function prepCommit(c: Commit){
  // c.dec stays as git printed it: browser mode rebuilds refs from it when
  // branches are hidden or shown. S.remotes is set by setData before any commit.
  c.groups = groupRefs(S.refDec ? S.refDec.get(c.hash) || '' : c.dec, S.remotes!);
  c.ini = initials(c.author);
  c.hay = `${c.subject} ${c.author} ${c.email} ${c.hash} ${c.groups.map(g => g.name).join(' ')}`.toLowerCase();
}

/* Adds rows below the ones already loaded; earlier rows keep their layout. */
function appendCommits(list: Commit[]){
  const start = S.commits.length;
  list.forEach(c => { if (!S.idx.has(c.hash)) { S.idx.set(c.hash, S.commits.length); S.commits.push(c); } });
  for (let i = start; i < S.commits.length; i++) prepCommit(S.commits[i]!);
  layoutRows(S.lay!, S.commits, start, S.idx, S.edges);
  S.maxLane = Math.max(S.lay!.maxLane, S.stashLaneMax || 0);
}

/* Applies a planSync result in place: new rows are merged in, labels are
   refreshed, and the view stays on the same commit. Sync runs only on a
   loaded desktop repo, so S.refDec is set. */
type SyncPlan = Exclude<ReturnType<typeof planSync>, { full: string }> & { allRefs?: Refs };
function applySync(plan: SyncPlan){
  const sameDec = !plan.added.length && plan.dec.size === S.refDec!.size
    && [...plan.dec].every(([sha, d]) => S.refDec!.get(sha) === d);
  S.tips = plan.tips; S.refs = plan.allRefs || plan.refs;
  if (sameDec) return false;   // e.g. only stash or notes refs moved

  const keepHash = S.commits[sel]?.hash ?? null;
  const anchor = scrollAnchor(), top = wrap.scrollTop;

  const oldDec = S.refDec!;
  S.refDec = plan.dec;
  S.commits.forEach(c => { if ((oldDec.get(c.hash) || '') !== (plan.dec.get(c.hash) || '')) prepCommit(c); });
  if (plan.added.length) {
    plan.added.forEach(prepCommit);
    S.commits = plan.order;
    S.idx = new Map(S.commits.map((c, i) => [c.hash, i]));
    S.edges = []; S.lay = newLayout();
    layoutRows(S.lay, S.commits, 0, S.idx, S.edges);   // rows on top shift the lanes below
    laneStashes();
    S.maxLane = Math.max(S.lay.maxLane, S.stashLaneMax!);   // set by laneStashes
  }
  render(keepHash, { top: anchoredTop(anchor, top), left: wrap.scrollLeft });
  return true;
}

function makeRow(i: number){
  const c = S.commits[i]!, col = c.stashRow ? theme!.muted : laneCol(c.color);
  let refs = '';
  if (c.groups.length) {
    refs = pill(c.groups[0]!, col, 0);
    if (c.groups.length > 1) refs += `<span class="more" title="${esc(c.groups.slice(1).map(g => g.name).join(', '))}">+${c.groups.length - 1}</span>`;
    refs += `<span class="conn" style="background:${col}"></span>`;
  }
  const el = document.createElement('div');
  el.className = 'row' + (c.stashRow ? ' stash-row' : '') + (i === sel ? ' sel' : '') + (matchSet && !matchSet.has(i) ? ' dim' : '');
  el.dataset.i = String(i);
  el.style.top = rowOff + i * ROW_H + 'px';
  if (c.groups.length) el.style.setProperty('--tint', col + '12');
  el.innerHTML = `<div class="col-ref">${refs}</div><div class="col-graph"></div>`
    + (c.stashRow ? `<div class="col-msg" title="${esc(c.stashName + ': ' + c.subject)}"><span class="stash-name">${esc(c.stashName)}</span>${esc(c.subject)}</div>`
      : `<div class="col-msg${c.parents.length > 1 ? ' msg-merge' : ''}" title="${esc(c.subject)}">${esc(c.subject)}</div>`)
    + `<div class="col-date" title="${esc(rel(c.time))}">${esc(absDate(c.time))}</div>`;
  return el;
}

/* "+N": hovering a row's Branch / tag cell lists every label of that commit
   in a box over the rows below, the first label where it already was. The
   graph does not move. */
const refPop = document.createElement('div');
refPop.className = 'ref-pop'; refPop.hidden = true;
let refPopI = -1, refPopTimer = 0;   // the row it is for (or about to open for)
function openRefPop(i: number){
  const c = S.commits[i]; if (!c) return;
  const col = c.stashRow ? theme!.muted : laneCol(c.color);
  // Each label sits on its own opaque backing; the box around them is see-through.
  refPop.innerHTML = c.groups.map((g, k) => `<span class="ref-item">${pill(g, col, k)}</span>`).join('');
  refPop.dataset.i = String(i);
  refPop.style.top = rowOff + i * ROW_H + 'px';
  if (!refPop.isConnected) body.append(refPop);
  refPop.hidden = false;
}
function closeRefPop(){ clearTimeout(refPopTimer); refPopTimer = 0; refPopI = -1; refPop.hidden = true; }
const refCellRow = (el: EventTarget | null) => { const cell = el instanceof Element ? el.closest('.row .col-ref') : null, row = cell && cell.parentElement; return row && row !== wipRow ? +row.dataset.i! : -1; };
body.addEventListener('mouseover', e => {
  if (e.target instanceof Node && refPop.contains(e.target)) return;
  const i = refCellRow(e.target);
  if (i === refPopI) return;
  closeRefPop();
  if (i >= 0 && S.commits[i]!.groups.length > 1) { refPopI = i; refPopTimer = setTimeout(() => openRefPop(i), 120); }
});
body.addEventListener('mouseout', e => {
  // Moving between the cell and its box (or within the box) keeps it.
  const to = e.relatedTarget;
  if (refPopI < 0 || (to instanceof Node && refPop.contains(to)) || refCellRow(to) === refPopI) return;
  closeRefPop();
});

/* Index edges by row tile so a frame only looks at edges near the viewport. */
function buildTiles(){
  const n = S.commits.length;
  tiles = Array.from({ length: Math.ceil(n / TILE) }, (): Edge[] => []);
  S.edges.forEach(e => {
    const end = e.to >= 0 ? e.to : n - 1;
    for (let t = Math.floor(e.from / TILE), last = Math.floor(end / TILE); t <= last; t++) tiles[t]!.push(e);
  });
}

function scheduleDraw(){
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

function draw(){
  drawQueued = false;
  const n = S.commits.length, top = wrap.scrollTop - HEAD_H - rowOff;
  const a = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const b = Math.min(n, Math.ceil((top + wrap.clientHeight) / ROW_H) + OVERSCAN);
  syncRows(a, b);
  paintGraph(a, b);
  if (S.more && b >= n - PREFETCH) loadMore();
}

function syncRows(a: number, b: number){
  for (const [i, el] of pool) if (i < a || i >= b) { el.remove(); pool.delete(i); }
  const frag = document.createDocumentFragment();
  for (let i = a; i < b; i++) if (!pool.has(i)) { const el = makeRow(i); pool.set(i, el); frag.appendChild(el); }
  body.appendChild(frag);
}

/* The canvas covers only the visible part of the graph column, rows [a, b). */
function paintGraph(a: number, b: number){
  const n = S.commits.length;
  // Lanes past a narrowed graph column are simply cut off.
  const gx0 = Math.floor(Math.max(0, wrap.scrollLeft - cols.ref));
  const gx1 = Math.ceil(Math.min(graphColW(), wrap.scrollLeft + wrap.clientWidth - cols.ref));
  if (!n || b <= a || gx1 <= gx0) { canvas.hidden = true; return; }
  canvas.hidden = false;
  const on = wipOn(), r0 = on && a === 0 ? -1 : a;   // row -1 is the WIP row

  const w = gx1 - gx0, h = (b - r0) * ROW_H, dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  canvas.style.cssText = `left:${cols.ref + gx0}px;top:${rowOff + r0 * ROW_H}px;width:${w}px;height:${h}px`;

  const ctx = canvas.getContext('2d')!;
  const th = theme!;
  ctx.setTransform(dpr, 0, 0, dpr, -gx0 * dpr, 0);
  ctx.clearRect(gx0, 0, w, h);
  const oy = r0 * ROW_H, Y = (v: number) => Math.max(-64, Math.min(h + 64, v - oy));

  ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  stamp++;
  const t1 = Math.floor(Math.min(n - 1, b) / TILE);
  for (let t = Math.floor(Math.max(0, a - 1) / TILE); t <= t1; t++) {
    for (const e of tiles[t]!) {
      if (e.stamp === stamp) continue;
      e.stamp = stamp;
      if (e.from > b || (e.to >= 0 ? e.to : n) < a - 1) continue;
      if (e.color < 0) { ctx.setLineDash([3, 3]); ctx.strokeStyle = th.muted; } else ctx.strokeStyle = laneCol(e.color);
      ctx.beginPath(); traceEdge(ctx, e, n, Y); ctx.stroke();
      if (e.color < 0) ctx.setLineDash([]);
    }
  }

  ctx.lineCap = 'butt'; ctx.globalAlpha = 0.6;
  for (let i = a; i < b; i++) {
    const c = S.commits[i]!; if (!c.groups.length) continue;
    ctx.strokeStyle = laneCol(c.color);
    ctx.beginPath(); ctx.moveTo(0, Y(ry(i))); ctx.lineTo(lx(c.lane) - nodeR(c), Y(ry(i))); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Dashed: the WIP node in HEAD's lane and the line down to HEAD. With HEAD
  // not in the graph (solo without it, or not loaded yet) there is no node at
  // all: one in some lane would look like it belonged to that branch.
  const hc = on ? wipHead() : -1;
  if (hc >= 0) {
    const head = S.commits[hc]!, x = lx(head.lane);
    ctx.save();
    ctx.setLineDash([3, 3]); ctx.lineWidth = 2; ctx.lineCap = 'butt';
    ctx.strokeStyle = laneCol(head.color);
    if (a <= hc) { ctx.beginPath(); ctx.moveTo(x, Y(ry(-1) + R)); ctx.lineTo(x, Y(ry(hc) - nodeR(head))); ctx.stroke(); }
    if (r0 < 0) {
      ctx.beginPath(); ctx.arc(x, Y(ry(-1)), R - 1, 0, Math.PI * 2);
      ctx.fillStyle = th.stroke; ctx.fill(); ctx.stroke();
      if (wipSel) { ctx.setLineDash([]); ctx.strokeStyle = th.ring; ctx.beginPath(); ctx.arc(x, Y(ry(-1)), R + 3.5, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.restore();
  }

  ctx.lineWidth = 2.5; ctx.strokeStyle = th.stroke;
  ctx.font = NODE_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = a; i < b; i++) {
    const c = S.commits[i]!, x = lx(c.lane), y = Y(ry(i)), k = c.color % PALETTE.length;
    if (c.stashRow) {   // a gray box, like GitKraken's stash nodes
      ctx.beginPath(); ctx.roundRect(x - R + 1.5, y - R + 1.5, 2 * R - 3, 2 * R - 3, 4);
      ctx.fillStyle = th.muted; ctx.fill(); ctx.stroke();
      ctx.fillStyle = th.stroke; ctx.fillRect(x - 4, y - 1, 8, 2);
      continue;
    }
    ctx.beginPath(); ctx.arc(x, y, nodeR(c), 0, Math.PI * 2);
    ctx.fillStyle = PALETTE[k]!; ctx.fill(); ctx.stroke();
    if (c.parents.length <= 1) { ctx.fillStyle = ON_COL[k]!; ctx.fillText(c.ini, x, y + 0.5); }
  }

  if (sel >= a && sel < b) {
    const c = S.commits[sel]!;
    ctx.lineWidth = 2; ctx.strokeStyle = th.ring;
    ctx.beginPath(); ctx.arc(lx(c.lane), Y(ry(sel)), nodeR(c) + 3.5, 0, Math.PI * 2); ctx.stroke();
  }

  // A graph column narrower than the lanes fades out at its edge instead of
  // ending in a hard cut, so it reads as "more to the right".
  const colW = graphColW();
  if (colW < S.graphW! && gx1 > colW - 18) {   // graphW is set by updateView
    const fade = ctx.createLinearGradient(colW - 18, 0, colW, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = fade; ctx.fillRect(colW - 18, 0, 18, h);
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* Sizes, edge index and toolbar text for everything loaded so far. Runs on
   every render and again after each appended page. */
function updateView(){
  const n = S.commits.length;
  S.graphW = lx(S.maxLane) + R + PAD + 4;
  applyCols();
  moreRow.hidden = !S.more;
  placeRows();
  buildTiles();

  let headG = null as RefGroup | null;   // assigned inside the callback below
  const branches = new Set<string>(), tags = new Set<string>();
  S.commits.forEach(c => c.groups.forEach(g => {
    (g.kind === 'tag' ? tags : branches).add(g.name);
    if (g.head && !headG) headG = g;
  }));
  $('#repoName').textContent = S.repo || 'repository';
  // From the ref snapshot, not the labels: solo can leave HEAD unlabelled.
  const hr = S.refs && S.refs.headRef;
  $('#headName').textContent = hr ? hr.replace(/^refs\/heads\//, '') : S.refs && S.refs.headSha ? 'detached' : headG ? headG.name : '—';
  renderHeadTrack(); updateFetchBtn();
  $('#sampleBadge').hidden = !S.sample;
  const note = S.note + (S.bad ? `, ${S.bad} unreadable entries skipped` : '')
    + (S.capped ? ', history cut off at 2,000,000 commits' : '');
  // Nothing to count while the repo waits for its operation.
  $('#stats').textContent = !tabBusy.hidden ? '' : `${(n - (S.stashRows || 0)).toLocaleString('en')}${S.more ? '+' : ''} commits, ${branches.size} branches, ${tags.size} tags${note}`;
  document.title = `${S.repo || 'Repository'} — GitKrapao`;
}

function render(keepHash: string | null, keepScroll: { top: number; left: number } | null){
  const n = S.commits.length;
  closeRefPop();
  for (const el of pool.values()) el.remove();
  pool.clear();
  if (!canvas.isConnected) body.append(canvas, moreRow, wipRow);
  if (!theme) readTheme();
  updateView();
  renderSide();

  sel = -1; runSearch();
  // A stash or pull request card stays put across syncs of the same repo.
  const show = !(keepHash && detailFor && detailFor.card);
  if (n && wipSel && wipOn()) {
    selectWip();   // the WIP row stays selected across reloads and syncs
  } else if (!n) {
    detailFor = null;
    detail.innerHTML = '<div class="empty">This repository has no commits yet</div>';
  } else if (keepHash && S.idx.has(keepHash)) {
    select(S.idx.get(keepHash)!, { detail: show });
  } else {
    const headIdx = S.commits.findIndex(c => c.groups.some(g => g.head));
    select(headIdx >= 0 ? headIdx : 0, { scroll: !keepScroll, detail: show });
  }
  if (keepScroll) { wrap.scrollTop = keepScroll.top; wrap.scrollLeft = keepScroll.left; }
  draw();   // paint now so a refresh never shows an empty frame
}

/* ---------- selection & detail ---------- */
/* detail: false keeps a stash or pull request card in the detail panel
   while the graph shows the commit it belongs to. */
function select(i: number, { scroll = false, open = false, detail: show = true }: { scroll?: boolean; open?: boolean; detail?: boolean } = {}){
  if (!(i >= 0 && i < S.commits.length)) return;
  pool.get(sel)?.classList.remove('sel');
  if (wipSel) { wipSel = false; wipRow.classList.remove('sel'); }
  sel = i;
  pool.get(i)?.classList.add('sel');
  if (show) {
    const c = S.commits[i]!, st = c.stashRow && stashes.find(x => x.key === c.stashKey);
    if (st) stashCard(st); else renderDetail(c);
  }
  markSide();
  if (scroll) ensureVisible(i);
  if (open) detail.classList.add('open');
  scheduleDraw();
}
function ensureVisible(i: number){
  const top = HEAD_H + rowOff + i * ROW_H;
  if (top < wrap.scrollTop + HEAD_H) wrap.scrollTop = top - HEAD_H;
  else if (top + ROW_H > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = top + ROW_H - wrap.clientHeight;
}
function hashLink(h: string){
  return S.idx.has(h) ? `<button class="hash-link" data-jump="${esc(h)}">${esc(h.slice(0,7))}</button>` : `<code class="muted" title="Not in the loaded history">${esc(h.slice(0,7))}</code>`;
}
let detailFor: Shown | null = null;        // what the detail panel shows: a commit, stash or pull request
function renderDetail(c: Commit){
  const col = laneCol(c.color);
  detailFor = c;
  detail.innerHTML =
    `<div class="d-top"><span class="k">Commit</span><code>${esc(c.hash.slice(0,7))}</code><button class="btn sm" data-copy="${esc(c.hash)}">Copy SHA</button><button class="btn icon-btn sm d-close" aria-label="Close details">✕</button></div>`
    + `<h2 class="d-subject">${esc(c.subject)}</h2>`
    + '<div id="dBody"></div>'
    + (c.groups.length ? `<div class="d-refs">${c.groups.map(g => pill(g, col)).join('')}</div>` : '')
    + `<div class="d-person"><span class="d-av" style="background:${col};color:${textOn(col)}">${esc(initials(c.author))}</span><div><div class="d-name">${esc(c.author)}</div><div class="d-mail">${esc(c.email)}</div></div></div>`
    + `<dl class="d-meta"><dt>Date</dt><dd>${esc(absDate(c.time))} <span class="muted">(${esc(rel(c.time))})</span></dd>`
    + `<dt>SHA</dt><dd><code>${esc(c.hash)}</code></dd>`
    + `<dt>Parents</dt><dd>${c.parents.length ? c.parents.map(hashLink).join('') : '<span class="muted">None, this is a root commit</span>'}</dd>`
    + `<dt>Children</dt><dd>${c.children.length ? c.children.map(i => hashLink(S.commits[i]!.hash)).join('') : '<span class="muted">None in loaded history</span>'}</dd></dl>`
    + (c.parents.length > 1 ? '<p class="muted note">Merge commit, shown as a small dot on the graph.</p>' : '')
    + (NATIVE && current ? '<div id="dFiles" class="d-files"><p class="muted">Loading changes…</p></div>' : '');
  requestDetail(c);
}

/* ---------- commit details (desktop) ----------
   Full message and changed files come from `git show` when a commit is
   selected. Arrow-key browsing waits briefly so only the commit it stops on
   is fetched; results are cached since commits never change. */
const detailCache = new Map<string, CommitDetail>(), DETAIL_CACHE = 300;
let detailSeq = 0, detailTimer = 0;
/** A commit or a stash card: both list the files of a commit. */
type DetailSource = Commit | Extract<Card, { card: 'stash' }>;
function requestDetail(c: DetailSource){
  if (!NATIVE || !current) return;
  const key = current.path + '\n' + c.hash, seq = ++detailSeq;
  clearTimeout(detailTimer);
  if (detailCache.has(key)) { fillDetail(c, detailCache.get(key)!); return; }
  detailTimer = setTimeout(async () => {
    try {
      // Read when the timer fires (as before); a closed repo throws into the catch below.
      const d = await invoke('commit_detail', { path: current!.path, sha: c.hash });
      detailCache.set(key, d);
      if (detailCache.size > DETAIL_CACHE) detailCache.delete(detailCache.keys().next().value!);
      if (seq === detailSeq) fillDetail(c, d);
    } catch (e) {
      // #dFiles is part of the card's HTML, so it is gone once another card replaced it.
      const box = document.querySelector<HTMLElement>('#dFiles');
      if (seq === detailSeq && box) box.innerHTML = `<p class="err">Could not load changes: ${esc(String(e))}</p>`;
    }
  }, 100);
}
function fillDetail(c: DetailSource, d: CommitDetail){
  const body = document.querySelector<HTMLElement>('#dBody'), box = document.querySelector<HTMLElement>('#dFiles');
  if (!body || !box || detailFor !== c) return;
  // %B starts with the subject paragraph, which the heading already shows.
  const cut = d.body.search(/\n\s*\n/);
  const rest = cut < 0 ? '' : d.body.slice(cut).trim();
  body.innerHTML = rest ? `<div class="d-body">${esc(rest)}</div>` : '';
  panelFiles = d.files.map(f => ({ kind: 'commit' as const, sha: c.hash, path: f.path, oldPath: f.oldPath, status: f.status }));
  if (!d.totalFiles) { box.innerHTML = '<p class="muted">No file changes</p>'; return; }
  box.innerHTML =
    `<div class="d-files-head"><span>${d.totalFiles.toLocaleString('en')} ${d.totalFiles === 1 ? 'file' : 'files'} changed</span>`
    + `<span class="add">+${d.add.toLocaleString('en')}</span><span class="del">−${d.del.toLocaleString('en')}</span></div>`
    + (c.stash ? '<p class="muted note">Compared with the commit the stash was made on.</p>'
      : c.parents.length > 1 ? '<p class="muted note">Compared with the first parent.</p>' : '')
    + `<ul class="d-file-list">${d.files.map(fileRow).join('')}</ul>`
    + (d.totalFiles > d.files.length ? `<p class="muted note">and ${(d.totalFiles - d.files.length).toLocaleString('en')} more files</p>` : '');
  markDiffRow();
}
function fileRow(f: FileChange, i: number){
  const slash = f.path.lastIndexOf('/');
  const dir = f.path.slice(0, slash + 1), name = f.path.slice(slash + 1);
  const full = (f.oldPath ? f.oldPath + ' → ' : '') + f.path;
  const stat = f.add == null ? '<span class="muted">binary</span>' : `<span class="add">+${f.add}</span><span class="del">−${f.del}</span>`;
  return `<li class="d-file" data-df="${i}" title="${esc(full)}"><span class="st st-${esc(f.status)}">${esc(f.status)}</span>`
    + `<span class="fp">${f.oldPath ? `<span class="from">${esc(f.oldPath)} → </span>` : ''}<span class="dir">${esc(dir)}</span>${esc(name)}</span>`
    + `<span class="ns">${stat}</span></li>`;
}

async function copyText(text: string, btn?: HTMLElement | null){
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (_) {} ta.remove();
  }
  if (btn) { const t = btn.textContent; btn.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { btn.textContent = t; }, 1200); }
}

/* ---------- file diff view (desktop) ----------
   Clicking a file in the detail card shows its diff over the graph, which
   stays mounted underneath so its scroll position and layout survive.
   Commit and stash diffs never change and are cached; work tree diffs are
   fetched fresh and follow WIP polls. */
const diffPane = $('#diff'), dfBody = $('#dfBody');
const DIFF_MAX_LINES = 20000, DF_CACHE = 100, HL_MAX_CHARS = 2000000;
/** A file the detail card lists: of a commit (or stash), or of the work tree (WIP card). */
type WipSide = 'staged' | 'unstaged' | 'untracked' | 'conflict';
type DiffTarget =
  | { kind: 'commit'; sha: string; path: string; oldPath: string | null; status: string; side?: undefined }
  | { kind: 'wip'; side: WipSide; path: string; oldPath: string | null; status: string; sha?: undefined };
interface DiffLine {
  t: 'add' | 'del' | 'ctx'; o?: number; n?: number; s: string; noeol?: boolean;
  /** Changed part, in code points (markWords). */
  mark?: [number, number];
  /** Syntax tokens of the old / new side (highlightDiff). */
  ho?: Token[] | null; hn?: Token[] | null;
}
interface Hunk { head: string; lines: DiffLine[] }
interface ParsedDiff { hunks: Hunk[]; binary: boolean; meta: string[]; add: number; del: number }
type LineToks = Map<number, { s: string; t: Token[] }>;
/** A file_diff result; `tok` caches the whole-file colors on the cached object. */
type DiffResult = FileDiff & { tok?: { old: LineToks; neu: LineToks } | null };
const dfCache = new Map<string, DiffResult>();
let panelFiles: DiffTarget[] = [];         // files the detail card lists right now, as diff targets
let dfList: DiffTarget[] = [], dfAt = -1, dfSeq = 0;
let dfPrefs = { split: false, full: false, ...lsJSON<{ split?: boolean; full?: boolean }>('lanes.diff', {}) };
const diffOpen = () => !diffPane.hidden;
const dfKey = (f: DiffTarget | undefined) => f ? [f.kind, f.sha || '', f.side || '', f.oldPath || '', f.path].join('|') : '';

function openDiff(i: number){
  if (!panelFiles[i]) return;
  dfList = panelFiles; dfAt = i;
  diffPane.hidden = false;
  if (narrowView()) detail.classList.remove('open');
  markDiffRow();
  loadDiff();
  dfBody.focus({ preventScroll: true });
}
function closeDiff(){
  if (!diffOpen()) return;
  diffPane.hidden = true; dfAt = -1; dfSeq++;
  markDiffRow();
}
function stepDiff(d: number){
  const i = dfAt + d;
  if (i < 0 || i >= dfList.length) return;
  dfAt = i; markDiffRow(); loadDiff();
}
// The card was redrawn (WIP poll, page load): follow the same file in the new list.
function syncDiffList(){
  const k = dfKey(dfList[dfAt]), i = panelFiles.findIndex(f => dfKey(f) === k);
  if (i >= 0) { dfList = panelFiles; dfAt = i; }
}
function markDiffRow(){
  detail.querySelectorAll('.d-file.on').forEach(el => el.classList.remove('on'));
  if (!diffOpen()) return;
  const k = dfKey(dfList[dfAt]), i = panelFiles.findIndex(f => dfKey(f) === k);
  const el = i >= 0 && detail.querySelector(`.d-file[data-df="${i}"]`);
  if (el) { el.classList.add('on'); el.scrollIntoView({ block: 'nearest' }); }
}

/* quiet = a WIP poll re-reading the open work tree file: no "Loading…", errors
   keep what is shown, and the pane is redrawn (scroll kept) only if the
   patch changed. Edits to an already modified file do not change git status,
   so the poll cannot wait for the WIP signature to change. */
let dfShown = '';            // file, view and patch the pane shows now
let dfBusy = 0;              // dfSeq of the load in flight; polls never cancel it
async function loadDiff(quiet = false){
  const f = dfList[dfAt];
  if (!f || !current) return;
  if (!quiet) { diffBar(f, null); dfShown = ''; }
  const seq = ++dfSeq;
  if (f.side === 'conflict') {
    if (quiet) return;
    dfBusy = 0;
    dfBody.innerHTML = '<p class="df-note">This file has a merge conflict. Resolve it in your editor; GitKrapao does not show conflict diffs.</p>';
    return;
  }
  // A WIP file always has a side, and conflicts returned above.
  const kind: DiffKind = f.kind === 'commit' ? 'commit' : f.side as Exclude<WipSide, 'conflict'>;
  const repo = current.path;
  const get = async (context: number): Promise<DiffResult> => {
    const key = kind === 'commit' ? [repo, f.sha, f.oldPath || '', f.path, context].join('\n') : null;
    const hit = key ? dfCache.get(key) : undefined;
    if (hit) return hit;
    const r: DiffResult = await invoke('file_diff', { path: repo, kind, sha: f.sha || null, file: f.path, oldFile: f.oldPath || null, context });
    if (key) { dfCache.set(key, r); if (dfCache.size > DF_CACHE) dfCache.delete(dfCache.keys().next().value!); }
    return r;
  };
  // In Changes mode a hunk can start inside a docstring or code fence, so the
  // colors come from lexing the whole file (fetched alongside). Added, deleted
  // and untracked files already arrive whole.
  const prime = !dfPrefs.full && kind !== 'untracked' && !'AD?'.includes(f.status)
    && !!(Syntax.lang(f.path) || (f.oldPath && Syntax.lang(f.oldPath)));
  const loading = !quiet && setTimeout(() => { if (seq === dfSeq) dfBody.innerHTML = '<p class="df-note">Loading…</p>'; }, 0);
  let r: DiffResult, whole: DiffResult | null = null;
  dfBusy = seq;
  try {
    [r, whole] = await Promise.all([get(dfPrefs.full ? 1000000 : 3), prime ? get(1000000).catch(() => null) : null]);
  } catch (e) {
    clearTimeout(loading || undefined);
    if (dfBusy === seq) dfBusy = 0;
    if (seq === dfSeq && !quiet) dfBody.innerHTML = `<p class="df-note err">${esc(String(e))}</p>`;
    return;
  }
  clearTimeout(loading || undefined);
  if (dfBusy === seq) dfBusy = 0;
  if (seq !== dfSeq) return;
  const shown = [dfKey(f), dfPrefs.split, dfPrefs.full, r.patch].join('\n');
  if (quiet && shown === dfShown) { diffNav(); return; }
  const top = dfBody.scrollTop, left = dfBody.scrollLeft;
  renderDiff(f, r, whole);
  dfShown = shown;
  if (quiet) { dfBody.scrollTop = top; dfBody.scrollLeft = left; }
}
// A WIP poll: the open work tree diff may have changed even when git status did not.
function refreshWipDiff(){
  if (!dfBusy && diffOpen() && dfList[dfAt]?.kind === 'wip') loadDiff(true);
}

/* Unified diff text → hunks of lines with old/new numbers. Handles CRLF,
   "\ No newline at end of file", binary files and changes without hunks
   (mode only, pure renames, submodules). */
function parseDiff(text: string): ParsedDiff{
  const d: ParsedDiff = { hunks: [], binary: false, meta: [], add: 0, del: 0 };
  let h: Hunk | null = null, o = 0, n = 0;
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('@@ ')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
      if (!m) { h = null; continue; }
      o = +m[1]!; n = +m[2]!;
      h = { head: line, lines: [] }; d.hunks.push(h);
      continue;
    }
    if (line.startsWith('diff --git ')) { h = null; continue; }
    if (!h) {
      if (line.startsWith('Binary files ')) d.binary = true;
      else if (/^(old mode|new mode|deleted file mode|new file mode|similarity index|rename from|rename to|copy from|copy to|Large file)/.test(line)) d.meta.push(line);
      continue;
    }
    const c = line[0];
    if (c === '+') { h.lines.push({ t: 'add', n: n++, s: line.slice(1) }); d.add++; }
    else if (c === '-') { h.lines.push({ t: 'del', o: o++, s: line.slice(1) }); d.del++; }
    else if (c === ' ') h.lines.push({ t: 'ctx', o: o++, n: n++, s: line.slice(1) });
    else if (c === '\\') { const last = h.lines[h.lines.length - 1]; if (last) last.noeol = true; }
  }
  d.hunks.forEach(x => pairLines(x.lines));
  return d;
}

/* A run of removed lines followed by added lines is a change; pair them up
   and mark what changed inside each pair (common start and end trimmed). */
function pairLines(lines: DiffLine[]){
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.t !== 'del') { i++; continue; }
    let j = i; while (j < lines.length && lines[j]!.t === 'del') j++;
    let k = j; while (k < lines.length && lines[k]!.t === 'add') k++;
    for (let q = 0; q < Math.min(j - i, k - j); q++) markWords(lines[i + q]!, lines[j + q]!);
    i = k;
  }
}
function markWords(a: DiffLine, b: DiffLine){
  const x = [...a.s], y = [...b.s];
  let pre = 0; while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0; while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  if ((pre + suf) / Math.max(x.length, y.length, 1) < 0.3) return;   // mostly rewritten: no word marks
  a.mark = [pre, x.length - suf]; b.mark = [pre, y.length - suf];
}
/* Syntax colors: one lexer for the old side (context + removed lines) and
   one for the new side (context + added lines), so a comment opened on a
   removed line never colors the added lines after it. With the whole file's
   diff (`whole`) each line takes the colors of its line number in the old or
   new file; without it lexer state starts fresh at every hunk. */
function lexSides(d: ParsedDiff, langOld: string | null, langNew: string | null, each: (l: DiffLine, ho: Token[] | null, hn: Token[] | null) => void){
  let lines = 0, chars = 0;
  for (const h of d.hunks) {
    const o = langOld && Syntax.lexer(langOld), n = langNew && Syntax.lexer(langNew);
    for (const l of h.lines) {
      if (++lines > DIFF_MAX_LINES || (chars += l.s.length) > HL_MAX_CHARS) return false;
      each(l, l.t !== 'add' && o ? o.line(l.s) : null, l.t !== 'del' && n ? n.line(l.s) : null);
    }
  }
  return true;
}
// Old/new line number → { s, t } from the whole-file diff; kept on the (cached) result.
function wholeTokens(r: DiffResult, langOld: string | null, langNew: string | null){
  if (r.tok !== undefined) return r.tok;
  r.tok = null;
  if (r.truncated || r.patch.length > HL_MAX_CHARS) return null;
  const old: LineToks = new Map(), neu: LineToks = new Map();
  // Old-side tokens exist only for lines with an old number, new-side ones with a new number.
  const done = lexSides(parseDiff(r.patch), langOld, langNew, (l, ho, hn) => {
    if (ho) old.set(l.o!, { s: l.s, t: ho });
    if (hn) neu.set(l.n!, { s: l.s, t: hn });
  });
  if (done) r.tok = { old, neu };   // a file too big to color whole falls back to per-hunk state
  return r.tok;
}
function highlightDiff(d: ParsedDiff, f: DiffTarget, whole: DiffResult | null){
  const langNew = Syntax.lang(f.path), langOld = f.oldPath ? Syntax.lang(f.oldPath) : langNew;
  if (!langNew && !langOld) return;
  const w = whole && wholeTokens(whole, langOld, langNew);
  if (!w) { lexSides(d, langOld, langNew, (l, ho, hn) => { l.ho = ho; l.hn = hn; }); return; }
  const pick = (m: LineToks, k: number, s: string) => { const x = m.get(k); return x && x.s === s ? x.t : null; };
  // Non-added lines have an old number, non-removed lines a new one.
  for (const h of d.hunks) for (const l of h.lines) {
    if (l.t !== 'add') l.ho = pick(w.old, l.o!, l.s);
    if (l.t !== 'del') l.hn = pick(w.neu, l.n!, l.s);
  }
}
// Code point index (what markWords counts) → UTF-16 index (what the lexers count).
function unitAt(s: string, cp: number){
  let u = 0;
  for (let c = 0; c < cp && u < s.length; c++) u += s.codePointAt(u)! > 0xffff ? 2 : 1;
  return u;
}
// side 'o' or 'n' picks the old or new side's colors (context lines have both).
function codeHtml(l: DiffLine, side: 'o' | 'n'){
  const s = l.s, toks = (side === 'o' ? l.ho : l.hn) || [];
  let html = '', ti = 0;
  // [a, b) of the line split at token edges; text is always escaped.
  const piece = (a: number, b: number) => {
    while (a < b) {
      while (ti < toks.length && toks[ti]![1] <= a) ti++;
      const t = toks[ti];
      if (!t || t[0] >= b) { html += esc(s.slice(a, b)); return; }
      if (t[0] > a) { html += esc(s.slice(a, t[0])); a = t[0]; }
      const e = Math.min(t[1], b);
      html += Syntax.CLASSES.has(t[2]) ? `<span class="sx-${t[2]}">${esc(s.slice(a, e))}</span>` : esc(s.slice(a, e));
      a = e;
    }
  };
  if (!l.mark || l.mark[0] >= l.mark[1]) piece(0, s.length);
  else {
    const m0 = unitAt(s, l.mark[0]), m1 = unitAt(s, l.mark[1]);
    piece(0, m0); html += '<mark>'; piece(m0, m1); html += '</mark>'; piece(m1, s.length);
  }
  return html + (l.noeol ? '<span class="df-eol" title="No newline at end of file">⊘</span>' : '');
}

function diffNav(){
  $('#dfPos').textContent = `${dfAt + 1} / ${dfList.length}`;
  $<HTMLButtonElement>('#dfPrev').disabled = dfAt <= 0; $<HTMLButtonElement>('#dfNext').disabled = dfAt >= dfList.length - 1;
}
const ST_SHOWN_AS: Record<string, string> = { '?': 'A', '!': 'D' };
function diffBar(f: DiffTarget, d: ParsedDiff | null){
  const slash = f.path.lastIndexOf('/');
  $('#dfSt').className = 'st st-' + (ST_SHOWN_AS[f.status] || f.status);
  $('#dfSt').textContent = f.status;
  $('#dfPath').innerHTML = (f.oldPath && f.oldPath !== f.path ? `<span class="from">${esc(f.oldPath)} → </span>` : '')
    + `<span class="dir">${esc(f.path.slice(0, slash + 1))}</span>${esc(f.path.slice(slash + 1))}`;
  $('#dfPath').title = f.path;
  $('#dfStat').innerHTML = d && !d.binary ? `<span class="add">+${d.add.toLocaleString('en')}</span> <span class="del">−${d.del.toLocaleString('en')}</span>` : '';
  diffNav();
  diffPane.querySelectorAll<HTMLElement>('[data-df-view]').forEach(b => b.classList.toggle('on', (b.dataset.dfView === 'split') === dfPrefs.split));
  diffPane.querySelectorAll<HTMLElement>('[data-df-ctx]').forEach(b => b.classList.toggle('on', (b.dataset.dfCtx === 'full') === dfPrefs.full));
}

function renderDiff(f: DiffTarget, r: DiffResult, whole: DiffResult | null){
  const d = parseDiff(r.patch);
  diffBar(f, d);
  const note = (t: string) => `<p class="df-note">${t}</p>`;
  if (d.binary) { dfBody.innerHTML = note('Binary file: no text to compare.'); return; }
  if (!d.hunks.length) {
    const m = d.meta.join('\n');
    let t = 'No changes to show.';
    if (/^Large file/m.test(m)) t = esc(d.meta.find(x => x.startsWith('Large file'))) + '.';
    else if (/rename from/.test(m)) t = 'Renamed without changes.';
    else if (/old mode/.test(m)) t = 'Only the file mode changed (' + esc(m.match(/old mode (\d+)/)![1]) + ' → ' + esc((m.match(/new mode (\d+)/) || [, '?'])[1]) + ').';
    else if (/new file mode/.test(m)) t = 'New empty file.';
    else if (/deleted file mode/.test(m)) t = 'Deleted an empty file.';
    dfBody.innerHTML = note(t);
    return;
  }
  highlightDiff(d, f, whole);
  const nums = Math.max(1, ...d.hunks.flatMap(h => h.lines.map(l => Math.max(l.o || 0, l.n || 0))));
  dfBody.style.setProperty('--nw', String(nums).length + 1 + 'ch');
  let count = 0, cut = false, html = '';
  const sign: Record<DiffLine['t'], string> = { add: '+', del: '−', ctx: ' ' };
  for (const h of d.hunks) {
    if (cut) break;
    html += `<div class="df-hunk">${esc(h.head)}</div>`;
    if (!dfPrefs.split) {
      for (const l of h.lines) {
        if (++count > DIFF_MAX_LINES) { cut = true; break; }
        html += `<div class="df-ln t-${l.t}"><span class="no">${l.o ?? ''}</span><span class="no">${l.n ?? ''}</span><span class="sg">${sign[l.t]}</span><span class="code">${codeHtml(l, l.t === 'del' ? 'o' : 'n')}</span></div>`;
      }
      continue;
    }
    // Split: context on both sides; removed lines left, added right, side by side.
    for (let i = 0; i < h.lines.length && !cut;) {
      const l = h.lines[i]!;
      const cell = (x: DiffLine | undefined, side: 'l' | 'r') => x ? `<span class="no">${side === 'l' ? x.o : x.n}</span><span class="code t-${x.t}">${codeHtml(x, side === 'l' ? 'o' : 'n')}</span>` : '<span class="no"></span><span class="code none"></span>';
      if (l.t === 'ctx') { html += `<div class="df-row">${cell(l, 'l')}${cell(l, 'r')}</div>`; i++; count++; continue; }
      let j = i; while (j < h.lines.length && h.lines[j]!.t === 'del') j++;
      let k = j; while (k < h.lines.length && h.lines[k]!.t === 'add') k++;
      const dels = h.lines.slice(i, j), adds = h.lines.slice(j, k);
      for (let q = 0; q < Math.max(dels.length, adds.length); q++) {
        if (++count > DIFF_MAX_LINES) { cut = true; break; }
        html += `<div class="df-row">${cell(dels[q], 'l')}${cell(adds[q], 'r')}</div>`;
      }
      i = Math.max(k, i + 1);
    }
  }
  if (cut) html += note(`Showing the first ${DIFF_MAX_LINES.toLocaleString('en')} lines.`);
  if (r.truncated) html += note('This diff is very large and was cut short.');
  dfBody.innerHTML = `<div class="df-code ${dfPrefs.split ? 'split' : 'unified'}">${html}</div>`;
  dfBody.scrollTop = 0; dfBody.scrollLeft = 0;
}

$('#dfBack').addEventListener('click', closeDiff);
$('#dfPrev').addEventListener('click', () => stepDiff(-1));
$('#dfNext').addEventListener('click', () => stepDiff(1));
diffPane.querySelectorAll<HTMLElement>('[data-df-view]').forEach(b => b.addEventListener('click', () => {
  dfPrefs.split = b.dataset.dfView === 'split'; lsSet('lanes.diff', JSON.stringify(dfPrefs)); loadDiff();
}));
diffPane.querySelectorAll<HTMLElement>('[data-df-ctx]').forEach(b => b.addEventListener('click', () => {
  dfPrefs.full = b.dataset.dfCtx === 'full'; lsSet('lanes.diff', JSON.stringify(dfPrefs)); loadDiff();
}));

/* ---------- search ---------- */
function runSearch(){
  const q = $<HTMLInputElement>('#q').value.trim().toLowerCase();
  matches = []; matchPtr = -1;
  if (q) S.commits.forEach((c, i) => { if (c.hay.includes(q)) matches.push(i); });
  matchSet = q ? new Set(matches) : null;
  for (const [i, el] of pool) el.classList.toggle('dim', !!matchSet && !matchSet.has(i));
  $('#qCount').textContent = q ? `${matches.length} found` : '';
}

/* ---------- branch panel ----------
   Every branch, not only the ones whose commits are loaded: desktop lists
   them from the ref snapshot, browser mode from the labels in the log.
   Names with "/" are grouped into folders. The panel is an ARIA tree with
   one tab stop; the arrow keys move inside it. */
const sideList = $('#sideList');
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
let sideClosed = new Set(lsJSON<string[]>('lanes.sideClosed', []));
let sideFocus: string | null | undefined = null;   // data-key of the tree item holding the tab stop
let sideWaiting: string[] = [];        // branch tips not loaded yet; the panel redraws once they are
const sideBusy = new Set<string>();  // tips jumpTo is still loading history for
const FOLDER_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1.5 4v8.5h13V5.5H7.5L6 4z"/></svg>';
const CHEVRON = '<span class="sb-chev"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg></span>';

/* ---------- hidden branches ----------
   Per repository: full ref names, or prefixes ending in "/" for a whole
   folder or remote. Hidden refs leave the walk (git log --exclude) and lose
   their labels; commits that a visible ref also reaches stay, as in
   GitKraken. The checked-out branch is never hidden. */
const HIDDEN_KEY = 'lanes.hidden';
const repoKey = (path?: string) => path || (current ? current.path : 'browser:' + S.repo);
// Saved lists come from localStorage: keep only string entries.
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
function hiddenList(path?: string){
  return strings(lsJSON<Record<string, unknown>>(HIDDEN_KEY, {})[repoKey(path)]);
}
function saveHidden(list: string[], path?: string){
  const all = lsJSON<Record<string, string[]>>(HIDDEN_KEY, {});
  if (list.length) all[repoKey(path)] = list; else delete all[repoKey(path)];
  lsSet(HIDDEN_KEY, JSON.stringify(all));
}
const coveredBy = (ref: string, list: string[]) => list.find(h => h === ref || (h.endsWith('/') && ref.startsWith(h)));
function visibleRefs(r: Refs, list: string[]): Refs{
  if (!list.length) return r;
  return { ...r, refs: r.refs.filter(([, n]) => n === r.headRef || n.startsWith('refs/tags/') || !coveredBy(n, list)) };
}
const isHiddenRef = (ref: string, list: string[]) => !!S.refs && ref !== S.refs.headRef && !!coveredBy(ref, list);

/* Solo: show only the chosen branches (same entry format, saved in
   lanes.solo). It wins over hidden. The walk then has no tags and no HEAD,
   so sync tips must come from the soloed refs alone: a tip outside the walk
   used as ^exclude would drop commits a soloed branch later merges in. */
const SOLO_KEY = 'lanes.solo';
function soloList(path?: string){
  return strings(lsJSON<Record<string, unknown>>(SOLO_KEY, {})[repoKey(path)]);
}
function saveSolo(list: string[], path?: string){
  const all = lsJSON<Record<string, string[]>>(SOLO_KEY, {});
  if (list.length) all[repoKey(path)] = list; else delete all[repoKey(path)];
  lsSet(SOLO_KEY, JSON.stringify(all));
}
/* The refs the history walk starts from: their tips drive sync. */
function walkRefs(r: Refs, hidden: string[], solo: string[]): Refs{
  if (!solo.length) return visibleRefs(r, hidden);
  const head = r.headRef && coveredBy(r.headRef, solo);
  return { refs: r.refs.filter(([, n]) => !n.startsWith('refs/tags/') && coveredBy(n, solo)),
           headRef: head ? r.headRef : null, headSha: head ? r.headSha : null };
}
/* The refs shown as labels: the walk, plus tags on whatever it shows. */
function labelRefs(r: Refs, hidden: string[], solo: string[]): Refs{
  const w = walkRefs(r, hidden, solo);
  return solo.length ? { ...w, refs: w.refs.concat(r.refs.filter(([, n]) => n.startsWith('refs/tags/'))) } : w;
}
const shownRefs = (): Refs => S.refs ? walkRefs(S.refs, hiddenList(), soloList()) : { refs: [], headRef: null, headSha: null };

let hiddenGen = 0;           // bumped on every hide/solo change; a load or sync that saw an older list reloads
function reloadForWalk(){
  hiddenGen++;
  renderSide();
  if (NATIVE) { if (current && !busy) loadRepo(current, { keep: true }); }
  else if (browserData) showBrowser({ ...browserData, keep: true });
}
// Toggles ref in a hide/solo list. Covered by a folder entry: drops that
// entry (the whole folder comes back). Adding a folder drops entries inside it.
function toggleIn(list: string[], ref: string){
  const cover = coveredBy(ref, list);
  if (cover) return list.filter(h => h !== cover);
  return [...list.filter(h => !(ref.endsWith('/') && h.startsWith(ref))), ref];
}
/* A branch was renamed (to) or deleted (null): its exact entries in the hide
   and solo lists of each path follow it. Folder entries ("…/") stay as they
   are. Returns true when a list changed. */
function followRef(paths: string[], from: string, to: string | null){
  const old = 'refs/heads/' + from, now = to === null ? [] : ['refs/heads/' + to];
  let changed = false;
  for (const path of new Set(paths)) {
    const lists: [string[], (l: string[], p: string) => void][] = [[hiddenList(path), saveHidden], [soloList(path), saveSolo]];
    for (const [list, save] of lists) {
      if (!list.includes(old)) continue;
      // A Set: a stale entry of the new name (a branch deleted outside the app) is not doubled.
      save([...new Set(list.flatMap(h => h === old ? now : [h]))], path);
      changed = true;
    }
  }
  return changed;
}
// All off while an operation runs in the repo (opOff): the reload would have to wait for it.
function toggleHidden(ref: string){ if (opOff()) return; saveHidden(toggleIn(hiddenList(), ref)); reloadForWalk(); }
function toggleSolo(ref: string){ if (opOff()) return; saveSolo(toggleIn(soloList(), ref)); reloadForWalk(); }
function showAllBranches(){ if (opOff()) return; saveHidden([]); reloadForWalk(); }
function exitSolo(){ if (opOff()) return; saveSolo([]); reloadForWalk(); }

/* Browser mode: hiding filters the pasted log down to what visible refs reach. */
interface BrowserData { raws: Commit[]; repo: string; sample: boolean; note: string }
let browserData: BrowserData | null = null;
function showBrowser({ raws, repo, sample, note = '', keep = false }: Omit<BrowserData, 'note'> & { note?: string; keep?: boolean }){
  browserData = { raws, repo, sample, note };
  const remotes = guessRemotes(raws), refs = refsFromDec(raws, remotes);
  const hidden = hiddenList('browser:' + repo), solo = soloList('browser:' + repo);
  let list = raws;
  if (hidden.length || solo.length) {
    const by = new Map(raws.map(c => [c.hash, c])), keepSet = new Set<string>(), stack = [...tipsOf(walkRefs(refs, hidden, solo))];
    while (stack.length) {
      const h = stack.pop()!;
      if (keepSet.has(h) || !by.has(h)) continue;
      keepSet.add(h); by.get(h)!.parents.forEach(p => stack.push(p));
    }
    list = raws.filter(c => keepSet.has(c.hash));
  }
  setData(list, repo, sample, { note, refs, remotes: [...remotes], hidden, solo, keep });
}

interface Branch { name: string; ref: string; sha: string; head?: boolean }
/* Whether two full ref names are the same without letter case (any letter).
   On Windows HEAD "refs/heads/Feat" resolves through the file of branch
   "feat", so that is the checked-out branch; the backend compares the same way. */
const sameRef = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
type BranchList = { local: Branch[]; remote: Map<string, Branch[]>; detached: string | null };
function branchList(): BranchList{
  const local: Branch[] = [], remote = new Map<string, Branch[]>(); let detached: string | null = null;
  const addRemote = (r: string, b: Branch) => { if (!remote.has(r)) remote.set(r, []); remote.get(r)!.push(b); };
  if (S.refs) {
    const refs = S.refs;
    // Remote names can contain "/", so match the longest known one first.
    const names = [...S.remotes!].sort((a, b) => b.length - a.length);
    refs.refs.forEach(([sha, ref]) => {
      if (ref.startsWith('refs/heads/')) local.push({ name: ref.slice(11), ref, sha, head: sameRef(ref, refs.headRef) });
      else if (ref.startsWith('refs/remotes/')) {
        const rest = ref.slice(13), r = names.find(n => rest.startsWith(n + '/')) || rest.split('/')[0]!;
        const name = rest.slice(r.length + 1);
        if (name && name !== 'HEAD') addRemote(r, { name, ref, sha });
      }
    });
    if (S.refs.headSha && !local.some(b => b.head)) detached = S.refs.headSha;
  }
  return { local, remote, detached };
}

/* Browser mode has no upstream config: pair each local branch with the
   same name on origin (or any remote) and count over the loaded graph. */
function guessTracking(list: BranchList){
  const out = new Map<string, Track>();
  if (S.commits.length > 50000) return out;
  const reach = (sha: string) => {
    const seen = new Set<string>(), stack = [sha];
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h) || !S.idx.has(h)) continue;
      seen.add(h); S.commits[S.idx.get(h)!]!.parents.forEach(p => stack.push(p));
    }
    return seen;
  };
  const remotes = [...list.remote.keys()].sort((a, b) => +(b === 'origin') - +(a === 'origin'));
  list.local.forEach(b => {
    let up: Branch | null | undefined = null;
    for (const r of remotes) { up = list.remote.get(r)!.find(x => x.name === b.name); if (up) break; }
    if (!up || !S.idx.has(b.sha) || !S.idx.has(up.sha)) return;   // e.g. one of them is hidden
    const A = reach(b.sha), B = reach(up.sha);
    let ahead = 0, behind = 0;
    A.forEach(h => { if (!B.has(h)) ahead++; });
    B.forEach(h => { if (!A.has(h)) behind++; });
    out.set(b.name, { name: b.name, upstream: up.ref, ahead, behind, gone: false });
  });
  return out;
}

let trackSeq = 0;
async function loadTracking(){
  if (!NATIVE || !current) return;
  const seq = ++trackSeq, path = current.path;
  try {
    const list = await invoke('branch_tracking', { path });
    if (seq !== trackSeq || !current || current.path !== path) return;
    S.track = new Map(list.map(t => [t.name, t]));
    renderSide(); renderHeadTrack();
  } catch (e) { /* the counts are extras; the panel works without them */ }
}

let sideHidden: string[] = [], sideSolo: string[] = [];   // hide/solo lists for the render in progress (read once per render)

/* hideRef: the ref or "folder/" prefix the eye toggles; none for sections. */
function sideNode(key: string, level: number, label: string, count: number | null, children: string, cls: string, hideRef?: string){
  const open = !!$<HTMLInputElement>('#bq').value.trim() || !sideClosed.has(key);
  const st = hideRef ? refState(hideRef, false) : 'shown', hidden = st === 'hidden' || st === 'out';
  return `<div role="treeitem" class="sb-node ${cls}${hidden ? ' is-hidden' : ''}${st === 'solo' ? ' is-solo' : ''}" aria-level="${level}" aria-expanded="${open}" data-key="${esc(key)}"${hideRef ? ` data-ref="${esc(hideRef)}"` : ''} tabindex="-1">`
    + `<div class="sb-row" style="--lvl:${level}">${CHEVRON}${label}${count == null ? '' : `<span class="sb-count">${count.toLocaleString('en')}</span>`}`
    + `${hideRef ? rowButtons(hideRef, st) : ''}</div>`
    + `<div role="group">${children}</div></div>`;
}

/* solo: in the solo set; out: solo is on and this is not in it;
   hidden / shown otherwise. The checked-out branch is never hidden. */
type RefState = 'solo' | 'out' | 'hidden' | 'shown';
function refState(ref: string, isHead: boolean | undefined): RefState{
  if (sideSolo.length) return coveredBy(ref, sideSolo) ? 'solo' : 'out';
  return !isHead && coveredBy(ref, sideHidden) ? 'hidden' : 'shown';
}
function rowButtons(ref: string, st: RefState, canHide = true){
  const on = st === 'solo';
  const solo = `<span class="sb-solo${on ? ' on' : ''}" data-solo="${esc(ref)}" title="${on ? 'Leave solo (S)' : 'Solo: show only this (S)'}" aria-hidden="true">${ICON.solo}</span>`;
  return solo + (!sideSolo.length && canHide ? eyeBtn(ref, st === 'hidden') : '');
}
const refLabel = (r: string) => r.replace(/^refs\/(heads|remotes)\//, '');
function eyeBtn(ref: string, hidden: boolean){
  const cover = hidden && coveredBy(ref, sideHidden);
  let title = 'Hide from the graph (H)';
  // hidden comes from refState, so some entry covers ref.
  if (hidden) title = cover === ref ? 'Show in the graph (H)' : `Hidden with ${refLabel(cover as string)}. Click to show it again (H)`;
  return `<span class="sb-eye${hidden ? ' on' : ''}" data-hide="${esc(ref)}" title="${esc(title)}" aria-hidden="true">${hidden ? ICON.eyeOff : ICON.eye}</span>`;
}

function sideLeaf(b: Branch, label: string, level: number, track: Map<string, Track>){
  const i = S.idx.get(b.sha), loaded = i !== undefined;
  const canHide = !b.head && b.ref !== 'HEAD', canSolo = b.ref !== 'HEAD';
  const st = canSolo ? refState(b.ref, b.head) : (sideSolo.length ? 'out' : 'shown'), hidden = st === 'hidden' || st === 'out';
  const shown = loaded && !hidden;
  if (!loaded && !hidden) sideWaiting.push(b.sha);
  const mark = b.head ? `<span class="sb-head">${ICON.check}</span>`
    : `<span class="sb-dot${shown ? '' : ' off'}"${shown ? ` style="--c:${laneCol(S.commits[i!]!.color)}"` : ''}></span>`;
  const t = track.get(b.ref.startsWith('refs/heads/') ? b.name : '');
  const up = t ? t.upstream.replace(/^refs\/(remotes|heads)\//, '') : '';
  let badge = '', tip = b.ref;
  if (t && t.gone) { badge = '<span class="sb-track gone">gone</span>'; tip += `\nUpstream ${up} no longer exists`; }
  else if (t) {
    if (t.ahead || t.behind) badge = `<span class="sb-track">${t.ahead ? `<span>↑${t.ahead}</span>` : ''}${t.behind ? `<span>↓${t.behind}</span>` : ''}</span>`;
    tip += `\nTracking ${up}: ${t.ahead} ahead, ${t.behind} behind`;
  }
  if (st === 'out') tip += '\nNot in solo';
  else if (hidden) tip += '\nHidden from the graph';
  else if (!loaded) tip += '\nNot loaded yet; click to load and show it';
  if (b.head) tip += '\nThe checked-out branch is always shown';
  const on = !hidden && detailFor && !detailFor.card && detailFor.hash === b.sha;
  return `<div role="treeitem" class="sb-leaf${b.head ? ' is-head' : ''}${hidden ? ' is-hidden' : ''}${st === 'solo' ? ' is-solo' : ''}${sideBusy.has(b.sha) ? ' busy' : ''}" data-kind="branch" aria-level="${level}" aria-selected="${!!on}" data-key="${esc(b.ref)}"${canSolo ? ` data-ref="${esc(b.ref)}"` : ''}${canHide ? ' data-can-hide="1"' : ''} data-sha="${esc(b.sha)}" tabindex="-1" title="${esc(tip)}">`
    + `<div class="sb-row" style="--lvl:${level}">${mark}<span class="sb-name">${esc(label)}</span>${badge}${canSolo ? rowButtons(b.ref, st, canHide) : ''}</div></div>`;
}

/* Folders and branches sorted together by name, like a file tree. */
interface TreeNode { dirs: Map<string, TreeNode>; leaves: Branch[]; n: number }
type TreeEntry = { name: string; d: TreeNode; b?: undefined } | { name: string; b: Branch; d?: undefined };
function sideTree(items: Branch[], level: number, key: string, track: Map<string, Track>, prefix: string){
  const root: TreeNode = { dirs: new Map(), leaves: [], n: 0 };
  items.forEach(b => {
    let n = root; n.n++;
    b.name.split('/').slice(0, -1).forEach(p => {
      if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), leaves: [], n: 0 });
      n = n.dirs.get(p)!; n.n++;
    });
    n.leaves.push(b);
  });
  const walk = (n: TreeNode, level: number, key: string, dir: string): string => [
    ...[...n.dirs].map(([name, d]): TreeEntry => ({ name, d })),
    ...n.leaves.map((b): TreeEntry => ({ name: b.name.slice(b.name.lastIndexOf('/') + 1), b })),
  ].sort((x, y) => collator.compare(x.name, y.name)).map(e => e.b
    ? sideLeaf(e.b, e.name, level, track)
    : sideNode(`${key}/${e.name}`, level, `<span class="sb-ic">${FOLDER_ICON}</span><span class="sb-name">${esc(e.name)}</span>`, e.d.n,
        walk(e.d, level + 1, `${key}/${e.name}`, `${dir}${e.name}/`), 'sb-folder', `${dir}${e.name}/`)
  ).join('');
  return walk(root, level, key, prefix);
}

function renderSide(){
  sideHidden = hiddenList(); sideSolo = soloList();
  const list = branchList();
  const track = NATIVE ? (S.track || new Map()) : guessTracking(list);
  const q = $<HTMLInputElement>('#bq').value.trim().toLowerCase();
  const hit = (b: Branch) => !q || b.name.toLowerCase().includes(q);
  // Tree items are HTML elements, so a focused one has a dataset.
  const focused = sideList.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : null;
  const empty = (level: number, text: string) => `<div class="sb-empty" role="none" style="--lvl:${level}">${text}</div>`;
  sideWaiting = [];

  const local = list.local.filter(hit);
  let localHtml = sideTree(local, 2, 'L', track, 'refs/heads/');
  if (list.detached && (!q || 'head (detached)'.includes(q)))
    localHtml = sideLeaf({ name: 'HEAD (detached)', ref: 'HEAD', sha: list.detached, head: true }, 'HEAD (detached)', 2, track) + localHtml;
  const localCount = local.length + (list.detached ? 1 : 0);

  let remoteHtml = '', remoteCount = 0;
  [...list.remote.keys()].sort((a, b) => +(b === 'origin') - +(a === 'origin') || collator.compare(a, b)).forEach(r => {
    const items = list.remote.get(r)!.filter(hit);
    if (q && !items.length) return;
    remoteCount += items.length;
    remoteHtml += sideNode(`R:${r}`, 2, `<span class="sb-ic">${ICON.cloud}</span><span class="sb-name">${esc(r)}</span>`, items.length,
      items.length ? sideTree(items, 3, `R:${r}`, track, `refs/remotes/${r}/`) : empty(3, 'No branches'), 'sb-remote', `refs/remotes/${r}/`);
  });

  sideList.innerHTML =
    sideNode('L', 1, `<span class="sb-ic">${ICON.laptop}</span><span class="sb-name">Local</span>`, localCount,
      localHtml || empty(2, q ? 'No matches' : 'No local branches'), 'sb-sec')
    + sideNode('R', 1, `<span class="sb-ic">${ICON.cloud}</span><span class="sb-name">Remote</span>`, remoteCount,
      remoteHtml || empty(2, q ? 'No matches' : 'No remotes'), 'sb-sec')
    + (NATIVE ? prSection(q, empty) + stashSection(q, empty) : '');

  // Above the tree: "Solo · N  [Exit solo]" or "N hidden  [Show all]".
  const all = list.local.concat(...list.remote.values());
  const n = sideSolo.length ? all.filter(b => coveredBy(b.ref, sideSolo)).length
    : all.filter(b => !b.head && isHiddenRef(b.ref, sideHidden)).length;
  const nn = n.toLocaleString('en');
  $('#sideHidden').hidden = !sideSolo.length && !sideHidden.length;
  $('#sideHidden').classList.toggle('solo', !!sideSolo.length);
  $('#sideHiddenText').textContent = sideSolo.length ? 'Solo · ' + nn : nn + ' hidden';
  $('#sideHiddenText').title = sideSolo.length ? 'Showing only ' + nn + (n === 1 ? ' branch' : ' branches')
    : nn + (n === 1 ? ' branch is' : ' branches are') + ' hidden from the graph';
  $('#showAllBtn').textContent = sideSolo.length ? 'Exit solo' : 'Show all';

  const items = [...sideList.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const keep = items.find(el => el.dataset.key === (focused || sideFocus)) || items[0];
  if (keep) { keep.tabIndex = 0; sideFocus = keep.dataset.key; if (focused) keep.focus({ preventScroll: true }); }
}

/* A branch is selected while its tip commit is in the detail panel; a stash
   or pull request while its own card is. */
function markSide(){
  const d = detailFor;
  sideList.querySelectorAll('.sb-leaf[aria-selected="true"]').forEach(el => el.setAttribute('aria-selected', 'false'));
  if (!d) return;
  const sel = d.card ? `.sb-leaf[data-key="${CSS.escape(d.key)}"]` : `.sb-leaf[data-kind="branch"][data-sha="${CSS.escape(d.hash)}"]`;
  sideList.querySelectorAll(sel).forEach(el => el.setAttribute('aria-selected', 'true'));
}

/* Selects a branch tip; on desktop keeps loading pages until it is in view. */
let jumpSeq = 0;
async function jumpTo(sha: string, { detail: show = true }: { detail?: boolean } = {}){
  const seq = ++jumpSeq;
  if (!S.idx.has(sha) && NATIVE && S.more) {
    // By SHA, not element: pages arriving meanwhile redraw the panel.
    const mark = (on: boolean) => { sideBusy[on ? 'add' : 'delete'](sha); sideList.querySelectorAll(`.sb-leaf[data-sha="${CSS.escape(sha)}"]`).forEach(x => x.classList.toggle('busy', on)); };
    mark(true);
    let stalls = 0;
    while (!S.idx.has(sha) && S.more && seq === jumpSeq) {
      const r = await loadMore();
      if (r === false) break;
      if (r === 'skip') { if (++stalls > 600) break; await new Promise(res => setTimeout(res, 100)); }
      else stalls = 0;
    }
    mark(false);
  }
  if (seq !== jumpSeq) return;
  const i = S.idx.get(sha);
  if (i === undefined) { showError('That commit is not in the loaded history.'); return; }
  select(i, { detail: show });
  // Center the row, the way GitKraken does when you pick a branch.
  wrap.scrollTop = Math.max(0, rowOff + i * ROW_H + ROW_H / 2 - (wrap.clientHeight - HEAD_H) / 2);
  if (narrowView()) showSide(false);
}

/* ---------- work in progress (desktop) ----------
   A row above the newest commit while the work tree has uncommitted
   changes, joined to HEAD by a dashed line, like GitKraken's WIP row. Work
   tree edits do not touch .git, so the ref fingerprint cannot see them;
   work_status is polled on its own, slower when status is slow. */
const WIP_EVERY = 4000;
let wip: { path: string | null; files: WorkFile[]; total: number; sig: string } = { path: null, files: [], total: 0, sig: '' }, wipSeq = 0, wipNext = 0;
let wipBusy: string | null = null;   // repo whose work_status is on its way
let wipSel = false;          // the WIP row is selected (sel is then -1)
let rowOff = 0;              // px above row 0: ROW_H while the WIP row shows
const wipRow = document.createElement('div');
wipRow.className = 'row wip-row';
wipRow.hidden = true;

const wipOn = () => NATIVE && !!current && wip.path === current.path && wip.total > 0 && S.commits.length > 0;
function wipHead(): number{
  const h = S.refs && S.refs.headSha && S.idx.get(S.refs.headSha);
  // headSha is null or a full SHA (never ''), so h is a row index here.
  return h === undefined || h === null ? -1 : h as number;
}

async function loadWip({ force = false }: { force?: boolean } = {}){
  // Only a status of this repo still on its way holds this one back: one of the
  // repo just left must not delay the new tab's WIP row.
  if (!NATIVE || !current || document.hidden || wipBusy === current.path || opHere()) return;
  if (!force && Date.now() < wipNext) return;
  const seq = ++wipSeq, path = current.path, t0 = performance.now();
  wipBusy = path;
  try {
    const r = await invoke('work_status', { path });
    if (seq === wipSeq && current && current.path === path) applyWip(path, r);
  } catch (e) { /* keep the last state; the next poll tries again */ }
  finally {
    // A newer request (another repo) owns the busy mark and the next time.
    if (seq === wipSeq) {
      wipBusy = null;
      // A slow status (huge work tree) is asked less often.
      wipNext = Date.now() + Math.max(WIP_EVERY, (performance.now() - t0) * 8);
    }
  }
}

function wipKind(f: WorkFile){
  if (f.conflict) return 'conflict';
  if (f.staged === 'A' || f.unstaged === '?') return 'add';
  if (f.staged === 'D' || f.unstaged === 'D') return 'del';
  return 'mod';
}
function applyWip(path: string, r: WorkStatus){
  const sig = r.total + '|' + r.files.map(f => `${f.staged}${f.unstaged}${f.conflict ? '!' : ''} ${f.oldPath || ''}>${f.path}`).join('|');
  if (wip.path === path && wip.sig === sig) { refreshWipDiff(); return; }
  wip = { path, files: r.files, total: r.total, sig };
  const n = { mod: 0, add: 0, del: 0, conflict: 0 };
  r.files.forEach(f => n[wipKind(f)]++);
  const chip = (k: keyof typeof n, icon: string, label: string) => n[k] ? `<span class="wip-n ${k}" title="${n[k]} ${label}">${icon}${n[k]}</span>` : '';
  wipRow.innerHTML = '<div class="col-ref"></div><div class="col-graph"></div>'
    + `<div class="col-msg"><span class="wip-label">// WIP</span>${chip('mod', ICON.pencil, 'modified')}${chip('add', '+', 'added')}${chip('del', '−', 'deleted')}${chip('conflict', '!', 'conflicted')}</div><div class="col-date"></div>`;
  wipRow.title = r.total === 1 ? '1 file changed, not committed' : r.total.toLocaleString('en') + ' files changed, not committed';
  placeRows();
  if (detailFor && detailFor.card === 'wip') {
    if (wipOn()) { wipCard(); if (diffOpen() && dfList[dfAt]?.kind === 'wip') { syncDiffList(); diffNav(); refreshWipDiff(); } }
    else { const h = wipHead(); select(h >= 0 ? h : 0); }   // everything was committed or reverted
  }
  scheduleDraw();
}

/* Positions everything below the WIP row and keeps the same commits on
   screen when it appears or goes away. */
function placeRows(){
  const on = wipOn(), off = on ? ROW_H : 0, n = S.commits.length;
  body.style.height = off + (n + (S.more ? 1 : 0)) * ROW_H + 'px';
  moreRow.style.top = off + n * ROW_H + 'px';
  if (off !== rowOff) {
    const d = off - rowOff;
    rowOff = off;
    if (wrap.scrollTop > 0) wrap.scrollTop += d;
    for (const [i, el] of pool) el.style.top = rowOff + i * ROW_H + 'px';
  }
  wipRow.hidden = !on;
  wipRow.classList.toggle('no-head', on && wipHead() < 0);   // see paintGraph
  if (!on && wipSel) { wipSel = false; wipRow.classList.remove('sel'); }
}

function selectWip({ open = false }: { open?: boolean } = {}){
  if (!wipOn()) return;
  pool.get(sel)?.classList.remove('sel');
  sel = -1; wipSel = true;
  wipRow.classList.add('sel');
  wipCard();
  markSide();
  if (open) detail.classList.add('open');
  scheduleDraw();
}

function wipFile(f: WorkFile, side: 's' | 'u', i: number){
  const st = f.conflict ? '!' : side === 's' ? f.staged : f.unstaged;
  const cls = st === '?' ? 'A' : st === '!' ? 'D' : st;
  const slash = f.path.lastIndexOf('/');
  const full = (f.oldPath ? f.oldPath + ' → ' : '') + f.path;
  const note = f.conflict ? '<span class="del">conflict</span>' : st === '?' ? '<span class="muted">untracked</span>' : '';
  return `<li class="d-file" data-df="${i}" title="${esc(full)}"><span class="st st-${esc(cls)}">${esc(st === '?' ? 'A' : st)}</span>`
    + `<span class="fp">${f.oldPath ? `<span class="from">${esc(f.oldPath)} → </span>` : ''}<span class="dir">${esc(f.path.slice(0, slash + 1))}</span>${esc(f.path.slice(slash + 1))}</span>`
    + `<span class="ns">${note}</span></li>`;
}
function wipCard(){
  detailFor = { card: 'wip', key: 'WIP' };
  const files = wip.files, staged = files.filter(f => f.staged), unstaged = files.filter(f => f.unstaged || f.conflict);
  const branch = S.refs && S.refs.headRef ? S.refs.headRef.replace(/^refs\/heads\//, '') : 'a detached HEAD';
  const conflicts = files.filter(f => f.conflict).length;
  // One list for diff navigation: unstaged first, then staged, as shown.
  panelFiles = [];
  const entry = (f: WorkFile, side: 's' | 'u') => {
    const kind: WipSide = f.conflict ? 'conflict' : side === 's' ? 'staged' : f.unstaged === '?' ? 'untracked' : 'unstaged';
    const status = f.conflict ? '!' : side === 's' ? f.staged : f.unstaged === '?' ? 'A' : f.unstaged;
    panelFiles.push({ kind: 'wip', side: kind, path: f.path, oldPath: side === 's' ? f.oldPath : null, status });
    return panelFiles.length - 1;
  };
  const part = (title: string, list: WorkFile[], side: 's' | 'u') => `<div class="d-files"><div class="d-files-head"><span>${title} (${list.length.toLocaleString('en')})</span></div>`
    + (list.length ? `<ul class="d-file-list">${list.map(f => wipFile(f, side, entry(f, side))).join('')}</ul>` : '<p class="muted">None</p>') + '</div>';
  detail.innerHTML =
    '<div class="d-top"><span class="k">Work in progress</span><button class="btn icon-btn sm d-close" aria-label="Close details">✕</button></div>'
    + '<h2 class="d-subject">Uncommitted changes</h2>'
    + `<p class="muted">On ${esc(branch)} · ${wip.total.toLocaleString('en')} ${wip.total === 1 ? 'file' : 'files'} changed</p>`
    + (conflicts ? `<div class="d-refs"><span class="d-badge warn">${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}</span></div>` : '')
    + part('Unstaged files', unstaged, 'u') + part('Staged files', staged, 's')
    + (wip.total > files.length ? `<p class="muted note">and ${(wip.total - files.length).toLocaleString('en')} more files</p>` : '')
    + '<p class="muted note">GitKrapao only shows these changes. Stage and commit them in your editor or terminal.</p>';
  markDiffRow();
}

/* ---------- stashes and pull requests (desktop) ----------
   Kept per repository outside S, which is rebuilt on every reload. Clicking
   one puts its card in the detail panel and moves the graph to the commit
   it belongs to, without replacing the card. */
type StashItem = Stash & { card: 'stash'; key: string };
let stashes: StashItem[] = [], stashPath: string | null = null, stashSeq = 0;
async function loadStashes(){
  if (!NATIVE || !current) return;
  const seq = ++stashSeq, path = current.path;
  try {
    const list = await invoke('list_stashes', { path });
    if (seq !== stashSeq || !current || current.path !== path) return;
    stashes = list.map(st => ({ ...st, card: 'stash' as const, key: 'S:' + st.sha }));
    stashPath = path;
    placeStashes();
    refreshCard();
    renderSide();
  } catch (e) { /* the list stays as it was; the next sync asks again */ }
}

// "On main: message" -> message; "WIP on main: 1a2b3c4 subject" -> WIP on main
function stashLabel(st: Stash){
  const m = st.message.match(/^(WIP on|On) ([^:]*): ([\s\S]*)$/);
  if (!m) return { label: st.message, branch: '' };
  return { label: m[1] === 'On' ? m[3]! : `WIP on ${m[2]}`, branch: m[2]! };
}

/* Stash rows: each stash also sits in the graph as its own row above the
   commit it was made on, joined by a dashed gray line. git log does not list
   them, so they are merged in by committer time (mergeNew) and the layout is
   redone, but only when the set of stashes whose base is loaded changes:
   after the stash list changes, after a full reload, and when a new page
   brings in a stash's base. Returns 'relayout', 'names' or false. */
// A stash always has its base as first parent. Row fields come from prepCommit/layoutRows.
function stashRowOf(st: StashItem){
  return { hash: st.sha, parents: [st.parents[0]!], author: 'Stash', email: '', time: st.time, ctime: st.time,
           subject: stashLabel(st).label, dec: '', stashRow: true, stashKey: st.key, stashName: st.name } as Commit;
}
/* Gives each stash row the first lane right of its base commit that is free
   on every row between the two (no node, no other line), so it sits beside
   its branch instead of taking that branch's lane. The dashed line runs
   down that lane and bends into the base commit. */
function laneStashes(){
  S.stashLaneMax = 0;
  const n = S.commits.length;
  S.commits.forEach((c, s) => {
    if (!c.stashRow) return;
    // Stash rows are placed only when their base commit is loaded (placeStashes).
    const b = S.idx.get(c.parents[0]!)!, base = S.commits[b]!, taken = new Set<number>();
    for (let r = s; r <= b; r++) if (!S.commits[r]!.stashRow) taken.add(S.commits[r]!.lane);
    for (const e of S.edges) {
      const t = e.to >= 0 ? e.to : n;
      if (t < s || e.from > b) continue;
      taken.add(e.lane);
      if (e.from >= s) taken.add(e.fromLane);
      if (t <= b) taken.add(e.toLane);
    }
    let x = base.lane + 1;
    while (taken.has(x)) x++;
    c.lane = x; c.color = -1;
    S.edges.push({ from: s, fromLane: x, lane: x, to: b, toLane: base.lane, color: -1 });
    base.children.push(s);
    if (x > S.stashLaneMax!) S.stashLaneMax = x;   // set to 0 above
  });
}

function placeStashes({ render: redraw = true }: { render?: boolean } = {}){
  if (!NATIVE || !S.commits.length) return false;
  const list = current && stashPath === current.path ? stashes : [];
  const want = list.filter(st => { const i = S.idx.get(st.parents[0]!); return i !== undefined && !S.commits[i]!.stashRow; });
  const have = S.commits.filter(c => c.stashRow);
  const ids = (a: (StashItem | Commit)[]) => a.map(x => 'sha' in x ? x.sha : x.hash).sort().join();
  if (ids(want) === ids(have)) {
    // Same stashes; only stash@{n} may have shifted after a push or pop.
    let renamed = false;
    have.forEach(c => { const st = list.find(x => x.sha === c.hash); if (st && st.name !== c.stashName) { c.stashName = st.name; renamed = true; } });
    if (renamed && redraw) { for (const el of pool.values()) el.remove(); pool.clear(); scheduleDraw(); }
    return renamed ? 'names' : false;
  }
  const keepHash = S.commits[sel]?.hash ?? null;
  const anchor = scrollAnchor(), top = wrap.scrollTop, left = wrap.scrollLeft;
  const real = S.commits.filter(c => !c.stashRow);
  const rows = want.map(stashRowOf).sort((x, y) => y.ctime! - x.ctime!);
  S.commits = mergeNew(rows, real, new Map(real.map((c, i) => [c.hash, i])));
  S.idx = new Map(S.commits.map((c, i) => [c.hash, i]));
  rows.forEach(prepCommit);
  S.edges = []; S.lay = newLayout();
  layoutRows(S.lay, S.commits, 0, S.idx, S.edges);
  laneStashes();
  S.maxLane = Math.max(S.lay.maxLane, S.stashLaneMax!); S.stashRows = rows.length;
  if (redraw) render(keepHash, { top: anchoredTop(anchor, top), left });
  return 'relayout';
}

type EmptyRow = (level: number, text: string) => string;
function stashSection(q: string, empty: EmptyRow){
  const list = current && stashPath === current.path ? stashes : [];
  const items = list.filter(st => !q || `${st.name} ${st.message}`.toLowerCase().includes(q));
  const html = items.map(st => {
    const on = detailFor && detailFor.key === st.key;
    const tip = `${st.name}\n${st.message}\n${absDate(st.time)}`;
    return `<div role="treeitem" class="sb-leaf sb-stash" data-kind="stash" aria-level="2" aria-selected="${!!on}" data-key="${esc(st.key)}" tabindex="-1" title="${esc(tip)}">`
      + `<div class="sb-row" style="--lvl:2"><span class="sb-ic">${ICON.stash}</span><span class="sb-name">${esc(stashLabel(st).label)}</span></div></div>`;
  }).join('');
  return sideNode('ST', 1, `<span class="sb-ic">${ICON.stash}</span><span class="sb-name">Stashes</span>`, items.length,
    html || empty(2, q ? 'No matches' : 'No stashes'), 'sb-sec');
}

function showStash(key: string){
  const st = stashes.find(x => x.key === key); if (!st) return;
  stashCard(st);
  if (narrowView()) detail.classList.add('open');
  // Only to a loaded commit, as for pull requests: a stash made on a commit
  // that was later rebased away is in no branch, so searching for it would
  // read the whole history for nothing.
  if (S.idx.has(st.sha)) jumpTo(st.sha, { detail: false });   // its own row in the graph
  else if (S.idx.has(st.parents[0]!)) jumpTo(st.parents[0]!, { detail: false });
  else markSide();
}
function stashCard(st: StashItem){
  const base = st.parents[0], { label, branch } = stashLabel(st);
  const c: Extract<Card, { card: 'stash' }> = { card: 'stash', stash: true, key: st.key, hash: st.sha, parents: st.parents };
  detailFor = c;
  detail.innerHTML =
    `<div class="d-top"><span class="k">Stash</span><code>${esc(st.name)}</code><button class="btn sm" data-copy="${esc(st.sha)}">Copy SHA</button><button class="btn icon-btn sm d-close" aria-label="Close details">✕</button></div>`
    + `<h2 class="d-subject">${esc(label)}</h2>`
    + '<div id="dBody"></div>'
    + `<dl class="d-meta"><dt>Date</dt><dd>${esc(absDate(st.time))} <span class="muted">(${esc(rel(st.time))})</span></dd>`
    + (branch ? `<dt>Branch</dt><dd>${esc(branch)}</dd>` : '')
    + `<dt>Made on</dt><dd>${base ? hashLink(base) : '<span class="muted">Unknown</span>'}</dd>`
    + `<dt>SHA</dt><dd><code>${esc(st.sha)}</code></dd></dl>`
    + (st.parents.length > 2 ? '<p class="muted note">Also holds untracked files, which are not listed below.</p>' : '')
    + '<div id="dFiles" class="d-files"><p class="muted">Loading changes…</p></div>';
  requestDetail(c);
}

/* After a new stash or PR list: redraw the card on screen (a stash's
   stash@{n} shifts, a PR's votes change), or go back to the selected commit
   when what it showed is gone (stash dropped, PR completed). */
function refreshCard(){
  const d = detailFor; if (!d || !d.card) return;
  const now = d.card === 'stash' ? stashes.find(x => x.key === d.key) : prs.items.find(x => x.key === d.key);
  const cur = S.commits[sel];
  if (!now) { if (cur) renderDetail(cur); else { detailFor = null; detail.innerHTML = ''; } }
  // now came from the list that matches d.card.
  else if (d.card === 'stash') stashCard(now as StashItem);
  else prCard(now as PrItem);
}

type PrItem = PullRequest & { card: 'pr'; key: string };
interface PrState { path: string | null; state: 'idle' | 'loading' | 'ok' | 'none' | 'error'; items: PrItem[]; repo: string | null; error: string; at: number }
let prs: PrState = { path: null, state: 'idle', items: [], repo: null, error: '', at: 0 };
const prSeq = new Map<string, number>();   // per repo, so a request for one repo never cancels another's
const prCache = new Map<string, PrState>();   // every repo seen, a list still loading included, so going back does not run az again
const noPrs = (): PrState => ({ path: null, state: 'idle', items: [], repo: null, error: '', at: 0 });
// A repo that is no longer open (prSeq stays: numbers must not repeat). Its list may
// also be the live one: loadPrs would otherwise put it back in the cache on the next switch.
function forgetPrs(path: string): void { prCache.delete(path); if (prs.path === path) prs = noPrs(); }
const PR_EVERY = 5 * 60e3;   // pull requests change on the server; ask again this often
/* minAge: skip if the list is newer than this. A sync (commit, fetch, a new
   remote URL) asks sooner than the timer, a manual refresh (force) always.
   An answer for a repo that is no longer the current one goes to that repo's
   cache entry only (prs and the panel belong to the current repo). */
async function loadPrs({ force = false, minAge = PR_EVERY }: { force?: boolean; minAge?: number } = {}){
  if (!NATIVE || !current) return;
  const path = current.path;
  const switched = prs.path !== path;
  if (switched) {
    if (prs.path) prCache.set(prs.path, prs);
    prs = prCache.get(path) ?? { path, state: 'loading', items: [], repo: null, error: '', at: 0 };
  }
  if (!force && Date.now() - prs.at < minAge) { if (switched) renderSide(); return; }
  const seq = (prSeq.get(path) ?? 0) + 1;
  prSeq.set(path, seq);
  prs.at = Date.now();
  if (prs.state === 'loading') renderSide();
  // Where this repo's list lives now; undefined once forgetPrs dropped it.
  const entry = () => prs.path === path ? prs : prCache.get(path);
  const put = (next: PrState) => { if (prs.path === path) prs = next; else prCache.set(path, next); };
  try {
    const r = await invoke('pull_requests', { path });
    const now = entry();
    if (seq !== prSeq.get(path) || !now) return;
    put({ ...now, state: r.repo ? 'ok' : 'none', repo: r.repo, error: '',
          items: r.items.map(p => ({ ...p, card: 'pr' as const, key: 'PR:' + p.id })) });
    if (prs.path !== path) return;
    refreshCard();
  } catch (e) {
    const now = entry();
    if (seq !== prSeq.get(path) || !now) return;
    put({ ...now, state: 'error', error: String(e) });   // keep the last list on screen
    if (prs.path !== path) return;
  }
  renderSide();
}

const shortRef = (r: string) => r.replace(/^refs\/heads\//, '');
const colorOf = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) | 0; return Math.abs(h) % PALETTE.length; };
const VOTE: Record<number, string> = { 10: 'Approved', 5: 'Approved with suggestions', 0: 'No vote', '-5': 'Waiting for author', '-10': 'Rejected' };
function prVotes(p: PrItem){
  const n = (f: (v: number) => boolean) => p.reviewers.filter(r => f(r.vote)).length;
  return ([[n(v => v >= 5), 'approved'], [n(v => v === -5), 'waiting for author'], [n(v => v <= -10), 'rejected']] as [number, string][])
    .filter(([k]) => k).map(([k, t]) => `${k} ${t}`).join(', ');
}
function avatar(name: string, cls: string){
  const k = colorOf(name);
  return `<span class="${cls}" style="background:${PALETTE[k]};color:${ON_COL[k]}">${esc(initials(name))}</span>`;
}

function prSection(q: string, empty: EmptyRow){
  const mine = current && prs.path === current.path;
  const items = (mine ? prs.items : []).filter(p => !q || `#${p.id} ${p.title} ${p.author} ${p.source}`.toLowerCase().includes(q));
  let body = '';
  if (!mine || (prs.state === 'loading' && !prs.items.length)) body = empty(2, 'Loading…');
  else if (prs.state === 'none') body = empty(2, 'No Azure DevOps remote');
  else {
    if (prs.state === 'error') body += `<div class="sb-empty sb-err" role="none" style="--lvl:2">${esc(prs.error)}</div>`;
    body += items.map(p => {
      const on = detailFor && detailFor.key === p.key, votes = prVotes(p);
      const tip = `#${p.id} ${p.title}\n${shortRef(p.source)} → ${shortRef(p.target)}\nBy ${p.author}${p.draft ? ' (draft)' : ''}${votes ? `\n${votes}` : ''}`;
      return `<div role="treeitem" class="sb-leaf sb-pr${p.draft ? ' draft' : ''}" data-kind="pr" aria-level="2" aria-selected="${!!on}" data-key="${esc(p.key)}" tabindex="-1" title="${esc(tip)}">`
        + `<div class="sb-row" style="--lvl:2">${avatar(p.author, 'sb-av')}<span class="sb-name">${esc(p.title)}</span>`
        + `${p.draft ? '<span class="sb-tag">Draft</span>' : ''}<span class="sb-count">#${p.id}</span></div></div>`;
    }).join('') || (prs.state === 'error' ? '' : empty(2, q ? 'No matches' : 'No active pull requests'));
  }
  const count = mine && (prs.state === 'ok' || prs.items.length) ? items.length : null;
  return sideNode('PR', 1, `<span class="sb-ic">${ICON.pr}</span><span class="sb-name">Pull requests</span>`, count, body, 'sb-sec');
}

/* The source branch as fetched (origin first, then other remotes, then a
   local branch of the same name), else the PR's last pushed commit if it is
   already loaded. Never an unloaded commit: it may not be in the repo at all. */
function prTip(p: PrItem): string | null{
  const name = shortRef(p.source), refs = shownRefs().refs;
  const find = (full: string) => { const r = refs.find(([, n]) => n === full); return r && r[0]; };
  const remotes = [...S.remotes!].sort((a, b) => +(b === 'origin') - +(a === 'origin'));
  return remotes.map(r => find(`refs/remotes/${r}/${name}`)).find(Boolean) || find(`refs/heads/${name}`)
    || (p.sourceSha && S.idx.has(p.sourceSha) ? p.sourceSha : null);
}

/* The PR's source branch exists here but every copy of it is hidden. */
function srcHidden(src: string){
  if (!S.refs) return false;
  const have = new Set(S.refs.refs.map(([, n]) => n)), shown = new Set(shownRefs().refs.map(([, n]) => n));
  const names = [`refs/heads/${src}`, ...[...S.remotes!].map(r => `refs/remotes/${r}/${src}`)].filter(n => have.has(n));
  return names.length > 0 && names.every(n => !shown.has(n));
}

function showPr(key: string){
  const p = prs.items.find(x => x.key === key); if (!p) return;
  const tip = prCard(p);
  if (narrowView()) detail.classList.add('open');
  if (tip) jumpTo(tip, { detail: false }); else markSide();
}
function prCard(p: PrItem){
  detailFor = { card: 'pr', key: p.key };
  const created = Date.parse(p.created) / 1000, tip = prTip(p);
  const src = shortRef(p.source), dst = shortRef(p.target);
  const at = tip !== null && S.idx.has(tip) ? laneCol(S.commits[S.idx.get(tip)!]!.color) : PALETTE[1];
  const badges = [p.draft ? '<span class="d-badge">Draft</span>' : '',
    p.mergeStatus === 'conflicts' ? '<span class="d-badge warn">Merge conflicts</span>' : '',
    p.mergeStatus === 'rejectedByPolicy' ? '<span class="d-badge warn">Blocked by policy</span>' : ''].join('');
  // Groups come as "[Project]\Team"; the team name is enough.
  const who = (n: string) => n.replace(/^\[[^\]]*\]\\/, '');
  const reviewers = p.reviewers.length
    ? `<ul class="d-reviewers">${p.reviewers.map(r => `<li>${avatar(who(r.name), 'sb-av')}<span class="n" title="${esc(r.name)}">${esc(who(r.name))}</span><span class="v v${r.vote}">${esc(VOTE[r.vote] || 'No vote')}</span></li>`).join('')}</ul>`
    : '<span class="muted">None</span>';
  detail.innerHTML =
    `<div class="d-top"><span class="k">Pull request</span><code>#${p.id}</code><button class="btn sm" data-open-url="${esc(p.url)}">Open in Azure DevOps</button><button class="btn icon-btn sm d-close" aria-label="Close details">✕</button></div>`
    + `<h2 class="d-subject">${esc(p.title)}</h2>`
    + (badges ? `<div class="d-refs">${badges}</div>` : '')
    + `<div class="d-flow"><span class="pill" style="--c:${at};background:${at}2e"><span class="name">${esc(src)}</span></span><span class="muted">into</span><span class="pill" style="--c:var(--text-3);background:var(--panel-2)"><span class="name">${esc(dst)}</span></span></div>`
    + (p.description ? `<div class="d-body">${esc(p.description)}</div>` : '')
    + `<div class="d-person">${avatar(p.author, 'd-av')}<div><div class="d-name">${esc(p.author)}</div><div class="d-mail">opened ${Number.isFinite(created) ? esc(rel(created)) : ''}</div></div></div>`
    + `<dl class="d-meta"><dt>Created</dt><dd>${Number.isFinite(created) ? `${esc(absDate(created))} <span class="muted">(${esc(rel(created))})</span>` : '<span class="muted">Unknown</span>'}</dd>`
    + `<dt>Source</dt><dd>${tip ? hashLink(tip) : '<span class="muted">Not fetched</span>'}</dd>`
    + `<dt>Reviewers</dt><dd>${reviewers}</dd></dl>`
    + (tip ? '' : `<p class="muted note">${srcHidden(src)
      ? `${esc(src)} is hidden from the graph. Show it in the branch panel to see it.` : `Fetch ${esc(src)} to see it in the graph.`}</p>`);
  return tip;
}

// Tree items always carry data-key; branch leaves also data-sha, and the eye/solo buttons their ref.
function sideToggle(el: HTMLElement, open = el.getAttribute('aria-expanded') !== 'true'){
  el.setAttribute('aria-expanded', String(open));
  if ($<HTMLInputElement>('#bq').value.trim()) return;   // filtering opens everything; don't remember that
  if (open) sideClosed.delete(el.dataset.key!); else sideClosed.add(el.dataset.key!);
  lsSet('lanes.sideClosed', JSON.stringify([...sideClosed]));
}
function sideActivate(el: HTMLElement){
  const kind = el.dataset.kind;
  if (kind) closeDiff();   // the graph is about to move: show it
  // A hidden or out-of-solo tip is usually not in the graph; jump only if it is loaded anyway.
  if (kind === 'branch') { if (!el.classList.contains('is-hidden') || S.idx.has(el.dataset.sha!)) jumpTo(el.dataset.sha!); }
  else if (kind === 'stash') showStash(el.dataset.key!);
  else if (kind === 'pr') showPr(el.dataset.key!);
  else sideToggle(el);
}
function sideMoveTo(el: HTMLElement | null | undefined, focus = true){
  if (!el) return;
  sideList.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"]').forEach(x => { x.tabIndex = -1; });
  el.tabIndex = 0; sideFocus = el.dataset.key; if (focus) el.focus();
}
const sideVisible = () => [...sideList.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  .filter(el => !el.parentElement!.closest('[aria-expanded="false"]'));

sideList.addEventListener('click', e => {
  const t = e.target as Element;
  const row = t.closest('.sb-row'); if (!row) return;
  const el = row.parentElement!;   // the tree item
  sideMoveTo(el);
  const eye = t.closest<HTMLElement>('[data-hide]'), solo = t.closest<HTMLElement>('[data-solo]');
  if (eye) toggleHidden(eye.dataset.hide!);
  else if (solo) toggleSolo(solo.dataset.solo!);
  else sideActivate(el);
});
$('#showAllBtn').addEventListener('click', () => (soloList().length ? exitSolo() : showAllBranches()));
sideList.addEventListener('keydown', e => {
  const el = (e.target as Element).closest<HTMLElement>('[role="treeitem"]'); if (!el) return;
  const vis = sideVisible(), k = vis.indexOf(el);
  const isNode = el.hasAttribute('aria-expanded'), open = el.getAttribute('aria-expanded') === 'true';
  const parent = el.parentElement!.closest<HTMLElement>('[role="treeitem"]');
  let done = true;
  if (e.key === 'ArrowDown') sideMoveTo(vis[k + 1]);
  else if (e.key === 'ArrowUp') sideMoveTo(vis[k - 1]);
  else if (e.key === 'Home') sideMoveTo(vis[0]);
  else if (e.key === 'End') sideMoveTo(vis[vis.length - 1]);
  else if (e.key === 'ArrowRight') { if (isNode && !open) sideToggle(el, true); else if (isNode) sideMoveTo(el.querySelector<HTMLElement>('[role="treeitem"]')); }
  else if (e.key === 'ArrowLeft') { if (isNode && open) sideToggle(el, false); else sideMoveTo(parent); }
  else if (e.key === 'Enter' || e.key === ' ') sideActivate(el);
  else if (e.ctrlKey || e.metaKey || e.altKey || !el.dataset.ref) done = false;
  // H hides (not the checked-out branch, not while solo is on); S solos.
  else if ((e.key === 'h' || e.key === 'H') && (el.dataset.canHide || el.classList.contains('sb-node')) && !soloList().length) toggleHidden(el.dataset.ref);
  else if (e.key === 's' || e.key === 'S') toggleSolo(el.dataset.ref);
  else done = false;
  if (done) { e.preventDefault(); e.stopPropagation(); }
});
$('#bq').addEventListener('input', renderSide);
$('#bq').addEventListener('keydown', e => {
  const t = e.target as HTMLInputElement;
  if (e.key === 'Escape' && t.value) { t.value = ''; renderSide(); e.stopPropagation(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); sideMoveTo(sideVisible()[0]); }
});

/* branch menu: right-click a branch, folder or remote in the panel, or a
   branch label in the graph. Hide follows the eye button's rules. */
const ctxMenu = $('#ctxMenu');
interface CtxEntry { label: string; off?: string; run: () => void }
let ctxRun: (() => void)[] = [], ctxBack: HTMLElement | null = null, ctxKeys = false;   // item actions; what gets focus back; keyboard in use
function openCtx(e: MouseEvent, entries: CtxEntry[], back: HTMLElement | null){
  e.preventDefault();
  // From the Menu key / Shift+F10: pointerType '' (or no position at all). WebView2 sends a PointerEvent.
  const pointerType = (e as PointerEvent).pointerType;
  ctxKeys = pointerType === '' || (!pointerType && !e.clientX && !e.clientY);
  ctxRun = entries.map(x => x.run); ctxBack = back;
  ctxMenu.innerHTML = entries.map((x, k) => `<button class="menu-item" role="menuitem" data-k="${k}"${x.off ? ' disabled' : ''}>`
    + `<span class="n">${esc(x.label)}</span>${x.off ? `<span class="p">${esc(x.off)}</span>` : ''}</button>`).join('');
  ctxMenu.hidden = false;
  // At the pointer; from the keyboard, under the item.
  let x = e.clientX, y = e.clientY;
  if (ctxKeys && back) { const r = back.getBoundingClientRect(); x = r.left + 16; y = r.bottom; }
  const m = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(4, Math.min(x, innerWidth - m.width - 4)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(y, innerHeight - m.height - 4)) + 'px';
  // A mouse user gets no focus ring: the menu itself (no outline) holds focus
  // for the arrow keys, and items light up on hover.
  ((ctxKeys && ctxMenu.querySelector<HTMLElement>('.menu-item:not(:disabled)')) || ctxMenu).focus();
}
function closeCtx(refocus: boolean){
  if (ctxMenu.hidden) return;
  ctxMenu.hidden = true; ctxRun = [];
  if (refocus && ctxKeys && ctxBack && ctxBack.isConnected) ctxBack.focus();
  else if (ctxMenu.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  ctxBack = null;
}
const SOLO_OFF = 'Exit solo to hide branches', HEAD_OFF = 'The checked-out branch is always shown';
const switchOff = (head: boolean) => head ? 'Already checked out' : opNow() || capOff();

sideList.addEventListener('contextmenu', e => {
  const el = (e.target as Element).closest<HTMLElement>('[role="treeitem"]');
  const leaf = el && el.dataset.kind === 'branch';
  if (!el || !el.dataset.ref || !(leaf || el.classList.contains('sb-node'))) return;
  sideMoveTo(el, false);
  const ref = el.dataset.ref, solo = soloList().length > 0;
  const show = !solo && el.classList.contains('is-hidden');
  const entries: CtxEntry[] = [{ label: show ? 'Show' : 'Hide', off: opOff() || (solo ? SOLO_OFF : leaf && !el.dataset.canHide ? HEAD_OFF : ''), run: () => toggleHidden(ref) }];
  if (leaf && NATIVE) entries.unshift({ label: `Switch to ${refLabel(ref)}`, off: switchOff(el.classList.contains('is-head')), run: () => runSwitch(ref) });
  if (leaf) entries.push({ label: 'Copy branch name', run: () => copyText(refLabel(ref)) });
  if (leaf && ref.startsWith('refs/heads/')) entries.push(...branchEntries(ref.slice('refs/heads/'.length)));
  openCtx(e, entries, el);
});
/* Double-click a branch (panel or graph label) to switch to it. */
sideList.addEventListener('dblclick', e => {
  const t = e.target as Element, el = t.closest<HTMLElement>('[role="treeitem"]');
  if (!NATIVE || !el || el.dataset.kind !== 'branch' || !el.dataset.ref || t.closest('button') || switchOff(el.classList.contains('is-head'))) return;
  runSwitch(el.dataset.ref);
});
body.addEventListener('dblclick', e => {
  const g = NATIVE ? pillGroup(e) : null;
  if (g && !switchOff(g.head)) runSwitch(groupRef(g));
});
/* The branch a graph label under the event stands for. A label is one ref
   group of its commit (data-g): one name, local and/or on remotes. */
function pillAt(e: Event): RefGroup | null {
  const pill = (e.target as Element).closest<HTMLElement>('.pill'), host = pill && pill.closest<HTMLElement>('.row, .ref-pop');
  if (!pill || !host || host === wipRow) return null;
  const c = S.commits[+host.dataset.i!];
  return (c && c.groups[+pill.dataset.g! || 0]) || null;
}
function pillGroup(e: Event): RefGroup | null {
  const g = pillAt(e);
  return g && g.kind === 'branch' && g.name !== 'HEAD (detached)' ? g : null;
}
/* A tag label (desktop only: its menu deletes it). */
function pillTag(e: Event): RefGroup | null {
  const g = NATIVE ? pillAt(e) : null;
  return g && g.kind === 'tag' ? g : null;
}
/* The local branch when there is one; a group without it is on a remote. */
const groupRef = (g: RefGroup) => g.local ? 'refs/heads/' + g.name : `refs/remotes/${g.remotes[0]}/${g.name}`;
/* Index of the commit row (or "+N" box) under the event; -1 for none and for the WIP row. */
function eventRow(e: Event): number {
  const host = (e.target as Element).closest<HTMLElement>('.row, .ref-pop');
  return host && host !== wipRow ? +host.dataset.i! : -1;   // rows and the box carry data-i
}
body.addEventListener('contextmenu', e => {
  const g = pillGroup(e), tag = g ? null : pillTag(e), i = eventRow(e), c = S.commits[i];
  if (tag) { openCtx(e, tagEntries(tag.name, c), null); return; }
  if (!g) {
    // Elsewhere on a commit row: create a branch or tag there. Over text
    // selected in the row, the WebView's own menu (Copy) stays instead.
    const s = getSelection();
    if (s && !s.isCollapsed && s.containsNode(e.target as Node, true)) return;
    const entries = c ? createEntries(c) : [];
    if (!entries.length) return;
    select(i);
    openCtx(e, entries, null);
    return;
  }
  const refs = (g.local ? ['refs/heads/' + g.name] : []).concat(g.remotes.map(r => `refs/remotes/${r}/${g.name}`));
  const solo = soloList().length > 0;
  const entries: CtxEntry[] = [
    { label: 'Hide', off: opOff() || (solo ? SOLO_OFF : g.head ? HEAD_OFF : ''), run: () => { if (opOff()) return; saveHidden(refs.reduce(toggleIn, hiddenList())); reloadForWalk(); } },
    { label: 'Copy branch name', run: () => copyText(g.local ? g.name : `${g.remotes[0]}/${g.name}`) },
  ];
  if (NATIVE) entries.unshift({ label: `Switch to ${g.local ? g.name : `${g.remotes[0]}/${g.name}`}`, off: switchOff(g.head), run: () => runSwitch(groupRef(g)) });
  if (g.local) entries.push(...branchEntries(g.name));
  if (c) entries.push(...createEntries(c));
  openCtx(e, entries, null);
});
ctxMenu.addEventListener('click', e => {
  const b = (e.target as Element).closest<HTMLButtonElement>('.menu-item'); if (!b || b.disabled) return;
  const run = ctxRun[+b.dataset.k!]!;   // data-k indexes the entries openCtx rendered
  closeCtx(true); run();
});
ctxMenu.addEventListener('keydown', e => {
  e.stopPropagation();   // the graph and panel keys stay off while the menu is open
  ctxKeys = true;        // from here on, focus rings and returning focus are wanted
  const on = [...ctxMenu.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)')], k = on.indexOf(document.activeElement as HTMLElement);
  const to = ({ ArrowDown: k + 1, ArrowUp: k < 0 ? -1 : k - 1, Home: 0, End: on.length - 1 } as Record<string, number>)[e.key];
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeCtx(true); }
  else if (to !== undefined && on.length) { e.preventDefault(); on[(to + on.length) % on.length]!.focus(); }
});
document.addEventListener('pointerdown', e => { if (!ctxMenu.contains(e.target as Node)) closeCtx(false); }, true);
[wrap, sideList].forEach(el => el.addEventListener('scroll', () => closeCtx(false), { passive: true }));
window.addEventListener('blur', () => closeCtx(false));
window.addEventListener('resize', () => closeCtx(false));

/* panel visibility and width */
const SIDE = { min: 160, max: 520, def: 200 };
const appEl = $('.app'), side = $('#side'), sideRz = $('.side-resizer');
const narrowView = () => matchMedia('(max-width: 900px)').matches;
let sideW = Number(lsGet('lanes.sidew'));   // 0 when unset, NaN when not a number: both fail the range check below
if (!(sideW >= SIDE.min && sideW <= SIDE.max)) sideW = SIDE.def;
// On a small screen the panel floats over the graph, so it starts closed.
let sideShown = !narrowView() && lsGet('lanes.side') !== '0';
function applySide(){
  appEl.style.setProperty('--sidew', sideW + 'px');
  appEl.classList.toggle('side-hidden', !sideShown);
  $('#sideBtn').setAttribute('aria-expanded', String(sideShown));
  sideRz.setAttribute('aria-valuenow', String(sideW));
}
function showSide(show = !sideShown){
  sideShown = show;
  if (!narrowView()) lsSet('lanes.side', show ? '1' : '0');
  applySide();
}
sideRz.setAttribute('aria-valuemin', String(SIDE.min));
sideRz.setAttribute('aria-valuemax', String(SIDE.max));
applySide();
$('#sideBtn').addEventListener('click', () => showSide());
{
  const set = (w: number) => { sideW = Math.round(Math.max(SIDE.min, Math.min(SIDE.max, w))); applySide(); };
  const save = () => lsSet('lanes.sidew', String(sideW));
  sideRz.addEventListener('pointerdown', e => {
    e.preventDefault(); sideRz.setPointerCapture(e.pointerId); sideRz.classList.add('drag');
    const startX = e.clientX, startW = sideW;
    const move = (ev: PointerEvent) => set(startW + ev.clientX - startX);
    const up = () => { sideRz.classList.remove('drag'); sideRz.removeEventListener('pointermove', move); sideRz.removeEventListener('pointerup', up); save(); };
    sideRz.addEventListener('pointermove', move); sideRz.addEventListener('pointerup', up);
  });
  sideRz.addEventListener('dblclick', () => { set(SIDE.def); save(); });
  sideRz.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); set(sideW + (e.key === 'ArrowRight' ? 10 : -10)); save();
  });
}

/* ---------- banner ---------- */
function showError(msg: string){ $('#bannerMsg').textContent = msg; $('#banner').hidden = false; }
function hideError(){ $('#banner').hidden = true; }
$('#bannerClose').addEventListener('click', hideError);

/* Undo bar: after a branch or tag was deleted in the active repo. It holds
   the backend's token (the page never sees what to restore) and the repo's
   lock key. It hides on ×, when any operation starts (runOp) and when the
   repo is left (dropRepo); a new delete replaces it; syncs and reloads of
   the same repo keep it. */
const undoBar = $('#undoBar'), undoBtn = $<HTMLButtonElement>('#undoBtn');
let undoFor: { d: DeletedRef; key: string } | null = null;
function showUndo(d: DeletedRef, key: string){
  undoFor = { d, key };
  const what = `Deleted ${d.kind} ${d.name} (${d.short})`;
  $('#undoMsg').textContent = d.onOrigin ? `${what} here and on origin. Undo restores it here only.` : what;
  undoBar.hidden = false;
}
function hideUndo(){ undoFor = null; undoBar.hidden = true; }
$('#undoClose').addEventListener('click', hideUndo);
undoBtn.addEventListener('click', () => {
  const u = undoFor;
  if (!u || current?.lockKey !== u.key) return;
  runOp('restore', path => invoke('restore_ref', { path, token: u.d.token }), {
    // Nothing was written (the name is taken, a trust question cancelled,
    // update-ref refused by git, 'busy'): the backend still holds the token and
    // answers with no exit code, so offer it again. A timeout, or a run that
    // wrote the ref and then failed, used it up.
    done: (r, info) => {
      if (!r.ok && r.exitCode === null && !r.timedOut && current?.lockKey === info.lockKey) showUndo(u.d, u.key);
      return false;
    },
  });
});

/* ---------- desktop: real repositories ---------- */
let current: RepoInfo | null = null;
let fingerprintSeen: string | null = null;
let busy = false, moreBusy = false;
let busyPath: string | null = null;   // repo of the load or sync that holds `busy`
let loadSeq = 0;             // newest load (or sync) wins: an older one stops after its next await
let streamGen = 0;           // backend history stream the loaded rows came from
let streamPos = 0;           // records consumed from that stream (rows can also come from syncs)
let startedGen = 0;          // newest stream start_history returned (gens only grow)
let stoppedGen = 0;          // every stream up to this gen has been told to stop
const SYNC_CAP = 5000;       // more new commits than this: reload instead of merging

/* Leaving a repo releases its history stream: git stops and the rows read so
   far are freed. The backend ignores the stop when a newer stream than gen has
   started, so a stop that arrives after the next start_history is harmless. */
function stopHistory(gen = startedGen){
  if (!NATIVE || gen <= stoppedGen) return;
  stoppedGen = gen;
  invoke('stop_history', { gen }).catch(() => {});
}

function recentList(){ return lsJSON<Pick<RepoInfo, 'path' | 'name'>[]>('lanes.recent', []).filter(r => r && r.path); }
function addRecent(info: RepoInfo){
  const list = recentList().filter(r => r.path !== info.path);
  list.unshift({ path: info.path, name: info.name });
  lsSet('lanes.recent', JSON.stringify(list.slice(0, 8)));
}
function forgetRecent(path: string){ lsSet('lanes.recent', JSON.stringify(recentList().filter(r => r.path !== path))); }

function recentButtons(cls: string, attrs = ''){
  return recentList().map(r => `<button class="${cls}"${attrs} data-path="${esc(r.path)}" title="${esc(r.path)}"><span class="n">${esc(r.name)}</span><span class="p">${esc(r.path)}</span></button>`).join('');
}
function showEmpty(){
  tabBusy.hidden = true; tabLoading.hidden = true;
  $('#emptyState').hidden = false;
  const items = recentButtons('recent-item');
  $('#emptyRecent').innerHTML = items ? `<div class="t">Recent</div>${items}` : '';
}

/* The repo of the active tab has an operation (fetch, switch, create) running (its lock key, so
   maybe started from another worktree's tab): the backend refuses to read it
   until it ends, and runOp then runs the load stored here if the repo is
   still active. A repo that is not on screen yet shows a placeholder instead
   of the graph; one already loaded keeps its graph. */
function waitForOp(info: RepoInfo, op: RepoOp, keep: boolean, manual: boolean){
  op.pending = { info, keep, manual };
  if (current && current.path === info.path) return;
  current = info; fingerprintSeen = null;
  stashes = []; stashPath = null;
  $('#emptyState').hidden = true;
  $('#tabBusyText').textContent = `${op.kind === 'fetch' ? 'Fetching…' : OP_BUSY[op.kind]} the history loads when it finishes`;
  tabBusy.hidden = false; tabLoading.hidden = true;
  setData([], info.name, false);   // empty graph and panel, the repo's name in the toolbar
  detailFor = null; detail.innerHTML = '<div class="empty">Select a commit to see details</div>';
  $('#repoBtn').title = info.path;
}

async function loadRepo(info: RepoInfo, { keep = false, manual = false }: { keep?: boolean; manual?: boolean } = {}){
  if (busy && busyPath === info.path) return;   // a refresh while this repo loads; another repo supersedes the load below
  // Another repo: the old one is dropped first (its rows, panel and toolbar, and every follow-up call).
  if (!current || current.path !== info.path) dropRepo({ empty: false });
  const op = ops.get(info.lockKey);
  if (op) { waitForOp(info, op, keep, manual); return; }
  const placeholder = !tabBusy.hidden;   // the load runOp runs after the repo waited for its operation
  tabBusy.hidden = true;
  if (placeholder) tabLoading.hidden = false;   // the graph area is empty until this load ends
  const seq = ++loadSeq;
  busy = true; busyPath = info.path; document.body.classList.add('loading');
  if (!keep) { $('#stats').textContent = 'Loading history…'; closeDiff(); }
  const hg = hiddenGen, hidden = hiddenList(info.path), solo = soloList(info.path);
  try {
    // A refresh reloads as deep as the user had scrolled, so the view stays put.
    const want = keep ? Math.max(PAGE, S.commits.length) : PAGE;
    const st = await invoke('start_history', { path: info.path, hidden, solo });
    startedGen = Math.max(startedGen, st.gen);
    // Superseded (another tab, a New tab): nobody reads this stream.
    if (seq !== loadSeq) { stopHistory(st.gen); return; }
    // Every soloed branch is gone (deleted, renamed): leave solo; the
    // finally block below reloads with the full graph.
    if (solo.length && !st.refs.refs.some(([, n]) => coveredBy(n, solo))) { saveSolo([], info.path); hiddenGen++; }
    const page = await invoke('history_page', { gen: st.gen, start: 0, count: want });
    if (seq !== loadSeq) return;
    const { commits, bad } = parseLog(page.log);
    // The ref listing ran alongside the log; if anything moved meanwhile the
    // refs may be newer than the rows, so the next poll reloads in full.
    const settled = await invoke('repo_fingerprint', { path: info.path });
    if (seq !== loadSeq) return;
    current = info; fingerprintSeen = st.fingerprint; streamGen = st.gen; streamPos = commits.length + bad.length;
    $('#emptyState').hidden = true;
    setData(commits, info.name, false, { remotes: st.remotes, refs: st.refs, hidden, solo, keep, ordered: true, more: page.more, capped: page.capped });
    S.bad = bad.length; S.forceFull = settled !== st.fingerprint; updateView();
    $('#repoBtn').title = info.path;
    addRecent(info);   // lanes.last is written by saveTabs, without lockKey
    hideError();
    loadTracking(); loadStashes(); loadPrs({ force: manual }); loadWip({ force: true });
  } catch (e) {
    if (seq !== loadSeq) return;   // superseded: its error (a 'stale' stream included) is nobody's business
    const op = String(e) === BUSY ? ops.get(info.lockKey) : undefined;
    if (op) waitForOp(info, op, keep, manual);   // an operation started while this was on its way
    else {
      // The active tab asks for this repo now: never leave another repo's graph
      // (or the placeholder's "Loading history…") under it. A refresh of a
      // loaded graph keeps it. dropRepo hides the banner, so it goes first.
      const drop = !current || current.path !== info.path || placeholder;
      if (drop) dropRepo();
      // 'busy' with no operation of ours left to run the load later: say so instead of waiting forever.
      showError(String(e) === BUSY ? BUSY_MSG : String(e));
      // The repo could not be read (deleted or moved meanwhile): forgotten as a
      // failed open is. Not for 'busy', nor a 'stale' stream (replaced by a newer one).
      if (drop && String(e) !== BUSY && String(e) !== 'stale') forgetRecent(info.path);
    }
  } finally {
    if (seq === loadSeq) {
      busy = false; busyPath = null; document.body.classList.remove('loading');
      tabLoading.hidden = true;
      // Branches were hidden or shown while this ran with the old list. Read
      // current when it runs: a tab switch in between leaves it null.
      if (hg !== hiddenGen && current) setTimeout(() => { if (current) loadRepo(current, { keep: true }); }, 0);
    }
  }
}

/* Nothing loaded: an empty tab, a tab whose repo failed to open, no tab at all,
   or (empty: false) the moment before another repo loads, so nothing of the old
   one stays on screen or can be refreshed, synced or polled under the new tab.
   A load in flight is dropped (busy too, or polls would stop for good and the
   same repo could never load again), and so is a page still on its way
   (streamGen). With current null nothing polls. Its history stream is
   stopped and its banner hidden. */
function dropRepo({ empty = true }: { empty?: boolean } = {}){
  loadSeq++; openSeq++; jumpSeq++; streamGen = -1;
  stopHistory();
  hideError();   // a banner of the repo left behind; a failure of the next one shows after this
  hideUndo();    // its Undo too: the token belongs to that repo
  busy = false; busyPath = null; document.body.classList.remove('loading');
  current = null; fingerprintSeen = null;
  if (prs.path) { prCache.set(prs.path, prs); prs = noPrs(); }
  closeDiff(); wipSel = false;
  S = { commits: [], idx: new Map(), edges: [], maxLane: 0, repo: '', sample: false, note: '' };
  render(null, null);
  detailFor = null; detail.innerHTML = '<div class="empty">Select a commit to see details</div>';
  $('#repoName').textContent = '—'; $('#headName').textContent = '—'; $('#stats').textContent = empty ? '' : 'Loading history…';
  $('#repoBtn').title = ''; document.title = 'GitKrapao';
  tabBusy.hidden = true;
  tabLoading.hidden = empty;   // a repo is about to load: the spinner stays until its load ends
  if (empty) showEmpty(); else $('#emptyState').hidden = true;
}

/* Opening a repo (recent menu, Ctrl/⌘ O, the empty state) fills the active tab,
   as GitKraken's repository menu does; with no tabs it makes one first. */
let openSeq = 0;   // the newest open or tab switch wins: open_repo of an earlier click may answer late
async function openPath(path: string){
  closeMenu();
  if (goToOpen(path)) return;
  const tab = targetTab(), seq = ++openSeq;
  let info: RepoInfo;
  try {
    info = await invoke('open_repo', { path });
  } catch (e) {
    if (seq !== openSeq || tabs.list[tabs.active] !== tab) return;
    // The tab keeps the path asked for, named as the recent list had it, so it can be closed.
    const r = recentList().find(x => x.path === path);
    Object.assign(tab, { path, name: r ? r.name : baseName(path), info: undefined, sel: undefined });
    saveTabs(tabs); renderTabs();
    forgetRecent(path);
    dropRepo();
    showError(String(e));
    return;
  }
  if (seq !== openSeq || tabs.list[tabs.active] !== tab) return;
  await openInTab(tab, info);
}

async function pickRepo(){
  closeMenu();
  if (opOff()) return;   // it would replace the repo an operation is changing
  try {
    const info = await invoke('pick_repo', {});
    if (!info) return;
    openSeq++;   // a slow open_repo of an earlier click must not land on top of this
    await openInTab(targetTab(), info);
  } catch (e) { showError(String(e)); }
}

/* ---------- repository tabs (desktop) ----------
   One repo is loaded at a time, the active tab's; the others are only a
   path and a name (plus, in memory, the last open_repo answer and the
   selected commit). Switching drops the old repo's state and loads the new
   one; background tabs never call the backend (an operation started
   in one keeps running). */
let tabs: Tabs = { list: [], active: -1 };   // read from lanes.tabs at boot
const tabStrip = $('#tabStrip'), tabList = $('#tabList');

function renderTabs(): void {
  const focused = tabStrip.contains(document.activeElement);
  tabStrip.innerHTML = tabs.list.map((t, i) => {
    const on = i === tabs.active, run = tabRunning(t);
    // An operation in the tab's repo: a spinner instead of the icon, and it cannot close.
    return `<div class="tab-item${on ? ' on' : ''}${run ? ' running' : ''}" role="presentation" data-tab="${i}">`
      + `<button class="tab" role="tab" aria-selected="${on}" aria-busy="${run}" tabindex="${on ? 0 : -1}" title="${esc(t.path || NEW_TAB)}">`
      + `<span class="tab-ic">${run ? '<span class="tab-spin" aria-hidden="true"></span>' : ICON.repo}</span><span class="tab-name">${esc(t.name)}</span>`
      + (t.err ? '<span class="tab-dot" title="The last Git operation failed"></span>' : '') + '</button>'
      + `<button class="tab-x" tabindex="-1" aria-label="Close ${esc(t.name)}" aria-disabled="${run}" title="${run ? OP_OFF : 'Close tab (Ctrl+W)'}">${ICON.x}</button></div>`;
  }).join('');
  $('#tabMore').hidden = !tabs.list.length;
  if (!tabs.list.length) closeTabList(); else if (!tabList.hidden) fillTabList();
  if (focused) tabStrip.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus();
}
function scrollTabIntoView(){ tabStrip.querySelector('.tab-item.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }

// The selected commit of the tab being left, restored if it is loaded when the tab comes back.
// A tab left while it waits for its operation (no rows) keeps the hash it had.
function rememberSel(t: Tab){ if (tabBusy.hidden && current && t.path === current.path) t.sel = S.commits[sel]?.hash; }
/* Only from rows already loaded: switching never pages further to find it. */
function restoreSel(t: Tab){
  const i = t.sel && tabs.list[tabs.active] === t && current && current.path === t.path ? S.idx.get(t.sel) : undefined;
  if (i !== undefined) select(i, { scroll: true });
}

async function activateTab(i: number): Promise<void>{
  const t = tabs.list[i]; if (!t) return;
  const out = tabs.list[tabs.active];
  if (out === t) {
    // Already active: a tab whose repo is neither loaded nor loading (it failed) tries again.
    scrollTabIntoView();
    if (t.path && !busy && (!current || current.path !== t.path)) await showTab(t);
    return;
  }
  if (out) rememberSel(out);
  tabs.active = i; t.err = false;
  saveTabs(tabs); renderTabs();
  await showTab(t);
}

/* Shows tab t, already the active one: an empty tab shows the empty state;
   otherwise its repo loads, superseding any load in flight (loadRepo/loadSeq). */
async function showTab(t: Tab){
  scrollTabIntoView();
  if (!t.path) { dropRepo(); return; }
  // Nothing of the tab left behind stays while open_repo and the load run.
  if (!current || current.path !== t.path) dropRepo({ empty: false });
  if (t.info) { openSeq++; await loadRepo(t.info); }
  else await openPath(t.path);   // fills t.info
  restoreSel(t);
}

function newTab(): void {
  const out = tabs.list[tabs.active];
  if (out) rememberSel(out);
  tabs.list.push({ path: null, name: NEW_TAB });
  tabs.active = tabs.list.length - 1;
  saveTabs(tabs); renderTabs(); scrollTabIntoView();
  dropRepo();
}

/* Closing the active tab shows its right neighbour (else the left one); closing
   another loads nothing; closing the last leaves the empty state. Recents stay. */
function closeTab(i: number): void {
  const t = tabs.list[i]; if (!t || tabRunning(t)) return;   // not while its repo has an operation
  const was = i === tabs.active, next = afterClose(tabs, i);
  tabs.list.splice(i, 1);
  tabs.active = next;
  if (t.path) forgetPrs(t.path);
  saveTabs(tabs); renderTabs();
  if (!was) return;
  const n = tabs.list[next];
  if (n) showTab(n); else dropRepo();
}

// The active tab, or a new one when there are none.
function targetTab(): Tab {
  const cur = tabs.list[tabs.active];
  if (cur) return cur;
  const t: Tab = { path: null, name: NEW_TAB };
  tabs.list.push(t); tabs.active = tabs.list.length - 1;
  saveTabs(tabs); renderTabs();
  return t;
}
/* path is open in another tab: activate that one instead of opening it twice,
   and drop the active tab if it was an empty New tab. */
function goToOpen(path: string): boolean {
  let j = indexOfPath(tabs, path);
  if (j < 0 || j === tabs.active) return false;
  const cur = tabs.list[tabs.active];
  if (cur && !cur.path) { tabs.list.splice(tabs.active, 1); tabs.active = -1; j = indexOfPath(tabs, path); }
  activateTab(j);
  return true;
}
// open_repo / pick_repo answered: the tab takes the repo, unless it is open in
// another tab (a folder inside a repo resolves to the repo's root).
async function openInTab(tab: Tab, info: RepoInfo){
  if (goToOpen(info.path)) return;
  if (tab.path !== info.path) tab.sel = undefined;
  Object.assign(tab, { path: info.path, name: info.name, info, err: false });
  saveTabs(tabs); renderTabs();
  await loadRepo(info);
}

function fillTabList(){
  tabList.innerHTML = tabs.list.map((t, i) => `<button class="menu-item${i === tabs.active ? ' on' : ''}" data-tab="${i}" title="${esc(t.path || NEW_TAB)}">`
    + `<span class="n">${esc(t.name)}</span>${t.path ? `<span class="p">${esc(t.path)}</span>` : ''}</button>`).join('');
}
function closeTabList(){ tabList.hidden = true; $('#tabMore').setAttribute('aria-expanded', 'false'); }
function toggleTabList(){
  if (!tabList.hidden) { closeTabList(); return; }
  fillTabList();
  tabList.hidden = false; $('#tabMore').setAttribute('aria-expanded', 'true');
}

/* Infinite scroll: append the next page of the current stream. A reload
   that starts a new stream meanwhile makes this result stale.
   Returns true when a page was added, 'skip' when nothing ran, false on error. */
async function loadMore(): Promise<boolean | 'skip'>{
  if (!NATIVE || !current || busy || moreBusy || !S.more) return 'skip';
  moreBusy = true;
  const gen = streamGen, start = streamPos;
  try {
    const page = await invoke('history_page', { gen, start, count: PAGE });
    if (gen !== streamGen || start !== streamPos) return 'skip';
    const { commits, bad } = parseLog(page.log);
    streamPos += commits.length + bad.length;
    appendCommits(commits);
    S.more = page.more && commits.length > 0; S.capped = page.capped; S.bad! += bad.length;   // set by loadRepo
    updateView();
    if ($<HTMLInputElement>('#q').value.trim()) runSearch();
    const cur = S.commits[sel];
    if (cur && detailFor === cur) renderDetail(cur);   // parents may now be loaded
    if (sideWaiting.some(h => S.idx.has(h))) renderSide();   // branch tips now in view
    placeStashes();   // this page may hold a stash's base
  } catch (e) {
    if (String(e) === 'stale') return 'skip';
    showError(String(e));
    return false;
  } finally {
    moreBusy = false;
  }
  scheduleDraw();
  return true;
}

/* Manual refresh (button, Ctrl/⌘ R) always re-reads everything: the escape hatch. */
async function refresh(){ if (current && !opOff()) await loadRepo(current, { keep: true, manual: true }); }

/* After a commit, fetch, checkout etc.: ask git only for what is new and
   merge it in. Anything the plan cannot prove correct falls back to a full
   reload at the same depth. */
async function syncRepo(){
  if (!current || busy || moreBusy || opHere()) return;
  let full: string | null = S.forceFull ? 'refs may be newer than the loaded rows' : null;
  // A load of another repo started meanwhile bumps loadSeq: this sync then stops without touching anything.
  const seq = ++loadSeq;
  if (!full) {
    busy = true; busyPath = current.path;
    const hg = hiddenGen, hidden = hiddenList(), solo = soloList();
    try {
      // A loaded desktop repo always has tips (setData).
      const r = await invoke('sync_history', { path: current.path, exclude: [...S.tips!], hidden, solo, limit: SYNC_CAP });
      if (seq !== loadSeq) return;
      if (hg !== hiddenGen) full = 'hidden branches changed';
      else if (r.fingerprintBefore !== r.fingerprintAfter) full = 'repo changed while reading';
      else if (r.over) full = 'too many new commits';
      else {
        const { commits, bad } = parseLog(r.log);
        // Tips and labels from visible refs only, as in a full load; the
        // panel keeps the whole listing.
        // The reasons in { full } are never empty, so a string full is the same test as a truthy one.
        const plan: { full: string } | SyncPlan = bad.length ? { full: 'unreadable entries' } : planSync(S as SyncFrom, walkRefs(r.refs, hidden, solo), commits, labelRefs(r.refs, hidden, solo));
        if (typeof plan.full !== 'string') plan.allRefs = r.refs;
        if (typeof plan.full === 'string') full = plan.full;
        else { applySync(plan); fingerprintSeen = r.fingerprintBefore; loadTracking(); loadStashes(); loadPrs({ minAge: 30e3 }); loadWip({ force: true }); loadRemotes(); }
      }
    } catch (e) {
      full = String(e);
    } finally {
      if (seq === loadSeq) { busy = false; busyPath = null; }
    }
  }
  if (seq !== loadSeq) return;
  if (full === BUSY) return;   // a fetch started; it syncs when done
  if (full) await loadRepo(current, { keep: true });
}

async function poll(){
  if (!current || busy || moreBusy || document.hidden || opHere()) return;
  // Another tab may start loading while this waits (busy, current not switched yet):
  // then nothing below may run for the repo being left.
  const path = current.path, left = () => busy || !current || current.path !== path;
  try {
    const fp = await invoke('repo_fingerprint', { path });
    if (fp === null || left()) return;   // null: an operation is changing the repo
    if (fp !== fingerprintSeen) { await syncRepo(); if (left()) return; }
    loadPrs();   // returns at once unless PR_EVERY has passed
    loadWip();   // likewise, unless its interval has passed
  } catch (e) { /* repo moved or deleted; the next manual action will report it */ }
}

/* ---------- git operations: fetch, switch, create / rename / delete, Undo ---------- */
/* One operation at a time per repository, keyed by the backend's lock key
   (linked worktrees of one repo share it, so their tabs wait together), and
   at most MAX_OPS app-wide. While the active tab's repo has one, every action
   there is off (opOff); other tabs stay free. */
const BUSY = 'busy';           // backend error while an operation runs in the repo
const BUSY_MSG = 'Another Git operation is already running in this repository.';
// branch / tag: create one; delBranch / delTag: delete one; restore: Undo a delete.
type OpKind = 'fetch' | 'switch' | 'branch' | 'tag' | 'rename' | 'delBranch' | 'delTag' | 'restore';
const OP_BUSY: Record<OpKind, string> = { fetch: 'Fetching all remotes…', switch: 'Switching branch…', branch: 'Creating branch…', tag: 'Creating tag…',
  rename: 'Renaming branch…', delBranch: 'Deleting branch…', delTag: 'Deleting tag…', restore: 'Restoring…' };
interface RepoOp { kind: OpKind; pending: { info: RepoInfo; keep: boolean; manual: boolean } | null }   // pending: the load asked for meanwhile
const ops = new Map<string, RepoOp>();       // by RepoInfo.lockKey
const opErr = new Map<string, string>();     // by lockKey: banner text of the last failed operation, cleared by the next success
const MAX_OPS = 3;
const OP_OFF = 'Wait for the Git operation in this repository to finish';
const CAP_OFF = '3 Git operations are already running; wait for one to finish';
const opHere = () => !!current && ops.has(current.lockKey);
/* What the active repo is doing ("Creating tag…"), '' when nothing. */
const opNow = () => { const op = current && ops.get(current.lockKey); return op ? OP_BUSY[op.kind] : ''; };
const opOff = () => opHere() ? OP_OFF : '';
const capOff = () => ops.size >= MAX_OPS && !opHere() ? CAP_OFF : '';
const tabRunning = (t: Tab) => !!t.info && ops.has(t.info.lockKey);

/* The toolbar and panel controls of the active tab: Fetch (its operation, the
   cap), and Refresh, Open, Show all and the eye/solo buttons (body.op-running),
   which are off while its repo has an operation. */
function updateFetchBtn(){
  if (!NATIVE) return;
  const b = $('#fetchBtn'), op = current ? ops.get(current.lockKey) : undefined, cap = capOff();
  const none = !!current && !(S.remotes && S.remotes.size);
  const here = !!op && op.kind === 'fetch';
  b.setAttribute('aria-disabled', String(!current || none || !!op || !!cap));
  b.setAttribute('aria-busy', String(here));
  b.classList.toggle('running', here);
  $('#fetchLabel').textContent = here ? 'Fetching…' : 'Fetch';
  b.setAttribute('aria-label', here ? 'Fetching' : 'Fetch');
  // The operation first: a repo waiting for it shows no remotes yet.
  b.title = op ? OP_BUSY[op.kind] : none ? 'No remotes'
    : cap || 'Fetch all remotes (Ctrl/⌘ Shift F)';
  const off = opOff();
  $('#refreshBtn').setAttribute('aria-disabled', String(!!off));
  $('#refreshBtn').title = off || 'Refresh (Ctrl/⌘ R)';
  $('#openBtn').setAttribute('aria-disabled', String(!!off));
  $('#openBtn').title = off || 'Open repository (Ctrl/⌘ O)';
  $<HTMLButtonElement>('#showAllBtn').disabled = !!off;
  document.body.classList.toggle('op-running', !!off);
  // Undo is an operation too: off at the cap (an operation here hides the bar).
  undoBtn.disabled = !!cap; undoBtn.title = cap;
}

/* "↑2 ↓5" next to the branch name: the checked-out branch against its
   upstream, from branch_tracking. Hidden when detached, without an upstream
   or when the upstream is gone. */
function renderHeadTrack(){
  const box = $('#headTrack');
  const hr = NATIVE && S.refs ? S.refs.headRef : null;
  const t = hr && S.track ? S.track.get(hr.replace(/^refs\/heads\//, '')) : undefined;
  if (!t || t.gone) { box.hidden = true; box.textContent = ''; box.title = ''; return; }
  box.hidden = false;
  box.textContent = `↑${t.ahead} ↓${t.behind}`;
  box.title = `${t.ahead} ahead, ${t.behind} behind ${t.upstream.replace(/^refs\/(remotes|heads)\//, '')}`;
}

/* After a sync: a remote added or removed changes how labels are grouped
   (groupRefs), so reload when the list differs. */
let remoteSeq = 0;
async function loadRemotes(){
  if (!NATIVE || !current) return;
  const seq = ++remoteSeq, path = current.path;
  try {
    const list = await invoke('list_remotes', { path });
    if (seq !== remoteSeq || !current || current.path !== path) return;
    const old = S.remotes || new Set<string>();
    if (list.length !== old.size || list.some(r => !old.has(r))) await loadRepo(current, { keep: true });
  } catch (e) { /* the next sync asks again */ }
}

/* One operation (fetch, switch, create) in the active tab's repo. The backend holds the repo's
   lock meanwhile, so polls, refreshes and loads of this repo (and of its other
   worktrees) wait. Every tab of that lock key spins. The result goes to the
   Output drawer. If the repo is still the active one, a failure also goes to
   the banner and opens the drawer, then the graph syncs once (or runs the load
   asked for meanwhile). In the background it is only logged and a failure
   marks its tabs; activating one loads it in full anyway. `switching`: it may
   check out another branch (a switch, or a new branch with checkout).
   `done` runs once the result is logged, in the active tab or not (rename and
   delete update the hide/solo lists there and show the Undo bar); it returns
   true when those lists changed, and the active repo then reloads in full
   instead of syncing. Resolves to the result, or null when nothing ran. */
interface OpOpts { switching?: boolean; done?: (r: GitResult, info: RepoInfo) => boolean }
async function runOp(kind: OpKind, call: (path: string) => Promise<GitResult>,
                     { switching = kind === 'switch', done }: OpOpts = {}): Promise<GitResult | null>{
  if (!NATIVE || !current || opHere() || capOff()) return null;
  hideUndo();   // its token may be the one this operation changes (Undo itself included)
  const info = current, key = info.lockKey, at = new Date();
  const op: RepoOp = { kind, pending: null };
  ops.set(key, op); updateFetchBtn(); renderTabs();
  if (switching) { $('#headName').textContent = 'Switching…'; $('#headTrack').hidden = true; }
  let r: GitResult;
  try {
    r = await call(info.path);
  } catch (e) {
    const msg = String(e);
    r = { ok: false, timedOut: false, cancelled: false, durationMs: 0, exitCode: null, command: `git ${kind}`, stdout: '', stderr: '',
          summary: msg === BUSY ? BUSY_MSG : msg };
  } finally {
    ops.delete(key);   // before the sync or load below: both stop while opHere()
  }
  logOp(at, info.name, r);
  const listsChanged = done ? done(r, info) : false;
  const failed = !r.ok && !r.cancelled;
  if (current?.lockKey !== key) {
    if (failed) tabs.list.forEach(t => { if (t.info?.lockKey === key) t.err = true; });
    else if (r.ok) opErr.delete(key);
    updateFetchBtn(); renderTabs();
    return r;
  }
  if (failed) { showError(r.summary); opErr.set(key, r.summary); openOut(true); }
  else if (r.ok) {
    // Only our own stale error; a load error stays.
    if (opErr.get(key) === $('#bannerMsg').textContent) hideError();
    opErr.delete(key);
  }
  updateFetchBtn(); renderTabs();
  if (switching && S.commits.length) updateView();   // branch name and ↑↓ until the sync below
  const p = op.pending, waited = !tabBusy.hidden;
  // The walk itself changed (a hidden or soloed branch renamed or deleted): reload, as hiding does.
  if (!p && listsChanged) { hiddenGen++; renderSide(); await loadRepo(current, { keep: true }); }
  else if (!p) await syncRepo();
  else {
    await loadRepo(p.info, { keep: p.keep, manual: p.manual });
    // The tab showed the placeholder: bring back its selection, as a tab switch does.
    const t = tabs.list[tabs.active];
    if (waited && t) restoreSel(t);
  }
  // A successful load (or a sync that reloads) hides the banner: the failure
  // stays on screen while its repo is active. A failed load's own error wins
  // (the banner is showing then).
  if (failed && current?.lockKey === key && $('#banner').hidden) showError(r.summary);
  return r;
}
function runFetch(){
  if (S.remotes && S.remotes.size) runOp('fetch', path => invoke('fetch', { path }));
}
/* ref: refs/heads/x, or refs/remotes/<remote>/x (the backend makes a local
   branch that tracks it, or uses the local branch of that name). */
function runSwitch(ref: string){
  runOp('switch', path => invoke('switch_branch', { path, target: ref }));
}

/* ---------- create a branch or tag at a commit ---------- */
/* Right-click a commit row, or a label on it: "Create branch here…" /
   "Create tag here…" (desktop only; not on the WIP row or a stash). The
   dialog checks the name as it is typed (refname.ts) and the backend checks
   again with git. It keeps the commit's hash and the repo's lock key, not a
   row: a sync can move rows while it is open, and the ref must go to the repo
   it was asked for in. */
const createDlg = $<HTMLDialogElement>('#createDlg'), cName = $<HTMLInputElement>('#cName'), cGo = $<HTMLButtonElement>('#cGo'), cAt = $('#createDlg .c-at');
// rename: the same dialog renames local branch `from` (no commit, message or switch rows).
type CreateFor = { mode: 'create'; kind: RefKind; hash: string; key: string } | { mode: 'rename'; kind: 'branch'; from: string; key: string };
let createFor: CreateFor | null = null;
const createOff = () => opNow() || capOff();
function createEntries(c: Commit): CtxEntry[] {
  if (!NATIVE || c.stashRow) return [];
  const off = createOff();
  return [
    { label: 'Create branch here…', off, run: () => openCreate('branch', c) },
    { label: 'Create tag here…', off, run: () => openCreate('tag', c) },
  ];
}

/* ---------- rename / delete a branch, delete a tag ---------- */
/* Local refs only. Rename uses the create dialog; a delete invokes at once,
   because the backend asks every question itself (a native dialog page
   script cannot answer) and counts the commits that would be left on no
   branch. A delete shows the Undo bar. */
const HEAD_DEL = 'The checked-out branch cannot be deleted';
/* Rename and Delete for the local branch `name` (short). Delete is off for
   the checked-out branch, read from the full snapshot (a label's own mark is
   exact and missing in solo without HEAD) and compared without case. */
function branchEntries(name: string): CtxEntry[] {
  if (!NATIVE) return [];
  const off = createOff(), head = sameRef('refs/heads/' + name, S.refs ? S.refs.headRef : null);
  return [
    { label: 'Rename branch…', off, run: () => openRename(name) },
    { label: 'Delete branch…', off: head ? HEAD_DEL : off, run: () => runDelete('branch', name) },
  ];
}
/* A tag label's menu; c: its commit. Desktop only (pillTag). */
function tagEntries(name: string, c: Commit | undefined): CtxEntry[] {
  return [
    { label: 'Delete tag…', off: createOff(), run: () => runDelete('tag', name) },
    { label: 'Copy tag name', run: () => copyText(name) },
    ...(c ? createEntries(c) : []),
  ];
}
/* Every open path of info's repo (linked worktrees share its lock key):
   their hide/solo lists follow a renamed or deleted branch. */
function repoPaths(info: RepoInfo){
  return [info.path, ...tabs.list.flatMap(t => t.info && t.info.lockKey === info.lockKey ? [t.info.path] : [])];
}
function runDelete(kind: RefKind, name: string){
  const done = (r: GitResult, info: RepoInfo) => {
    // deleted: the local ref is gone (also when deleting the tag on origin failed afterwards).
    if (!r.deleted) return false;
    if (current?.lockKey === info.lockKey) showUndo(r.deleted, info.lockKey);
    return kind === 'branch' && followRef(repoPaths(info), name, null);
  };
  if (kind === 'branch') runOp('delBranch', path => invoke('delete_branch', { path, name }), { done });
  else runOp('delTag', path => invoke('delete_tag', { path, name }), { done });
}
/* Short names of the refs of that kind, from the snapshot the labels use. */
function refNames(kind: RefKind){
  const pre = kind === 'branch' ? 'refs/heads/' : 'refs/tags/';
  return (S.refs ? S.refs.refs : []).filter(([, r]) => r.startsWith(pre)).map(([, r]) => r.slice(pre.length));
}
function checkCreate(){
  if (!createFor) return;
  // Renaming: the branch's own name is no clash, but Rename stays off until the name changes.
  const self = createFor.mode === 'rename' ? createFor.from : undefined;
  const name = cName.value, why = nameProblem(name, createFor.kind) || nameClash(name, createFor.kind, refNames(createFor.kind), self);
  $('#cErr').textContent = why;
  cName.setAttribute('aria-invalid', String(!!why));
  cGo.disabled = !name || !!why || name === self;
}
function openCreate(kind: RefKind, c: Commit){
  if (!current || createOff() || createDlg.open) return;
  createFor = { mode: 'create', kind, hash: c.hash, key: current.lockKey };
  const branch = kind === 'branch';
  $('#cTitle').textContent = branch ? 'Create branch' : 'Create tag';
  cGo.textContent = branch ? 'Create branch' : 'Create tag';
  $('#cLabel').textContent = branch ? 'Branch name' : 'Tag name';
  $('#cHash').textContent = c.hash.slice(0, 7);
  $('#cSubject').textContent = c.subject;
  cAt.hidden = false;
  $('#cSwitchRow').hidden = !branch;
  $('#cMsgRow').hidden = branch;
  cName.value = '';
  $<HTMLInputElement>('#cMsg').value = '';
  $<HTMLInputElement>('#cSwitch').checked = true;
  checkCreate();
  createDlg.showModal();
  cName.focus();
}
/* The create dialog, renaming local branch `from`: the old name filled in and selected. */
function openRename(from: string){
  if (!current || createOff() || createDlg.open) return;
  createFor = { mode: 'rename', kind: 'branch', from, key: current.lockKey };
  $('#cTitle').textContent = 'Rename branch';
  cGo.textContent = 'Rename';
  $('#cLabel').textContent = 'New name';
  cAt.hidden = true; $('#cSwitchRow').hidden = true; $('#cMsgRow').hidden = true;
  cName.value = from;
  checkCreate();
  createDlg.showModal();
  cName.focus(); cName.select();
}
function closeCreate(){ createFor = null; if (createDlg.open) createDlg.close(); }
// 'close' comes later, as a task: by then the dialog may be open again for another commit.
createDlg.addEventListener('close', () => { if (!createDlg.open) createFor = null; });
// A click on the backdrop closes it, unless it started inside (selecting text and letting go outside).
let downOnBackdrop = false;
createDlg.addEventListener('pointerdown', e => { downOnBackdrop = e.target === createDlg; });
createDlg.addEventListener('click', e => { if (downOnBackdrop && e.target === createDlg) closeCreate(); });
cName.addEventListener('input', checkCreate);
$('#cCancel').addEventListener('click', closeCreate);
$('#createForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = createFor, name = cName.value, msg = $<HTMLInputElement>('#cMsg').value.trim(), checkout = $<HTMLInputElement>('#cSwitch').checked;
  if (!f || cGo.disabled) return;
  closeCreate();
  if (current?.lockKey !== f.key) return;   // its repo is no longer the active one
  if (f.mode === 'rename') {
    const from = f.from;
    runOp('rename', path => invoke('rename_branch', { path, from, to: name }), { done: (r, info) => r.ok && followRef(repoPaths(info), from, name) });
  }
  else if (f.kind === 'branch') runOp('branch', path => invoke('create_branch', { path, name, at: f.hash, checkout }), { switching: checkout });
  else runOp('tag', path => invoke('create_tag', { path, name, at: f.hash, message: msg || null }));
});

/* Output drawer: every operation (fetch, switch, create, rename, delete, Undo), newest last, in memory only. Text from git
   only ever goes through textContent. */
interface OutEntry { at: Date; repo: string; r: GitResult }
const OUT_MAX = 50;
const outLog: OutEntry[] = [];
function logOp(at: Date, repo: string, r: GitResult){
  outLog.push({ at, repo, r });
  if (outLog.length > OUT_MAX) outLog.splice(0, outLog.length - OUT_MAX);
  renderOut();
}
function outStatus(r: GitResult){
  return r.ok ? 'done' : r.timedOut ? 'timed out' : r.cancelled ? 'cancelled' : r.exitCode === null ? 'not run' : `exit ${r.exitCode}`;
}
function textEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string){
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function renderOut(){
  $('#out').hidden = !outLog.length;
  const last = outLog[outLog.length - 1];
  $('#outLast').textContent = last ? `${last.at.toLocaleTimeString()} · ${outStatus(last.r)} · ${last.r.summary}` : '';
  const list = $('#outList');
  list.replaceChildren(...outLog.map(({ at, repo, r }) => {
    const item = textEl('div', `out-item ${r.ok ? 'ok' : r.cancelled ? 'cancel' : 'fail'}`);
    const head = textEl('div', 'out-head');
    head.append(textEl('span', 'out-time', at.toLocaleTimeString()), textEl('span', 'out-repo', repo),
      textEl('span', 'mono out-cmd', r.command), textEl('span', 'out-st', outStatus(r)),
      textEl('span', 'out-dur', `${(r.durationMs / 1000).toFixed(1)} s`));
    item.append(head, textEl('div', 'out-sum', r.summary));
    const text = (r.stderr + (r.stdout ? '\n' + r.stdout : '')).trim();
    if (text) item.append(textEl('pre', 'mono out-err', text));
    return item;
  }));
  list.scrollTop = list.scrollHeight;
}
function openOut(open: boolean){
  const list = $('#outList');
  list.hidden = !open;
  $('#out').classList.toggle('open', open);
  $('#outBar').setAttribute('aria-expanded', String(open));
  if (open) list.scrollTop = list.scrollHeight;
}
$('#outBar').addEventListener('click', () => openOut(!$('#out').classList.contains('open')));

/* recent menu */
const menu = $('#recentMenu');
function closeMenu(){ menu.hidden = true; $('#repoBtn').setAttribute('aria-expanded', 'false'); }
function toggleMenu(){
  if (!menu.hidden) { closeMenu(); return; }
  // While an operation runs here, nothing may replace this tab's repo.
  const off = opOff(), dis = off ? ' disabled' : '';
  const items = recentButtons('menu-item', dis);
  menu.innerHTML = (off ? `<div class="hint">${esc(off)}</div>` : '') + (items || '<div class="hint">No recent repositories</div>')
    + `<hr><button class="menu-item" data-action="open"${dis}><span class="n">Open another repository…</span></button>`;
  menu.hidden = false; $('#repoBtn').setAttribute('aria-expanded', 'true');
}
function onRecentClick(e: MouseEvent){
  const b = (e.target as Element).closest<HTMLElement>('[data-path],[data-action]'); if (!b || opOff()) return;
  if (b.dataset.action === 'open') pickRepo(); else openPath(b.dataset.path!);
}

/* ---------- browser mode: manual import ---------- */
function openModal(){ $('#modal').hidden = false; $('#err').textContent = ''; $<HTMLInputElement>('#repoIn').value = S.sample ? '' : S.repo; $('#logIn').focus(); }
function closeModal(){ $('#modal').hidden = true; }

/* ---------- events ---------- */
// Clicks and keys below come from elements of the page; data-* attributes are the ones this file renders.
body.addEventListener('click', e => {
  const t = e.target as Element;
  const pop = t.closest<HTMLElement>('.ref-pop'); if (pop) { select(+pop.dataset.i!, { open: true }); return; }
  const r = t.closest<HTMLElement>('.row'); if (!r) return;
  if (r === wipRow) selectWip({ open: true }); else select(+r.dataset.i!, { open: true });
});
detail.addEventListener('click', e => {
  const t = e.target as Element;
  const df = t.closest<HTMLElement>('[data-df]'); if (df) { openDiff(+df.dataset.df!); return; }
  // data-jump is only rendered for loaded commits (hashLink).
  const j = t.closest<HTMLElement>('[data-jump]'); if (j) { closeDiff(); select(S.idx.get(j.dataset.jump!)!, { scroll: true, open: detail.classList.contains('open') }); return; }
  const cp = t.closest<HTMLElement>('[data-copy]'); if (cp) { copyText(cp.dataset.copy!, cp); return; }
  const ou = t.closest<HTMLElement>('[data-open-url]'); if (ou) { invoke('open_url', { url: ou.dataset.openUrl! }).catch(err => showError(String(err))); return; }
  if (t.closest('.d-close')) detail.classList.remove('open');
});
$('#q').addEventListener('input', runSearch);
$('#q').addEventListener('keydown', e => {
  if (e.key === 'Enter' && matches.length) { matchPtr = (matchPtr + 1) % matches.length; select(matches[matchPtr]!, { scroll: true }); $('#qCount').textContent = `${matchPtr + 1} of ${matches.length}`; }
  if (e.key === 'Escape') { const q = e.target as HTMLInputElement; q.value = ''; runSearch(); q.blur(); }
});
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  // The create dialog keeps the keys: no shortcut acts on the page behind it.
  if (createDlg.open) {
    if ((mod && e.key.toLowerCase() === 'r') || e.key === 'F5') e.preventDefault();   // never reload the page
    else if (e.key === 'Escape') { e.preventDefault(); closeCreate(); }
    return;
  }
  if (NATIVE) {
    // Stop the webview from reloading the page (which would drop all state).
    if ((mod && e.key.toLowerCase() === 'r') || e.key === 'F5') { e.preventDefault(); refresh(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); runFetch(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); pickRepo(); return; }
    // Tabs. preventDefault keeps the WebView from acting on them itself.
    if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); newTab(); return; }
    if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); if (tabs.active >= 0) closeTab(tabs.active); return; }
    if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); const i = cycle(tabs, e.shiftKey ? -1 : 1); if (i >= 0) activateTab(i); return; }
    if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); const i = nth(tabs, +e.key); if (i >= 0) activateTab(i); return; }
  }
  const modalOpen = !$('#modal').hidden;
  if (mod && e.key.toLowerCase() === 'b' && !modalOpen) { e.preventDefault(); showSide(); return; }
  if (e.key === 'Escape') {
    if (modalOpen) closeModal(); else if (!menu.hidden) closeMenu(); else if (!tabList.hidden) closeTabList();
    else if (diffOpen()) closeDiff();
    else if (sideShown && narrowView()) showSide(false); else detail.classList.remove('open');
    return;
  }
  if (diffOpen()) {
    // The graph is covered: keys move between files instead of commits.
    if (modalOpen || /INPUT|TEXTAREA/.test(document.activeElement!.tagName) || side.contains(document.activeElement)) return;
    if (e.key === 'j' || e.key === ']') { e.preventDefault(); stepDiff(1); }
    else if (e.key === 'k' || e.key === '[') { e.preventDefault(); stepDiff(-1); }
    return;
  }
  const n = S.commits.length;
  if (modalOpen || /INPUT|TEXTAREA/.test(document.activeElement!.tagName) || side.contains(document.activeElement) || !n) return;
  const open = detail.classList.contains('open');
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); select(Math.min(sel + 1, n - 1), { scroll: true, open }); }
  else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    if (sel === 0 && wipOn()) { selectWip({ open }); wrap.scrollTop = 0; } else if (!wipSel) select(Math.max(sel - 1, 0), { scroll: true, open });
  }
  else if (e.key === 'Home') { e.preventDefault(); select(0, { scroll: true, open }); }
  else if (e.key === 'End') { e.preventDefault(); select(n - 1, { scroll: true, open }); }
  else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
});
document.addEventListener('click', e => {
  if (!menu.hidden && !(e.target as Element).closest('.repo-wrap')) closeMenu();
  if (!tabList.hidden && !(e.target as Element).closest('.tabs-more-wrap')) closeTabList();
});
if (NATIVE) {
  // The webview's own menu (Back, Refresh, Print…) does nothing useful here. Keep it only
  // in text boxes (paste) and while text is selected (copy).
  document.addEventListener('contextmenu', e => {
    const box = (e.target as Element).closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    if (box && !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test(box.type)) return;
    if (String(getSelection()).trim()) return;
    e.preventDefault();
  });
}

/* column resize: drag a header's right edge, double-click it to reset,
   or focus it and use the arrow keys. */
document.querySelectorAll<HTMLElement>('.head .resizer').forEach(rz => {
  const key = rz.dataset.col as ColKey;   // data-col in index.html is one of the column keys
  const all = cols as Record<ColKey, number | null>;
  const current = (): number => {
    if (key === 'graph') return graphColW();
    if (key === 'msg') return cols.msg || rz.parentElement!.getBoundingClientRect().width;
    return all[key]!;   // ref and date always have a width
  };
  const set = (w: number) => { all[key] = Math.round(Math.max(COLS[key].min, Math.min(COLS[key].max, w))); applyCols(); };
  rz.addEventListener('pointerdown', e => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add('drag');
    const startX = e.clientX, startW = current();
    const move = (ev: PointerEvent) => set(startW + ev.clientX - startX);
    const up = () => { rz.classList.remove('drag'); rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); saveCols(); };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
  });
  rz.addEventListener('dblclick', () => { all[key] = COLS[key].reset(); applyCols(); saveCols(); });
  rz.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); set(current() + (e.key === 'ArrowRight' ? 10 : -10)); saveCols();
  });
});

/* theme */
const savedTheme = lsGet('lanes.theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next; lsSet('lanes.theme', next);
  applyTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

wrap.addEventListener('scroll', () => { closeRefPop(); scheduleDraw(); }, { passive: true });
new ResizeObserver(scheduleDraw).observe(wrap);

/* ---------- boot ---------- */
// tests/ui reads state through this; real builds have __TEST__ = false and drop it.
if (__TEST__) window.__gitkrapao = { get S() { return S; }, get PALETTE() { return PALETTE; }, textOn, nameProblem, nameClash };
if (NATIVE) {
  $('#openBtn').hidden = false;
  $('#refreshBtn').hidden = false;
  $('#fetchBtn').hidden = false;
  $('#openBtn').addEventListener('click', pickRepo);
  // aria-disabled instead of disabled, so the "No remotes" tooltip still shows.
  $('#fetchBtn').addEventListener('click', () => { if ($('#fetchBtn').getAttribute('aria-disabled') !== 'true') runFetch(); });
  $('#emptyOpen').addEventListener('click', pickRepo);
  $('#refreshBtn').addEventListener('click', refresh);
  $('#repoBtn').addEventListener('click', toggleMenu);
  menu.addEventListener('click', onRecentClick);
  $('#emptyRecent').addEventListener('click', onRecentClick);
  setInterval(poll, POLL_MS);
  window.addEventListener('focus', poll);
  window.addEventListener('focus', () => loadWip({ force: true }));   // back from the editor
  document.addEventListener('visibilitychange', poll);

  // Tab strip: a click activates, the x (or a middle click) closes; Left/Right move
  // focus between tabs and Enter/Space (the button's own click) activates.
  $('#tabs').hidden = false;
  tabStrip.addEventListener('click', e => {
    const t = e.target as Element, item = t.closest<HTMLElement>('.tab-item'); if (!item) return;
    if (t.closest('.tab-x')) closeTab(+item.dataset.tab!); else activateTab(+item.dataset.tab!);   // data-tab: renderTabs
  });
  tabStrip.addEventListener('auxclick', e => {
    const item = (e.target as Element).closest<HTMLElement>('.tab-item');
    if (item && e.button === 1) { e.preventDefault(); closeTab(+item.dataset.tab!); }
  });
  tabStrip.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...tabStrip.querySelectorAll<HTMLElement>('[role="tab"]')];
    const at = all.indexOf(document.activeElement as HTMLElement); if (at < 0) return;
    e.preventDefault();
    const next = all[(at + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]!;   // all has at least the focused tab
    all.forEach(b => { b.tabIndex = b === next ? 0 : -1; });
    next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  // A mouse wheel scrolls an overflowing strip sideways.
  tabStrip.addEventListener('wheel', e => { if (e.deltaY && !e.deltaX && tabStrip.scrollWidth > tabStrip.clientWidth) { e.preventDefault(); tabStrip.scrollLeft += e.deltaY; } }, { passive: false });
  $('#tabNew').addEventListener('click', newTab);
  $('#tabMore').addEventListener('click', toggleTabList);
  tabList.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLElement>('[data-tab]'); if (!b) return;
    closeTabList(); activateTab(+b.dataset.tab!);
  });

  // Saved tabs (or lanes.last from an older build); only the active one loads, and a
  // repo that fails to open says so in the banner.
  tabs = loadTabs();
  saveTabs(tabs); renderTabs();
  const first = tabs.list[tabs.active];
  if (first) showTab(first); else showEmpty();
} else {
  $('#repoBtn').classList.add('static');
  $('#repoBtn').removeAttribute('aria-haspopup');
  $('#importBtn').hidden = false;
  $('#importBtn').addEventListener('click', openModal);
  $('#cancelBtn').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if ((e.target as Element).id === 'modal') closeModal(); });
  $('#copyCmd').addEventListener('click', e => copyText($('#cmd').textContent!, e.currentTarget as HTMLElement));
  $('#fileIn').addEventListener('change', async e => {
    const input = e.target as HTMLInputElement;
    const f = input.files![0]; if (!f) return;
    const buf = await f.arrayBuffer(); const b = new Uint8Array(buf);
    const enc = (b[0] === 0xFF && b[1] === 0xFE) ? 'utf-16le' : (b[0] === 0xFE && b[1] === 0xFF) ? 'utf-16be' : 'utf-8';
    $<HTMLTextAreaElement>('#logIn').value = new TextDecoder(enc).decode(buf).replace(/^\uFEFF/, '');
    const base = f.name.replace(/\.(txt|log)$/i, '');
    if (!$<HTMLInputElement>('#repoIn').value && base !== 'gitkrapao') $<HTMLInputElement>('#repoIn').value = base;
    input.value = '';
  });
  $('#loadBtn').addEventListener('click', () => {
    const text = $<HTMLTextAreaElement>('#logIn').value;
    const { commits, bad } = parseLog(text);
    if (!commits.length) { $('#err').textContent = 'No commits found. Use the exact command above, without --graph or --oneline.'; return; }
    const repo = $<HTMLInputElement>('#repoIn').value.trim() || 'my-repo';
    if (!lsSet('lanes.log', text.length < 4e6 ? text : '')) lsDel('lanes.log');
    lsSet('lanes.repo', repo);
    closeModal();
    showBrowser({ raws: commits, repo, sample: false, note: bad.length ? `, ${bad.length} lines skipped` : '' });
  });
  $('#sampleBtn').addEventListener('click', () => { lsDel('lanes.log'); lsDel('lanes.repo'); closeModal(); showBrowser({ raws: buildSample(), repo: 'sample-webapp', sample: true }); });

  const saved = lsGet('lanes.log');
  const parsed = saved ? parseLog(saved) : null;
  if (parsed && parsed.commits.length) showBrowser({ raws: parsed.commits, repo: lsGet('lanes.repo') || 'my-repo', sample: false });
  else showBrowser({ raws: buildSample(), repo: 'sample-webapp', sample: true });
}
})();
