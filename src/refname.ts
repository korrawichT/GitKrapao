/* Branch and tag names, checked as they are typed so the create dialog can
   say what is wrong before anything runs. The rules are git's own
   (check-ref-format), plus a leading "-" (git would read an option), "HEAD"
   for tags too, "@" alone (every git command reads it as HEAD), and names
   Windows cannot store: refs are files there, so git fails on them, also for
   a teammate on Windows who fetches the ref. The backend checks again with
   git itself. No DOM here. */
export type RefKind = 'branch' | 'tag';

/* Why `name` cannot be a branch/tag name; '' when it can (or is still empty). */
export function nameProblem(name: string, kind: RefKind): string {
  if (!name) return '';
  if (name.startsWith('-')) return 'Cannot start with "-"';
  if (name === 'HEAD' || name === '@') return `"${name}" cannot be a ${kind} name`;
  if (name.includes(' ')) return 'No spaces; use "-" instead';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'No control characters';
  const bad = /[~^:?*[\\]/.exec(name);
  if (bad) return `"${bad[0]}" is not allowed`;
  const win = /["<>|]/.exec(name);
  if (win) return `"${win[0]}" is not allowed (Windows cannot store it)`;
  if (name.includes('..')) return '".." is not allowed';
  if (name.includes('@{')) return '"@{" is not allowed';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'No "/" at the start or end, and no "//"';
  const parts = name.split('/');
  if (parts.some(p => p.startsWith('.'))) return 'No part may start with "."';
  if (parts.some(p => p.endsWith('.lock'))) return 'No part may end with ".lock"';
  if (parts.some(p => p.endsWith('.'))) return 'No part may end with "."';
  const dev = parts.find(p => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(p));
  if (dev) return `"${dev}" is a reserved name on Windows`;
  return '';
}

/* The existing name (of the same kind) that `name` clashes with: the same
   name in another case (one file on Windows and macOS), or a name that
   would be a folder of it or inside it (feat and feat/x). '' when none. */
export function nameClash(name: string, kind: RefKind, names: string[]): string {
  const low = name.toLowerCase();
  const same = names.find(n => n.toLowerCase() === low);
  if (same !== undefined) return `A ${kind} named ${same} already exists.`;
  const nested = names.find(n => { const m = n.toLowerCase(); return m.startsWith(low + '/') || low.startsWith(m + '/'); });
  return nested !== undefined ? `Clashes with the ${kind} ${nested}` : '';
}
