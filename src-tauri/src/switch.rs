//! Switching branches from the branch panel or a graph label. Never forces:
//! when git refuses because uncommitted changes would be overwritten, the
//! user may stash them first (native dialog), and nothing is ever discarded.
//! Before anything runs, the repo gets the same trust check as fetch: a
//! checkout can run hooks, filters and an fsmonitor named in its own config.
//! A remote branch becomes a local branch that tracks it. When a local
//! branch of that name exists, it is checked out and fast-forwarded to the
//! remote one only if it is merely behind (`merge --ff-only`); a local branch
//! with commits of its own is never moved.

use super::fetch::{
    ask_native, assess, git_env, git_error, read_trust_config, sanitize, trust_file, trust_gate, GitResult, RepoLock, BUSY,
};
use super::*;

/// A checkout can run LFS filters and a post-checkout hook, so it gets more
/// time than a fetch; killing it can leave the work tree half updated.
pub(crate) const LIMIT: Duration = Duration::from_secs(300);
const MAX_OUTPUT: usize = 1 << 20;
const MAX_FILES: usize = 20;

#[derive(Debug, PartialEq)]
enum Target {
    Local(String),
    Remote { remote: String, name: String },
}

/// refs/heads/<name>, or refs/remotes/<remote>/<name> for a known remote
/// (the longest match, since remote names may contain "/").
fn parse_target(target: &str, remotes: &[String]) -> Option<Target> {
    if let Some(n) = target.strip_prefix("refs/heads/") {
        return Some(Target::Local(n.to_string()));
    }
    let rest = target.strip_prefix("refs/remotes/")?;
    remotes
        .iter()
        .filter(|r| rest.len() > r.len() + 1 && rest.starts_with(r.as_str()) && rest.as_bytes()[r.len()] == b'/')
        .max_by_key(|r| r.len())
        .map(|r| Target::Remote { remote: r.clone(), name: rest[r.len() + 1..].to_string() })
}

pub(crate) struct SwitchCtx<'a> {
    /// Asks whether to stash and switch; true = stash.
    pub ask: &'a dyn Fn(&str) -> bool,
    /// The trust question shared with fetch; true = go ahead.
    pub trust: &'a dyn Fn(&str) -> bool,
    /// trust.json and its lock (shared with fetch).
    pub store: &'a Path,
    pub store_lock: &'a Mutex<()>,
    pub limit: Duration,
    /// Extra environment for every git call (tests isolate the config).
    pub env: &'a [(&'a str, &'a str)],
    pub pid: Option<&'a Mutex<Option<u32>>>,
}

/// Put before every step, like fetch's --no-auto-maintenance: a merge would
/// otherwise start gc/maintenance (the pre-auto-gc hook, repacking), and
/// submodule.recurse would carry the switch into submodules, whose config
/// and hooks the trust check never sees. These only turn things off, so the
/// Output drawer shows each step without them.
const SAFE_CONFIG: &[&str] = &["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "submodule.recurse=false"];

/// The steps that ran, joined for the Output drawer.
#[derive(Default)]
pub(crate) struct Steps {
    command: Vec<String>,
    stdout: Vec<String>,
    stderr: Vec<String>,
    elapsed: Duration,
}

impl Steps {
    pub(crate) fn run(&mut self, repo: &Path, args: &[&str], cx: &SwitchCtx) -> Result<Limited, String> {
        self.command.push(format!("git {}", args.join(" ")));
        let r = run_limited(git_env(repo, &[SAFE_CONFIG, args].concat(), cx.env), cx.limit, MAX_OUTPUT, cx.pid).map_err(spawn_error)?;
        self.elapsed += r.elapsed;
        let text = |b: &[u8]| String::from_utf8_lossy(b).trim_end().to_string();
        self.stdout.push(text(&r.stdout));
        self.stderr.push(text(&r.stderr));
        Ok(r)
    }

    pub(crate) fn result(self, last: Option<&Limited>, summary: String, cancelled: bool) -> GitResult {
        let join = |v: Vec<String>| v.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
        GitResult {
            ok: last.is_some_and(|r| !r.timed_out && r.status.is_some_and(|s| s.success())),
            timed_out: last.is_some_and(|r| r.timed_out),
            cancelled,
            duration_ms: self.elapsed.as_millis() as u64,
            exit_code: last.and_then(|r| r.status).and_then(|s| s.code()),
            command: self.command.join(" && "),
            stdout: join(self.stdout),
            stderr: join(self.stderr),
            summary,
        }
    }
}

pub(crate) fn succeeded(r: &Limited) -> bool {
    !r.timed_out && r.status.is_some_and(|s| s.success())
}

fn ref_exists(repo: &Path, full: &str, env: &[(&str, &str)]) -> bool {
    git_env(repo, &["show-ref", "--verify", "--quiet", full], env).output().is_ok_and(|o| o.status.success())
}

fn valid_branch(repo: &Path, name: &str, env: &[(&str, &str)]) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name != "HEAD"
        && git_env(repo, &["check-ref-format", "--branch", name], env).output().is_ok_and(|o| o.status.success())
}

