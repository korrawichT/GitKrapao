//! Renaming a branch, deleting a branch or a tag (local refs only; a tag can
//! then also be deleted on origin), and Undo of the last delete. The same
//! lock, trust check, Steps and Output drawer as create. Every name the page
//! sends is matched byte for byte against for-each-ref, because Windows opens
//! a loose ref file whatever the letter case. What Undo needs stays here in
//! AppState.undo; the page only gets a token.

use super::create::{run_op, taken, valid_name, windows_unsafe, OpCtx};
use super::fetch::{assess, git_env, git_error, read_trust_config, sanitize, trust_gate, GitResult};
use super::switch::{rev, succeeded, Steps, SwitchCtx};
use super::*;

/// Deleting a tag on origin talks to the server: fetch's limit.
const PUSH_LIMIT: Duration = Duration::from_secs(90);
/// Counting the commits only the ref keeps (read-only, but a huge repo can be slow).
const COUNT_LIMIT: Duration = Duration::from_secs(60);
const HEADS: &str = "refs/heads/";
const TAGS: &str = "refs/tags/";
const CASE_ONLY: &str = "Only the letter case changes; Windows stores both names as one file.";

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub(crate) enum RefKind {
    Branch,
    Tag,
}

/// A branch or tag just deleted, as the Undo bar shows it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeletedRef {
    /// Hands the delete back to restore_ref; only valid in the same repo, once.
    #[cfg_attr(test, ts(type = "number"))]
    pub token: u64,
    pub kind: RefKind,
    pub name: String,
    /// The commit it pointed to, abbreviated.
    pub short: String,
    /// The tag was also deleted on origin, which Undo does not bring back.
    pub on_origin: bool,
}

/// What Undo restores. Never sent to the page.
#[derive(Clone, Debug)]
pub(crate) struct Deleted {
    kind: RefKind,
    name: String,
    /// The object the ref held (a tag object for an annotated tag).
    sha: String,
    short: String,
    /// branch.<name>.* keys and values (None: a key without "=").
    config: Vec<(String, Option<String>)>,
}

/// The last delete per repo (GitDirs::lock_key), behind a token.
#[derive(Default)]
pub(crate) struct UndoStore {
    next: AtomicU64,
    map: Mutex<HashMap<String, (u64, Deleted)>>,
}

impl UndoStore {
    /// Replaces the repo's entry; returns its token.
    fn put(&self, key: &str, d: Deleted) -> u64 {
        let token = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_string(), (token, d));
        token
    }

    /// The repo's entry if `token` is its token; removes it then. A stale or
    /// foreign token leaves the entry as it is.
    fn take(&self, key: &str, token: u64) -> Option<Deleted> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(key).is_some_and(|(t, _)| *t == token) {
            map.remove(key).map(|(_, d)| d)
        } else {
            None
        }
    }

    /// Gives an entry back after a restore that changed nothing, unless a
    /// newer delete took the repo's slot meanwhile.
    fn put_back(&self, key: &str, token: u64, d: Deleted) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).entry(key.to_string()).or_insert((token, d));
    }
}

/// The object `ns` + `name` points to, for exactly that name (byte for
/// byte). Never show-ref / rev-parse a name the page sent: Windows opens a
/// loose ref file whatever the letter case.
fn exact(repo: &Path, ns: &str, name: &str, env: &[(&str, &str)]) -> Result<Option<String>, String> {
    let out = git_env(repo, &["for-each-ref", "--format=%(objectname) %(refname)", ns], env).output().map_err(spawn_error)?;
    if !out.status.success() {
        return Err(git_error(&String::from_utf8_lossy(&out.stderr), out.status.code(), "git for-each-ref"));
    }
    let want = format!("{ns}{name}");
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.split_once(' ').filter(|(_, r)| *r == want).map(|(o, _)| o.to_string())))
}

/// Another ref under `ns` whose name equals `name` without case (any letter,
/// as in `taken`) but not byte for byte. On Windows git reads and writes
/// such a pair as one file: `git branch -D feat` next to a loose "FEAT"
/// deletes FEAT's commit as well, and `-m` renames the wrong tip.
fn case_sibling(repo: &Path, ns: &str, name: &str, env: &[(&str, &str)]) -> Result<Option<String>, String> {
    let out = git_env(repo, &["for-each-ref", "--format=%(refname)", ns], env).output().map_err(spawn_error)?;
    if !out.status.success() {
        return Err(git_error(&String::from_utf8_lossy(&out.stderr), out.status.code(), "git for-each-ref"));
    }
    let want = format!("{ns}{name}");
    let lower = want.to_lowercase();
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|r| *r != want && r.to_lowercase() == lower)
        .map(|r| r[ns.len()..].to_string()))
}

/// The refusal text for a case sibling of branch `name`.
fn sibling_text(name: &str, other: &str, nothing: &str) -> String {
    format!(
        "Another branch, {}, differs from {} only in letter case; Windows stores both as one file, so {nothing}. Rename or delete one of them in a terminal first.",
        sanitize(other, 120),
        sanitize(name, 120)
    )
}

/// More stashes than this would not fit the Windows command line: no count.
const MAX_STASHES: usize = 500;

/// Commits reachable from `tip` that nothing but `full` reaches: no other
/// branch, remote-tracking branch, tag, HEAD or another worktree's HEAD (all
/// in `--all`), and no stash. `--all` has only stash@{0} (refs/stash); the
/// older ones live in its reflog, so every stash commit is listed too. None
/// when git failed or took too long.
fn unreachable(repo: &Path, full: &str, tip: &str, cx: &SwitchCtx) -> Option<u32> {
    let out = git_env(repo, &["stash", "list", "--format=%H"], cx.env).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let stashes: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if stashes.len() > MAX_STASHES {
        return None;
    }
    let exclude = format!("--exclude={full}");
    // Everything after --not is on the excluded side, the stash commits included.
    let args = [&["rev-list", "--count", tip, "--not", &exclude, "--all"][..], &stashes].concat();
    let cmd = git_env(repo, &args, cx.env);
    let r = run_limited(cmd, cx.limit.min(COUNT_LIMIT), 4096, cx.pid).ok()?;
    if !succeeded(&r) {
        return None;
    }
    String::from_utf8_lossy(&r.stdout).trim().parse().ok()
}

/// The warning under a delete question; empty when nothing would be lost.
fn lost_text(n: Option<u32>, noun: &str) -> String {
    match n {
        Some(0) => String::new(),
        Some(1) => "\n\n1 commit will no longer be on any branch. Undo brings it back; after that only via git reflog / git fsck.".into(),
        Some(n) => format!("\n\n{n} commits will no longer be on any branch. Undo brings them back; after that only via git reflog / git fsck."),
        None => format!(
            "\n\nGitKrapao could not count the commits only this {noun} keeps; some may no longer be on any branch. Undo brings them back; after that only via git reflog / git fsck."
        ),
    }
}

