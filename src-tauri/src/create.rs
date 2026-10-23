//! Creating a branch or a tag at a commit, from the graph's right-click menu.
//! Never forces: a name already taken is refused and no ref is ever moved or
//! deleted. A new ref runs the repo's reference-transaction hook, so the repo
//! gets the same trust check as fetch and switch before anything runs. A new
//! branch can be checked out right away through switch's own steps (the stash
//! question included).

use super::fetch::{
    ask_native, assess, git_env, git_error, read_trust_config, sanitize, trust_file, trust_gate, GitResult, RepoLock, BUSY,
};
use super::refedit::UndoStore;
use super::switch::{rev, succeeded, switch_in, Steps, SwitchCtx, LIMIT};
use super::*;

/// What to create at the commit.
pub(crate) enum NewRef<'a> {
    /// `checkout`: switch to the new branch afterwards.
    Branch { checkout: bool },
    /// A message makes it an annotated tag; none (or only spaces) a lightweight one.
    Tag { message: Option<&'a str> },
}

/// Plain check-ref-format on the full ref name, for branches too: `--branch`
/// reads "@{-1}" as the previous branch (and so would `git branch`). A
/// leading "-" would be an option; "HEAD" and "@" alone mean HEAD to git.
pub(crate) fn valid_name(repo: &Path, full: &str, name: &str, env: &[(&str, &str)]) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name != "HEAD"
        && name != "@"
        && git_env(repo, &["check-ref-format", full], env).output().is_ok_and(|o| o.status.success())
}

/// Names Windows cannot store, the same rules as nameProblem in refname.ts.
/// Refs are files there (also for a teammate who fetches the ref): `" < > |`,
/// a part ending in "." (Windows drops it, so "a./b" is the file of "a/b")
/// and device names such as con, nul, aux/x and com1.txt.
pub(crate) fn windows_unsafe(name: &str) -> bool {
    let device = |part: &str| {
        let stem = part.split('.').next().unwrap_or(part).to_ascii_lowercase();
        matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    };
    name.contains(['"', '<', '>', '|']) || name.split('/').any(|p| p.ends_with('.') || device(p))
}

/// The ref under `ns` (refs/heads/ or refs/tags/) that `name` would clash
/// with, compared without case (any letter, not only ASCII): names that
/// differ only in case are one file on Windows and macOS, and next to a
/// packed ref git itself lets such a name in, which in effect moves that ref.
pub(crate) fn taken(repo: &Path, ns: &str, name: &str, env: &[(&str, &str)]) -> Result<Option<String>, String> {
    let out = git_env(repo, &["for-each-ref", "--format=%(refname)", ns], env).output().map_err(spawn_error)?;
    if !out.status.success() {
        return Err(git_error(&String::from_utf8_lossy(&out.stderr), out.status.code(), "git for-each-ref"));
    }
    let want = fold_case(&format!("{ns}{name}"));
    Ok(String::from_utf8_lossy(&out.stdout).lines().find(|r| fold_case(r) == want).map(|r| r[ns.len()..].to_string()))
}

/// The form two ref names are compared in when letter case must not count
/// (every letter, not only ASCII). Used by `taken` and by refedit's checks.
pub(crate) fn fold_case(s: &str) -> String {
    s.to_lowercase()
}

/// The new branch and the switch to it, as one Output entry. The branch exists
/// either way, so only a switch that failed makes it a failure; one the user
/// cancelled is no "cancelled" result (that means nothing changed).
fn then_switch(created: GitResult, switched: GitResult) -> GitResult {
    let join = |a: String, b: String| [a, b].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
    GitResult {
        ok: switched.ok || switched.cancelled,
        timed_out: switched.timed_out,
        cancelled: false,
        duration_ms: created.duration_ms + switched.duration_ms,
        exit_code: switched.exit_code,
        command: format!("{} && {}", created.command, switched.command),
        stdout: join(created.stdout, switched.stdout),
        stderr: join(created.stderr, switched.stderr),
        summary: format!("{} {}", created.summary, switched.summary),
        deleted: None,
    }
}