/// git refused (switch or fast-forward) because uncommitted or untracked
/// files would be overwritten. Returns the files it named, if so.
fn blocked_files(stderr: &str) -> Option<Vec<String>> {
    let l = stderr.to_ascii_lowercase();
    let blocked = ["checkout", "merge"].iter().any(|op| l.contains(&format!("would be overwritten by {op}")) || l.contains(&format!("would be removed by {op}")));
    if !blocked {
        return None;
    }
    Some(stderr.lines().filter_map(|x| x.strip_prefix('\t')).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
}

/// `action` names the step, e.g. "Switching to feat".
fn stash_text(action: &str, files: &[String]) -> String {
    let mut t = format!("{} would overwrite uncommitted changes in:\n", sanitize(action, 300));
    for f in files.iter().take(MAX_FILES) {
        t += &format!("  {}\n", sanitize(f, 200));
    }
    if files.len() > MAX_FILES {
        t += &format!("  and {} more\n", files.len() - MAX_FILES);
    }
    t += "\nStash all uncommitted changes (untracked files included) and switch? You can bring them back later from STASHES.";
    t
}

fn timeout_text() -> String {
    format!(
        "Switching took longer than {} minutes and was stopped. The work tree may be partly updated; check it with git status.",
        LIMIT.as_secs() / 60
    )
}

pub(crate) fn rev(repo: &Path, r: &str, env: &[(&str, &str)]) -> Option<String> {
    let o = git_env(repo, &["rev-parse", "-q", "--verify", &format!("{r}^{{commit}}")], env).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn is_ancestor(repo: &Path, a: &str, b: &str, env: &[(&str, &str)]) -> bool {
    git_env(repo, &["merge-base", "--is-ancestor", a, b], env).output().is_ok_and(|o| o.status.success())
}

/// How an existing local branch relates to the remote branch it was asked for.
#[derive(PartialEq)]
enum Relation { Same, Behind, Ahead, Diverged }

const STASH_PREFIX: &str = "GitKrapao: before ";

/// Why a step stopped the whole switch.
enum Stop {
    /// Spawning git failed; nothing ran.
    Spawn(String),
    /// The user chose Cancel.
    Cancelled,
    /// git stash failed or timed out (`Limited` of the stash step).
    Stash(Limited, String),
}

impl Steps {
    /// Runs one step. If git refuses because uncommitted changes would be
    /// overwritten, asks (once per switch) whether to stash them, stashes
    /// with untracked files, and runs the step again.
    fn run_or_stash(&mut self, repo: &Path, args: &[&str], action: &str, cx: &SwitchCtx, stashed: &mut Option<String>) -> Result<Limited, Stop> {
        let r = self.run(repo, args, cx).map_err(Stop::Spawn)?;
        if succeeded(&r) || r.timed_out || stashed.is_some() {
            return Ok(r);
        }
        let Some(files) = blocked_files(&String::from_utf8_lossy(&r.stderr)) else { return Ok(r) };
        if !(cx.ask)(&stash_text(action, &files)) {
            return Err(Stop::Cancelled);
        }
        // "Switching to Feature/X" -> "...before switching to Feature/X": only the verb is lowered.
        let mut verb = action.chars();
        let lowered: String = verb.next().map(|c| c.to_lowercase().chain(verb).collect()).unwrap_or_default();
        let message = format!("{STASH_PREFIX}{lowered}");
        let st = self.run(repo, &["stash", "push", "--include-untracked", "-m", &message], cx).map_err(Stop::Spawn)?;
        if !succeeded(&st) {
            let why = if st.timed_out { "it took too long".to_string() } else {
                git_error(&String::from_utf8_lossy(&st.stderr), st.status.and_then(|s| s.code()), "git stash")
            };
            return Err(Stop::Stash(st, why));
        }
        *stashed = Some(message);
        self.run(repo, args, cx).map_err(Stop::Spawn)
    }
}

/// Switches `top` to `target` (a full ref name). The caller holds the repo's RepoLock.
pub(crate) fn switch_in(top: &str, target: &str, cx: &SwitchCtx) -> GitResult {
    let repo = Path::new(top);
    let refused = |summary: String| GitResult::not_run(format!("git switch ({target})"), summary, false);
    let remotes: Vec<String> = match git_env(repo, &["remote"], cx.env).output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
        Err(e) => return refused(spawn_error(e)),
    };
    let Some(t) = parse_target(target, &remotes) else {
        return refused(format!("Not a branch: {target}"));
    };
    let (name, remote) = match &t {
        Target::Local(n) => (n.as_str(), None),
        Target::Remote { remote, name } => (name.as_str(), Some(remote.as_str())),
    };
    if !valid_branch(repo, name, cx.env) || !ref_exists(repo, target, cx.env) {
        return refused(format!("Branch {target} does not exist."));
    }
    let entries = match read_trust_config(repo, cx.env) {
        Ok(e) => e,
        Err(e) => return refused(format!("Could not check this repository's config, so nothing was switched: {e}")),
    };
    if let Err((summary, cancelled)) = trust_gate(top, "Switch branch", &assess(repo, &entries, cx.env), None, cx.store, cx.store_lock, cx.trust) {
        return GitResult::not_run(format!("git switch ({target})"), summary.replace("Switch branch cancelled", "Switch cancelled"), cancelled);
    }
    let local_ref = format!("refs/heads/{name}");
    let create = remote.is_some() && !ref_exists(repo, &local_ref, cx.env);
    let current = git_env(repo, &["symbolic-ref", "-q", "HEAD"], cx.env)
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == local_ref);
    // Remote twin of an existing local branch: may it catch up by fast-forward?
    let relation = match remote {
        Some(_) if !create => {
            let (l, r) = (rev(repo, &local_ref, cx.env), rev(repo, target, cx.env));
            if l == r { Relation::Same }
            else if is_ancestor(repo, &local_ref, target, cx.env) { Relation::Behind }
            else if is_ancestor(repo, target, &local_ref, cx.env) { Relation::Ahead }
            else { Relation::Diverged }
        }
        _ => Relation::Same,
    };
    let short = remote.map(|r| format!("{r}/{name}")).unwrap_or_default();

    let mut steps = Steps::default();
    let mut stashed: Option<String> = None;
    let stash_note = |stashed: &Option<String>, safe: bool| match stashed {
        Some(m) if safe => format!(" Your uncommitted changes are safe in stash@{{0}} (\"{m}\")."),
        Some(m) => format!(" Your uncommitted changes are in stash@{{0}} (\"{m}\")."),
        None => String::new(),
    };
    // A step that did not succeed ends the switch with git's reason.
    let failed = |steps: Steps, r: &Limited, what: &str, stashed: &Option<String>| {
        let why = if r.timed_out { timeout_text() } else { git_error(&String::from_utf8_lossy(&r.stderr), r.status.and_then(|s| s.code()), what) };
        steps.result(Some(r), format!("{why}{}", stash_note(stashed, true)), false)
    };
    let stopped = |steps: Steps, stop: Stop| match stop {
        Stop::Spawn(e) => GitResult::not_run(format!("git switch ({target})"), e, false),
        Stop::Cancelled => steps.result(None, "Switch cancelled: your uncommitted changes were left as they are.".into(), true),
        Stop::Stash(st, why) => steps.result(Some(&st), format!("Could not stash your changes ({why}), so nothing was switched."), false),
    };

    // 1. Check out the branch, unless it already is (a second switch is a no-op).
    let mut last = None;
    if !current {
        // --no-guess: never create a branch from a remote one unless asked to here.
        let args: Vec<&str> = if create { vec!["switch", "-c", name, "--track", target] } else { vec!["switch", "--no-guess", name] };
        let r = match steps.run_or_stash(repo, &args, &format!("Switching to {name}"), cx, &mut stashed) {
            Ok(r) => r,
            Err(stop) => return stopped(steps, stop),
        };
        if !succeeded(&r) {
            return failed(steps, &r, "git switch", &stashed);
        }
        last = Some(r);
    }

    // 2. Catch up with the remote branch when nothing would be lost.
    let mut summary = match (remote, create) {
        (Some(r), true) => format!("Created {name} tracking {r}/{name} and switched to it."),
        _ if current && remote.is_none() => format!("{name} is already checked out."),
        _ => format!("Switched to {name}."),
    };
    if remote.is_some() && !create {
        match relation {
            Relation::Same if current => summary = format!("{name} is already at {short}."),
            Relation::Same => {}
            Relation::Behind => {
                let r = match steps.run_or_stash(repo, &["merge", "--ff-only", target], &format!("Fast-forwarding {name} to {short}"), cx, &mut stashed) {
                    Ok(r) => r,
                    Err(stop) => return stopped(steps, stop),
                };
                if !succeeded(&r) {
                    let lead = if current { String::new() } else { format!("Switched to {name}, but ") };
                    let why = if r.timed_out { timeout_text() } else { git_error(&String::from_utf8_lossy(&r.stderr), r.status.and_then(|s| s.code()), "git merge") };
                    let note = stash_note(&stashed, true);
                    return steps.result(Some(&r), format!("{lead}could not fast-forward it to {short}: {why}{note}"), false);
                }
                summary = if current { format!("Fast-forwarded {name} to {short}.") } else { format!("Switched to {name} and fast-forwarded it to {short}.") };
                last = Some(r);
            }
            Relation::Ahead => {
                summary = format!("{}{name} is ahead of {short}; nothing to fast-forward.",
                    if current { String::new() } else { format!("Switched to {name}. ") })
            }
            Relation::Diverged => {
                summary = format!("{}{name} has commits {short} does not have, so it was not fast-forwarded (pull or merge to combine them).",
                    if current { String::new() } else { format!("Switched to {name}. ") })
            }
        }
    }
    summary += &stash_note(&stashed, false);
    match last {
        Some(r) => steps.result(Some(&r), summary, false),
        // Nothing had to run: report success without a git step.
        None => GitResult { ok: true, ..GitResult::not_run("(no git command needed)".into(), summary, false) },
    }
}