/// branch.<name>.<key> entries of the repo's own config, in file order. The
/// rest after the name must have no dot: "branch.feat.x.remote" belongs to
/// a branch "feat.x".
fn branch_config(repo: &Path, name: &str, env: &[(&str, &str)]) -> Result<Vec<(String, Option<String>)>, String> {
    let out = git_env(repo, &["config", "--local", "-z", "--list"], env).output().map_err(spawn_error)?;
    if !out.status.success() {
        return Err(git_error(&String::from_utf8_lossy(&out.stderr), out.status.code(), "git config"));
    }
    let prefix = format!("branch.{name}.");
    Ok(String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter_map(|kv| {
            let (k, v) = match kv.split_once('\n') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (kv, None),
            };
            k.strip_prefix(&prefix).filter(|rest| !rest.is_empty() && !rest.contains('.')).map(|_| (k.to_string(), v))
        })
        .collect())
}

/// The trust gate for `op`; Err is the refusal's (summary, cancelled).
fn trusted(top: &str, op: &str, cx: &SwitchCtx) -> Result<(), (String, bool)> {
    let repo = Path::new(top);
    let entries = read_trust_config(repo, cx.env)
        .map_err(|e| (format!("Could not check this repository's config, so nothing was changed: {e}"), false))?;
    trust_gate(top, op, &assess(repo, &entries, cx.env), None, cx.store, cx.store_lock, cx.trust)
}

/// git's reason a step failed, or that it ran out of time.
fn why(r: &Limited, doing: &str, what: &str, cx: &SwitchCtx) -> String {
    if r.timed_out {
        format!("{doing} took longer than {} s and was stopped.", cx.limit.as_secs())
    } else {
        git_error(&String::from_utf8_lossy(&r.stderr), r.status.and_then(|s| s.code()), what)
    }
}

/// Renames local branch `from` to `to` in `top`. The caller holds the repo's RepoLock.
pub(crate) fn rename_in(top: &str, from: &str, to: &str, o: &OpCtx) -> GitResult {
    let repo = Path::new(top);
    let cx = &o.cx;
    let (f, t) = (sanitize(from, 120), sanitize(to, 120));
    let refused = |summary: String, cancelled: bool| GitResult::not_run(format!("git branch -m ({f} → {t})"), summary, cancelled);
    match exact(repo, HEADS, from, cx.env) {
        Ok(Some(_)) => {}
        Ok(None) => return refused(format!("Branch {f} does not exist."), false),
        Err(e) => return refused(format!("Could not read the branches, so nothing was renamed: {e}"), false),
    }
    match case_sibling(repo, HEADS, from, cx.env) {
        Ok(None) => {}
        Ok(Some(other)) => return refused(sibling_text(from, &other, "nothing was renamed"), false),
        Err(e) => return refused(format!("Could not read the branches, so nothing was renamed: {e}"), false),
    }
    if to == from {
        return refused(format!("The branch is already called {t}."), false);
    }
    if !valid_name(repo, &format!("{HEADS}{to}"), to, cx.env) {
        return refused(format!("Not a valid branch name: \"{t}\""), false);
    }
    if windows_unsafe(to) {
        return refused(format!("Not a valid branch name: \"{t}\" (Windows cannot store it as a file)"), false);
    }
    match taken(repo, HEADS, to, cx.env) {
        Ok(None) => {}
        Ok(Some(other)) if other == from => return refused(CASE_ONLY.into(), false),
        Ok(Some(other)) => return refused(format!("A branch named {other} already exists."), false),
        Err(e) => return refused(format!("Could not read the existing branches, so nothing was renamed: {e}"), false),
    }
    if let Err((summary, cancelled)) = trusted(top, "Rename branch", cx) {
        return refused(summary, cancelled);
    }
    let mut steps = Steps::default();
    let r = match steps.run(repo, &["branch", "-m", "--", from, to], cx) {
        Ok(r) => r,
        Err(e) => return refused(e, false),
    };
    if !succeeded(&r) {
        let w = why(&r, "Renaming the branch", "git branch -m", cx);
        return steps.result(Some(&r), w, false);
    }
    steps.result(Some(&r), format!("Renamed branch {from} to {to}."), false)
}

/// Deletes local branch `name` in `top` after the confirm. The caller holds the repo's RepoLock.
pub(crate) fn delete_branch_in(top: &str, name: &str, o: &OpCtx) -> GitResult {
    let repo = Path::new(top);
    let cx = &o.cx;
    let shown = sanitize(name, 120);
    let refused = |summary: String, cancelled: bool| GitResult::not_run(format!("git branch -D ({shown})"), summary, cancelled);
    let full = format!("{HEADS}{name}");
    let tip = match exact(repo, HEADS, name, cx.env) {
        Ok(Some(t)) => t,
        Ok(None) => return refused(format!("Branch {shown} does not exist."), false),
        Err(e) => return refused(format!("Could not read the branches, so nothing was deleted: {e}"), false),
    };
    match case_sibling(repo, HEADS, name, cx.env) {
        Ok(None) => {}
        Ok(Some(other)) => return refused(sibling_text(name, &other, "nothing was deleted"), false),
        Err(e) => return refused(format!("Could not read the branches, so nothing was deleted: {e}"), false),
    }
    match git_env(repo, &["symbolic-ref", "-q", "HEAD"], cx.env).output() {
        Ok(out) if String::from_utf8_lossy(&out.stdout).trim() == full => {
            return refused("The checked-out branch cannot be deleted.".into(), false);
        }
        Ok(_) => {}
        Err(e) => return refused(spawn_error(e), false),
    }
    let config = match branch_config(repo, name, cx.env) {
        Ok(c) => c,
        Err(e) => return refused(format!("Could not read the branch's settings, so nothing was deleted: {e}"), false),
    };
    let short = tip[..7].to_string();
    let lost = unreachable(repo, &full, &tip, cx);
    if let Err((summary, cancelled)) = trusted(top, "Delete branch", cx) {
        return refused(summary, cancelled);
    }
    let text = format!("Delete branch {shown} ({short})?{}", lost_text(lost, "branch"));
    if !(o.confirm)(&shown, "Delete", "Cancel", &text) {
        return refused("Delete branch cancelled.".into(), true);
    }
    if !matches!(exact(repo, HEADS, name, cx.env), Ok(Some(now)) if now == tip) {
        return refused(format!("Branch {shown} moved while the dialog was open; nothing was deleted."), false);
    }
    let mut steps = Steps::default();
    let r = match steps.run(repo, &["branch", "-D", "--", name], cx) {
        Ok(r) => r,
        Err(e) => return refused(e, false),
    };
    if !succeeded(&r) {
        let w = why(&r, "Deleting the branch", "git branch -D", cx);
        return steps.result(Some(&r), w, false);
    }
    let token = o.undo.put(o.key, Deleted { kind: RefKind::Branch, name: name.into(), sha: tip, short: short.clone(), config });
    let mut res = steps.result(Some(&r), format!("Deleted branch {name} ({short})."), false);
    res.deleted = Some(DeletedRef { token, kind: RefKind::Branch, name: name.into(), short, on_origin: false });
    res
}