/// Creates `name` at the commit `at` (its hash) in `top`. The caller holds the repo's RepoLock.
pub(crate) fn create_in(top: &str, what: NewRef, name: &str, at: &str, cx: &SwitchCtx) -> GitResult {
    let repo = Path::new(top);
    let (op, noun, nouns, ns) = match what {
        NewRef::Branch { .. } => ("Create branch", "branch", "branches", "refs/heads/"),
        NewRef::Tag { .. } => ("Create tag", "tag", "tags", "refs/tags/"),
    };
    let refused = |summary: String, cancelled: bool| GitResult::not_run(format!("git {noun} ({})", sanitize(name, 120)), summary, cancelled);
    if !valid_name(repo, &format!("{ns}{name}"), name, cx.env) {
        return refused(format!("Not a valid {noun} name: \"{}\"", sanitize(name, 120)), false);
    }
    if windows_unsafe(name) {
        return refused(format!("Not a valid {noun} name: \"{}\" (Windows cannot store it as a file)", sanitize(name, 120)), false);
    }
    match taken(repo, ns, name, cx.env) {
        Ok(None) => {}
        Ok(Some(other)) => return refused(format!("A {noun} named {other} already exists."), false),
        Err(e) => return refused(format!("Could not read the existing {nouns}, so nothing was created: {e}"), false),
    }
    // A full hash only: a short hex string can be a ref name too (a branch
    // "abcd1234"), and nothing that looks like an option may reach git.
    let hex = matches!(at.len(), 40 | 64) && at.bytes().all(|b| b.is_ascii_hexdigit());
    let Some(commit) = hex.then(|| rev(repo, at, cx.env)).flatten() else {
        return refused(format!("Not a commit in this repository: {}", sanitize(at, 80)), false);
    };
    let entries = match read_trust_config(repo, cx.env) {
        Ok(e) => e,
        Err(e) => return refused(format!("Could not check this repository's config, so nothing was created: {e}"), false),
    };
    if let Err((summary, cancelled)) = trust_gate(top, op, &assess(repo, &entries, cx.env), None, cx.store, cx.store_lock, cx.trust) {
        return refused(summary, cancelled);
    }

    let message = match what {
        NewRef::Tag { message } => message.map(str::trim).filter(|m| !m.is_empty()),
        NewRef::Branch { .. } => None,
    };
    // Tags: --no-sign, since signing runs gpg.program, which the repo's own
    // config can name; --cleanup=whitespace, since the default would drop
    // message lines that start with "#".
    let args: Vec<&str> = match (&what, message) {
        (NewRef::Branch { .. }, _) => vec!["branch", name, &commit],
        (NewRef::Tag { .. }, Some(m)) => vec!["tag", "-a", "--no-sign", "--cleanup=whitespace", "-m", m, name, &commit],
        (NewRef::Tag { .. }, None) => vec!["tag", "--no-sign", name, &commit],
    };
    let mut steps = Steps::default();
    let r = match steps.run(repo, &args, cx) {
        Ok(r) => r,
        Err(e) => return refused(e, false),
    };
    if !succeeded(&r) {
        let why = if r.timed_out {
            format!("Creating the {noun} took longer than {} s and was stopped.", cx.limit.as_secs())
        } else {
            git_error(&String::from_utf8_lossy(&r.stderr), r.status.and_then(|s| s.code()), &format!("git {noun}"))
        };
        return steps.result(Some(&r), why, false);
    }
    let created = steps.result(Some(&r), format!("Created {noun} {name} at {}.", &commit[..7]), false);
    match what {
        NewRef::Branch { checkout: true } => then_switch(created, switch_in(top, &format!("refs/heads/{name}"), cx)),
        _ => created,
    }
}

