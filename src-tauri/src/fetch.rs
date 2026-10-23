//! `git fetch` from the toolbar. Safety rules (see CLAUDE.md, "Fetch"):
//! - only flags that cannot delete or overwrite local branches or tags;
//! - a per-repo lock, so polls and history loads never read half-updated refs;
//! - the repo's own config can name programs that fetch runs (ssh command,
//!   credential helper, hooks...), so those are shown in a native dialog the
//!   webview cannot answer, and approvals live in the app data dir;
//! - refspecs that would write outside refs/remotes/ are refused;
//! - 90 s limit, then the whole process tree is killed.

use super::refedit::DeletedRef;
use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

/// Error text of a fetch, history load or sync refused while a fetch runs.
pub(crate) const BUSY: &str = "busy";
const LIMIT: Duration = Duration::from_secs(90);
/// fetch output kept per stream (git prints one line per updated ref).
const MAX_OUTPUT: usize = 1 << 20;
/// Everything here only turns behaviour off: --no-prune-tags beats
/// fetch.pruneTags / remote.*.pruneTags, --no-auto-maintenance keeps gc (and
/// its pre-auto-gc hook) from running, and submodules have their own config
/// that is not checked.
const FETCH_ARGS: [&str; 6] = ["fetch", "--all", "--prune", "--no-prune-tags", "--no-auto-maintenance", "--no-recurse-submodules"];

/// Config keys that make fetch or a checkout (switch, fast-forward, stash)
/// run a program or connect somewhere else, plus fetch/mirror, which could
/// write outside refs/remotes/. Read from every scope; the trust check keeps
/// the repo's own (local/worktree) entries. One list for both operations,
/// so trusting a repo once covers both.
const TRUST_CONFIG_RE: &str = r"^(core\.(sshcommand|gitproxy|askpass|hookspath|alternaterefscommand|fsmonitor)|credential\..*helper|remote\..*\.(uploadpack|receivepack|vcs|fetch|mirror)|protocol\.(.+\.)?allow|url\..*\.insteadof|hook\..*|filter\..*\.(smudge|clean|process))$";
/// Hooks fetch (reference-transaction), a checkout, fast-forward or stash, or
/// the push that deletes a tag on origin (pre-push) runs.
const TRUST_HOOKS: [&str; 6] = ["reference-transaction", "post-checkout", "post-merge", "post-index-change", "pre-auto-gc", "pre-push"];

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
/// Outcome of an operation (fetch, switch, create, rename, delete, undo), shown in the Output drawer.
pub(crate) struct GitResult {
    pub ok: bool,
    pub timed_out: bool,
    /// The user answered Cancel in the native dialog; nothing changed.
    pub cancelled: bool,
    #[cfg_attr(test, ts(type = "number"))]
    pub duration_ms: u64,
    /// None when git did not run or was killed.
    pub exit_code: Option<i32>,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    /// One line for the banner; stderr keeps git's own words.
    pub summary: String,
    /// Set when a branch or tag was deleted here: the UI offers Undo with its token.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub deleted: Option<DeletedRef>,
}

impl GitResult {
    /// git did not run (or not to the end): refused, cancelled, or a step before it failed.
    pub(crate) fn not_run(command: String, summary: impl Into<String>, cancelled: bool) -> Self {
        GitResult {
            ok: false,
            timed_out: false,
            cancelled,
            duration_ms: 0,
            exit_code: None,
            command,
            stdout: String::new(),
            stderr: String::new(),
            summary: summary.into(),
            deleted: None,
        }
    }

    fn refused(summary: impl Into<String>, cancelled: bool) -> Self {
        Self::not_run(command_text(), summary, cancelled)
    }
}

fn command_text() -> String {
    format!("git {}", FETCH_ARGS.join(" "))
}

/* ---------- lock ---------- */

/// One running operation (fetch, switch, create): what it is, which repo (for dialogs), and the
/// slot its git process publishes its PID into (so closing the app can stop it).
pub(crate) struct RunningOp {
    /// "Fetch" or "Switch branch".
    pub kind: &'static str,
    pub name: String,
    pub pid: Arc<Mutex<Option<u32>>>,
}

/// Running operations by `GitDirs::lock_key`: at most one per repo, any number
/// across repos.
pub(crate) type OpRegistry = Arc<Mutex<HashMap<String, RunningOp>>>;

/// Marks a repo as busy (fetch, switch, create); dropping it (also on a panic) frees the repo.
pub(crate) struct RepoLock {
    reg: OpRegistry,
    key: String,
    pid: Arc<Mutex<Option<u32>>>,
}

impl RepoLock {
    pub(crate) fn take(reg: &OpRegistry, key: &str, kind: &'static str, name: &str) -> Option<Self> {
        use std::collections::hash_map::Entry;
        let pid = Arc::new(Mutex::new(None));
        match reg.lock().unwrap_or_else(|e| e.into_inner()).entry(key.to_string()) {
            Entry::Occupied(_) => None,
            Entry::Vacant(v) => {
                v.insert(RunningOp { kind, name: name.to_string(), pid: pid.clone() });
                Some(RepoLock { reg: reg.clone(), key: key.to_string(), pid })
            }
        }
    }

    /// The slot to hand to `FetchCtx.pid` / `SwitchCtx.pid`.
    pub(crate) fn pid(&self) -> Arc<Mutex<Option<u32>>> {
        self.pid.clone()
    }
}

impl Drop for RepoLock {
    fn drop(&mut self) {
        // A poisoned lock still holds the map; never leave the repo marked.
        self.reg.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
    }
}

pub(crate) fn is_busy(state: &AppState, dirs: &GitDirs) -> bool {
    state.busy_repos.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&dirs.lock_key)
}

/// PIDs of every git process a running operation has started.
pub(crate) fn running_pids(reg: &OpRegistry) -> Vec<u32> {
    let ops = reg.lock().unwrap_or_else(|e| e.into_inner());
    ops.values().filter_map(|op| *op.pid.lock().unwrap_or_else(|e| e.into_inner())).collect()
}