/// Checks out a branch (`target` is a full ref: refs/heads/x or
/// refs/remotes/<remote>/x). Err only for "busy" or a path that is not a
/// repository; every other outcome is a GitResult for the output log.
#[tauri::command]
pub(crate) async fn switch_branch(app: tauri::AppHandle, path: String, target: String, state: State<'_, AppState>) -> Result<GitResult, String> {
    let info = resolve_repo(&state, Path::new(&path))?;
    let dirs = state.dirs.lock().unwrap()[&info.path].clone(); // inserted by resolve_repo
    let lock = RepoLock::take(&state.busy_repos, &dirs.lock_key, "Switch branch", &info.name).ok_or(BUSY)?;
    let store = trust_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let pid = lock.pid();
        let _lock = lock;
        let state = app.state::<AppState>();
        let ask_title = format!("Switch branch — {}: uncommitted changes", info.name);
        let trust_title = format!("Switch branch — {}: trust this repository?", info.name);
        let ask = |text: &str| ask_native(&app, &ask_title, "Stash and switch", text);
        let trust = |text: &str| ask_native(&app, &trust_title, "Switch", text);
        switch_in(&info.path, &target, &SwitchCtx {
            ask: &ask, trust: &trust, store: &store, store_lock: &state.trust_lock, limit: LIMIT, env: &[], pid: Some(&*pid),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A bare remote with main and feat, and a clone ("local") to switch in.
    /// No user config leaks in; the folder is removed on drop. Trust
    /// questions are recorded in `trusted` and answered with `trust`.
    struct Fixture {
        dir: PathBuf,
        global: String,
        trusted: RefCell<Vec<String>>,
        trust: Cell<bool>,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("gitkrapao-switch-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("work")).unwrap();
            let global = dir.join("empty-global").to_string_lossy().replace('\\', "/");
            std::fs::write(&global, "").unwrap();
            let f = Fixture { dir, global, trusted: RefCell::new(vec![]), trust: Cell::new(true) };
            let w = f.dir.join("work");
            f.git(&f.dir, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
            f.git(&w, &["init", "-q", "-b", "main"]);
            f.write(&w, "a.txt", "main\n");
            f.write(&w, "same.txt", "same\n");
            f.git(&w, &["add", "-A"]);
            f.git(&w, &["commit", "-q", "-m", "one"]);
            f.git(&w, &["switch", "-q", "-c", "feat"]);
            f.write(&w, "a.txt", "feat\n");
            f.write(&w, "u.txt", "tracked on feat\n");
            f.git(&w, &["add", "-A"]);
            f.git(&w, &["commit", "-q", "-m", "two"]);
            f.git(&w, &["remote", "add", "origin", "../remote.git"]);
            f.git(&w, &["push", "-q", "origin", "main", "feat"]);
            f.git(&f.dir, &["clone", "-q", "-b", "main", "remote.git", "local"]);
            f
        }
        fn local(&self) -> PathBuf { self.dir.join("local") }
        fn env(&self) -> Vec<(&str, &str)> {
            vec![
                ("GIT_CONFIG_GLOBAL", self.global.as_str()),
                ("GIT_CONFIG_NOSYSTEM", "1"),
                ("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"),
                ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@t"),
            ]
        }
        fn git(&self, dir: &Path, args: &[&str]) -> String {
            let out = git_env(dir, args, &self.env()).output().unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        fn write(&self, dir: &Path, name: &str, body: &str) {
            std::fs::write(dir.join(name), body).unwrap();
        }
        fn read(&self, name: &str) -> String {
            std::fs::read_to_string(self.local().join(name)).unwrap_or_default()
        }
        fn head(&self) -> String { self.git(&self.local(), &["symbolic-ref", "-q", "HEAD"]) }
        fn switch(&self, target: &str, answer: bool, asked: &RefCell<Vec<String>>) -> GitResult {
            self.switch_with(target, answer, asked, Duration::from_secs(60))
        }
        fn store(&self) -> PathBuf { self.dir.join("trust.json") }
        fn switch_with(&self, target: &str, answer: bool, asked: &RefCell<Vec<String>>, limit: Duration) -> GitResult {
            let ask = |t: &str| { asked.borrow_mut().push(t.to_string()); answer };
            let trust = |t: &str| { self.trusted.borrow_mut().push(t.to_string()); self.trust.get() };
            let env = self.env();
            let lock = Mutex::new(());
            let store = self.store();
            switch_in(&self.local().to_string_lossy(), target, &SwitchCtx {
                ask: &ask, trust: &trust, store: &store, store_lock: &lock, limit, env: &env, pid: None,
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    // A remote branch becomes a tracking local branch; later the existing
    // local branch is used as it is, even when the remote one moved on.
    #[test]
    fn switches_local_and_remote_branches() {
        let f = Fixture::new("basic");
        let asked = RefCell::new(vec![]);
        let r = f.switch("refs/remotes/origin/feat", true, &asked);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.head(), "refs/heads/feat");
        assert_eq!(f.git(&f.local(), &["rev-parse", "--abbrev-ref", "feat@{u}"]), "origin/feat");
        assert!(r.summary.starts_with("Created feat tracking origin/feat"), "{}", r.summary);
        assert_eq!(r.command, "git switch -c feat --track refs/remotes/origin/feat");

        let r = f.switch("refs/heads/main", true, &asked);
        assert!(r.ok && r.summary == "Switched to main.", "{}", r.summary);
        assert_eq!(f.head(), "refs/heads/main");

        let w = f.dir.join("work");
        f.git(&w, &["switch", "-q", "feat"]);
        f.git(&w, &["commit", "-q", "--allow-empty", "-m", "three"]);
        f.git(&w, &["push", "-q", "origin", "feat"]);
        f.git(&f.local(), &["fetch", "-q"]);
        let remote = f.git(&f.local(), &["rev-parse", "refs/remotes/origin/feat"]);
        let r = f.switch("refs/remotes/origin/feat", true, &asked);
        assert!(r.ok && r.summary == "Switched to feat and fast-forwarded it to origin/feat.", "{}", r.summary);
        assert_eq!(f.head(), "refs/heads/feat");
        assert_eq!(f.git(&f.local(), &["rev-parse", "HEAD"]), remote, "a local branch that is only behind catches up");
        assert!(asked.borrow().is_empty(), "a clean switch asks nothing");
    }

    // The remote twin of the checked-out branch: no second `git switch`
    // (it was a no-op "develop to develop"), just the fast-forward. A local
    // branch with its own commits is never moved; blocked changes can be
    // stashed as with a switch.
    #[test]
    fn fast_forwards_only_when_nothing_is_lost() {
        let f = Fixture::new("ff");
        let asked = RefCell::new(vec![]);
        let w = f.dir.join("work");
        f.git(&w, &["switch", "-q", "main"]);
        f.write(&w, "a.txt", "main 2\n");
        f.git(&w, &["commit", "-q", "-am", "main two"]);
        f.git(&w, &["push", "-q", "origin", "main"]);
        f.git(&f.local(), &["fetch", "-q"]);
        let remote = f.git(&f.local(), &["rev-parse", "refs/remotes/origin/main"]);

        let r = f.switch("refs/remotes/origin/main", true, &asked);
        assert!(r.ok && r.summary == "Fast-forwarded main to origin/main.", "{}", r.summary);
        assert_eq!(r.command, "git merge --ff-only refs/remotes/origin/main", "no switch to the branch already checked out");
        assert_eq!(f.git(&f.local(), &["rev-parse", "HEAD"]), remote);
        let r = f.switch("refs/remotes/origin/main", true, &asked);
        assert!(r.ok && r.summary == "main is already at origin/main.", "{}", r.summary);

        // Diverged: the local commit stays, nothing is moved.
        f.git(&f.local(), &["commit", "-q", "--allow-empty", "-m", "local only"]);
        f.write(&w, "a.txt", "main 3\n");
        f.git(&w, &["commit", "-q", "-am", "main three"]);
        f.git(&w, &["push", "-q", "origin", "main"]);
        f.git(&f.local(), &["fetch", "-q"]);
        let mine = f.git(&f.local(), &["rev-parse", "HEAD"]);
        let r = f.switch("refs/remotes/origin/main", true, &asked);
        assert!(r.ok && r.summary.contains("not fast-forwarded"), "{}", r.summary);
        assert_eq!(f.git(&f.local(), &["rev-parse", "HEAD"]), mine);

        // Behind, with an edit the fast-forward would overwrite: asked, stashed, moved.
        f.git(&f.local(), &["reset", "-q", "--hard", "HEAD~1"]);
        f.write(&f.local(), "a.txt", "my edit\n");
        let r = f.switch("refs/remotes/origin/main", true, &asked);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(asked.borrow().len(), 1);
        assert!(asked.borrow()[0].starts_with("Fast-forwarding main to origin/main would overwrite"), "{}", asked.borrow()[0]);
        assert!(r.summary.contains("stash@{0}"), "{}", r.summary);
        assert_eq!(f.git(&f.local(), &["show", "stash@{0}:a.txt"]), "my edit");
        assert_eq!(f.git(&f.local(), &["rev-parse", "HEAD"]), f.git(&f.local(), &["rev-parse", "refs/remotes/origin/main"]));
    }

    // Like fetch's --no-auto-maintenance: no step starts gc/maintenance (a
    // pre-auto-gc hook, repacking), whatever the repo's config says.
    #[test]
    fn runs_no_auto_maintenance() {
        let f = Fixture::new("gc");
        let asked = RefCell::new(vec![]);
        let w = f.dir.join("work");
        let l = f.local();
        f.git(&w, &["switch", "-q", "main"]);
        f.git(&w, &["commit", "-q", "--allow-empty", "-m", "main two"]);
        f.git(&w, &["push", "-q", "origin", "main"]);
        f.git(&l, &["fetch", "-q"]);
        // Four small packs: gc --auto is then due.
        for n in 0..4 {
            f.write(&l, "blob", &format!("{n}
"));
            let id = f.git(&l, &["hash-object", "-w", "blob"]);
            f.git(&l, &["update-ref", &format!("refs/tmp/{n}"), &id]);
            f.git(&l, &["repack", "-q"]);
        }
        std::fs::remove_file(l.join("blob")).unwrap();
        for (k, v) in [("gc.auto", "1"), ("gc.autoPackLimit", "1"), ("gc.autoDetach", "false"),
                       ("maintenance.autoDetach", "false"), ("submodule.recurse", "true")] {
            f.git(&l, &["config", k, v]);
        }
        let marker = f.dir.join("gc-ran").to_string_lossy().replace('\\', "/");
        std::fs::write(l.join(".git").join("hooks").join("pre-auto-gc"), format!("#!/bin/sh\ntouch '{marker}'\nexit 1\n")).unwrap();

        let r = f.switch("refs/remotes/origin/main", true, &asked);
        assert!(r.ok && r.summary == "Fast-forwarded main to origin/main.", "{}: {}", r.summary, r.stderr);
        assert!(!Path::new(&marker).exists(), "no auto maintenance after the fast-forward");
        assert!(f.trusted.borrow().iter().any(|t| t.contains("hook pre-auto-gc")), "the hook is part of the trust question");
        assert_eq!(r.command, "git merge --ff-only refs/remotes/origin/main", "the drawer shows the step without the overrides");
    }

    // submodule.recurse in the repo's config is overridden: a submodule's
    // config and hooks are not trust-checked.
    #[test]
    fn does_not_recurse_into_submodules() {
        let f = Fixture::new("sub");
        let asked = RefCell::new(vec![]);
        let file = ["-c", "protocol.file.allow=always"];
        let sub = f.dir.join("subw");
        std::fs::create_dir_all(&sub).unwrap();
        f.git(&sub, &["init", "-q", "-b", "main"]);
        f.git(&sub, &["commit", "-q", "--allow-empty", "-m", "s1"]);
        let s1 = f.git(&sub, &["rev-parse", "HEAD"]);
        f.git(&sub, &["commit", "-q", "--allow-empty", "-m", "s2"]);
        let url = sub.to_string_lossy().replace('\\', "/");

        let w = f.dir.join("work");
        f.git(&w, &["switch", "-q", "main"]);
        f.git(&w, &[&file[..], &["submodule", "add", "-q", &url, "sub"]].concat());
        f.git(&w.join("sub"), &["checkout", "-q", &s1]);
        f.git(&w, &["commit", "-q", "-am", "add sub"]);
        f.git(&w, &["switch", "-q", "-c", "next"]);
        f.git(&w.join("sub"), &["checkout", "-q", "main"]);
        f.git(&w, &["commit", "-q", "-am", "sub moves"]);
        f.git(&w, &["push", "-q", "origin", "main", "next"]);

        let l = f.local();
        f.git(&l, &["pull", "-q", "--ff-only"]);
        f.git(&l, &[&file[..], &["submodule", "update", "-q", "--init"]].concat());
        f.git(&l, &["config", "submodule.recurse", "true"]);
        let marker = f.dir.join("sub-hook-ran").to_string_lossy().replace('\\', "/");
        std::fs::write(l.join(".git").join("modules").join("sub").join("hooks").join("post-checkout"),
                       format!("#!/bin/sh\ntouch '{marker}'\n")).unwrap();

        let r = f.switch("refs/remotes/origin/next", true, &asked);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.head(), "refs/heads/next");
        assert!(!Path::new(&marker).exists(), "the submodule was not checked out, so its hook never ran");
        assert_eq!(f.git(&l.join("sub"), &["rev-parse", "HEAD"]), s1, "the submodule stays where it was");
    }

    // Changes git can carry over go along; changes it would overwrite stop
    // the switch, and the user chooses: Cancel keeps everything, Stash keeps
    // everything in a stash (untracked files too) and switches.
    #[test]
    fn uncommitted_changes_are_never_lost() {
        let f = Fixture::new("dirty");
        let asked = RefCell::new(vec![]);
        f.git(&f.local(), &["switch", "-q", "feat"]);
        f.write(&f.local(), "same.txt", "edited\n");
        let r = f.switch("refs/heads/main", true, &asked);
        assert!(r.ok && asked.borrow().is_empty(), "{}", r.summary);
        assert_eq!(f.read("same.txt"), "edited\n", "a change git can carry goes along");

        f.write(&f.local(), "a.txt", "my edit\n");
        let r = f.switch("refs/heads/feat", false, &asked);
        assert!(!r.ok && r.cancelled, "{}", r.summary);
        assert_eq!(asked.borrow().len(), 1);
        assert!(asked.borrow()[0].contains("  a.txt\n"), "{}", asked.borrow()[0]);
        assert_eq!(f.head(), "refs/heads/main");
        assert_eq!(f.read("a.txt"), "my edit\n");
        assert_eq!(f.git(&f.local(), &["stash", "list"]), "", "cancel stashes nothing");

        let r = f.switch("refs/heads/feat", true, &asked);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert_eq!(f.head(), "refs/heads/feat");
        assert!(r.summary.contains("stash@{0}"), "{}", r.summary);
        assert!(r.command.contains("git stash push --include-untracked"), "{}", r.command);
        assert!(f.git(&f.local(), &["stash", "list"]).contains("GitKrapao: before switching to feat"));
        assert_eq!(f.git(&f.local(), &["show", "stash@{0}:a.txt"]), "my edit");
        assert_eq!(f.git(&f.local(), &["show", "stash@{0}:same.txt"]), "edited", "every change is stashed");

        // An untracked file the target branch tracks.
        f.git(&f.local(), &["switch", "-q", "main"]);
        f.write(&f.local(), "u.txt", "untracked, mine\n");
        let r = f.switch("refs/heads/feat", true, &asked);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert!(asked.borrow().last().unwrap().contains("u.txt"));
        assert_eq!(f.git(&f.local(), &["show", "stash@{0}^3:u.txt"]), "untracked, mine");
    }

    // Programs from the repo's own config or hooks (here a post-checkout
    // hook and a smudge filter) need the same trust as fetch, asked before
    // anything runs; the answer is shared with fetch through trust.json.
    #[test]
    fn asks_before_running_the_repos_programs() {
        let f = Fixture::new("trust");
        let asked = RefCell::new(vec![]);
        let r = f.switch("refs/remotes/origin/feat", true, &asked);
        assert!(r.ok && f.trusted.borrow().is_empty(), "a repo with nothing to run asks nothing: {}", r.summary);

        let marker = f.dir.join("hook-ran").to_string_lossy().replace('\\', "/");
        let hook = f.local().join(".git").join("hooks").join("post-checkout");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{marker}'\n")).unwrap();
        f.trust.set(false);
        let r = f.switch("refs/heads/main", true, &asked);
        assert!(!r.ok && r.cancelled && r.summary == "Switch cancelled: the repository was not trusted.", "{}", r.summary);
        assert_eq!(f.head(), "refs/heads/feat", "nothing switched");
        assert!(!Path::new(&marker).exists(), "the hook never ran");
        let t = f.trusted.borrow()[0].clone();
        assert!(t.starts_with("Switch branch in this repository?") && t.contains("hook post-checkout"), "{t}");
        assert!(t.ends_with("Continue only if you trust this repository.") && !t.contains("fetch"), "says what is asked: {t}");
        assert!(!t.contains('\\'), "paths with one kind of slash: {t}");

        f.trust.set(true);
        assert!(f.switch("refs/heads/main", true, &asked).ok);
        assert!(Path::new(&marker).exists(), "trusted: the hook runs as in a terminal");
        assert!(f.switch("refs/heads/feat", true, &asked).ok);
        assert_eq!(f.trusted.borrow().len(), 2, "approved once, not asked again");

        f.git(&f.local(), &["config", "filter.x.smudge", "cat"]);
        assert!(f.switch("refs/heads/main", true, &asked).ok);
        assert_eq!(f.trusted.borrow().len(), 3, "new risky config asks again");
        assert!(f.trusted.borrow()[2].contains("filter.x.smudge = cat"));

        // An approval made by fetch covers switch too: same store, same hash.
        f.git(&f.local(), &["config", "filter.x.smudge", "cat -"]);
        let lock = Mutex::new(());
        let env = f.env();
        let yes = |_: &str| true;
        let local = f.local();
        let r = crate::fetch::fetch_in(&local.to_string_lossy(), &local.join(".git"), &crate::fetch::FetchCtx {
            store: &f.store(), store_lock: &lock, ask: &yes, limit: Duration::from_secs(60), env: &env, pid: None,
        });
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert!(f.switch("refs/heads/feat", true, &asked).ok);
        assert_eq!(f.trusted.borrow().len(), 3, "trusted by fetch: switch does not ask");
    }

    #[test]
    fn refuses_what_is_not_a_branch() {
        let f = Fixture::new("bad");
        let asked = RefCell::new(vec![]);
        f.git(&f.local(), &["tag", "v1"]);
        for t in ["refs/tags/v1", "refs/heads/nope", "refs/heads/-x", "refs/heads/a..b", "refs/remotes/origin/HEAD", "refs/remotes/nosuch/feat", "HEAD", "--orphan"] {
            let r = f.switch(t, true, &asked);
            assert!(!r.ok && r.exit_code.is_none() && !r.summary.is_empty(), "{t}: {}", r.summary);
        }
        assert_eq!(f.head(), "refs/heads/main");
        assert!(asked.borrow().is_empty());
    }

    // A hung checkout (here a slow post-checkout hook) is stopped and says
    // the work tree may be partly updated.
    #[test]
    fn timeout_is_reported() {
        let f = Fixture::new("slow");
        std::fs::write(f.local().join(".git").join("hooks").join("post-checkout"), "#!/bin/sh\nsleep 5\n").unwrap();
        let asked = RefCell::new(vec![]);
        let r = f.switch_with("refs/remotes/origin/feat", true, &asked, Duration::from_secs(1));
        assert!(r.timed_out && !r.ok && r.summary.contains("git status"), "{}", r.summary);
    }

    #[test]
    fn parses_targets() {
        let remotes = vec!["origin".to_string(), "team/a".to_string(), "team".to_string()];
        assert_eq!(parse_target("refs/heads/x/y", &remotes), Some(Target::Local("x/y".into())));
        assert_eq!(parse_target("refs/remotes/origin/x", &remotes), Some(Target::Remote { remote: "origin".into(), name: "x".into() }));
        assert_eq!(parse_target("refs/remotes/team/a/x", &remotes), Some(Target::Remote { remote: "team/a".into(), name: "x".into() }));
        assert_eq!(parse_target("refs/remotes/team/b", &remotes), Some(Target::Remote { remote: "team".into(), name: "b".into() }));
        assert_eq!(parse_target("refs/remotes/other/x", &remotes), None);
        assert_eq!(parse_target("refs/tags/x", &remotes), None);
        let err = "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n\tb c.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\n";
        assert_eq!(blocked_files(err), Some(vec!["a.txt".to_string(), "b c.txt".to_string()]));
        assert_eq!(blocked_files("fatal: invalid reference: x"), None);
        let many: Vec<String> = (0..25).map(|i| format!("f{i}")).collect();
        let t = stash_text("feat\u{202e}", &many);
        assert!(t.contains("feat\\u{202e}") && t.contains("f19\n") && !t.contains("f20\n") && t.contains("and 5 more"));
    }
}
