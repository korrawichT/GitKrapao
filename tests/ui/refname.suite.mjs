// Branch and tag names are checked as they are typed (src/refname.ts) with
// git's own rules (check-ref-format; this table was checked against git 2.42),
// plus "-x", "HEAD" and "@" (git takes "@" alone to mean HEAD), and names
// Windows cannot store as files (refs are files there; git fails on them).
// A clash: the same name in another case (one file on Windows), or a branch
// that would be a folder of another one (feat and feat/x).
export const probe = `
run(async () => {
  const { nameProblem, nameClash } = window.__gitkrapao;
  const good = ['feature/x', 'ก-ไทย', 'a.b', 'a-b_c', 'v1.0', 'a@b', 'x/y/z', 'UPPER', 'a.lockx', 'a/b.c', 'a]b', 'a{b}',
    "a'b", 'a#b', 'a%b', 'a!b', 'a/@', '@a', 'a\\u00a0b', 'console', 'connect', 'auxiliary', 'a/con-x', 'com10', 'v1.x/y'];
  const bad = ['-x', 'a b', 'a\\tb', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\\\b', 'a..b', 'a@{b', '@{', '/a', 'a/', 'a//b',
    '.a', 'a/.b', 'a.lock', 'a/b.lock', 'a.', 'a\\u007fb', 'HEAD', '@',
    'a"b', 'a<b', 'a>b', 'a|b', 'con', 'NUL', 'aux/x', 'feat/lpt9', 'com1.txt', 'x./y'];
  for (const kind of ['branch', 'tag']) {
    for (const n of good) ok(nameProblem(n, kind) === '', kind + ' ok: ' + JSON.stringify(n), nameProblem(n, kind));
    for (const n of bad) ok(nameProblem(n, kind) !== '', kind + ' refused: ' + JSON.stringify(n));
    ok(nameProblem('', kind) === '', kind + ': nothing typed yet is not an error');
  }
  ok(/space/.test(nameProblem('a b', 'branch')), 'says what is wrong', nameProblem('a b', 'branch'));
  ok(/Windows/.test(nameProblem('aux/x', 'branch')) && /Windows/.test(nameProblem('a|b', 'tag')), 'says when it is Windows', nameProblem('aux/x', 'branch'));

  const names = ['main', 'feat', 'team/a'];
  ok(nameClash('Main', 'branch', names) === 'A branch named main already exists.', 'same name in another case', nameClash('Main', 'branch', names));
  ok(nameClash('main', 'branch', names) === 'A branch named main already exists.', 'same name');
  ok(nameClash('feat/x', 'branch', names) === 'Clashes with the branch feat', 'under an existing branch', nameClash('feat/x', 'branch', names));
  ok(nameClash('team', 'branch', names) === 'Clashes with the branch team/a', 'over an existing folder', nameClash('team', 'branch', names));
  ok(['feature', 'team-b', 'topic', 'main2'].every(n => nameClash(n, 'branch', names) === ''), 'no clash');
  ok(nameClash('V1', 'tag', ['v1']) === 'A tag named v1 already exists.', 'tags too', nameClash('V1', 'tag', ['v1']));
});`;