/// Body text for the "close now?" dialog, or None when nothing is running.
pub(crate) fn close_warning(reg: &OpRegistry) -> Option<String> {
    let ops = reg.lock().unwrap_or_else(|e| e.into_inner());
    let mut lines: Vec<String> = ops.values().map(|op| format!("{} — {}", op.kind, op.name)).collect();
    if lines.is_empty() {
        return None;
    }
    lines.sort();
    Some(format!(
        "{}

Closing now stops them. A branch switch that is stopped can leave the working tree half updated; check git status in that repository afterwards.",
        lines.join("
")
    ))
}

/* ---------- reading config ---------- */

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ConfigEntry {
    /// system, global, local, worktree or command.
    scope: String,
    /// Section and key are lowercase; a subsection keeps its case.
    key: String,
    /// None for a key written without "=" (a boolean true).
    value: Option<String>,
}

/// `git config --show-scope -z --get-regexp` output: `scope\0key\nvalue\0`,
/// and `scope\0key\0` for a key without a value.
fn parse_config_z(out: &[u8]) -> Vec<ConfigEntry> {
    let text = String::from_utf8_lossy(out);
    let mut parts = text.split('\0');
    let mut list = Vec::new();
    while let (Some(scope), Some(kv)) = (parts.next(), parts.next()) {
        if scope.is_empty() { break }
        let (key, value) = match kv.split_once('\n') {
            Some((k, v)) => (k, Some(v.to_string())),
            None => (kv, None),
        };
        list.push(ConfigEntry { scope: scope.into(), key: key.into(), value });
    }
    list
}

pub(crate) fn git_env(repo: &Path, args: &[&str], env: &[(&str, &str)]) -> Command {
    let mut cmd = git_command(repo, args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd
}

/// Exit code 1 means no key matched; anything else but 0 (a broken config or
/// include) refuses the fetch, since the check could not see everything.
pub(crate) fn read_trust_config(repo: &Path, env: &[(&str, &str)]) -> Result<Vec<ConfigEntry>, String> {
    let out = git_env(repo, &["config", "--show-scope", "--includes", "-z", "--get-regexp", TRUST_CONFIG_RE], env)
        .output()
        .map_err(spawn_error)?;
    match out.status.code() {
        Some(0) => Ok(parse_config_z(&out.stdout)),
        Some(1) => Ok(vec![]),
        code => {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if msg.is_empty() { format!("git config exited with {code:?}.") } else { msg })
        }
    }
}

fn is_own(e: &ConfigEntry) -> bool {
    e.scope == "local" || e.scope == "worktree"
}

/// remote.<name>.fetch / .mirror are checked by `refspec_problem`, and
/// core.fsmonitor set to true/false is git's own monitor (no program); every
/// other matched key from the repo's own config needs the user's trust.
fn risky_entries(entries: &[ConfigEntry]) -> Vec<&ConfigEntry> {
    let builtin = |e: &ConfigEntry| {
        e.key == "core.fsmonitor"
            && matches!(e.value.as_deref().map(|v| v.trim().to_ascii_lowercase()).as_deref(), None | Some("" | "true" | "false" | "yes" | "no" | "on" | "off" | "1" | "0"))
    };
    entries
        .iter()
        .filter(|e| is_own(e) && !builtin(e) && !(e.key.starts_with("remote.") && (e.key.ends_with(".fetch") || e.key.ends_with(".mirror"))))
        .collect()
}

fn git_bool(v: Option<&str>) -> bool {
    match v {
        None => true,
        Some(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "false" | "no" | "off" | "0"),
    }
}

/// Why fetch --prune could delete or overwrite a local branch or tag, if it
/// could: a refspec whose destination is outside refs/remotes/, a mirror
/// remote, or a remote defined in the old remotes/ or branches/ files (which
/// `git config` cannot see; branches/ writes into refs/heads).
fn refspec_problem(entries: &[ConfigEntry], common_dir: &Path) -> Option<String> {
    for e in entries {
        let Some(rest) = e.key.strip_prefix("remote.") else { continue };
        if let Some(name) = rest.strip_suffix(".fetch") {
            let v = e.value.as_deref().unwrap_or("").trim();
            if v.starts_with('^') { continue }
            let Some((_, dst)) = v.trim_start_matches('+').split_once(':') else { continue };
            let dst = dst.trim();
            if !dst.is_empty() && !dst.starts_with("refs/remotes/") {
                return Some(format!(
                    "Remote \"{name}\" fetches into {dst}, outside refs/remotes/, so fetching could overwrite or delete local branches or tags. GitKrapao will not fetch this repository."
                ));
            }
        } else if let Some(name) = rest.strip_suffix(".mirror") {
            if git_bool(e.value.as_deref()) {
                return Some(format!(
                    "Remote \"{name}\" is a mirror, so fetching could overwrite or delete local branches and tags. GitKrapao will not fetch this repository."
                ));
            }
        }
    }
    for dir in ["remotes", "branches"] {
        let has_file = std::fs::read_dir(common_dir.join(dir))
            .map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.path().is_file()))
            .unwrap_or(false);
        if has_file {
            return Some(format!(
                "This repository defines remotes in the old .git/{dir}/ folder, which can fetch straight into local branches. GitKrapao will not fetch it."
            ));
        }
    }
    None
}