/// What `run_op` hands an operation: switch's context (trust and stash
/// questions, limit, PID slot), a confirm dialog, and the repo's Undo slot.
pub(crate) struct OpCtx<'a> {
    pub cx: SwitchCtx<'a>,
    /// (title tail, OK label, Cancel label, text); true for OK. The native
    /// dialog's title is "{op} — {repo}: {tail}".
    pub confirm: &'a dyn Fn(&str, &str, &str, &str) -> bool,
    pub undo: &'a UndoStore,
    /// GitDirs::lock_key of the repo: an Undo token only works there.
    pub key: &'a str,
}

/// Runs `f` under the repo's lock, with the native dialogs (their titles
/// name the repo, as the tab asking may not be the active one). Shared by
/// create, rename, delete and undo; `op` is e.g. "Create branch", and its
/// first word labels the trust dialog's OK button.
pub(crate) async fn run_op(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    op: &'static str,
    path: String,
    f: impl FnOnce(&str, &OpCtx) -> GitResult + Send + 'static,
) -> Result<GitResult, String> {
    let info = resolve_repo(&state, Path::new(&path))?;
    let dirs = state.dirs.lock().unwrap()[&info.path].clone(); // inserted by resolve_repo
    let lock = RepoLock::take(&state.busy_repos, &dirs.lock_key, op, &info.name).ok_or(BUSY)?;
    let store = trust_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let pid = lock.pid();
        let _lock = lock;
        let state = app.state::<AppState>();
        let title = |tail: &str| format!("{op} — {}: {tail}", info.name);
        let (ask_title, trust_title) = (title("uncommitted changes"), title("trust this repository?"));
        let verb = op.split(' ').next().unwrap_or(op);
        let ask = |text: &str| ask_native(&app, &ask_title, "Stash and switch", "Cancel", text);
        let trust = |text: &str| ask_native(&app, &trust_title, verb, "Cancel", text);
        let confirm = |tail: &str, ok: &str, cancel: &str, text: &str| ask_native(&app, &title(tail), ok, cancel, text);
        f(&info.path, &OpCtx {
            cx: SwitchCtx { ask: &ask, trust: &trust, store: &store, store_lock: &state.trust_lock, limit: LIMIT, env: &[], pid: Some(&*pid) },
            confirm: &confirm,
            undo: &state.undo,
            key: &dirs.lock_key,
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Creates branch `name` at the commit `at` (a hash) and, with `checkout`,
/// switches to it. Err only for "busy" or a path that is not a repository;
/// every other outcome is a GitResult for the output log.
#[tauri::command]
pub(crate) async fn create_branch(
    app: tauri::AppHandle,
    path: String,
    name: String,
    at: String,
    checkout: bool,
    state: State<'_, AppState>,
) -> Result<GitResult, String> {
    run_op(app, state, "Create branch", path, move |top, o| create_in(top, NewRef::Branch { checkout }, &name, &at, &o.cx)).await
}

/// Creates tag `name` at the commit `at` (a hash): annotated when `message`
/// has text, else lightweight. Errors as for create_branch.
#[tauri::command]
pub(crate) async fn create_tag(
    app: tauri::AppHandle,
    path: String,
    name: String,
    at: String,
    message: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitResult, String> {
    run_op(app, state, "Create tag", path, move |top, o| create_in(top, NewRef::Tag { message: message.as_deref() }, &name, &at, &o.cx)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::Fixture;

    impl Fixture {
        fn create(&self, what: NewRef, name: &str, at: &str) -> GitResult {
            self.op(&UndoStore::default(), "k", |o| create_in(&self.top(), what, name, at, &o.cx))
        }
    }

    const BRANCH: NewRef<'static> = NewRef::Branch { checkout: false };
    const SWITCH: NewRef<'static> = NewRef::Branch { checkout: true };
    const LIGHT: NewRef<'static> = NewRef::Tag { message: None };

    // The branch starts at the commit asked for; HEAD and the work tree stay
    // where they were, and the branch tracks nothing.
    #[test]
    fn creates_a_branch_where_asked() {
        let f = Fixture::new("create-branch");
        let one = f.sha("HEAD~1");
        let r = f.create(BRANCH, "feat/x", &one);
        assert!(r.ok && !r.cancelled, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Created branch feat/x at {}.", &one[..7]));
        assert_eq!(r.command, format!("git branch feat/x {one}"));
        assert_eq!(f.sha("refs/heads/feat/x"), one);
        assert_eq!(f.head(), "refs/heads/main");
        assert_eq!(f.read("a.txt"), "two\n");
        assert!(f.fails(&["rev-parse", "--abbrev-ref", "feat/x@{u}"]), "no upstream");
        assert!(f.trusted.borrow().is_empty() && f.asked.borrow().is_empty(), "nothing to ask");
    }

    // Thai names go through to git and back unchanged.
    #[test]
    fn thai_names_work() {
        let f = Fixture::new("create-thai");
        let head = f.sha("HEAD");
        let r = f.create(SWITCH, "ฟีเจอร์/ใหม่", &head);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.head(), "refs/heads/ฟีเจอร์/ใหม่");
        assert!(r.summary.starts_with("Created branch ฟีเจอร์/ใหม่ at "), "{}", r.summary);
        let r = f.create(NewRef::Tag { message: Some("รุ่นแรก") }, "รุ่น-1", &head);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.git(&["for-each-ref", "--format=%(contents)", "refs/tags/รุ่น-1"]), "รุ่นแรก");
        assert_eq!(f.create(BRANCH, "ฟีเจอร์/ใหม่", &head).summary, "A branch named ฟีเจอร์/ใหม่ already exists.");
    }

    // Create and switch: one Output entry with both steps.
    #[test]
    fn creates_a_branch_and_switches_to_it() {
        let f = Fixture::new("create-checkout");
        let one = f.sha("HEAD~1");
        let r = f.create(SWITCH, "feat", &one);
        assert!(r.ok && !r.cancelled, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Created branch feat at {}. Switched to feat.", &one[..7]));
        assert_eq!(r.command, format!("git branch feat {one} && git switch --no-guess feat"));
        assert_eq!(f.head(), "refs/heads/feat");
        assert_eq!(f.read("a.txt"), "one\n");
    }

    // A switch blocked by uncommitted changes asks to stash, as switch does.
    // Cancel keeps the new branch and the changes, and is not a "cancelled"
    // result: the branch was created. Stash switches with the changes stashed.
    #[test]
    fn a_blocked_switch_keeps_the_new_branch() {
        let f = Fixture::new("create-blocked");
        let one = f.sha("HEAD~1");
        f.write("a.txt", "mine\n");
        f.stash.set(false);
        let r = f.create(SWITCH, "feat", &one);
        assert!(r.ok && !r.cancelled, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Created branch feat at {}. Switch cancelled: your uncommitted changes were left as they are.", &one[..7]));
        assert_eq!(f.asked.borrow().len(), 1);
        assert!(f.asked.borrow()[0].starts_with("Switching to feat would overwrite"), "{}", f.asked.borrow()[0]);
        assert_eq!(f.sha("refs/heads/feat"), one, "the branch stays");
        assert_eq!(f.head(), "refs/heads/main");
        assert_eq!(f.read("a.txt"), "mine\n");
        assert_eq!(f.git(&["stash", "list"]), "");

        f.stash.set(true);
        let r = f.create(SWITCH, "feat2", &one);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert!(r.summary.starts_with(&format!("Created branch feat2 at {}. Switched to feat2.", &one[..7])), "{}", r.summary);
        assert!(r.summary.contains("stash@{0}"), "{}", r.summary);
        assert_eq!(f.head(), "refs/heads/feat2");
        assert_eq!(f.git(&["show", "stash@{0}:a.txt"]), "mine");
    }

    // No message: a lightweight tag (the commit itself). A message: an
    // annotated tag object that keeps the text as typed, even a leading "#".
    #[test]
    fn creates_lightweight_and_annotated_tags() {
        let f = Fixture::new("create-tags");
        let one = f.sha("HEAD~1");
        let r = f.create(LIGHT, "v1", &one);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Created tag v1 at {}.", &one[..7]));
        assert_eq!(r.command, format!("git tag --no-sign v1 {one}"));
        assert_eq!(f.git(&["cat-file", "-t", "v1"]), "commit");
        assert_eq!(f.sha("v1"), one);

        let r = f.create(NewRef::Tag { message: Some("  #42 release \n") }, "v2", &one);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(r.summary, format!("Created tag v2 at {}.", &one[..7]));
        assert_eq!(f.git(&["cat-file", "-t", "v2"]), "tag");
        assert_eq!(f.git(&["for-each-ref", "--format=%(contents)", "refs/tags/v2"]), "#42 release");
        assert_eq!(f.sha("v2^{commit}"), one);

        let r = f.create(NewRef::Tag { message: Some(" \n ") }, "v3", &one);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.git(&["cat-file", "-t", "v3"]), "commit", "a blank message makes a lightweight tag");
        assert_eq!(f.head(), "refs/heads/main");
    }

    // Signing runs gpg.program, which the repo's own config can name (and the
    // trust check does not list): tags are never signed, whatever tag.gpgSign says.
    #[test]
    fn never_signs_a_tag() {
        let f = Fixture::new("create-sign");
        let marker = f.dir.join("gpg-ran").to_string_lossy().replace('\\', "/");
        let gpg = f.dir.join("gpg.sh");
        std::fs::write(&gpg, format!("#!/bin/sh\ntouch '{marker}'\nexit 1\n")).unwrap();
        f.git(&["config", "tag.gpgSign", "true"]);
        // Signs a tag that has a message but no -a, even with --no-sign.
        f.git(&["config", "tag.forceSignAnnotated", "true"]);
        f.git(&["config", "gpg.program", &gpg.to_string_lossy().replace('\\', "/")]);
        let head = f.sha("HEAD");
        let r = f.create(LIGHT, "v1", &head);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.git(&["cat-file", "-t", "v1"]), "commit");
        let r = f.create(NewRef::Tag { message: Some("release") }, "v2", &head);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert!(!f.git(&["cat-file", "-p", "v2"]).contains("-----BEGIN"), "no signature");
        assert!(!Path::new(&marker).exists(), "gpg never ran");
    }

    // A name git rejects, or one already taken (also in another case: one
    // file on Windows), is refused before anything runs; nothing changes.
    // "@{-1}" is no name: `git branch` would make it the previous branch.
    #[test]
    fn refuses_bad_or_taken_names() {
        let f = Fixture::new("create-names");
        let head = f.sha("HEAD");
        f.git(&["tag", "v1"]);
        f.git(&["switch", "-q", "-c", "old"]);
        f.git(&["switch", "-q", "main"]);
        f.git(&["branch", "-q", "-D", "old"]);
        for name in ["main", "Main", "", "-x", "HEAD", "@", "@{-1}", "a..b", "a b", "x.lock", "x/", ".x", "a@{u}", "a\nb"] {
            let r = f.create(BRANCH, name, &head);
            assert!(!r.ok && !r.cancelled && r.exit_code.is_none() && !r.summary.is_empty(), "{name:?}: {}", r.summary);
        }
        assert_eq!(f.create(BRANCH, "Main", &head).summary, "A branch named main already exists.");
        assert_eq!(f.create(SWITCH, "main", &head).summary, "A branch named main already exists.");
        for name in ["v1", "V1", "", "-x", "HEAD", "@", "a..b", "a b"] {
            let r = f.create(LIGHT, name, &head);
            assert!(!r.ok && !r.cancelled && r.exit_code.is_none() && !r.summary.is_empty(), "{name:?}: {}", r.summary);
        }
        assert_eq!(f.create(LIGHT, "V1", &head).summary, "A tag named v1 already exists.");
        assert_eq!(f.refs("refs/heads/"), "refs/heads/main");
        assert_eq!(f.refs("refs/tags/"), "refs/tags/v1");
        assert!(f.trusted.borrow().is_empty() && f.asked.borrow().is_empty());
    }

    // Refs are files on Windows, so names it cannot store are refused here
    // too, as in refname.ts: "a./b" would be the file of a packed "a/b"
    // (Windows drops a trailing "."), which in effect moves that ref.
    #[test]
    fn refuses_names_windows_cannot_store() {
        let f = Fixture::new("create-windows");
        let (one, head) = (f.sha("HEAD~1"), f.sha("HEAD"));
        f.git(&["branch", "a/b", &one]);
        f.git(&["tag", "v1/x", &one]);
        f.git(&["pack-refs", "--all"]);
        for name in ["a./b", "x./y", "a\"b", "a<b", "a>b", "a|b", "con", "NUL", "aux/x", "feat/lpt9", "com1.txt", "Prn.x/y"] {
            let r = f.create(BRANCH, name, &head);
            assert!(!r.ok && !r.cancelled && r.exit_code.is_none(), "{name:?}: {}", r.summary);
            assert!(r.summary.contains("Windows"), "{name:?}: {}", r.summary);
        }
        for name in ["v1./x", "con", "lpt1.tar"] {
            let r = f.create(LIGHT, name, &head);
            assert!(!r.ok && r.exit_code.is_none() && r.summary.contains("Windows"), "{name:?}: {}", r.summary);
        }
        assert_eq!(f.refs("refs/heads/"), "refs/heads/a/b\nrefs/heads/main");
        assert_eq!(f.refs("refs/tags/"), "refs/tags/v1/x");
        assert_eq!(f.sha("refs/heads/a/b"), one, "a/b did not move");
        // Only whole parts are device names.
        for name in ["console", "com10", "a/con-x", "auxiliary", "v1.x/y", "lpt"] {
            let r = f.create(BRANCH, name, &head);
            assert!(r.ok, "{name:?}: {}", r.summary);
        }
    }

    // Packed refs (after a clone or gc) are no files, so git itself lets
    // "Feat" in next to a packed "feat"; on Windows the new file then stands
    // in for the old ref, which in effect moves it. Any case, not only ASCII.
    #[test]
    fn a_packed_ref_in_another_case_is_taken() {
        let f = Fixture::new("create-packed");
        let (one, head) = (f.sha("HEAD~1"), f.sha("HEAD"));
        for (kind, name) in [("branch", "feat"), ("branch", "ärger"), ("tag", "v1"), ("tag", "réléase")] {
            f.git(&[kind, name, &one]);
        }
        f.git(&["pack-refs", "--all"]);
        for (what, name, taken) in [(BRANCH, "Feat", "feat"), (BRANCH, "Ärger", "ärger"), (LIGHT, "V1", "v1"), (LIGHT, "RÉLÉASE", "réléase")] {
            let noun = if matches!(what, NewRef::Branch { .. }) { "branch" } else { "tag" };
            let r = f.create(what, name, &head);
            assert_eq!(r.summary, format!("A {noun} named {taken} already exists."), "{name}");
            assert!(!r.ok && r.exit_code.is_none());
        }
        for name in ["refs/heads/feat", "refs/heads/ärger", "refs/tags/v1", "refs/tags/réléase"] {
            assert_eq!(f.sha(name), one, "{name} did not move");
        }
    }

    // `at` must be the full hash of a commit in the repo: never a ref name
    // (a short hex one can be: a branch called "abcd1234"), nor anything git
    // could read as an option.
    #[test]
    fn refuses_what_is_not_a_commit() {
        let f = Fixture::new("create-at");
        let tree = f.sha("HEAD^{tree}");
        let head = f.sha("HEAD");
        f.git(&["branch", "abcd1234", "HEAD~1"]);
        for at in ["", "-x", "--orphan", "HEAD", "main", "zz", "abcd1234", &head[..7], "0000000000000000000000000000000000000000", tree.as_str()] {
            let r = f.create(BRANCH, "feat", at);
            assert!(!r.ok && !r.cancelled && r.exit_code.is_none() && !r.summary.is_empty(), "{at:?}: {}", r.summary);
            let r = f.create(LIGHT, "v1", at);
            assert!(!r.ok && r.exit_code.is_none(), "{at:?}: {}", r.summary);
        }
        assert_eq!(f.refs("refs/heads/"), "refs/heads/abcd1234\nrefs/heads/main");
        assert_eq!(f.refs("refs/tags/"), "");
    }

    // One Output entry for both steps; the exit code is the switch's own, so
    // a switch that never ran says "not run", not "exit 0".
    #[test]
    fn merges_the_create_and_switch_results() {
        let created = GitResult { ok: true, exit_code: Some(0), stderr: "made".into(), duration_ms: 5,
            ..GitResult::not_run("git branch x abc".into(), "Created branch x at abc1234.", false) };
        let refused = GitResult::not_run("git switch (refs/heads/x)".into(), "Not a branch.", false);
        let r = then_switch(created, refused);
        assert!(!r.ok && !r.cancelled && r.exit_code.is_none(), "a switch that did not run is a failure without an exit code");
        assert_eq!(r.command, "git branch x abc && git switch (refs/heads/x)");
        assert_eq!(r.summary, "Created branch x at abc1234. Not a branch.");
        assert_eq!((r.stderr.as_str(), r.duration_ms), ("made", 5));

        let created = GitResult { ok: true, exit_code: Some(0), ..GitResult::not_run("git branch x abc".into(), "Created.", false) };
        let r = then_switch(created, GitResult::not_run("git switch --no-guess x".into(), "Switch cancelled.", true));
        assert!(r.ok && !r.cancelled, "cancelled after the branch was made: done, and not \"nothing changed\"");
    }

    // A new ref runs the repo's reference-transaction hook: asked before
    // anything runs, with the same store as fetch and switch.
    #[test]
    fn asks_before_running_the_repos_hooks() {
        let f = Fixture::new("create-trust");
        let head = f.sha("HEAD");
        let marker = f.dir.join("hook-ran").to_string_lossy().replace('\\', "/");
        std::fs::write(f.repo().join(".git").join("hooks").join("reference-transaction"), format!("#!/bin/sh\ntouch '{marker}'\n")).unwrap();
        f.trust.set(false);
        let r = f.create(BRANCH, "feat", &head);
        assert!(!r.ok && r.cancelled && r.summary == "Create branch cancelled: the repository was not trusted.", "{}", r.summary);
        assert_eq!(f.refs("refs/heads/"), "refs/heads/main", "nothing created");
        assert!(!Path::new(&marker).exists(), "the hook never ran");
        let t = f.trusted.borrow()[0].clone();
        assert!(t.starts_with("Create branch in this repository?") && t.contains("hook reference-transaction"), "{t}");

        f.trust.set(true);
        assert!(f.create(BRANCH, "feat", &head).ok);
        assert!(Path::new(&marker).exists(), "trusted: the hook runs as in a terminal");
        let r = f.create(LIGHT, "v1", &head);
        assert!(r.ok, "{}", r.summary);
        assert_eq!(f.trusted.borrow().len(), 2, "approved once, not asked again");
    }

    // A hook that hangs is stopped at the time limit.
    #[test]
    fn a_hung_hook_is_stopped() {
        let f = Fixture::new("create-slow");
        let head = f.sha("HEAD");
        std::fs::write(f.repo().join(".git").join("hooks").join("reference-transaction"), "#!/bin/sh\nsleep 5\n").unwrap();
        f.limit.set(Duration::from_secs(1));
        let r = f.create(BRANCH, "feat", &head);
        assert!(r.timed_out && !r.ok && r.summary.starts_with("Creating the branch took longer than"), "{}", r.summary);
    }
}