/// Deletes local tag `name` in `top` after the confirm, then on origin if
/// asked. The caller holds the repo's RepoLock.
pub(crate) fn delete_tag_in(top: &str, name: &str, o: &OpCtx) -> GitResult {
    let repo = Path::new(top);
    let cx = &o.cx;
    let shown = sanitize(name, 120);
    let full = format!("{TAGS}{name}");
    let refused = |summary: String, cancelled: bool| GitResult::not_run(format!("git update-ref -d ({TAGS}{shown})"), summary, cancelled);
    let obj = match exact(repo, TAGS, name, cx.env) {
        Ok(Some(o)) => o,
        Ok(None) => return refused(format!("Tag {shown} does not exist."), false),
        Err(e) => return refused(format!("Could not read the tags, so nothing was deleted: {e}"), false),
    };
    // An annotated tag is a tag object: count from, and show, its commit.
    let commit = rev(repo, &obj, cx.env);
    let short = commit.as_deref().unwrap_or(&obj)[..7].to_string();
    let lost = commit.as_deref().and_then(|c| unreachable(repo, &full, c, cx));
    if let Err((summary, cancelled)) = trusted(top, "Delete tag", cx) {
        return refused(summary, cancelled);
    }
    let text = format!("Delete tag {shown} ({short})?{}", lost_text(lost, "tag"));
    if !(o.confirm)(&shown, "Delete", "Cancel", &text) {
        return refused("Delete tag cancelled.".into(), true);
    }
    // With the old value, git refuses if the tag moved meanwhile.
    let mut steps = Steps::default();
    let r = match steps.run(repo, &["update-ref", "-d", &full, &obj], cx) {
        Ok(r) => r,
        Err(e) => return refused(e, false),
    };
    if !succeeded(&r) {
        let w = why(&r, "Deleting the tag", "git update-ref", cx);
        return steps.result(Some(&r), w, false);
    }
    let token = o.undo.put(o.key, Deleted { kind: RefKind::Tag, name: name.into(), sha: obj, short: short.clone(), config: vec![] });
    // Every outcome from here on: the local tag is gone, so Undo is offered.
    let done = |steps: Steps, last: &Limited, summary: String, ok: bool, on_origin: bool| GitResult {
        ok,
        deleted: Some(DeletedRef { token, kind: RefKind::Tag, name: name.into(), short: short.clone(), on_origin }),
        ..steps.result(Some(last), summary, false)
    };
    let has_origin = git_env(repo, &["remote"], cx.env)
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).lines().any(|l| l.trim() == "origin"));
    if !has_origin {
        return done(steps, &r, format!("Deleted tag {name} ({short})."), true, false);
    }
    // Every push URL: the push goes to all of them.
    let urls: String = git_env(repo, &["remote", "get-url", "--push", "--all", "origin"], cx.env)
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).lines().map(|u| format!("  {}\n", sanitize(u.trim(), 200))).collect())
        .unwrap_or_default();
    let text = format!(
        "Tag {shown} was deleted in this repository. Also delete it on origin?\n\n{urls}\nTeammates who already fetched it keep their copy, and Undo does not bring it back on origin."
    );
    if !(o.confirm)("also delete on origin?", "Delete on origin", "Keep on origin", &text) {
        return done(steps, &r, format!("Deleted tag {name} ({short}); kept on origin."), true, false);
    }
    // --no-signed: signing would run gpg.program, which the repo's config can name.
    let pcx = SwitchCtx { limit: cx.limit.min(PUSH_LIMIT), ..*cx };
    let p = match steps.run(repo, &["push", "--no-signed", "--no-recurse-submodules", "origin", "--delete", &full], &pcx) {
        Ok(p) => p,
        Err(e) => return done(steps, &r, format!("Deleted tag {name} ({short}) here; deleting it on origin failed: {e}"), false, false),
    };
    // Origin never had it: newer git warns and succeeds, older servers refuse.
    let err = String::from_utf8_lossy(&p.stderr).to_ascii_lowercase();
    if !p.timed_out && (err.contains("deleting a non-existent ref") || err.contains("remote ref does not exist")) {
        return done(steps, &p, format!("Deleted tag {name} ({short}); origin had no tag {name}."), true, false);
    }
    if succeeded(&p) {
        return done(steps, &p, format!("Deleted tag {name} ({short}) here and on origin."), true, true);
    }
    let summary = if p.timed_out {
        format!("Deleted tag {name} ({short}) here; deleting it on origin took longer than {} s and was stopped.", pcx.limit.as_secs())
    } else {
        let e = git_error(&String::from_utf8_lossy(&p.stderr), p.status.and_then(|s| s.code()), "git push");
        format!("Deleted tag {name} ({short}) here; deleting it on origin failed: {e}")
    };
    done(steps, &p, summary, false, false)
}

/// Brings back the delete `token` stands for, in `top` only. The caller holds the repo's RepoLock.
pub(crate) fn restore_in(top: &str, token: u64, o: &OpCtx) -> GitResult {
    let repo = Path::new(top);
    let cx = &o.cx;
    let Some(d) = o.undo.take(o.key, token) else {
        return GitResult::not_run("git update-ref (undo)".into(), "Nothing to undo: that delete is no longer remembered.", false);
    };
    let (ns, noun) = match d.kind {
        RefKind::Branch => (HEADS, "branch"),
        RefKind::Tag => (TAGS, "tag"),
    };
    let shown = sanitize(&d.name, 120);
    let full = format!("{ns}{}", d.name);
    // Refused before anything was written: the entry goes back, so Undo can
    // be pressed again (after a cancelled trust question, or once the name
    // is free).
    let refused = |summary: String, cancelled: bool| {
        o.undo.put_back(o.key, token, d.clone());
        GitResult::not_run(format!("git update-ref ({ns}{shown})"), summary, cancelled)
    };
    match taken(repo, ns, &d.name, cx.env) {
        Ok(None) => {}
        Ok(Some(other)) => {
            let sha = &d.sha;
            return refused(format!("A {noun} named {other} already exists, so {shown} ({sha}) was not restored."), false);
        }
        Err(e) => return refused(format!("Could not read the existing {noun}s, so nothing was restored: {e}"), false),
    }
    if !git_env(repo, &["cat-file", "-e", &d.sha], cx.env).output().is_ok_and(|out| out.status.success()) {
        return refused(format!("The {noun}'s object is no longer in the repository (git gc removed it), so {shown} was not restored."), false);
    }
    if let Err((summary, cancelled)) = trusted(top, "Undo delete", cx) {
        return refused(summary, cancelled);
    }
    // The all-zero old value: git refuses if the name was taken meanwhile.
    let zero = "0".repeat(d.sha.len());
    let mut steps = Steps::default();
    let r = match steps.run(repo, &["update-ref", "-m", "GitKrapao: undo delete", &full, &d.sha, &zero], cx) {
        Ok(r) => r,
        Err(e) => return refused(e, false),
    };
    if !succeeded(&r) {
        let w = why(&r, "Restoring", "git update-ref", cx);
        return steps.result(Some(&r), w, false);
    }
    let restored = format!("Restored {noun} {} at {}.", d.name, d.short);
    // The upstream and the branch's other settings, unless something set
    // them again meanwhile.
    if d.kind == RefKind::Branch && !d.config.is_empty() && branch_config(repo, &d.name, cx.env).is_ok_and(|c| c.is_empty()) {
        for (key, value) in &d.config {
            // A key written without "=" is a boolean true.
            let value = value.as_deref().unwrap_or("true");
            let c = match steps.run(repo, &["config", "--local", "--add", "--", key, value], cx) {
                Ok(c) => c,
                Err(e) => return GitResult { ok: false, ..steps.result(Some(&r), format!("{restored} Its settings (upstream) were not restored: {e}"), false) },
            };
            if !succeeded(&c) {
                let w = why(&c, "Restoring the settings", "git config", cx);
                return steps.result(Some(&c), format!("{restored} Its settings (upstream) were not restored: {w}"), false);
            }
        }
    }
    steps.result(Some(&r), restored, false)
}