/// The TRUST_HOOKS present in the hooks folder (Git for Windows also runs
/// a .exe). Skipped when core.hooksPath comes from the user's own global or
/// system config. Returns (dialog line, hash line) per hook.
fn hook_entries(repo: &Path, entries: &[ConfigEntry], env: &[(&str, &str)]) -> Vec<(String, String)> {
    let hooks_path = entries.iter().filter(|e| e.key == "core.hookspath" && e.scope != "command").last();
    if hooks_path.is_some_and(|e| !is_own(e)) {
        return vec![];
    }
    let Ok(out) = git_env(repo, &["rev-parse", "--path-format=absolute", "--git-path", "hooks"], env).output() else { return vec![] };
    let dir = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if !out.status.success() || dir.as_os_str().is_empty() {
        return vec![];
    }
    TRUST_HOOKS
        .iter()
        .flat_map(|h| [h.to_string(), format!("{h}.exe")])
        .filter_map(|name| {
            let p = dir.join(&name);
            let body = std::fs::read(&p).ok()?;
            let path = p.to_string_lossy();
            // The hash keeps the path as it was, so earlier approvals still hold.
            Some((format!("hook {name} ({})", shown_path(&path)), format!("hook\t{path}\t{:x}", Sha256::digest(&body))))
        })
        .collect()
}

/// What the repo's own config and hooks would run: dialog lines, and the
/// hash the user's approval is stored under (None when there is nothing).
pub(crate) struct Risk {
    shown: Vec<String>,
    hash: Option<String>,
}

pub(crate) fn assess(repo: &Path, entries: &[ConfigEntry], env: &[(&str, &str)]) -> Risk {
    let mut shown = Vec::new();
    let mut hashed = Vec::new();
    for e in risky_entries(entries) {
        let v = e.value.as_deref();
        shown.push(match v {
            Some(v) => format!("{} = {}", sanitize(&e.key, 120), sanitize(v, 200)),
            None => sanitize(&e.key, 120),
        });
        hashed.push(format!("{}\t{}\t{}", e.scope, e.key, v.unwrap_or("")));
    }
    for (show, hash) in hook_entries(repo, entries, env) {
        shown.push(sanitize(&show, 300));
        hashed.push(hash);
    }
    let hash = (!hashed.is_empty()).then(|| trust_hash(&hashed));
    Risk { shown, hash }
}

/// The trust gate shared by fetch, switch and create (one store, one hash per repo).
/// `op` names the operation in the dialog and in the cancel message.
/// Fetch passes its remotes: a repo it has never fetched in is asked about
/// once even with nothing risky, since fetching contacts those remotes.
/// Err carries the summary and whether the user cancelled.
pub(crate) fn trust_gate(
    top: &str,
    op: &str,
    risk: &Risk,
    fetch_remotes: Option<&[(String, String)]>,
    store: &Path,
    store_lock: &Mutex<()>,
    ask: &dyn Fn(&str) -> bool,
) -> Result<(), (String, bool)> {
    let key = path_key(Path::new(top));
    let known = {
        let _g = store_lock.lock().unwrap();
        load_store(store).repos.get(&key).cloned().unwrap_or_default()
    };
    let new_repo = fetch_remotes.is_some() && !known.fetch;
    let changed = risk.hash.is_some() && known.config != risk.hash;
    if !(new_repo || changed) {
        return Ok(());
    }
    // The store lock is not held while the dialog is open.
    let text = trust_text(top, op, new_repo, fetch_remotes.unwrap_or(&[]), if changed { &risk.shown } else { &[] });
    if !ask(&text) {
        return Err((format!("{op} cancelled: the repository was not trusted."), true));
    }
    update_store(store, store_lock, &key, |t| {
        if fetch_remotes.is_some() {
            t.fetch = true;
        }
        if risk.hash.is_some() {
            t.config = risk.hash.clone();
        }
    })
    .map_err(|e| (format!("Could not save your answer: {e}"), false))
}

/* ---------- trust store ---------- */

#[derive(Serialize, Deserialize, Default)]
struct TrustStore {
    repos: BTreeMap<String, TrustEntry>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct TrustEntry {
    /// The user picked the repo or allowed fetching in it.
    fetch: bool,
    /// SHA-256 of the risky config the user approved.
    config: Option<String>,
}

/// SHA-256 of the sorted lines, so the order git lists keys in never matters.
fn trust_hash(lines: &[String]) -> String {
    let mut v: Vec<&str> = lines.iter().map(String::as_str).collect();
    v.sort_unstable();
    format!("{:x}", Sha256::digest(v.join("\n").as_bytes()))
}

/// A missing or unreadable file is an empty store: nothing is trusted.
fn load_store(path: &Path) -> TrustStore {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Written to a temp file first, so a crash never leaves half a file.
fn save_store(path: &Path, store: &TrustStore) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn update_store(path: &Path, lock: &Mutex<()>, key: &str, f: impl FnOnce(&mut TrustEntry)) -> Result<(), String> {
    let _g = lock.lock().unwrap();
    let mut store = load_store(path);
    f(store.repos.entry(key.to_string()).or_default());
    save_store(path, &store)
}

pub(crate) fn trust_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("trust.json"))
}

/// Marks a repo the user picked in the native folder dialog as allowed.
pub(crate) fn allow_repo(app: &tauri::AppHandle, state: &AppState, top: &str) {
    if let Ok(file) = trust_file(app) {
        let _ = update_store(&file, &state.trust_lock, &path_key(Path::new(top)), |e| e.fetch = true);
    }
}

/* ---------- dialog text ---------- */

/// Control and bidi/format characters are shown as escapes, so a value cannot
/// fake extra lines or reorder text in the dialog. Cut at `max` characters.
pub(crate) fn sanitize(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i == max {
            out.push('…');
            break;
        }
        let hidden = matches!(c as u32, 0x200B..=0x200F | 0x202A..=0x202E | 0x2066..=0x2069 | 0x061C | 0xFEFF);
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() || hidden => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

const MAX_LINES: usize = 20;

/// Windows paths in the dialog with one kind of slash, as git prints them.
fn shown_path(p: &str) -> String {
    if cfg!(windows) { p.replace('\\', "/") } else { p.to_string() }
}

fn trust_text(path: &str, op: &str, new_repo: bool, remotes: &[(String, String)], risky: &[String]) -> String {
    let mut t = String::new();
    if new_repo {
        t += "GitKrapao has not fetched in this repository before:\n";
    } else {
        t += &format!("{op} in this repository?\n");
    }
    t += &format!("{}\n", sanitize(&shown_path(path), 300));
    if new_repo {
        t += "\nFetch contacts:\n";
        for (name, url) in remotes.iter().take(MAX_LINES) {
            t += &format!("  {}  {}\n", sanitize(name, 60), sanitize(url, 200));
        }
        if remotes.len() > MAX_LINES {
            t += &format!("  and {} more\n", remotes.len() - MAX_LINES);
        }
    }
    if !risky.is_empty() {
        t += "\nIts own config or hooks can run programs or change where git connects:\n";
        for line in risky.iter().take(MAX_LINES) {
            t += &format!("  {line}\n");
        }
        if risky.len() > MAX_LINES {
            t += &format!("  and {} more\n", risky.len() - MAX_LINES);
        }
        t += "\nContinue only if you trust this repository.";
    }
    t
}

/* ---------- result text ---------- */

/// `git remote -v` shows URLs after insteadOf rewriting.
fn remote_urls(repo: &Path, env: &[(&str, &str)]) -> Result<Vec<(String, String)>, String> {
    let out = git_env(repo, &["remote", "-v"], env).output().map_err(spawn_error)?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() { "git remote exited with an error.".into() } else { msg });
    }
    let mut list: Vec<(String, String)> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some(l) = line.strip_suffix(" (fetch)") else { continue };
        if let Some((name, url)) = l.split_once('\t') {
            list.push((name.to_string(), url.to_string()));
        }
    }
    Ok(list)
}

/// ssh://, git+ssh://, ssh+git:// or scp-style host:path (but not C:\…).
fn is_ssh_url(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    if ["ssh://", "git+ssh://", "ssh+git://"].iter().any(|p| u.starts_with(p)) {
        return true;
    }
    if u.contains("://") {
        return false;
    }
    match u.find(':') {
        Some(1) => false, // drive letter
        Some(i) => !u[..i].contains('/') && !u[..i].contains('\\'),
        None => false,
    }
}

/// One line for the banner. git's own stderr is kept next to it.
fn fetch_summary(ok: bool, timed_out: bool, code: Option<i32>, stderr: &str, ssh: bool) -> String {
    if timed_out {
        let mut s = format!("Fetch took longer than {} seconds and was stopped.", LIMIT.as_secs());
        if ssh {
            s += " The remote uses SSH: make sure ssh-agent is running and your key is added (ssh-add).";
        }
        return s;
    }
    if ok {
        let n = stderr
            .lines()
            .filter(|l| l.starts_with(' ') && (l.contains("->") || l.contains("[deleted]")))
            .count();
        return match n {
            0 => "Fetched: already up to date.".into(),
            1 => "Fetched: 1 ref updated.".into(),
            n => format!("Fetched: {n} refs updated."),
        };
    }
    let l = stderr.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| l.contains(w));
    if has(&["authentication failed", "could not read username", "could not read password", "invalid username or password", "permission denied (publickey", "access denied"]) {
        "Authentication failed. Sign in to the remote (Git Credential Manager, or ssh-add for SSH keys), then fetch again.".into()
    } else if has(&["host key verification failed"]) {
        "SSH does not know this host yet. Connect once from a terminal to accept its key, then fetch again.".into()
    } else if has(&["could not resolve host", "could not resolve hostname", "network is unreachable", "failed to connect", "connection timed out", "connection refused", "no route to host"]) {
        "Could not reach the remote. Check your network connection.".into()
    } else {
        git_error(stderr, code, "git fetch")
    }
}

/// A failure line shared by fetch, switch and create: a left-over lock file, else
/// git's last fatal:/error: line, else the exit code.
pub(crate) fn git_error(stderr: &str, code: Option<i32>, what: &str) -> String {
    let l = stderr.to_ascii_lowercase();
    if l.contains(".lock") && (l.contains("unable to create") || l.contains("file exists")) {
        return "Another git process is updating this repository (a .lock file exists). Wait for it to finish, then try again.".into();
    }
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find_map(|x| x.strip_prefix("fatal:").or_else(|| x.strip_prefix("error:")))
        .map(|x| x.trim().to_string())
        .unwrap_or_else(|| format!("{what} failed (exit code {}).", code.map_or("unknown".into(), |c| c.to_string())))
}

/* ---------- fetch ---------- */

pub(crate) struct FetchCtx<'a> {
    /// trust.json
    pub store: &'a Path,
    pub store_lock: &'a Mutex<()>,
    /// Shows the trust question; true = fetch.
    pub ask: &'a dyn Fn(&str) -> bool,
    pub limit: Duration,
    /// Extra environment for every git call (tests isolate the config).
    pub env: &'a [(&'a str, &'a str)],
    pub pid: Option<&'a Mutex<Option<u32>>>,
}

/// Runs the checks, asks when needed, then fetches. The caller holds the
/// repo's RepoLock. `top` is the resolved toplevel.
pub(crate) fn fetch_in(top: &str, common_dir: &Path, cx: &FetchCtx) -> GitResult {
    let repo = Path::new(top);
    let remotes = match remote_urls(repo, cx.env) {
        Ok(r) => r,
        Err(e) => return GitResult::refused(e, false),
    };
    if remotes.is_empty() {
        return GitResult::refused("This repository has no remotes configured.", false);
    }
    let entries = match read_trust_config(repo, cx.env) {
        Ok(e) => e,
        Err(e) => return GitResult::refused(format!("Could not check this repository's config, so it was not fetched: {e}"), false),
    };
    if let Some(why) = refspec_problem(&entries, common_dir) {
        return GitResult::refused(why, false);
    }

    let risk = assess(repo, &entries, cx.env);
    if let Err((summary, cancelled)) = trust_gate(top, "Fetch", &risk, Some(&remotes), cx.store, cx.store_lock, cx.ask) {
        return GitResult::refused(summary, cancelled);
    }

    let run = run_limited(git_env(repo, &FETCH_ARGS, cx.env), cx.limit, MAX_OUTPUT, cx.pid);
    let r = match run {
        Ok(r) => r,
        Err(e) => return GitResult::refused(spawn_error(e), false),
    };
    let ok = !r.timed_out && r.status.is_some_and(|s| s.success());
    let exit_code = r.status.and_then(|s| s.code());
    let stderr = String::from_utf8_lossy(&r.stderr).into_owned();
    let ssh = remotes.iter().any(|(_, u)| is_ssh_url(u));
    GitResult {
        ok,
        timed_out: r.timed_out,
        cancelled: false,
        duration_ms: r.elapsed.as_millis() as u64,
        exit_code,
        command: command_text(),
        stdout: String::from_utf8_lossy(&r.stdout).into_owned(),
        summary: fetch_summary(ok, r.timed_out, exit_code, &stderr, ssh),
        stderr,
        deleted: None,
    }
}