/// Renames local branch `from` to `to` (`git branch -m`: the upstream, the
/// reflog and HEAD follow). Err only for "busy" or a path that is not a
/// repository; every other outcome is a GitResult for the output log.
#[tauri::command]
pub(crate) async fn rename_branch(app: tauri::AppHandle, path: String, from: String, to: String, state: State<'_, AppState>) -> Result<GitResult, String> {
    run_op(app, state, "Rename branch", path, move |top, o| rename_in(top, &from, &to, o)).await
}

/// Deletes local branch `name` after a native confirm; `deleted` carries the Undo token.
#[tauri::command]
pub(crate) async fn delete_branch(app: tauri::AppHandle, path: String, name: String, state: State<'_, AppState>) -> Result<GitResult, String> {
    run_op(app, state, "Delete branch", path, move |top, o| delete_branch_in(top, &name, o)).await
}

/// Deletes local tag `name` after a native confirm, then, if the repo has an
/// origin and the user agrees, on origin too; `deleted` carries the Undo token.
#[tauri::command]
pub(crate) async fn delete_tag(app: tauri::AppHandle, path: String, name: String, state: State<'_, AppState>) -> Result<GitResult, String> {
    run_op(app, state, "Delete tag", path, move |top, o| delete_tag_in(top, &name, o)).await
}