/// Native, modal, and not reachable from the webview (the dialog plugin has
/// no permission in capabilities/default.json), so page script cannot answer it.
/// True for `ok`; `cancel` (e.g. "Cancel", "Keep on origin") or closing the dialog is false.
pub(crate) fn ask_native(app: &tauri::AppHandle, title: &str, ok: &str, cancel: &str, text: &str) -> bool {
    let mut d = app
        .dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()));
    if let Some(w) = app.get_webview_window("main") {
        d = d.parent(&w);
    }
    d.blocking_show()
}

/// Fetches every remote of the repo. Err only for "busy" (an operation
/// already runs here) or a path that is not a repository; every other outcome is a
/// GitResult so the output log can show it.
#[tauri::command]
pub(crate) async fn fetch(app: tauri::AppHandle, path: String, state: State<'_, AppState>) -> Result<GitResult, String> {
    // Resolved here rather than trusting the path string as given.
    let info = resolve_repo(&state, Path::new(&path))?;
    let dirs = state.dirs.lock().unwrap()[&info.path].clone(); // inserted by resolve_repo
    let lock = RepoLock::take(&state.busy_repos, &dirs.lock_key, "Fetch", &info.name).ok_or(BUSY)?;
    let store = trust_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let pid = lock.pid();
        let _lock = lock;
        let state = app.state::<AppState>();
        let title = format!("Fetch — {}: trust this repository?", info.name);
        let ask = |text: &str| ask_native(&app, &title, "Fetch", "Cancel", text);
        fetch_in(
            &info.path,
            &dirs.common_dir,
            &FetchCtx { store: &store, store_lock: &state.trust_lock, ask: &ask, limit: LIMIT, env: &[], pid: Some(&*pid) },
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// Remote names, asked again after a sync (a remote may have been added).
#[tauri::command]
pub(crate) async fn list_remotes(path: String) -> Result<Vec<String>, String> {
    let repo = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(git(&repo, &["remote"])?.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A temp folder with a bare remote, a "work" clone that pushes to it and
    /// the "local" clone the tests fetch into. Git runs without the user's
    /// global/system config, so their credential helper or fetch.pruneTags
    /// cannot leak in. The folder is removed on drop.
    struct Fixture {
        dir: PathBuf,
        global: String,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("gitkrapao-fetch-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let global = dir.join("empty-global").to_string_lossy().replace('\\', "/");
            std::fs::write(&global, "").unwrap();
            let f = Fixture { dir, global };
            f.git(&f.dir, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
            f.git(&f.dir, &["clone", "-q", "remote.git", "work"]);
            f.commit("one");
            f.git(&f.work(), &["push", "-q", "origin", "HEAD:main"]);
            f.git(&f.dir, &["clone", "-q", "remote.git", "local"]);
            f
        }
        fn work(&self) -> PathBuf { self.dir.join("work") }
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
        fn commit(&self, msg: &str) -> String {
            self.git(&self.work(), &["commit", "-q", "--allow-empty", "-m", msg]);
            self.git(&self.work(), &["rev-parse", "HEAD"])
        }
        fn rev(&self, r: &str) -> Option<String> {
            let out = git_env(&self.local(), &["rev-parse", "-q", "--verify", r], &self.env()).output().unwrap();
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        fn store(&self) -> PathBuf { self.dir.join("trust.json") }
        /// Runs fetch_in on the local clone; `answer` replies to the dialog,
        /// and every question asked is recorded.
        fn fetch(&self, answer: bool, asked: &RefCell<Vec<String>>) -> GitResult {
            self.fetch_with(answer, asked, Duration::from_secs(60))
        }
        fn fetch_with(&self, answer: bool, asked: &RefCell<Vec<String>>, limit: Duration) -> GitResult {
            let lock = Mutex::new(());
            let ask = |t: &str| { asked.borrow_mut().push(t.to_string()); answer };
            let env = self.env();
            let local = self.local();
            let common = local.join(".git");
            fetch_in(&local.to_string_lossy(), &common, &FetchCtx { store: &self.store(), store_lock: &lock, ask: &ask, limit, env: &env, pid: None })
        }
        fn asks(asked: &RefCell<Vec<String>>) -> usize { asked.borrow().len() }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    // New commits arrive, deleted remote branches are pruned, and local
    // branches and tags are never touched: not by fetch.pruneTags /
    // remote.origin.pruneTags, and not when a tag moved on the remote.
    #[test]
    fn fetches_and_never_touches_local_refs() {
        let f = Fixture::new("basic");
        let one = f.git(&f.work(), &["rev-parse", "HEAD"]);
        f.git(&f.work(), &["tag", "v1"]);
        f.git(&f.work(), &["tag", "old"]);
        f.git(&f.work(), &["push", "-q", "origin", "HEAD:refs/heads/gone", "v1", "old"]);
        f.git(&f.local(), &["fetch", "-q", "--tags"]);
        f.git(&f.local(), &["branch", "keep"]);
        f.git(&f.local(), &["tag", "mine"]);
        f.git(&f.local(), &["config", "fetch.pruneTags", "true"]);
        f.git(&f.local(), &["config", "remote.origin.pruneTags", "true"]);
        assert_eq!(f.rev("refs/remotes/origin/gone").as_deref(), Some(one.as_str()));

        let two = f.commit("two");
        f.git(&f.work(), &["push", "-q", "origin", "HEAD:main"]);
        f.git(&f.work(), &["push", "-q", "origin", "--delete", "gone", "old"]);
        f.git(&f.work(), &["tag", "-f", "v1"]);
        f.git(&f.work(), &["push", "-q", "-f", "origin", "v1"]);

        let asked = RefCell::new(vec![]);
        let r = f.fetch(true, &asked);
        assert!(r.ok, "{}: {}", r.summary, r.stderr);
        assert!(!r.timed_out && !r.cancelled && r.exit_code == Some(0));
        assert_eq!(r.command, "git fetch --all --prune --no-prune-tags --no-auto-maintenance --no-recurse-submodules");
        assert_eq!(Fixture::asks(&asked), 1, "a repo not picked in the dialog is asked about once");
        assert!(asked.borrow()[0].contains("has not fetched in this repository before"));
        assert_eq!(f.rev("refs/remotes/origin/main").as_deref(), Some(two.as_str()));
        assert_eq!(f.rev("refs/remotes/origin/gone"), None, "pruned");
        assert_eq!(f.rev("refs/tags/old").as_deref(), Some(one.as_str()), "a tag deleted on the remote stays");
        assert_eq!(f.rev("refs/tags/v1").as_deref(), Some(one.as_str()), "a moved tag is not overwritten");
        assert_eq!(f.rev("refs/tags/mine").as_deref(), Some(one.as_str()));
        assert_eq!(f.rev("refs/heads/keep").as_deref(), Some(one.as_str()));
        assert!(r.summary.starts_with("Fetched: "), "{}", r.summary);

        let r = f.fetch(true, &asked);
        assert!(r.ok);
        assert_eq!(Fixture::asks(&asked), 1, "the answer is remembered");
        assert_eq!(r.summary, "Fetched: already up to date.");
    }

    // Risky keys from the repo's own config (also through include.path) are
    // shown; cancel fetches nothing; an approval holds until a value or the
    // hook changes.
    #[test]
    fn asks_about_risky_config() {
        let f = Fixture::new("trust");
        let before = f.rev("refs/remotes/origin/main");
        f.commit("two");
        f.git(&f.work(), &["push", "-q", "origin", "HEAD:main"]);
        let extra = f.local().join(".git").join("extra.cfg");
        std::fs::write(&extra, "[core]\n\tsshCommand = ssh -o Evil=yes\n").unwrap();
        f.git(&f.local(), &["config", "include.path", "extra.cfg"]);

        let entries = read_trust_config(&f.local(), &f.env()).unwrap();
        let ssh = entries.iter().find(|e| e.key == "core.sshcommand").expect("an included key is read");
        assert_eq!(ssh.scope, "local", "an included file takes its includer's scope");

        let asked = RefCell::new(vec![]);
        let r = f.fetch(false, &asked);
        assert!(!r.ok && r.cancelled && r.exit_code.is_none());
        assert!(asked.borrow()[0].contains("core.sshcommand = ssh -o Evil=yes"), "{}", asked.borrow()[0]);
        assert_eq!(f.rev("refs/remotes/origin/main"), before, "nothing fetched");
        assert!(!f.store().exists(), "cancel saves nothing");

        // A local file remote never runs ssh, so the fetch itself works.
        let r = f.fetch(true, &asked);
        assert!(r.ok, "{}", r.stderr);
        let n = Fixture::asks(&asked);
        assert!(f.fetch(true, &asked).ok);
        assert_eq!(Fixture::asks(&asked), n, "approved config is not asked again");

        std::fs::write(&extra, "[core]\n\tsshCommand = ssh -o Evil=no\n").unwrap();
        f.fetch(true, &asked);
        assert_eq!(Fixture::asks(&asked), n + 1, "a changed value asks again");
        assert!(asked.borrow()[n].starts_with("Fetch in this repository?"), "an allowed repo is not new");

        for (k, v) in [
            ("protocol.allow", "always"),
            ("core.alternateRefsCommand", "x"),
            ("credential.helper", "x"),
            ("url.https://e.com/.insteadOf", "x"),
            ("remote.origin.uploadpack", "x"),
            ("hook.h.command", "x"),
            ("filter.x.smudge", "x"),
            ("filter.x.process", "x"),
            ("core.fsmonitor", "x"),
        ] {
            f.git(&f.local(), &["config", k, v]);
            let n = Fixture::asks(&asked);
            f.fetch(false, &asked);
            assert_eq!(Fixture::asks(&asked), n + 1, "{k} asks");
            let (sec, rest) = k.split_once('.').unwrap();
            let (sub, key) = rest.rsplit_once('.').map_or(("", rest), |(s, k)| (s, k));
            let shown = if sub.is_empty() { format!("{sec}.{}", key.to_lowercase()) } else { format!("{sec}.{sub}.{}", key.to_lowercase()) };
            assert!(asked.borrow()[n].contains(&shown), "{k} is listed: {}", asked.borrow()[n]);
            f.git(&f.local(), &["config", "--unset", k]);
        }

        // The built-in monitor runs no program of the repo's choosing.
        f.git(&f.local(), &["config", "core.fsmonitor", "true"]);
        let n = Fixture::asks(&asked);
        assert!(f.fetch(true, &asked).ok);
        assert_eq!(Fixture::asks(&asked), n, "core.fsmonitor=true is not a question");
        f.git(&f.local(), &["config", "--unset", "core.fsmonitor"]);

        // Hooks a checkout runs are part of the same trust (fetch and switch share it).
        let post = f.local().join(".git").join("hooks").join("post-checkout");
        std::fs::write(&post, "#!/bin/sh\nexit 0\n").unwrap();
        let n = Fixture::asks(&asked);
        assert!(f.fetch(true, &asked).ok);
        assert!(asked.borrow()[n].contains("hook post-checkout"), "{}", asked.borrow()[n]);
        std::fs::remove_file(&post).unwrap();

        let hook = f.local().join(".git").join("hooks").join("reference-transaction");
        std::fs::write(&hook, "#!/bin/sh\nexit 0\n").unwrap();
        let n = Fixture::asks(&asked);
        assert!(f.fetch(true, &asked).ok);
        assert_eq!(Fixture::asks(&asked), n + 1);
        assert!(asked.borrow()[n].contains("hook reference-transaction"));
        assert!(f.fetch(true, &asked).ok);
        assert_eq!(Fixture::asks(&asked), n + 1);
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        f.fetch(false, &asked);
        assert_eq!(Fixture::asks(&asked), n + 2, "a changed hook asks again");
    }

    // pre-push joined TRUST_HOOKS (deleting a tag on origin pushes). The hash
    // is made from the hooks that exist, so a repo without pre-push keeps the
    // hash it had, and with it its approval; one with pre-push is asked once.
    #[test]
    fn pre_push_is_trusted_without_changing_other_hashes() {
        let f = Fixture::new("prepush");
        let dir = PathBuf::from(f.git(&f.local(), &["rev-parse", "--path-format=absolute", "--git-path", "hooks"]));
        let line = |name: &str| {
            let p = dir.join(name);
            format!("hook	{}	{:x}", p.to_string_lossy(), Sha256::digest(std::fs::read(&p).unwrap()))
        };
        std::fs::write(dir.join("reference-transaction"), "#!/bin/sh
exit 0
").unwrap();
        let env = f.env();
        let hash = || assess(&f.local(), &read_trust_config(&f.local(), &env).unwrap(), &env).hash;
        assert_eq!(hash(), Some(trust_hash(&[line("reference-transaction")])), "the same hash as before pre-push was listed");

        let asked = RefCell::new(vec![]);
        assert!(f.fetch(true, &asked).ok);
        let n = Fixture::asks(&asked);
        assert!(f.fetch(true, &asked).ok);
        assert_eq!(Fixture::asks(&asked), n, "approved once");

        std::fs::write(dir.join("pre-push"), "#!/bin/sh
exit 0
").unwrap();
        assert_eq!(hash(), Some(trust_hash(&[line("reference-transaction"), line("pre-push")])));
        assert!(f.fetch(true, &asked).ok);
        assert_eq!(Fixture::asks(&asked), n + 1, "a pre-push hook asks once");
        assert!(asked.borrow()[n].contains("hook pre-push"), "{}", asked.borrow()[n]);
        assert!(f.fetch(true, &asked).ok);
        assert_eq!(Fixture::asks(&asked), n + 1);
    }

    // Anything that would let --prune delete or overwrite local refs is
    // refused before git runs and before any question.
    #[test]
    fn refuses_refspecs_into_local_refs() {
        let f = Fixture::new("refspec");
        let asked = RefCell::new(vec![]);
        let cases: [(&str, &str, &str); 3] = [
            ("remote.origin.fetch", "+refs/heads/*:refs/heads/*", "refs/heads/*"),
            ("remote.origin.fetch", "refs/tags/*:refs/tags/*", "refs/tags/*"),
            ("remote.origin.mirror", "true", "mirror"),
        ];
        for (k, v, word) in cases {
            f.git(&f.local(), &["config", "--add", k, v]);
            let r = f.fetch(true, &asked);
            assert!(!r.ok && !r.cancelled && r.summary.contains(word), "{k}={v}: {}", r.summary);
            f.git(&f.local(), &["config", "--fixed-value", "--unset", k, v]);
        }
        assert_eq!(Fixture::asks(&asked), 0);
        let branches = f.local().join(".git").join("branches");
        std::fs::create_dir_all(&branches).unwrap();
        assert!(f.fetch(true, &asked).ok, "an empty branches/ folder is fine");
        std::fs::write(branches.join("x"), "../remote.git").unwrap();
        let r = f.fetch(true, &asked);
        assert!(!r.ok && r.summary.contains("branches/"), "{}", r.summary);
        assert_eq!(Fixture::asks(&asked), 1, "only the fetch that ran asked");

        // Negative refspecs and refspecs without a destination are fine.
        let e = |v: &str| vec![ConfigEntry { scope: "local".into(), key: "remote.o.fetch".into(), value: Some(v.into()) }];
        let none = Path::new("does-not-exist");
        assert!(refspec_problem(&e("^refs/heads/x"), none).is_none());
        assert!(refspec_problem(&e("refs/heads/main"), none).is_none());
        assert!(refspec_problem(&e("refs/heads/main:"), none).is_none());
        assert!(refspec_problem(&e("+refs/heads/*:refs/remotes/o/*"), none).is_none());
        assert!(refspec_problem(&e("refs/heads/main:main"), none).is_some(), "shorthand means refs/heads/main");
        let m = |v: Option<&str>| vec![ConfigEntry { scope: "local".into(), key: "remote.o.mirror".into(), value: v.map(String::from) }];
        assert!(refspec_problem(&m(None), none).is_some());
        assert!(refspec_problem(&m(Some("false")), none).is_none());
    }

    #[test]
    fn no_remotes_and_broken_config() {
        let f = Fixture::new("none");
        let asked = RefCell::new(vec![]);
        f.git(&f.local(), &["remote", "remove", "origin"]);
        let r = f.fetch(true, &asked);
        assert!(!r.ok && r.summary.contains("no remotes"), "{}", r.summary);
        f.git(&f.local(), &["remote", "add", "origin", "../remote.git"]);
        std::fs::write(f.local().join(".git").join("bad.cfg"), "[core\n").unwrap();
        f.git(&f.local(), &["config", "include.path", "bad.cfg"]);
        let r = f.fetch(true, &asked);
        assert!(!r.ok && r.exit_code.is_none(), "{}", r.summary);
        assert_eq!(Fixture::asks(&asked), 0);
    }

    // The limit kills the whole tree: the ssh command runs in a grandchild of
    // the git launcher, and must never reach the touch.
    #[test]
    fn timeout_kills_the_process_tree() {
        let f = Fixture::new("timeout");
        let marker = f.dir.join("marker").to_string_lossy().replace('\\', "/");
        f.git(&f.local(), &["remote", "set-url", "origin", "ssh://git@example.invalid/x.git"]);
        f.git(&f.local(), &["config", "core.sshCommand", &format!("sleep 4; touch '{marker}'; :")]);
        let asked = RefCell::new(vec![]);
        let start = Instant::now();
        let r = f.fetch_with(true, &asked, Duration::from_secs(1));
        assert!(r.timed_out && !r.ok && r.exit_code.is_none(), "{} / {}", r.summary, r.stderr);
        assert!(start.elapsed() < Duration::from_secs(4), "returned after {:?}", start.elapsed());
        assert!(r.summary.contains("ssh-agent"), "{}", r.summary);
        std::thread::sleep(Duration::from_secs(5));
        assert!(!Path::new(&marker).exists(), "the sleeping ssh command survived the kill");
    }

    #[test]
    fn registry_tracks_each_running_op() {
        let reg: OpRegistry = Arc::default();
        let a = RepoLock::take(&reg, "a", "Fetch", "alpha").unwrap();
        assert!(RepoLock::take(&reg, "a", "Switch branch", "alpha").is_none(), "one op per repo");
        let b = RepoLock::take(&reg, "b", "Switch branch", "beta").unwrap();
        *a.pid().lock().unwrap() = Some(11);
        *b.pid().lock().unwrap() = Some(22);
        let mut pids = running_pids(&reg);
        pids.sort();
        assert_eq!(pids, vec![11, 22]);
        drop(a);
        assert_eq!(running_pids(&reg), vec![22]);
        assert!(RepoLock::take(&reg, "a", "Fetch", "alpha").is_some());
    }

    #[test]
    fn close_warning_lists_ops_by_repo() {
        let reg: OpRegistry = Arc::default();
        assert_eq!(close_warning(&reg), None);
        let _a = RepoLock::take(&reg, "a", "Fetch", "alpha").unwrap(); // no PID yet: still listed
        let _b = RepoLock::take(&reg, "b", "Switch branch", "beta").unwrap();
        let w = close_warning(&reg).unwrap();
        assert!(w.contains("Fetch — alpha") && w.contains("Switch branch — beta"));
        assert!(w.contains("half updated"));
    }

    #[test]
    fn parses_config_z() {
        let got = parse_config_z(b"local\0core.askpass\n\0local\0remote.origin.mirror\0global\0url.x.insteadof\nline1\nline2\0");
        assert_eq!(got, vec![
            ConfigEntry { scope: "local".into(), key: "core.askpass".into(), value: Some(String::new()) },
            ConfigEntry { scope: "local".into(), key: "remote.origin.mirror".into(), value: None },
            ConfigEntry { scope: "global".into(), key: "url.x.insteadof".into(), value: Some("line1\nline2".into()) },
        ]);
        let own: Vec<_> = risky_entries(&got).iter().map(|e| e.key.as_str()).collect();
        assert_eq!(own, vec!["core.askpass"], "global config and refspec keys are not trust questions");
    }

    #[test]
    fn dialog_text_cannot_be_spoofed() {
        assert_eq!(sanitize("a\nb\u{202e}c\u{7}d\u{2066}", 100), "a\\nb\\u{202e}c\\u{7}d\\u{2066}");
        assert_eq!(sanitize("abcdef", 3), "abc…");
        assert_eq!(sanitize("ไทย", 10), "ไทย");
        let lines: Vec<String> = (0..25).map(|i| format!("k{i}")).collect();
        let t = trust_text("C:/r", "Fetch", false, &[], &lines);
        assert!(t.contains("k19\n") && !t.contains("k20\n") && t.contains("and 5 more"));
        assert_eq!(trust_hash(&["b".into(), "a".into()]), trust_hash(&["a".into(), "b".into()]));
        // SHA-256, so the stored value survives Rust upgrades (DefaultHasher would not).
        assert_eq!(trust_hash(&["a".into(), "b".into()]), "7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78");
    }

    #[test]
    fn explains_fetch_errors() {
        let s = |e: &str| fetch_summary(false, false, Some(128), e, false);
        assert!(s("fatal: could not read Username for 'https://x': terminal prompts disabled").starts_with("Authentication failed"));
        assert!(s("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://x/'").starts_with("Authentication failed"));
        assert!(s("git@x: Permission denied (publickey).\nfatal: Could not read from remote repository.").starts_with("Authentication failed"));
        assert!(s("Host key verification failed.\nfatal: Could not read from remote repository.").starts_with("SSH does not know"));
        assert!(s("fatal: unable to access 'https://x/': Could not resolve host: x").starts_with("Could not reach"));
        assert!(s("error: cannot lock ref 'refs/remotes/origin/main': Unable to create 'C:/r/.git/refs/remotes/origin/main.lock': File exists.").starts_with("Another git process"));
        assert_eq!(s("warning: x\nfatal: something else\n"), "something else");
        assert_eq!(s(""), "git fetch failed (exit code 128).");
        assert!(fetch_summary(false, true, None, "", true).contains("ssh-agent"));
        assert!(!fetch_summary(false, true, None, "", false).contains("ssh-agent"));
        let ok = "From ../remote\n   1111111..2222222  main       -> origin/main\n - [deleted]         (none)     -> origin/gone\n * [new branch]      x          -> origin/x\n";
        assert_eq!(fetch_summary(true, false, Some(0), ok, false), "Fetched: 3 refs updated.");
        for (u, ssh) in [
            ("ssh://git@h/x", true),
            ("git@github.com:a/b.git", true),
            ("https://h/x", false),
            ("C:/repos/x", false),
            ("C:\\repos\\x", false),
            ("../remote.git", false),
            ("/srv/x:y", false),
        ] {
            assert_eq!(is_ssh_url(u), ssh, "{u}");
        }
    }
}