/// Restores the delete `token` stands for, in this repo only, once.
#[tauri::command]
pub(crate) async fn restore_ref(app: tauri::AppHandle, path: String, token: u64, state: State<'_, AppState>) -> Result<GitResult, String> {
    run_op(app, state, "Undo delete", path, move |top, o| restore_in(top, token, o)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::Fixture;

    const KEY: &str = "repo";

    impl Fixture {
        fn rename(&self, from: &str, to: &str) -> GitResult {
            self.op(&UndoStore::default(), KEY, |o| rename_in(&self.top(), from, to, o))
        }
        fn del_branch(&self, undo: &UndoStore, name: &str) -> GitResult {
            self.op(undo, KEY, |o| delete_branch_in(&self.top(), name, o))
        }
        fn del_tag(&self, undo: &UndoStore, name: &str) -> GitResult {
            self.op(undo, KEY, |o| delete_tag_in(&self.top(), name, o))
        }
        fn restore(&self, undo: &UndoStore, key: &str, token: u64) -> GitResult {
            self.op(undo, key, |o| restore_in(&self.top(), token, o))
        }
        fn count(&self, full: &str, tip: &str) -> Option<u32> {
            self.op(&UndoStore::default(), KEY, |o| unreachable(&self.repo(), full, tip, &o.cx))
        }
        fn answer(&self, a: &[bool]) {
            self.answers.borrow_mut().extend(a);
        }
        /// A new branch with one commit of its own; HEAD back on main.
        fn side(&self, name: &str) -> String {
            self.git(&["switch", "-q", "-c", name]);
            let c = self.commit(name);
            self.git(&["switch", "-q", "main"]);
            c
        }
        fn hook(&self, name: &str, body: &str) {
            std::fs::write(self.repo().join(".git").join("hooks").join(name), body).unwrap();
        }
        fn marker(&self, name: &str) -> String {
            self.dir.join(name).to_string_lossy().replace('\\', "/")
        }
    }

    fn lost(n: u32) -> String {
        format!("{n} commits will no longer be on any branch. Undo brings them back; after that only via git reflog / git fsck.")
    }

    /* ---------- rename ---------- */

    // git branch -m: the upstream, the reflog and HEAD follow the new name.
    // No dialog besides trust (none here), no Undo.
    #[test]
    fn rename_keeps_upstream_reflog_and_head() {
        let f = Fixture::new("refedit-rename");
        f.bare_origin();
        let r = f.rename("main", "trunk");
        assert!(r.ok && !r.cancelled, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, "Renamed branch main to trunk.");
        assert_eq!(r.command, "git branch -m -- main trunk");
        assert!(r.deleted.is_none());
        assert_eq!(f.head(), "refs/heads/trunk");
        assert_eq!(f.refs(HEADS), "refs/heads/trunk");
        assert_eq!(f.git(&["rev-parse", "--abbrev-ref", "trunk@{u}"]), "origin/main");
        let log = f.git(&["reflog", "show", "--format=%gs", "refs/heads/trunk"]);
        assert!(log.contains("commit: two") && log.contains("commit (initial): one"), "{log}");
        assert!(f.confirms.borrow().is_empty() && f.trusted.borrow().is_empty());
    }

    // Thai names, and a branch renamed into a folder named after itself.
    #[test]
    fn rename_to_thai_and_into_its_own_folder() {
        let f = Fixture::new("refedit-rename-thai");
        let one = f.sha("HEAD~1");
        f.git(&["branch", "feat", &one]);
        let r = f.rename("feat", "feat/x");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.refs(HEADS), "refs/heads/feat/x\nrefs/heads/main");
        let r = f.rename("feat/x", "ฟีเจอร์/ใหม่");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, "Renamed branch feat/x to ฟีเจอร์/ใหม่.");
        assert_eq!(f.sha("refs/heads/ฟีเจอร์/ใหม่"), one);
        let r = f.rename("ฟีเจอร์/ใหม่", "เสร็จ");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.refs(HEADS), "refs/heads/main\nrefs/heads/เสร็จ");
    }

    // Refused before anything runs: a case-only change (one file on
    // Windows), a name taken (loose or packed, in any case), names git or
    // Windows cannot take, the same name, and a `from` that is not exactly
    // an existing branch (Windows would open "Feat" for "feat").
    #[test]
    fn rename_refuses_case_only_taken_and_bad_names() {
        let f = Fixture::new("refedit-rename-names");
        f.git(&["branch", "packed"]);
        f.git(&["pack-refs", "--all"]);
        f.git(&["branch", "feat"]);
        f.git(&["branch", "loose"]);
        let before = f.refs(HEADS);
        assert_eq!(f.rename("feat", "Feat").summary, CASE_ONLY);
        assert_eq!(f.rename("feat", "FEAT").summary, CASE_ONLY);
        assert_eq!(f.rename("feat", "loose").summary, "A branch named loose already exists.");
        assert_eq!(f.rename("feat", "LOOSE").summary, "A branch named loose already exists.");
        assert_eq!(f.rename("feat", "Packed").summary, "A branch named packed already exists.");
        assert_eq!(f.rename("feat", "main").summary, "A branch named main already exists.");
        assert_eq!(f.rename("Feat", "x").summary, "Branch Feat does not exist.");
        assert_eq!(f.rename("nope", "x").summary, "Branch nope does not exist.");
        for to in ["", "-x", "HEAD", "@", "@{-1}", "a..b", "a b", "x.lock", "feat", "con", "a./b", "aux/x", "a|b"] {
            let r = f.rename("feat", to);
            assert!(!r.ok && !r.cancelled && r.exit_code.is_none() && !r.summary.is_empty(), "{to:?}: {}", r.summary);
        }
        for to in ["con", "a./b", "aux/x", "a|b"] {
            assert!(f.rename("feat", to).summary.contains("Windows"), "{to}");
        }
        assert_eq!(f.refs(HEADS), before);
        assert!(f.trusted.borrow().is_empty());
    }

    // A rename runs the reference-transaction hook: trust first; a hook that
    // hangs is stopped at the limit.
    #[test]
    fn rename_asks_trust_and_stops_a_hung_hook() {
        let f = Fixture::new("refedit-rename-trust");
        f.git(&["branch", "feat"]);
        let marker = f.marker("hook-ran");
        f.hook("reference-transaction", &format!("#!/bin/sh\ntouch '{marker}'\n"));
        f.trust.set(false);
        let r = f.rename("feat", "feat2");
        assert!(!r.ok && r.cancelled && r.summary == "Rename branch cancelled: the repository was not trusted.", "{}", r.summary);
        assert!(f.trusted.borrow()[0].starts_with("Rename branch in this repository?"));
        assert!(!Path::new(&marker).exists(), "the hook never ran");
        assert_eq!(f.refs(HEADS), "refs/heads/feat\nrefs/heads/main");

        f.trust.set(true);
        assert!(f.rename("feat", "feat2").ok);
        assert!(Path::new(&marker).exists());

        f.hook("reference-transaction", "#!/bin/sh\nsleep 6\n");
        f.trust.set(true);
        f.limit.set(Duration::from_secs(2));
        let r = f.rename("feat2", "feat3");
        assert!(r.timed_out && !r.ok && r.summary.starts_with("Renaming the branch took longer than"), "{}", r.summary);
    }

    /* ---------- delete branch ---------- */

    // Merged: nothing would be lost, a plain question. The Undo entry is
    // made only after the delete.
    #[test]
    fn deletes_a_merged_branch_with_a_plain_question() {
        let f = Fixture::new("refedit-del-merged");
        let one = f.sha("HEAD~1");
        f.git(&["branch", "done", &one]);
        let undo = UndoStore::default();
        let r = f.del_branch(&undo, "done");
        assert!(r.ok && !r.cancelled, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Deleted branch done ({}).", &one[..7]));
        assert_eq!(r.command, "git branch -D -- done");
        let c = f.confirms.borrow();
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].tail.as_str(), c[0].ok.as_str(), c[0].cancel.as_str()), ("done", "Delete", "Cancel"));
        assert_eq!(c[0].text, format!("Delete branch done ({})?", &one[..7]));
        let d = r.deleted.expect("an Undo entry");
        assert_eq!((d.kind, d.name.as_str(), d.short.as_str(), d.on_origin), (RefKind::Branch, "done", &one[..7], false));
        assert!(d.token > 0);
        assert_eq!(f.refs(HEADS), "refs/heads/main");
    }

    // Unmerged: the count is rev-list's and the warning says what Undo and
    // git reflog / fsck can still do. Cancel changes nothing.
    #[test]
    fn warns_about_unmerged_commits_and_cancel_keeps_everything() {
        let f = Fixture::new("refedit-del-unmerged");
        f.git(&["switch", "-q", "-c", "feat"]);
        for m in ["a", "b", "c"] {
            f.commit(m);
        }
        f.git(&["config", "branch.feat.remote", "origin"]);
        f.git(&["switch", "-q", "main"]);
        let tip = f.sha("refs/heads/feat");
        assert_eq!(f.git(&["rev-list", "--count", "feat", "--not", "main"]), "3");
        let undo = UndoStore::default();
        f.answer(&[false]);
        let r = f.del_branch(&undo, "feat");
        assert!(!r.ok && r.cancelled && r.deleted.is_none(), "{}", r.summary);
        assert_eq!(r.summary, "Delete branch cancelled.");
        let text = f.confirms.borrow()[0].text.clone();
        assert_eq!(text, format!("Delete branch feat ({})?\n\n{}", &tip[..7], lost(3)));
        assert_eq!(f.sha("refs/heads/feat"), tip);
        assert_eq!(f.git(&["config", "branch.feat.remote"]), "origin");

        f.side("one");
        f.answer(&[false]);
        f.del_branch(&undo, "one");
        assert!(f.confirms.borrow()[1].text.ends_with("1 commit will no longer be on any branch. Undo brings it back; after that only via git reflog / git fsck."));

        let r = f.del_branch(&undo, "feat");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert!(f.fails(&["config", "branch.feat.remote"]), "git drops the branch's config");
    }

    // Commits that a tag, a remote-tracking branch, the stash, a detached
    // HEAD or another worktree's HEAD still reach are not lost.
    #[test]
    fn counts_only_commits_nothing_else_reaches() {
        let f = Fixture::new("refedit-count");
        f.bare_origin();
        let lone = f.side("lone");
        assert_eq!(f.count("refs/heads/lone", &lone), Some(1));

        let t = f.side("tagged");
        f.git(&["tag", "keep", &t]);
        assert_eq!(f.count("refs/heads/tagged", &t), Some(0), "tag");

        let p = f.side("pushed");
        f.git(&["push", "-q", "origin", "pushed"]);
        assert_eq!(f.count("refs/heads/pushed", &p), Some(0), "remote-tracking branch");

        f.git(&["switch", "-q", "-c", "stashed"]);
        let s = f.commit("stashed");
        f.write("a.txt", "dirty\n");
        f.git(&["stash", "push", "-q"]);
        f.git(&["switch", "-q", "main"]);
        assert_eq!(f.count("refs/heads/stashed", &s), Some(0), "stash");

        // An older stash (stash@{1}) lives only in refs/stash's reflog, which --all does not read.
        f.git(&["switch", "-q", "-c", "older"]);
        let o = f.commit("older");
        f.write("a.txt", "older\n");
        f.git(&["stash", "push", "-q"]);
        f.git(&["switch", "-q", "main"]);
        f.write("a.txt", "newer\n");
        f.git(&["stash", "push", "-q"]);
        assert_eq!(f.git(&["stash", "list", "--format=%gd"]).lines().count(), 3);
        assert_eq!(f.count("refs/heads/older", &o), Some(0), "an older stash");

        let d = f.side("detached");
        f.git(&["switch", "-q", "--detach", &d]);
        assert_eq!(f.count("refs/heads/detached", &d), Some(0), "detached HEAD");
        f.git(&["switch", "-q", "main"]);
        assert_eq!(f.count("refs/heads/detached", &d), Some(1));

        let w = f.side("worktree");
        let wt = f.dir.join("wt").to_string_lossy().replace('\\', "/");
        f.git(&["worktree", "add", "-q", "--detach", &wt, &w]);
        assert_eq!(f.count("refs/heads/worktree", &w), Some(0), "--all counts a linked worktree's detached HEAD");

        assert_eq!(f.count("refs/heads/lone", "0000000000000000000000000000000000000000"), None, "an error is no count");
        assert!(lost_text(None, "tag").starts_with("\n\nGitKrapao could not count the commits only this tag keeps;"), "the dialog says so");
        assert_eq!(lost_text(Some(0), "branch"), "");
    }

    // The checked-out branch is refused before any question; one checked out
    // in another worktree gets git's own error and stays.
    #[test]
    fn refuses_the_checked_out_branch() {
        let f = Fixture::new("refedit-del-head");
        let undo = UndoStore::default();
        let r = f.del_branch(&undo, "main");
        assert!(!r.ok && !r.cancelled && r.exit_code.is_none() && r.deleted.is_none());
        assert_eq!(r.summary, "The checked-out branch cannot be deleted.");
        assert!(f.confirms.borrow().is_empty());

        let wt = f.dir.join("wt").to_string_lossy().replace('\\', "/");
        f.git(&["worktree", "add", "-q", "-b", "other", &wt]);
        let r = f.del_branch(&undo, "other");
        assert!(!r.ok && !r.cancelled && r.exit_code.is_some() && r.deleted.is_none(), "{}", r.summary);
        assert!(r.summary.contains("worktree"), "{}", r.summary);
        assert_eq!(f.refs(HEADS), "refs/heads/main\nrefs/heads/other");
    }

    // A branch that moves while the dialog is open is not deleted.
    #[test]
    fn a_branch_that_moved_is_not_deleted() {
        let f = Fixture::new("refedit-del-moved");
        let (one, head) = (f.sha("HEAD~1"), f.sha("HEAD"));
        f.git(&["branch", "feat", &one]);
        *f.during.borrow_mut() = Some(Box::new(|f: &Fixture| {
            f.git(&["branch", "-f", "feat", "HEAD"]);
        }));
        let undo = UndoStore::default();
        let r = f.del_branch(&undo, "feat");
        assert!(!r.ok && !r.cancelled && r.deleted.is_none(), "{}", r.summary);
        assert_eq!(r.summary, "Branch feat moved while the dialog was open; nothing was deleted.");
        assert_eq!(f.sha("refs/heads/feat"), head);
    }

    // Names are matched exactly: on Windows git would open the loose file
    // "feat" for "Feat" and delete it.
    #[test]
    fn delete_matches_names_exactly() {
        let f = Fixture::new("refedit-del-case");
        f.git(&["branch", "feat"]);
        f.git(&["tag", "v1"]);
        let undo = UndoStore::default();
        for name in ["Feat", "FEAT", "feat/", ""] {
            let r = f.del_branch(&undo, name);
            assert_eq!(r.summary, format!("Branch {name} does not exist."));
        }
        assert_eq!(f.del_tag(&undo, "V1").summary, "Tag V1 does not exist.");
        assert!(f.confirms.borrow().is_empty() && f.trusted.borrow().is_empty());
        assert_eq!(f.refs(HEADS), "refs/heads/feat\nrefs/heads/main");
        assert_eq!(f.refs(TAGS), "refs/tags/v1");
    }

    /* ---------- delete tag ---------- */

    // Lightweight and annotated; without a remote named origin there is no
    // origin question.
    #[test]
    fn deletes_lightweight_and_annotated_tags() {
        let f = Fixture::new("refedit-tags");
        let one = f.sha("HEAD~1");
        f.git(&["tag", "v1", &one]);
        f.git(&["tag", "-a", "-m", "rel", "v2", &one]);
        f.git(&["remote", "add", "upstream", "../elsewhere.git"]);
        let undo = UndoStore::default();
        let r = f.del_tag(&undo, "v1");
        assert!(r.ok && !r.cancelled, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Deleted tag v1 ({}).", &one[..7]));
        assert_eq!(r.command, format!("git update-ref -d refs/tags/v1 {one}"));
        assert_eq!(f.confirms.borrow().len(), 1, "no origin: no origin question");
        assert_eq!(f.confirms.borrow()[0].text, format!("Delete tag v1 ({})?", &one[..7]));
        let d = r.deleted.expect("Undo entry");
        assert_eq!((d.kind, d.name.as_str(), d.short.as_str(), d.on_origin), (RefKind::Tag, "v1", &one[..7], false));

        let obj = f.sha("refs/tags/v2");
        let r = f.del_tag(&undo, "v2");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.command, format!("git update-ref -d refs/tags/v2 {obj}"));
        assert_eq!(r.summary, format!("Deleted tag v2 ({}).", &one[..7]), "the commit's hash, not the tag object's");
        assert_eq!(f.refs(TAGS), "");

        // A tag that alone keeps a commit gets the warning too.
        let c = f.side("gone");
        f.git(&["tag", "only", &c]);
        f.git(&["branch", "-q", "-D", "gone"]);
        f.answer(&[false]);
        let r = f.del_tag(&undo, "only");
        assert!(r.cancelled && r.summary == "Delete tag cancelled.", "{}", r.summary);
        assert!(f.confirms.borrow()[2].text.ends_with("1 commit will no longer be on any branch. Undo brings it back; after that only via git reflog / git fsck."));
        assert_eq!(f.refs(TAGS), "refs/tags/only");
    }

    // With origin: "Delete on origin" pushes the delete; "Keep on origin" is
    // no cancel (the local tag is gone, Undo offered); a tag origin never had
    // counts as done.
    #[test]
    fn deletes_a_tag_on_origin_when_asked() {
        let f = Fixture::new("refedit-tag-origin");
        let bare = f.bare_origin();
        let head = f.sha("HEAD");
        f.git(&["tag", "v1"]);
        f.git(&["tag", "v2"]);
        f.git(&["tag", "local"]);
        f.git(&["push", "-q", "origin", "v1", "v2"]);
        let on_origin = |t: &str| f.git_in(&bare, &["tag", "-l", t]) == t;
        let undo = UndoStore::default();

        let r = f.del_tag(&undo, "v1");
        assert!(r.ok && !r.cancelled, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Deleted tag v1 ({}) here and on origin.", &head[..7]));
        assert!(r.command.ends_with("git push --no-signed --no-recurse-submodules origin --delete refs/tags/v1"), "{}", r.command);
        let q = f.confirms.borrow()[1].clone();
        assert_eq!((q.tail.as_str(), q.ok.as_str(), q.cancel.as_str()), ("also delete on origin?", "Delete on origin", "Keep on origin"));
        assert!(q.text.contains(&bare.to_string_lossy().replace('\\', "/")), "names the URL: {}", q.text);
        assert!(r.deleted.as_ref().is_some_and(|d| d.on_origin));
        assert!(!on_origin("v1"));

        f.answer(&[true, false]);
        let r = f.del_tag(&undo, "v2");
        assert!(r.ok && !r.cancelled, "{}", r.summary);
        assert_eq!(r.summary, format!("Deleted tag v2 ({}); kept on origin.", &head[..7]));
        assert!(r.deleted.as_ref().is_some_and(|d| !d.on_origin));
        assert!(on_origin("v2"));
        assert_eq!(f.refs("refs/tags/v2"), "");

        let r = f.del_tag(&undo, "local");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Deleted tag local ({}); origin had no tag local.", &head[..7]));
        assert!(r.deleted.as_ref().is_some_and(|d| !d.on_origin), "nothing was deleted on origin");
    }

    // The push runs pre-push: trust first. Never signed, whatever push.gpgSign says.
    #[test]
    fn the_push_needs_trust_and_is_never_signed() {
        let f = Fixture::new("refedit-tag-trust");
        let bare = f.bare_origin();
        f.git(&["tag", "v1"]);
        f.git(&["tag", "v2"]);
        f.git(&["push", "-q", "origin", "v1", "v2"]);
        let hook = f.marker("pre-push-ran");
        f.hook("pre-push", &format!("#!/bin/sh\ntouch '{hook}'\n"));
        let undo = UndoStore::default();
        f.trust.set(false);
        let r = f.del_tag(&undo, "v1");
        assert!(!r.ok && r.cancelled && r.summary == "Delete tag cancelled: the repository was not trusted.", "{}", r.summary);
        assert!(f.trusted.borrow()[0].contains("hook pre-push"), "{}", f.trusted.borrow()[0]);
        assert!(f.confirms.borrow().is_empty());
        assert_eq!(f.refs(TAGS), "refs/tags/v1\nrefs/tags/v2");

        f.trust.set(true);
        let r = f.del_tag(&undo, "v1");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert!(Path::new(&hook).exists(), "trusted: pre-push runs as in a terminal");
        assert_eq!(f.git_in(&bare, &["tag", "-l"]), "v2");

        let gpg = f.marker("gpg-ran");
        let prog = f.dir.join("gpg.sh");
        std::fs::write(&prog, format!("#!/bin/sh\ntouch '{gpg}'\nexit 1\n")).unwrap();
        f.git(&["config", "push.gpgSign", "true"]);
        f.git(&["config", "gpg.program", &prog.to_string_lossy().replace('\\', "/")]);
        let r = f.del_tag(&undo, "v2");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.git_in(&bare, &["tag", "-l"]), "", "deleted on origin");
        assert!(!Path::new(&gpg).exists(), "gpg never ran");
    }

    // A push that fails or hangs: the local tag is gone, so Undo is offered.
    #[test]
    fn a_failed_push_still_offers_undo() {
        let f = Fixture::new("refedit-tag-fail");
        f.bare_origin();
        let head = f.sha("HEAD");
        f.git(&["tag", "v1"]);
        f.git(&["tag", "v2"]);
        f.git(&["push", "-q", "origin", "v1", "v2"]);
        let good = f.git(&["remote", "get-url", "origin"]);
        f.git(&["remote", "set-url", "origin", &f.marker("nope.git")]);
        let undo = UndoStore::default();
        let r = f.del_tag(&undo, "v1");
        assert!(!r.ok && !r.cancelled && r.exit_code.is_some(), "{}", r.summary);
        assert!(r.summary.starts_with(&format!("Deleted tag v1 ({}) here; deleting it on origin failed: ", &head[..7])), "{}", r.summary);
        assert!(r.deleted.as_ref().is_some_and(|d| d.name == "v1" && !d.on_origin));
        assert_eq!(f.refs(TAGS), "refs/tags/v2");

        f.git(&["remote", "set-url", "origin", &good]);
        f.hook("pre-push", "#!/bin/sh\nsleep 6\n");
        f.limit.set(Duration::from_secs(2));
        let r = f.del_tag(&undo, "v2");
        assert!(r.timed_out && !r.ok, "{}", r.summary);
        assert_eq!(r.summary, format!("Deleted tag v2 ({}) here; deleting it on origin took longer than 2 s and was stopped.", &head[..7]));
        assert!(r.deleted.is_some());
        assert_eq!(f.refs(TAGS), "");
    }

    /* ---------- restore ---------- */

    // The branch comes back at its commit with its config (the upstream),
    // once; config of a branch whose name only starts the same is untouched.
    #[test]
    fn restores_a_branch_with_its_upstream() {
        let f = Fixture::new("refedit-restore-branch");
        f.bare_origin();
        f.git(&["switch", "-q", "-c", "feat"]);
        let tip = f.commit("x");
        f.git(&["push", "-q", "-u", "origin", "feat"]);
        f.git(&["config", "branch.feat.note", "-dash"]);
        f.git(&["config", "branch.feat.x.remote", "other"]);
        f.git(&["switch", "-q", "main"]);
        let before = f.git(&["config", "--local", "--get-regexp", r"^branch\.feat\.[^.]+$"]);
        let undo = UndoStore::default();
        let r = f.del_branch(&undo, "feat");
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        let token = r.deleted.unwrap().token;
        assert!(f.fails(&["config", "branch.feat.remote"]));

        let r = f.restore(&undo, KEY, token);
        assert!(r.ok && r.deleted.is_none(), "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Restored branch feat at {}.", &tip[..7]));
        assert!(r.command.starts_with(&format!("git update-ref -m GitKrapao: undo delete refs/heads/feat {tip} {}", "0".repeat(40))), "{}", r.command);
        assert_eq!(f.sha("refs/heads/feat"), tip);
        assert_eq!(f.git(&["rev-parse", "--abbrev-ref", "feat@{u}"]), "origin/feat");
        assert_eq!(f.git(&["config", "--local", "--get-regexp", r"^branch\.feat\.[^.]+$"]), before);
        assert_eq!(f.git(&["config", "--get-all", "branch.feat.x.remote"]), "other");

        let r = f.restore(&undo, KEY, token);
        assert!(!r.ok && r.summary == "Nothing to undo: that delete is no longer remembered.", "{}", r.summary);
    }

    // A tag comes back as the same object (an annotated tag keeps its message).
    #[test]
    fn restores_a_tag_as_the_same_object() {
        let f = Fixture::new("refedit-restore-tag");
        f.git(&["tag", "-a", "-m", "release notes", "v2"]);
        f.git(&["tag", "v1"]);
        let obj = f.sha("refs/tags/v2");
        let undo = UndoStore::default();
        for (name, kind) in [("v2", "tag"), ("v1", "commit")] {
            let before = f.sha(&format!("refs/tags/{name}"));
            let r = f.del_tag(&undo, name);
            assert!(r.ok, "{}: {}", r.summary, r.stderr);
            let r = f.restore(&undo, KEY, r.deleted.unwrap().token);
            assert!(r.ok, "{}: {}", r.summary, r.stderr);
            assert_eq!(f.sha(&format!("refs/tags/{name}")), before);
            assert_eq!(f.git(&["cat-file", "-t", &format!("refs/tags/{name}")]), kind);
        }
        assert_eq!(f.sha("refs/tags/v2"), obj);
        assert_eq!(f.git(&["for-each-ref", "--format=%(contents)", "refs/tags/v2"]), "release notes");
    }

    // A name taken meanwhile (in any case) is not overwritten; nothing
    // changes, the text gives the full hash, and the same token works once
    // the name is free again.
    #[test]
    fn restore_never_overwrites_a_taken_name() {
        let f = Fixture::new("refedit-restore-taken");
        let (one, head) = (f.sha("HEAD~1"), f.sha("HEAD"));
        f.git(&["branch", "feat", &one]);
        f.git(&["tag", "v1", &one]);
        let undo = UndoStore::default();
        let b = f.del_branch(&undo, "feat").deleted.unwrap().token;
        f.git(&["branch", "Feat", &head]);
        let r = f.restore(&undo, KEY, b);
        assert!(!r.ok && r.exit_code.is_none(), "{}", r.summary);
        assert_eq!(r.summary, format!("A branch named Feat already exists, so feat ({one}) was not restored."));
        assert_eq!(f.sha("refs/heads/Feat"), head);
        f.git(&["branch", "-D", "Feat"]);
        let r = f.restore(&undo, KEY, b);
        assert!(r.ok, "the token survived the refusal: {}", r.summary);
        assert_eq!(f.sha("refs/heads/feat"), one);

        let t = f.del_tag(&undo, "v1").deleted.unwrap().token;
        f.git(&["tag", "v1", &head]);
        let r = f.restore(&undo, KEY, t);
        assert_eq!(r.summary, format!("A tag named v1 already exists, so v1 ({one}) was not restored."));
        assert_eq!(f.sha("refs/tags/v1"), head);
    }

    // Trust cancelled: nothing changed, so Undo can be pressed again.
    #[test]
    fn a_cancelled_restore_keeps_the_token() {
        let f = Fixture::new("refedit-restore-cancel");
        let one = f.sha("HEAD~1");
        f.git(&["branch", "feat", &one]);
        let undo = UndoStore::default();
        let t = f.del_branch(&undo, "feat").deleted.unwrap().token;
        f.hook("reference-transaction", "#!/bin/sh
exit 0
");
        f.trust.set(false);
        let r = f.restore(&undo, KEY, t);
        assert!(!r.ok && r.cancelled && r.summary == "Undo delete cancelled: the repository was not trusted.", "{}", r.summary);
        assert_eq!(f.refs(HEADS), "refs/heads/main");
        f.trust.set(true);
        let r = f.restore(&undo, KEY, t);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.sha("refs/heads/feat"), one);
        assert!(!f.restore(&undo, KEY, t).ok, "a restore that wrote the ref uses the token up");
    }

    // A packed "feat" and a loose "FEAT" are one file on Windows: git would
    // delete or rename the wrong tip (and drop FEAT's commits uncounted), so
    // both operations are refused before any question; both refs stay.
    #[test]
    fn refuses_a_branch_with_a_case_sibling() {
        let f = Fixture::new("refedit-case-sibling");
        let (one, head) = (f.sha("HEAD~1"), f.sha("HEAD"));
        f.git(&["branch", "feat", &one]);
        f.git(&["pack-refs", "--all"]);
        f.git(&["update-ref", "refs/heads/FEAT", &head]);
        let refs = f.git(&["for-each-ref", "--format=%(objectname) %(refname)", HEADS]);
        assert!(refs.contains(&format!("{one} refs/heads/feat")) && refs.contains(&format!("{head} refs/heads/FEAT")), "{refs}");
        let undo = UndoStore::default();
        let r = f.del_branch(&undo, "feat");
        assert!(!r.ok && !r.cancelled && r.exit_code.is_none() && r.deleted.is_none(), "{}", r.summary);
        assert_eq!(r.summary, "Another branch, FEAT, differs from feat only in letter case; Windows stores both as one file, so nothing was deleted. Rename or delete one of them in a terminal first.");
        let r = f.del_branch(&undo, "FEAT");
        assert!(!r.ok && r.summary.starts_with("Another branch, feat, differs from FEAT"), "{}", r.summary);
        let r = f.rename("feat", "x");
        assert!(!r.ok && r.exit_code.is_none(), "{}", r.summary);
        assert!(r.summary.starts_with("Another branch, FEAT, differs from feat only in letter case;") && r.summary.contains("nothing was renamed"), "{}", r.summary);
        assert!(f.confirms.borrow().is_empty() && f.trusted.borrow().is_empty());
        assert_eq!(f.git(&["for-each-ref", "--format=%(objectname) %(refname)", HEADS]), refs, "both refs intact");
    }

    // A token works only in the repo that made it, only for the last delete
    // there, and only once; a wrong one leaves the right one usable.
    #[test]
    fn tokens_belong_to_one_repo_and_one_use() {
        let f = Fixture::new("refedit-restore-token");
        let one = f.sha("HEAD~1");
        for b in ["a", "b"] {
            f.git(&["branch", b, &one]);
        }
        let undo = UndoStore::default();
        let ta = f.del_branch(&undo, "a").deleted.unwrap().token;
        let tb = f.del_branch(&undo, "b").deleted.unwrap().token;
        assert_ne!(ta, tb);
        let none = "Nothing to undo: that delete is no longer remembered.";
        assert_eq!(f.restore(&undo, KEY, ta).summary, none, "replaced by the newer delete");
        assert_eq!(f.restore(&undo, "another repo", tb).summary, none);
        assert_eq!(f.restore(&undo, KEY, tb + 100).summary, none);
        assert!(f.restore(&undo, KEY, tb).ok, "still there after the wrong tries");
        assert_eq!(f.restore(&undo, KEY, tb).summary, none, "once");
        assert_eq!(f.refs(HEADS), "refs/heads/b\nrefs/heads/main");
    }

    // After gc removed the object, Undo says so instead of failing in git.
    #[test]
    fn restore_after_gc_explains() {
        let f = Fixture::new("refedit-restore-gc");
        f.git(&["tag", "-a", "-m", "x", "v1"]);
        let undo = UndoStore::default();
        let t = f.del_tag(&undo, "v1").deleted.unwrap().token;
        f.git(&["gc", "-q", "--prune=now"]);
        let r = f.restore(&undo, KEY, t);
        assert!(!r.ok && r.exit_code.is_none(), "{}", r.summary);
        assert_eq!(r.summary, "The tag's object is no longer in the repository (git gc removed it), so v1 was not restored.");
        assert_eq!(f.refs(TAGS), "");
    }
}
