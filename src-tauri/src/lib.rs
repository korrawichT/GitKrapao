use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;

mod create;
mod fetch;
mod switch;

/// Field separator (0x1f) and record separator (0x1e) never appear in normal
/// commit metadata, so subjects containing "|" or quotes parse safely.
/// Fields: hash, parents, author, email, author time, committer time, an
/// empty decoration slot (labels come from `list_refs`), subject.
const LOG_FORMAT: &str = "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%x1f%s%x1e";
const RS: u8 = 0x1e;

/// Safety valve for gigantic histories; ~190 bytes per commit kept in memory.
const MAX_COMMITS: usize = 2_000_000;
/// The reader publishes this many records at a time to waiting page requests.
const FLUSH_EVERY: usize = 512;
const PAGE_WAIT: Duration = Duration::from_secs(60);

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct RepoInfo {
    path: String,
    name: String,
    // GitDirs::lock_key: linked worktrees of one repo share it.
    lock_key: String,
}

/// Ref snapshot. Tips are commit ids; annotated tags are peeled one level and
/// refs to anything other than a commit are left out.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct Refs {
    /// [commit, full ref name] for refs/heads, refs/remotes and refs/tags.
    refs: Vec<(String, String)>,
    /// Ref HEAD points to (e.g. refs/heads/main); None when detached.
    head_ref: Option<String>,
    /// Commit HEAD resolves to; None on an unborn branch.
    head_sha: Option<String>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct StreamInfo {
    #[cfg_attr(test, ts(type = "number"))]
    gen: u64,
    remotes: Vec<String>,
    /// Taken before the log and the ref listing start.
    fingerprint: String,
    refs: Refs,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct SyncInfo {
    /// Taken before and after reading; if they differ the repo moved while
    /// we read it and the caller must not trust the result.
    fingerprint_before: String,
    fingerprint_after: String,
    refs: Refs,
    /// Commits reachable now but not from the excluded old tips.
    log: String,
    /// More than `limit` new commits; the caller should reload instead.
    over: bool,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct Page {
    log: String,
    /// More records exist after this page (or may still arrive from git).
    more: bool,
    /// History hit MAX_COMMITS and was cut off.
    capped: bool,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct FileChange {
    /// A, M, D, R, C, T, ... (rename/copy score dropped)
    status: String,
    path: String,
    /// Source path of a rename or copy.
    old_path: Option<String>,
    /// Lines added/removed; None for binary files.
    #[cfg_attr(test, ts(type = "number | null"))]
    add: Option<u64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    del: Option<u64>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct CommitDetail {
    /// Full raw message (%B), subject included.
    body: String,
    files: Vec<FileChange>,
    /// Number of changed files; can exceed `files.len()` (see MAX_FILES).
    total_files: usize,
    #[cfg_attr(test, ts(type = "number"))]
    add: u64,
    #[cfg_attr(test, ts(type = "number"))]
    del: u64,
}

/// A local branch and how it compares with its upstream.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct Track {
    /// Short name, e.g. feature/login.
    name: String,
    /// Full upstream ref, e.g. refs/remotes/origin/feature/login.
    upstream: String,
    ahead: u32,
    behind: u32,
    /// The upstream is configured but no longer exists.
    gone: bool,
}

/// More than this many changed files are counted but not listed.
const MAX_FILES: usize = 3000;

#[derive(Clone)]
struct GitDirs {
    git_dir: PathBuf,
    common_dir: PathBuf,
    /// Canonical common dir: linked worktrees share refs, so they share the
    /// fetch lock too.
    lock_key: String,
}

/// Everything one `git log` run has produced so far.
#[derive(Default)]
struct Store {
    buf: Vec<u8>,
    /// ends[i] = offset in `buf` just past record i.
    ends: Vec<usize>,
    done: bool,
    capped: bool,
    error: Option<String>,
}

type Shared = Arc<(Mutex<Store>, Condvar)>;

struct Stream {
    gen: u64,
    shared: Shared,
    child: Arc<Mutex<Option<Child>>>,
    /// Tells `read_log` to stop reading. Killing `git` may hit only a
    /// launcher (Git for Windows' cmd\git.exe) while the real git keeps
    /// writing; dropping the pipe then ends it on a broken pipe.
    stop: Arc<AtomicBool>,
}

impl Stream {
    fn kill(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

/// Stops and forgets the history stream unless it is newer than `gen`: a stop
/// sent when the UI left a repo may reach the backend after the next
/// `start_history`, and must not kill that one.
fn stop_stream(slot: &Mutex<Option<Stream>>, gen: u64) {
    let old = {
        let mut s = slot.lock().unwrap();
        if s.as_ref().is_some_and(|st| st.gen <= gen) { s.take() } else { None }
    };
    if let Some(old) = old {
        old.kill();
    }
}

#[derive(Default)]
struct AppState {
    stream: Mutex<Option<Stream>>,
    next_gen: AtomicU64,
    dirs: Mutex<HashMap<String, GitDirs>>,
    /// Operations (fetch, switch, create) running, by lock key (GitDirs::lock_key): one per repo.
    busy_repos: fetch::OpRegistry,
    /// Serializes reads and writes of the trust file.
    trust_lock: Mutex<()>,
    /// The "operations still running" close dialog is open (one at a time).
    closing_prompt: AtomicBool,
}

fn git_command(repo: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args([
            "-c", "core.quotepath=off",
            "-c", "log.showSignature=false",
            "-c", "color.ui=never",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    no_window(&mut cmd);
    cmd
}

/// Without this flag, every child process flashes a console window on Windows.
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        "Git was not found. Install Git and make sure it is on your PATH.".to_string()
    } else {
        format!("Could not run git: {e}")
    }
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_command(repo, args).output().map_err(spawn_error)?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() { "git exited with an error.".into() } else { msg });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One git call finds the work tree and the git dirs used for change detection.
fn resolve_repo(state: &AppState, path: &Path) -> Result<RepoInfo, String> {
    let out = git(
        path,
        &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
    )
    .map_err(|e| {
        if e.contains("dubious ownership") {
            e // let the user see git's own fix-it hint (safe.directory)
        } else {
            format!("{} is not inside a Git repository.", path.display())
        }
    })?;
    let mut lines = out.lines().map(|l| PathBuf::from(l.trim()));
    let (Some(top), Some(git_dir), Some(common_dir)) = (lines.next(), lines.next(), lines.next()) else {
        return Err(format!("{} is not inside a Git repository.", path.display()));
    };
    let name = top
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.display().to_string());
    let lock_key = path_key(&common_dir);
    let info = RepoInfo { path: top.to_string_lossy().into_owned(), name, lock_key: lock_key.clone() };
    state.dirs.lock().unwrap().insert(info.path.clone(), GitDirs { git_dir, common_dir, lock_key });
    Ok(info)
}

/// One spelling per folder: canonical, and lowercase on Windows where paths
/// are case-insensitive. Falls back to the path as given.
fn path_key(p: &Path) -> String {
    let s = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()).to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn dirs_for(state: &AppState, path: &str) -> Result<GitDirs, String> {
    if let Some(d) = state.dirs.lock().unwrap().get(path) {
        return Ok(d.clone());
    }
    let info = resolve_repo(state, Path::new(path))?;
    Ok(state.dirs.lock().unwrap()[&info.path].clone())
}

fn hash_meta(path: &Path, h: &mut DefaultHasher) {
    if let Ok(m) = std::fs::metadata(path) {
        path.hash(h);
        m.len().hash(h);
        m.modified().ok().hash(h);
    }
}

fn hash_tree(dir: &Path, h: &mut DefaultHasher) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        if p.is_dir() { hash_tree(&p, h) } else { hash_meta(&p, h) }
    }
}

/// Cheap change detector that reads ref files directly instead of spawning
/// git (each spawn costs ~200 ms on Windows). Any ref update rewrites a file
/// under refs/, packed-refs or reftable/, and checkout rewrites HEAD.
/// config is included so a new upstream (`git branch -u`) refreshes the
/// ahead/behind counts.
fn fingerprint(d: &GitDirs) -> String {
    let mut h = DefaultHasher::new();
    std::fs::read(d.git_dir.join("HEAD")).unwrap_or_default().hash(&mut h);
    hash_meta(&d.common_dir.join("config"), &mut h);
    // `git stash drop` only rewrites the stash reflog, not refs/stash.
    hash_meta(&d.common_dir.join("logs").join("refs").join("stash"), &mut h);
    hash_meta(&d.common_dir.join("packed-refs"), &mut h);
    hash_tree(&d.common_dir.join("refs"), &mut h);
    hash_tree(&d.common_dir.join("reftable"), &mut h);
    format!("{:016x}", h.finish())
}

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// One `git for-each-ref` call; HEAD comes from the HEAD file in git_dir.
fn list_refs(repo: &Path, d: &GitDirs) -> Result<Refs, String> {
    let out = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)",
            "refs/heads", "refs/remotes", "refs/tags",
        ],
    )?;
    let mut refs = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split('\0').collect();
        let [obj, ty, peeled, peeled_ty, name] = f[..] else { continue };
        let sha = if ty == "commit" { obj } else if peeled_ty == "commit" { peeled } else { continue };
        refs.push((sha.to_string(), name.to_string()));
    }

    let head = std::fs::read_to_string(d.git_dir.join("HEAD")).unwrap_or_default();
    let head = head.trim();
    let (mut head_ref, mut head_sha) = (None, None);
    if let Some(r) = head.strip_prefix("ref: ") {
        if r == "refs/heads/.invalid" {
            // reftable keeps the real HEAD inside the table; ask git.
            head_ref = git(repo, &["symbolic-ref", "-q", "HEAD"]).ok().map(|s| s.trim().to_string());
            head_sha = git(repo, &["rev-parse", "-q", "--verify", "HEAD^{commit}"]).ok().map(|s| s.trim().to_string());
        } else {
            head_ref = Some(r.to_string());
            head_sha = refs.iter().find(|(_, n)| n == r).map(|(s, _)| s.clone());
        }
    } else if is_sha(head) {
        head_sha = Some(head.to_string());
    }
    Ok(Refs { refs, head_ref, head_sha })
}

/// Parses `git show --format=%B%x1e --raw --numstat -z`: the message, then
/// one raw record per file (":modes shas STATUS\0path\0[dest\0]"), then one
/// numstat record per file in the same order ("add\tdel\tpath\0", or
/// "add\tdel\t\0src\0dest\0" for a rename). Paths are taken by position, so
/// names with tabs, colons or newlines cannot be mistaken for headers.
fn parse_detail(out: &[u8]) -> CommitDetail {
    let split = out.iter().position(|&b| b == RS).unwrap_or(out.len());
    let body = String::from_utf8_lossy(&out[..split]).trim_end().to_string();
    let rest = out.get(split + 1..).unwrap_or(&[]);
    let toks: Vec<String> = rest.split(|&b| b == 0).map(|t| String::from_utf8_lossy(t).into_owned()).collect();

    let mut files: Vec<FileChange> = Vec::new();
    let mut stats: Vec<(Option<u64>, Option<u64>)> = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        // Only the first header follows the blank line after the message.
        let t = toks[i].strip_prefix('\n').unwrap_or(&toks[i]);
        if t.is_empty() {
            i += 1;
        } else if t.starts_with(':') {
            let code = t.rsplit(' ').next().unwrap_or("");
            let status: String = code.chars().take(1).collect();
            let two = status == "R" || status == "C";
            let first = toks.get(i + 1).cloned().unwrap_or_default();
            let (path, old_path) = if two {
                (toks.get(i + 2).cloned().unwrap_or_default(), Some(first))
            } else {
                (first, None)
            };
            files.push(FileChange { status, path, old_path, add: None, del: None });
            i += if two { 3 } else { 2 };
        } else {
            let mut f = t.splitn(3, '\t');
            let (add, del) = (f.next().and_then(|s| s.parse().ok()), f.next().and_then(|s| s.parse().ok()));
            stats.push((add, del));
            i += if f.next().unwrap_or("").is_empty() { 3 } else { 1 };
        }
    }
    let (mut add, mut del) = (0, 0);
    for (f, (a, d)) in files.iter_mut().zip(stats) {
        f.add = a;
        f.del = d;
        add += a.unwrap_or(0);
        del += d.unwrap_or(0);
    }
    let total_files = files.len();
    files.truncate(MAX_FILES);
    CommitDetail { body, files, total_files, add, del }
}

/// Reads git's stdout to the end on its own thread, so git finishes as fast
/// as it can and never sits paused holding pack files open (which would make
/// `git gc` on Windows fail to delete them).
fn read_log(
    stdout: std::process::ChildStdout,
    mut stderr: std::process::ChildStderr,
    shared: Shared,
    child_slot: Arc<Mutex<Option<Child>>>,
    stop: Arc<AtomicBool>,
) {
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let (lock, cvar) = &*shared;
    let mut reader = BufReader::with_capacity(1 << 16, stdout);
    let (mut buf, mut ends, mut rec) = (Vec::new(), Vec::new(), Vec::new());
    let mut total = 0usize;
    let mut capped = false;
    let mut stopped = false;
    let flush = |buf: &mut Vec<u8>, ends: &mut Vec<usize>| {
        let mut s = lock.lock().unwrap();
        let base = s.buf.len();
        s.buf.extend_from_slice(buf);
        s.ends.extend(ends.iter().map(|e| e + base));
        buf.clear();
        ends.clear();
        cvar.notify_all();
    };
    loop {
        rec.clear();
        // Split on the record byte before decoding, so a multi-byte UTF-8
        // character (e.g. Thai) is never cut in half.
        match reader.read_until(RS, &mut rec) {
            Ok(0) | Err(_) => break,
            Ok(_) if rec.last() != Some(&RS) => break, // trailing newline only
            Ok(_) => {
                if stop.load(Ordering::SeqCst) {
                    stopped = true;
                    break;
                }
                buf.extend_from_slice(&rec);
                ends.push(buf.len());
                total += 1;
                if total >= MAX_COMMITS {
                    capped = true;
                    if let Some(c) = child_slot.lock().unwrap().as_mut() {
                        let _ = c.kill();
                    }
                    break;
                }
                if ends.len() >= FLUSH_EVERY {
                    flush(&mut buf, &mut ends);
                }
            }
        }
    }
    flush(&mut buf, &mut ends);
    // Close the pipe before waiting: after a stop or the cap, a git that kept
    // running (the kill may have hit only a launcher) would otherwise block
    // on a full pipe and keep stderr open, so neither wait below would return.
    drop(reader);

    let child = child_slot.lock().unwrap().take();
    let status = child.and_then(|mut c| c.wait().ok());
    let err = err_thread.join().unwrap_or_default();
    let mut s = lock.lock().unwrap();
    s.capped = capped;
    if !capped && !stopped && !status.is_some_and(|st| st.success()) {
        // An empty repository (no commits yet) shows an empty graph.
        let empty = err.contains("bad revision 'HEAD'") || err.contains("ambiguous argument 'HEAD'");
        if !empty && s.ends.is_empty() {
            let msg = err.trim();
            s.error = Some(if msg.is_empty() { "git log stopped unexpectedly.".into() } else { msg.into() });
        }
    }
    s.done = true;
    cvar.notify_all();
}

#[tauri::command]
async fn pick_repo(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Option<RepoInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open a Git repository")
        .blocking_pick_folder();
    let Some(folder) = picked else { return Ok(None) };
    let path = folder.into_path().map_err(|e| e.to_string())?;
    let info = resolve_repo(&state, &path)?;
    // Picked in the native dialog, so the user chose it: fetch may run there
    // without asking first (risky config still asks).
    fetch::allow_repo(&app, &state, &info.path);
    Ok(Some(info))
}

#[tauri::command]
async fn open_repo(path: String, state: State<'_, AppState>) -> Result<RepoInfo, String> {
    resolve_repo(&state, Path::new(&path))
}

/// The revisions the graph walks: branches, remotes, tags and HEAD (`--all`
/// would also pull in stash and notes commits, which clutter the graph),
/// minus hidden branches. Each hidden
/// entry is a full ref name (refs/heads/x, refs/remotes/origin/x) or a
/// prefix ending in "/" for a whole folder or remote. `--exclude` applies to
/// the next --branches/--remotes only, takes names without the refs/heads/ or
/// refs/remotes/ part, and its `*` also matches "/".
/// HEAD always stays, so the checked-out commit is never hidden.
///
/// Solo (non-empty `solo`, same entry format) walks only those branches,
/// without tags or HEAD, and ignores `hidden`. Each becomes a `--glob`, so a
/// branch deleted meanwhile matches nothing instead of failing the walk. A
/// glob without wildcards gets "/*" appended, so an exact ref brackets one
/// letter of "heads"/"remotes" (refs/[h]eads/x matches refs/heads/x only);
/// the branch name itself is never bracketed, since wildmatch works on
/// bytes and Thai names would not match.
fn rev_args(hidden: &[String], solo: &[String]) -> Result<Vec<String>, String> {
    let (mut heads, mut remotes, mut globs) = (Vec::new(), Vec::new(), Vec::new());
    let mut len = 0;
    for (h, is_solo) in hidden.iter().map(|h| (h, false)).chain(solo.iter().map(|h| (h, true))) {
        // Ref names cannot hold glob characters, so the patterns stay literal.
        let bad = h.bytes().any(|b| b < 0x20 || b"*?[\\".contains(&b));
        let (local, rest) = if let Some(r) = h.strip_prefix("refs/heads/") {
            (true, r)
        } else if let Some(r) = h.strip_prefix("refs/remotes/") {
            (false, r)
        } else {
            return Err(format!("not a branch: {h}"));
        };
        if bad || rest.is_empty() || rest == "/" {
            return Err(format!("not a branch: {h}"));
        }
        let folder = rest.ends_with('/');
        let arg = match (is_solo, folder) {
            (true, true) => format!("--glob={h}*"),
            (true, false) => format!("--glob=refs/{}/{rest}", if local { "[h]eads" } else { "[r]emotes" }),
            (false, true) => format!("--exclude={rest}*"),
            (false, false) => format!("--exclude={rest}"),
        };
        len += arg.len() + 1;
        match (is_solo, local) {
            (true, _) => globs.push(arg),
            (false, true) => heads.push(arg),
            (false, false) => remotes.push(arg),
        }
    }
    // Stay well inside the 32k Windows command line.
    if len > 24_000 {
        return Err("Too many hidden or solo branches. Use their folder or remote instead.".into());
    }
    if !globs.is_empty() {
        return Ok(globs);
    }
    let mut args = heads;
    args.push("--branches".into());
    args.extend(remotes);
    args.extend(["--remotes", "--tags", "HEAD"].map(String::from));
    Ok(args)
}

/// Starts reading the whole history in the background and returns at once.
/// Pages are then fetched with `history_page` using the returned `gen`.
#[tauri::command]
async fn start_history(path: String, hidden: Vec<String>, solo: Vec<String>, state: State<'_, AppState>) -> Result<StreamInfo, String> {
    let revs = rev_args(&hidden, &solo)?;
    let dirs = dirs_for(&state, &path)?;
    if fetch::is_busy(&state, &dirs) {
        return Err(fetch::BUSY.into());
    }
    let repo = PathBuf::from(&path);

    // Fingerprint first. The caller compares it with a fresh one once the
    // first page arrives; if they differ, the refs below may be newer than
    // the log and the caller reloads.
    let fingerprint = fingerprint(&dirs);

    // --date-order keeps every child above its parents, so rows can be laid
    // out as they arrive.
    let mut args = vec!["log", "--date-order", LOG_FORMAT];
    args.extend(revs.iter().map(String::as_str));
    let mut child = git_command(&repo, &args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(spawn_error)?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let shared: Shared = Arc::default();
    let slot = Arc::new(Mutex::new(Some(child)));
    let stop = Arc::new(AtomicBool::new(false));
    // The gen is taken under the stream lock, so the slot always holds the
    // newest stream started (stop_history relies on that).
    let (gen, old) = {
        let mut cur = state.stream.lock().unwrap();
        let gen = state.next_gen.fetch_add(1, Ordering::Relaxed) + 1;
        (gen, cur.replace(Stream { gen, shared: shared.clone(), child: slot.clone(), stop: stop.clone() }))
    };
    if let Some(old) = old {
        old.kill();
    }
    std::thread::spawn(move || read_log(stdout, stderr, shared, slot, stop));

    // Both run while git walks the history, so they add no wait of their own.
    let repo2 = repo.clone();
    let remotes = tauri::async_runtime::spawn_blocking(move || git(&repo2, &["remote"]));
    let refs = tauri::async_runtime::spawn_blocking(move || list_refs(&repo, &dirs));
    let remotes = remotes.await.map_err(|e| e.to_string())??
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let refs = refs.await.map_err(|e| e.to_string())??;

    Ok(StreamInfo { gen, remotes, fingerprint, refs })
}

/// The UI left the repo (another tab, a New tab, the last tab closed, a load
/// that failed or waits for a fetch): git stops and the history read so far
/// is freed, unless a newer stream than `gen` has started meanwhile.
#[tauri::command]
fn stop_history(gen: u64, state: State<'_, AppState>) {
    stop_stream(&state.stream, gen);
}

/// Commits that appeared since the caller's snapshot: everything reachable
/// from the current refs but not from `exclude` (the caller's old tips),
/// plus a fresh ref snapshot. Does not touch the history stream, so pages
/// past the loaded rows keep coming from it.
#[tauri::command]
async fn sync_history(path: String, exclude: Vec<String>, hidden: Vec<String>, solo: Vec<String>, limit: usize, state: State<'_, AppState>) -> Result<SyncInfo, String> {
    if let Some(bad) = exclude.iter().find(|s| !is_sha(s)) {
        return Err(format!("not a commit id: {bad}"));
    }
    let revs = rev_args(&hidden, &solo)?;
    let dirs = dirs_for(&state, &path)?;
    if fetch::is_busy(&state, &dirs) {
        return Err(fetch::BUSY.into());
    }
    let repo = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let fingerprint_before = fingerprint(&dirs);

        // Old tips go through stdin: git/git alone has ~1000 tags, more than
        // the Windows command line can hold.
        let n = (limit + 1).to_string();
        let mut args = vec!["log", "--date-order", "-n", &n, LOG_FORMAT, "--stdin"];
        args.extend(revs.iter().map(String::as_str));
        let mut child = git_command(&repo, &args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(spawn_error)?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let feeder = std::thread::spawn(move || {
            use std::io::Write;
            let text: String = exclude.iter().map(|s| format!("^{s}\n")).collect();
            let _ = stdin.write_all(text.as_bytes());
        });
        let refs = list_refs(&repo, &dirs);
        let _ = feeder.join();
        let out = child.wait_with_output().map_err(spawn_error)?;
        let fingerprint_after = fingerprint(&dirs);

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let empty = err.contains("bad revision 'HEAD'") || err.contains("ambiguous argument 'HEAD'");
            if !empty {
                let msg = err.trim();
                return Err(if msg.is_empty() { "git log exited with an error.".into() } else { msg.into() });
            }
        }
        let log = String::from_utf8_lossy(&out.stdout).into_owned();
        let over = log.bytes().filter(|&b| b == RS).count() > limit;
        Ok(SyncInfo { fingerprint_before, fingerprint_after, refs: refs?, log, over })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Records [start, start + count) of stream `gen`, waiting for git if they
/// have not been read yet.
#[tauri::command]
async fn history_page(gen: u64, start: usize, count: usize, state: State<'_, AppState>) -> Result<Page, String> {
    let shared = match &*state.stream.lock().unwrap() {
        Some(s) if s.gen == gen => s.shared.clone(),
        _ => return Err("stale".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (lock, cvar) = &*shared;
        let want = start.saturating_add(count);
        let deadline = Instant::now() + PAGE_WAIT;
        let mut s = lock.lock().unwrap();
        // Wait for one record past the page (or the end), so `more` is exact
        // even when the page ends right where the history does.
        while s.ends.len() <= want && !s.done {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { break }
            s = cvar.wait_timeout(s, left).unwrap().0;
        }
        if let Some(e) = &s.error {
            return Err(e.clone());
        }
        let len = s.ends.len();
        let (a, b) = (start.min(len), want.min(len));
        let from = if a == 0 { 0 } else { s.ends[a - 1] };
        let to = if b == 0 { 0 } else { s.ends[b - 1] };
        Ok(Page {
            log: String::from_utf8_lossy(&s.buf[from..to]).into_owned(),
            more: !(s.done && b >= len),
            capped: s.capped,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Full message and changed files of one commit, fetched when it is
/// selected. Merges are compared with their first parent.
#[tauri::command]
async fn commit_detail(path: String, sha: String) -> Result<CommitDetail, String> {
    if !is_sha(&sha) {
        return Err(format!("not a commit id: {sha}"));
    }
    let repo = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let out = git_command(
            &repo,
            &[
                "show", "--no-color",
                // Never run diff drivers or textconv programs named in a repo's config.
                "--no-ext-diff", "--no-textconv",
                "--diff-merges=first-parent", "-M",
                "--format=%B%x1e", "--raw", "--numstat", "-z",
                &sha,
            ],
        )
        .stdin(Stdio::null())
        .output()
        .map_err(spawn_error)?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if msg.is_empty() { "git show exited with an error.".into() } else { msg });
        }
        Ok(parse_detail(&out.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ---------- work in progress (uncommitted changes) ---------- */

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct WorkFile {
    path: String,
    /// Source of a staged rename or copy.
    old_path: Option<String>,
    /// Index against HEAD: A, M, D, R, C, T; empty when unchanged.
    staged: String,
    /// Work tree against the index: M, D, T, or "?" for untracked; empty when unchanged.
    unstaged: String,
    /// Unmerged path (merge conflict).
    conflict: bool,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct WorkStatus {
    files: Vec<WorkFile>,
    /// Number of changed paths; can exceed `files.len()` (see MAX_FILES).
    total: usize,
}

/// Parses `git status --porcelain=v2 -z`. Records are NUL-separated:
/// "1 XY sub mH mI mW hH hI path", "2 XY sub mH mI mW hH hI Xscore path"
/// followed by the source path as its own record, "u XY sub m1 m2 m3 mW h1
/// h2 h3 path" and "? path". The path is the last field, so it may contain
/// spaces.
fn parse_status(out: &[u8]) -> WorkStatus {
    let side = |c: char| if c == '.' { String::new() } else { c.to_string() };
    let mut recs = out.split(|&b| b == 0);
    let (mut files, mut total) = (Vec::new(), 0);
    while let Some(rec) = recs.next() {
        let rec = String::from_utf8_lossy(rec);
        let (kind, fields) = match rec.as_bytes().first() {
            Some(b'1') => (1, 9),
            Some(b'2') => (2, 10),
            Some(b'u') => (3, 11),
            Some(b'?') => (4, 2),
            _ => continue, // "# ..." headers, "! ..." ignored files
        };
        let f: Vec<&str> = rec.splitn(fields, ' ').collect();
        if f.len() != fields {
            continue;
        }
        let path = f[fields - 1].to_string();
        let old_path = if kind == 2 { recs.next().map(|p| String::from_utf8_lossy(p).into_owned()) } else { None };
        let xy: Vec<char> = f[1].chars().collect();
        let file = match kind {
            4 => WorkFile { path, old_path, staged: String::new(), unstaged: "?".into(), conflict: false },
            3 => WorkFile { path, old_path, staged: String::new(), unstaged: String::new(), conflict: true },
            _ if xy.len() == 2 => WorkFile { path, old_path, staged: side(xy[0]), unstaged: side(xy[1]), conflict: false },
            _ => continue,
        };
        total += 1;
        if files.len() < MAX_FILES {
            files.push(file);
        }
    }
    WorkStatus { files, total }
}

/// Uncommitted changes for the WIP row. This is the one command that looks
/// at the work tree, so it is kept from writing to the repo:
/// GIT_OPTIONAL_LOCKS=0 stops status from refreshing the index file, and
/// core.fsmonitor=false stops it from starting a file-monitor program.
/// Clean filters the user configured (git-lfs, for example) can still run
/// on files whose timestamps changed, as with any `git status`.
#[tauri::command]
async fn work_status(path: String) -> Result<WorkStatus, String> {
    let repo = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = git_command(
            &repo,
            &[
                "-c", "core.fsmonitor=false",
                "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty",
            ],
        );
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
        let out = output_within(cmd, Duration::from_secs(30), "git status took too long; the work tree may be very large.")?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            // A bare repository has no work tree, so nothing is in progress.
            if err.contains("work tree") {
                return Ok(WorkStatus { files: vec![], total: 0 });
            }
            return Err(err.trim().to_string());
        }
        Ok(parse_status(&out.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ---------- file diffs ---------- */

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct FileDiff {
    /// Unified diff text (git's own, or built here for an untracked file).
    patch: String,
    /// Cut at MAX_DIFF_BYTES.
    truncated: bool,
}

/// Larger diffs are cut; a generated file at full context can be megabytes.
const MAX_DIFF_BYTES: usize = 4 << 20;
/// Untracked files bigger than this are not shown.
const MAX_UNTRACKED: u64 = 2 << 20;

/// Keeps a byte buffer under the cap without splitting a UTF-8 character.
fn cap_text(mut b: Vec<u8>, cap: usize) -> (String, bool) {
    let cut = b.len() > cap;
    if cut {
        let mut end = cap;
        while end > 0 && (b[end] & 0xC0) == 0x80 {
            end -= 1;
        }
        b.truncate(end);
    }
    (String::from_utf8_lossy(&b).into_owned(), cut)
}

/// A path inside the work tree, given relative with "/" separators as git
/// prints it. Anything absolute or climbing out with ".." is refused.
fn worktree_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let bad = rel.is_empty()
        || rel.starts_with('/')
        || rel.contains('\\')
        || rel.contains(':')
        || rel.split('/').any(|c| c.is_empty() || c == "." || c == "..");
    if bad {
        return Err(format!("not a path inside the repository: {rel}"));
    }
    Ok(root.join(rel))
}

/// A synthetic all-added diff for an untracked file, so the UI parses one
/// format. Symbolic links show their target instead of being followed.
fn untracked_patch(root: &Path, rel: &str) -> Result<FileDiff, String> {
    let p = worktree_path(root, rel)?;
    let meta = std::fs::symlink_metadata(&p).map_err(|e| format!("Could not read {rel}: {e}"))?;
    let header = format!("diff --git a/{rel} b/{rel}\nnew file\n--- /dev/null\n+++ b/{rel}\n");
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&p).map(|t| t.display().to_string()).unwrap_or_default();
        return Ok(FileDiff { patch: format!("{header}@@ -0,0 +1 @@\n+{target}\n\\ No newline at end of file\n"), truncated: false });
    }
    if !meta.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    // A symlinked folder on the way could still lead outside the work tree.
    let inside = match (p.canonicalize(), root.canonicalize()) {
        (Ok(f), Ok(r)) => f.starts_with(r),
        _ => false,
    };
    if !inside {
        return Err(format!("{rel} is outside the repository"));
    }
    if meta.len() > MAX_UNTRACKED {
        return Ok(FileDiff { patch: format!("{header}Large file ({} KB) not shown\n", meta.len() / 1024), truncated: false });
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("Could not read {rel}: {e}"))?;
    // git's rule: a NUL in the first 8000 bytes means binary.
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Ok(FileDiff { patch: format!("diff --git a/{rel} b/{rel}\nnew file\nBinary files /dev/null and b/{rel} differ\n"), truncated: false });
    }
    let (text, truncated) = cap_text(bytes, MAX_DIFF_BYTES);
    if text.is_empty() {
        return Ok(FileDiff { patch: header, truncated });
    }
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut patch = format!("{header}@@ -0,0 +1,{} @@\n", lines.len());
    for l in &lines {
        patch.push('+');
        patch.push_str(l);
    }
    if !text.ends_with('\n') {
        patch.push_str("\n\\ No newline at end of file\n");
    }
    Ok(FileDiff { patch, truncated })
}

/// One file's diff. kind: "commit" (also a stash: against its first parent,
/// like the detail card), "staged" (index against HEAD), "unstaged" (work
/// tree against the index) or "untracked".
fn file_diff_in(repo: &Path, kind: &str, sha: Option<&str>, file: &str, old_file: Option<&str>, context: u32) -> Result<FileDiff, String> {
    if kind == "untracked" {
        return untracked_patch(repo, file);
    }
    let u = format!("-U{}", context.min(1_000_000));
    // Literal pathspecs: a file named "[a].txt" must not also match "a.txt".
    let mut args: Vec<&str> = vec!["--literal-pathspecs", "-c", "core.fsmonitor=false"];
    match kind {
        "commit" => {
            let sha = sha.filter(|s| is_sha(s)).ok_or("not a commit id")?;
            args.extend(["show", "--format=", "--diff-merges=first-parent", "-M", sha]);
        }
        "staged" => args.extend(["diff", "--cached", "-M"]),
        "unstaged" => args.push("diff"),
        _ => return Err(format!("unknown diff kind: {kind}")),
    }
    // Never run diff drivers or textconv programs named in a repo's config.
    args.extend(["--no-color", "--no-ext-diff", "--no-textconv", &u, "--"]);
    // Both sides of a rename, or -M sees only an added file.
    if let Some(o) = old_file.filter(|o| *o != file) {
        args.push(o);
    }
    args.push(file);
    let mut cmd = git_command(repo, &args);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    let out = output_within(cmd, Duration::from_secs(30), "git took too long to make this diff.")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { "git exited with an error.".into() } else { err });
    }
    let (patch, truncated) = cap_text(out.stdout, MAX_DIFF_BYTES);
    Ok(FileDiff { patch, truncated })
}

#[tauri::command]
async fn file_diff(path: String, kind: String, sha: Option<String>, file: String, old_file: Option<String>, context: u32) -> Result<FileDiff, String> {
    let repo = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || file_diff_in(&repo, &kind, sha.as_deref(), &file, old_file.as_deref(), context))
        .await
        .map_err(|e| e.to_string())?
}

/* ---------- stashes ---------- */

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct Stash {
    sha: String,
    /// The commit it was made on, the index commit, and the untracked-files
    /// commit when made with `-u`.
    parents: Vec<String>,
    /// stash@{n}
    name: String,
    #[cfg_attr(test, ts(type = "number"))]
    time: i64,
    /// Reflog subject: "WIP on main: 1a2b3c4 subject" or "On main: message".
    message: String,
}

const STASH_FORMAT: &str = "--format=%H%x1f%P%x1f%gd%x1f%ct%x1f%gs%x1e";

fn parse_stashes(out: &[u8]) -> Vec<Stash> {
    out.split(|&b| b == RS)
        .filter_map(|rec| {
            let rec = String::from_utf8_lossy(rec);
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            let [sha, parents, name, time, message] = f[..] else { return None };
            if !is_sha(sha) {
                return None;
            }
            Some(Stash {
                sha: sha.into(),
                parents: parents.split(' ').filter(|p| !p.is_empty()).map(Into::into).collect(),
                name: name.into(),
                time: time.parse().unwrap_or(0),
                message: message.into(),
            })
        })
        .collect()
}

#[tauri::command]
async fn list_stashes(path: String) -> Result<Vec<Stash>, String> {
    let repo = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let out = git_command(&repo, &["stash", "list", STASH_FORMAT])
            .stdin(Stdio::null())
            .output()
            .map_err(spawn_error)?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(parse_stashes(&out.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ---------- pull requests (Azure DevOps, through the az CLI) ----------
   Uses the account the user signed in with `az login`; GitKrapao never sees or
   stores a token. */

#[derive(Debug, PartialEq)]
struct AzureRepo {
    /// https://dev.azure.com/{org} or https://{org}.visualstudio.com
    org_url: String,
    project: String,
    repo: String,
}

fn pct_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn pct_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Understands every remote URL form Azure DevOps hands out:
/// https://[user@]dev.azure.com/org/project/_git/repo,
/// https://org.visualstudio.com/[DefaultCollection/]project/_git/repo,
/// git@ssh.dev.azure.com:v3/org/project/repo and
/// org@vs-ssh.visualstudio.com:v3/org/project/repo.
/// Credentials embedded in the URL are dropped.
fn parse_azure_remote(url: &str) -> Option<AzureRepo> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    for (host, new_style) in [("ssh.dev.azure.com", true), ("vs-ssh.visualstudio.com", false)] {
        let Some(at) = lower.find(host) else { continue };
        let rest = &url[at + host.len()..];
        let v3 = rest.find("v3/")?;
        let parts: Vec<&str> = rest[v3 + 3..].trim_end_matches('/').split('/').collect();
        let [org, project, repo] = parts[..] else { return None };
        let org_url = if new_style { format!("https://dev.azure.com/{org}") } else { format!("https://{org}.visualstudio.com") };
        return Some(AzureRepo { org_url, project: pct_decode(project), repo: pct_decode(repo) });
    }

    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let rest = rest.split(['?', '#']).next()?;
    let (authority, path) = rest.split_once('/')?;
    let host = authority.rsplit('@').next()?.split(':').next()?.to_ascii_lowercase();
    let segs: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    let g = segs.iter().position(|s| *s == "_git")?;
    let mut repo = *segs.get(g + 1)?;
    if repo == "_optimized" || repo == "_full" {
        repo = segs.get(g + 2)?;
    }
    let before: Vec<&str> = segs[..g].to_vec();
    let (org_url, project) = if host == "dev.azure.com" {
        match before[..] {
            [org, project] => (format!("https://dev.azure.com/{org}"), project),
            [org] => (format!("https://dev.azure.com/{org}"), repo), // project named like the repo
            _ => return None,
        }
    } else if let Some(org) = host.strip_suffix(".visualstudio.com") {
        let before: Vec<&str> = before.into_iter().filter(|s| !s.eq_ignore_ascii_case("DefaultCollection")).collect();
        match before[..] {
            [project] => (format!("https://{org}.visualstudio.com"), project),
            [] => (format!("https://{org}.visualstudio.com"), repo),
            _ => return None,
        }
    } else {
        return None;
    };
    Some(AzureRepo { org_url, project: pct_decode(project), repo: pct_decode(repo) })
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct Reviewer {
    name: String,
    /// 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected
    #[cfg_attr(test, ts(type = "number"))]
    vote: i64,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct PullRequest {
    #[cfg_attr(test, ts(type = "number"))]
    id: u64,
    title: String,
    description: String,
    author: String,
    /// ISO 8601, as Azure DevOps reports it.
    created: String,
    /// Full ref names, e.g. refs/heads/feature/login.
    source: String,
    target: String,
    draft: bool,
    /// succeeded, conflicts, rejectedByPolicy, queued, failure, notSet
    merge_status: String,
    source_sha: Option<String>,
    reviewers: Vec<Reviewer>,
    url: String,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
struct PrList {
    /// "org/project/repo" of the Azure DevOps remote; None when the repo has none.
    repo: Option<String>,
    items: Vec<PullRequest>,
}

fn parse_prs(json: &[u8], r: &AzureRepo) -> Result<Vec<PullRequest>, String> {
    let v: serde_json::Value = serde_json::from_slice(json).map_err(|_| "az returned something GitKrapao could not read.".to_string())?;
    let list = v.as_array().ok_or("az returned something GitKrapao could not read.")?;
    let text = |x: &serde_json::Value| x.as_str().unwrap_or("").to_string();
    let base = format!("{}/{}/_git/{}/pullrequest/", r.org_url, pct_encode(&r.project), pct_encode(&r.repo));
    Ok(list
        .iter()
        .filter_map(|p| {
            let id = p["pullRequestId"].as_u64()?;
            let description: String = text(&p["description"]).chars().take(4000).collect();
            Some(PullRequest {
                id,
                title: text(&p["title"]),
                description,
                author: text(&p["createdBy"]["displayName"]),
                created: text(&p["creationDate"]),
                source: text(&p["sourceRefName"]),
                target: text(&p["targetRefName"]),
                draft: p["isDraft"].as_bool().unwrap_or(false),
                merge_status: text(&p["mergeStatus"]),
                source_sha: p["lastMergeSourceCommit"]["commitId"].as_str().filter(|s| is_sha(s)).map(Into::into),
                reviewers: p["reviewers"]
                    .as_array()
                    .map(|a| a.iter().map(|x| Reviewer { name: text(&x["displayName"]), vote: x["vote"].as_i64().unwrap_or(0) }).collect())
                    .unwrap_or_default(),
                url: format!("{base}{id}"),
            })
        })
        .collect())
}

/// az is a .cmd script on Windows, which Command does not look up on PATH.
fn find_az() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["az.cmd", "az.exe", "az.bat"] } else { &["az"] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if cfg!(windows) {
        for base in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(b) = std::env::var_os(base) {
                dirs.push(PathBuf::from(b).join("Microsoft SDKs").join("Azure").join("CLI2").join("wbin"));
            }
        }
    }
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// Output of `run_limited`. `status` is None when the process was killed.
struct Limited {
    status: Option<ExitStatus>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
    elapsed: Duration,
}

/// Runs a command for at most `limit`. On timeout it kills the whole process
/// tree: `git` on PATH is often a launcher (Git\cmd\git.exe) whose real git,
/// ssh and remote helpers would outlive a plain `kill`. Each stream keeps at
/// most `max` bytes. Once the process is gone, readers get 2 s to finish, so
/// a grandchild that still holds a pipe open cannot hang the caller.
/// `pid_slot` holds the PID while it runs (to stop it when the app exits).
fn run_limited(mut cmd: Command, limit: Duration, max: usize, pid_slot: Option<&Mutex<Option<u32>>>) -> std::io::Result<Limited> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let start = Instant::now();
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    if let Some(slot) = pid_slot {
        *slot.lock().unwrap() = Some(child.id());
    }
    let (tx, rx) = mpsc::channel::<()>();
    let read = |mut r: Box<dyn Read + Send>, tx: mpsc::Sender<()>| {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let b = buf.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = r.read(&mut chunk) {
                if n == 0 { break }
                let mut b = b.lock().unwrap();
                let room = max.saturating_sub(b.len());
                b.extend_from_slice(&chunk[..n.min(room)]);
            }
            let _ = tx.send(());
        });
        buf
    };
    // Both pipes were requested above.
    let out = read(Box::new(child.stdout.take().expect("piped stdout")), tx.clone());
    let err = read(Box::new(child.stderr.take().expect("piped stderr")), tx);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if start.elapsed() > limit => {
                timed_out = true;
                kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                if let Some(slot) = pid_slot { *slot.lock().unwrap() = None; }
                return Err(e);
            }
        }
    };
    if let Some(slot) = pid_slot {
        *slot.lock().unwrap() = None;
    }
    let elapsed = start.elapsed();
    let deadline = Instant::now() + Duration::from_secs(2);
    for _ in 0..2 {
        if rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() { break }
    }
    let take = |b: Arc<Mutex<Vec<u8>>>| std::mem::take(&mut *b.lock().unwrap());
    Ok(Limited { status, stdout: take(out), stderr: take(err), timed_out, elapsed })
}

/// Kills a process and everything it started.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        // Absolute path, so a taskkill.exe in the repo or on PATH is never run.
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let mut k = Command::new(root.join("System32").join("taskkill.exe"));
        k.args(["/T", "/F", "/PID", &pid.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        no_window(&mut k);
        let _ = k.status();
    }
    #[cfg(unix)]
    {
        // run_limited put the child in its own process group.
        let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).stdin(Stdio::null()).stderr(Stdio::null()).status();
    }
}

/// Runs a command, giving up after `limit` so a hung CLI never blocks the panel.
fn output_within(cmd: Command, limit: Duration, slow: &str) -> Result<std::process::Output, String> {
    let name = std::path::Path::new(cmd.get_program()).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let r = run_limited(cmd, limit, usize::MAX, None).map_err(|e| format!("Could not run {name}: {e}"))?;
    match r.status {
        Some(status) => Ok(std::process::Output { status, stdout: r.stdout, stderr: r.stderr }),
        None => Err(slow.into()),
    }
}

/// Turns az's output into one actionable line. Takes stdout and stderr
/// together: az writes its questions ("install the extension now?") to
/// stdout and only the resulting traceback to stderr.
fn az_error(output: &str) -> String {
    let s = output.trim();
    let l = s.to_ascii_lowercase();
    if (l.contains("extension") && l.contains("azure-devops")) || l.contains("'repos' is misspelled") {
        "Install the Azure DevOps extension: run `az extension add --name azure-devops`, then press Refresh.".into()
    } else if l.contains("az login") || l.contains("az devops login") {
        "Sign in first: run `az login` in a terminal, then press Refresh.".into()
    } else if l.contains("eof when reading a line") {
        "az is waiting for an answer GitKrapao cannot give. Run `az repos pr list` once in a terminal, then press Refresh.".into()
    } else {
        s.lines()
            .map(|x| x.trim().trim_start_matches("ERROR:").trim())
            .find(|x| !x.is_empty() && !x.contains("unexpected error") && !x.starts_with("Traceback"))
            .unwrap_or("az exited with an error.")
            .to_string()
    }
}

/// Active pull requests of the repo's Azure DevOps remote (origin first).
#[tauri::command]
async fn pull_requests(path: String) -> Result<PrList, String> {
    let repo = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let urls = git(&repo, &["config", "--get-regexp", r"^remote\..*\.url$"]).unwrap_or_default();
        let mut remotes: Vec<(String, AzureRepo)> = urls
            .lines()
            .filter_map(|l| {
                let (key, url) = l.split_once(' ')?;
                let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
                Some((name.to_string(), parse_azure_remote(url)?))
            })
            .collect();
        remotes.sort_by_key(|(n, _)| n != "origin");
        let Some((_, r)) = remotes.into_iter().next() else {
            return Ok(PrList { repo: None, items: vec![] });
        };
        let az = find_az().ok_or("Install the Azure CLI (az) to see pull requests.")?;
        let mut cmd = Command::new(az);
        cmd.args([
            "repos", "pr", "list",
            "--organization", &r.org_url, "--project", &r.project, "--repository", &r.repo,
            "--status", "active", "--top", "200", "--detect", "false",
            "--output", "json", "--only-show-errors",
        ]);
        no_window(&mut cmd);
        let out = output_within(cmd, Duration::from_secs(45), "az took too long to answer. Check your network and try Refresh.")?;
        if !out.status.success() {
            let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            return Err(az_error(&text));
        }
        let name = format!("{}/{}/{}", r.org_url.trim_start_matches("https://"), r.project, r.repo);
        Ok(PrList { repo: Some(name), items: parse_prs(&out.stdout, &r)? })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a pull request page in the default browser. Only Azure DevOps
/// https URLs made of plain URL characters are accepted.
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    let ok_host = url.strip_prefix("https://").and_then(|r| r.split('/').next()).is_some_and(|h| {
        h == "dev.azure.com" || h.strip_suffix(".visualstudio.com").is_some_and(|o| !o.is_empty() && o.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
    });
    let ok_chars = url.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~%/:".contains(&b));
    if !ok_host || !ok_chars {
        return Err("GitKrapao only opens Azure DevOps links.".into());
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    no_window(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not open the browser: {e}"))
}

/// Parses `for-each-ref --format=%(refname:strip=2)%00%(upstream)%00%(upstream:track,nobracket)`.
/// The track field is "", "gone", "ahead N", "behind N" or "ahead N, behind M".
fn parse_tracking(out: &str) -> Vec<Track> {
    let mut list = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split('\0').collect();
        let [name, upstream, track] = f[..] else { continue };
        if upstream.is_empty() {
            continue;
        }
        let (mut ahead, mut behind) = (0, 0);
        for part in track.split(", ") {
            if let Some(n) = part.strip_prefix("ahead ") { ahead = n.parse().unwrap_or(0) }
            if let Some(n) = part.strip_prefix("behind ") { behind = n.parse().unwrap_or(0) }
        }
        list.push(Track { name: name.into(), upstream: upstream.into(), ahead, behind, gone: track == "gone" });
    }
    list
}

/// Ahead/behind counts for local branches that have an upstream. Asked for
/// separately, after the graph is up, since counting can walk far back on
/// branches that diverged long ago.
#[tauri::command]
async fn branch_tracking(path: String) -> Result<Vec<Track>, String> {
    let repo = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let out = git(
            &repo,
            &[
                "for-each-ref",
                "--format=%(refname:strip=2)%00%(upstream)%00%(upstream:track,nobracket)",
                "refs/heads",
            ],
        )?;
        Ok(parse_tracking(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
/// None while an operation runs in the repo: its refs are changing, so the
/// caller skips this poll.
async fn repo_fingerprint(path: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let dirs = dirs_for(&state, &path)?;
    Ok((!fetch::is_busy(&state, &dirs)).then(|| fingerprint(&dirs)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        // The window starts hidden (tauri.conf.json): WebView2 paints white for
        // a second or more before the page is up, a big white box over a dark
        // theme. Show it once the page has loaded, or after 5 s whatever happens.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.window().show();
            }
        })
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(5));
                    let _ = w.show();
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pick_repo, open_repo, start_history, stop_history, history_page, sync_history, commit_detail, file_diff, branch_tracking, work_status, list_stashes, pull_requests, open_url, repo_fingerprint, fetch::fetch, fetch::list_remotes, switch::switch_branch, create::create_branch, create::create_tag])
        .build(tauri::generate_context!())
        .expect("error while building GitKrapao")
        .run(|app, event| {
            // Closing while an operation runs would kill git mid-way (a switch
            // can leave the work tree half updated), so ask first.
            if let RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } = &event {
                if label == "main" {
                    let state = app.state::<AppState>();
                    if let Some(text) = fetch::close_warning(&state.busy_repos) {
                        api.prevent_close();
                        // A second click while the dialog is open stays prevented
                        // but must not open a second dialog.
                        if !state.closing_prompt.swap(true, Ordering::SeqCst) {
                            let app = app.clone();
                            // ask_native blocks until answered: never on the event loop.
                            std::thread::spawn(move || {
                                let close = fetch::ask_native(&app, "GitKrapao: operations still running", "Close anyway", &text);
                                let state = app.state::<AppState>();
                                state.closing_prompt.store(false, Ordering::SeqCst);
                                if close {
                                    for pid in fetch::running_pids(&state.busy_repos) {
                                        kill_tree(pid);
                                    }
                                    // destroy does not raise CloseRequested again;
                                    // RunEvent::Exit then cleans up as usual.
                                    if let Some(w) = app.get_webview_window("main") {
                                        let _ = w.destroy();
                                    }
                                }
                            });
                        }
                    }
                }
            }
            // Don't leave a git process running after the window closes.
            if let RunEvent::Exit = event {
                let state = app.state::<AppState>();
                if let Some(s) = state.stream.lock().unwrap().as_ref() {
                    s.kill();
                }
                for pid in fetch::running_pids(&state.busy_repos) {
                    kill_tree(pid);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Linked worktrees of one repo have different paths but share the lock key,
    // so a fetch in one blocks a fetch in the other.
    #[test]
    fn repo_info_carries_the_shared_lock_key() {
        let dir = std::env::temp_dir().join(format!("gitkrapao-lockkey-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let global = dir.join("empty-global");
        std::fs::write(&global, "").unwrap();
        let main_dir = dir.join("main");
        let wt_dir = dir.join("wt");
        std::fs::create_dir_all(&main_dir).unwrap();
        let run = |args: &[&str]| {
            let mut cmd = git_command(&main_dir, args);
            cmd.env("GIT_CONFIG_GLOBAL", &global).env("GIT_CONFIG_NOSYSTEM", "1");
            let out = cmd.output().unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        run(&["init", "-q", "-b", "main"]);
        let tree = run(&["hash-object", "-t", "tree", "-w", "--stdin"]); // empty tree (stdin is null)
        let c = run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", &tree, "-m", "root"]);
        run(&["update-ref", "refs/heads/main", &c]);
        run(&["worktree", "add", "-q", "--detach", &wt_dir.to_string_lossy(), "main"]);

        let state = AppState::default();
        let m = resolve_repo(&state, &main_dir).unwrap();
        let w = resolve_repo(&state, &wt_dir).unwrap();
        assert_eq!(m.lock_key, w.lock_key);
        assert_ne!(m.path, w.path);
        assert!(!m.lock_key.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Real `git show` output for a commit that adds, modifies, deletes and
    // renames files, including a binary file, a Thai path and a space.
    #[test]
    fn parses_every_kind_of_change() {
        let d = parse_detail(include_bytes!("../tests/fixtures/show-many-kinds.bin"));
        assert!(d.body.starts_with("Second: many kinds of change\n\nBody line 1"));
        assert!(d.body.ends_with("- bullet สอง ภาษาไทย"));
        let got: Vec<_> = d.files.iter()
            .map(|f| (f.status.as_str(), f.path.as_str(), f.old_path.as_deref(), f.add, f.del))
            .collect();
        assert_eq!(got, vec![
            ("D", "gone.txt", None, Some(0), Some(1)),
            ("A", "img.bin", None, None, None),
            ("M", "keep.txt", None, Some(2), Some(1)),
            ("R", "moved.txt", Some("move-me.txt"), Some(0), Some(0)),
            ("A", "with space.txt", None, Some(1), Some(0)),
            ("M", "เอกสาร/ไฟล์ไทย.md", None, Some(1), Some(1)),
        ]);
        assert_eq!((d.total_files, d.add, d.del), (6, 4, 3));
    }

    #[test]
    fn merge_against_first_parent() {
        let d = parse_detail(include_bytes!("../tests/fixtures/show-merge.bin"));
        assert_eq!(d.body, "Merge side");
        assert_eq!(d.files.len(), 1);
        assert_eq!((d.files[0].status.as_str(), d.files[0].path.as_str(), d.files[0].add), ("A", "side.txt", Some(1)));
    }

    #[test]
    fn empty_commit_has_no_files() {
        let d = parse_detail(b"Only a message\n\x1e\0");
        assert_eq!((d.body.as_str(), d.files.len(), d.total_files), ("Only a message", 0, 0));
    }

    #[test]
    fn hidden_branches_become_excludes() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(rev_args(&[], &[]).unwrap(), s(&["--branches", "--remotes", "--tags", "HEAD"]));
        let got = rev_args(&s(&["refs/remotes/origin/", "refs/heads/feature/ไทย", "refs/heads/old/"]), &[]).unwrap();
        assert_eq!(got, s(&["--exclude=feature/ไทย", "--exclude=old/*", "--branches", "--exclude=origin/*", "--remotes", "--tags", "HEAD"]));
        for bad in ["refs/tags/v1", "HEAD", "refs/heads/", "refs/heads/a*", "refs/heads/a\nb", "--all"] {
            assert!(rev_args(&s(&[bad]), &[]).is_err(), "{bad:?} should be refused");
            assert!(rev_args(&[], &s(&[bad])).is_err(), "{bad:?} should be refused for solo");
        }
        let many: Vec<String> = (0..2000).map(|i| format!("refs/heads/branch-number-{i}")).collect();
        assert!(rev_args(&many, &[]).is_err());
    }

    // Real `git status --porcelain=v2 -z` output during a merge conflict:
    // staged add, staged + unstaged edit, staged delete, unstaged edit,
    // staged rename, conflict, untracked files in a folder and with a Thai
    // name and a space.
    #[test]
    fn parses_work_status() {
        let w = parse_status(include_bytes!("../tests/fixtures/status-v2.bin"));
        let got: Vec<_> = w.files.iter()
            .map(|f| (f.path.as_str(), f.old_path.as_deref(), f.staged.as_str(), f.unstaged.as_str(), f.conflict))
            .collect();
        assert_eq!(got, vec![
            ("added.txt", None, "A", "", false),
            ("both.txt", None, "M", "M", false),
            ("gone.txt", None, "D", "", false),
            ("keep.txt", None, "", "M", false),
            ("moved.txt", Some("move-me.txt"), "R", "", false),
            ("clash.txt", None, "", "", true),
            ("sub/untracked.md", None, "", "?", false),
            ("ไฟล์ ใหม่.txt", None, "", "?", false),
        ]);
        assert_eq!(w.total, 8);
        assert_eq!(parse_status(b"").total, 0);
    }

    // file_diff against a real repo: root commit, edit, rename (both paths),
    // merge against its first parent, binary, CRLF, literal pathspecs,
    // staged / unstaged / untracked (Thai name with a space), and refused
    // paths and inputs.
    #[test]
    fn file_diffs_against_real_git() {
        let dir = std::env::temp_dir().join(format!("gitkrapao-diff-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let mut a = vec!["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false"];
            a.extend(args);
            let out = git_command(&dir, &a).output().unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let write = |name: &str, body: &[u8]| std::fs::write(dir.join(name), body).unwrap();
        run(&["init", "-q", "-b", "main"]);
        let long: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        write("keep.txt", b"one\ntwo\nthree\n");
        write("a.txt", b"a\n");
        write("[a].txt", b"bracket\n");
        write("move-me.txt", long.as_bytes());
        write("crlf.txt", b"x\r\ny\r\n");
        write("bin.dat", b"\x00\x01\x02");
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "root"]);
        let root = run(&["rev-parse", "HEAD"]);
        write("keep.txt", b"one\nTWO\nthree\n");
        write("a.txt", b"a2\n");
        write("[a].txt", b"bracket2\n");
        run(&["mv", "move-me.txt", "moved.txt"]);
        run(&["commit", "-qam", "edit"]);
        let edit = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "-b", "side", &root]);
        write("side.txt", b"side\n");
        run(&["add", "side.txt"]);
        run(&["commit", "-q", "-m", "side"]);
        run(&["checkout", "-q", "main"]);
        run(&["merge", "-q", "--no-ff", "-m", "merge", "side"]);
        let merge = run(&["rev-parse", "HEAD"]);

        let d = |kind: &str, sha: Option<&str>, file: &str, old: Option<&str>| file_diff_in(&dir, kind, sha, file, old, 3).map(|f| f.patch);
        let root_keep = d("commit", Some(&root), "keep.txt", None).unwrap();
        assert!(root_keep.contains("new file mode") && root_keep.contains("+three"));
        let bracket = d("commit", Some(&edit), "[a].txt", None).unwrap();
        assert_eq!(bracket.matches("diff --git").count(), 1, "literal pathspec: {bracket}");
        assert!(bracket.contains("+bracket2"));
        let moved = d("commit", Some(&edit), "moved.txt", Some("move-me.txt")).unwrap();
        assert!(moved.contains("rename from move-me.txt") && moved.contains("rename to moved.txt"));
        assert!(d("commit", Some(&merge), "side.txt", None).unwrap().contains("+side"));
        assert!(d("commit", Some(&root), "bin.dat", None).unwrap().contains("Binary files"));
        assert!(d("commit", Some(&root), "crlf.txt", None).unwrap().contains("+x\r\n"));
        let full = file_diff_in(&dir, "commit", Some(&edit), "moved.txt", Some("move-me.txt"), 1_000_000).unwrap().patch;
        assert!(full.contains("rename from"));

        write("keep.txt", b"one\nSTAGED\nthree\n");
        run(&["add", "keep.txt"]);
        write("keep.txt", b"one\nSTAGED\nthree\nunstaged\n");
        let staged = d("staged", None, "keep.txt", None).unwrap();
        assert!(staged.contains("+STAGED") && !staged.contains("+unstaged"));
        let unstaged = d("unstaged", None, "keep.txt", None).unwrap();
        assert!(unstaged.contains("+unstaged") && !unstaged.contains("+STAGED"));
        write("ใหม่ ไฟล์.txt", b"hello\nno newline");
        let un = d("untracked", None, "ใหม่ ไฟล์.txt", None).unwrap();
        assert!(un.contains("@@ -0,0 +1,2 @@\n+hello\n+no newline\n\\ No newline at end of file"), "{un}");
        write("blob.bin", b"ab\x00cd");
        assert!(d("untracked", None, "blob.bin", None).unwrap().contains("Binary files"));

        for bad in ["../x", "/etc/passwd", "C:/Windows/win.ini", "a/../../x", "", "sub\\x"] {
            assert!(d("untracked", None, bad, None).is_err(), "{bad:?} should be refused");
        }
        assert!(d("commit", Some("not-a-sha"), "keep.txt", None).is_err());
        assert!(d("everything", None, "keep.txt", None).is_err());
        let (text, cut) = cap_text("ก".repeat(10).into_bytes(), 7);   // 3-byte characters
        assert_eq!((text.as_str(), cut), ("กก", true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn solo_walks_only_its_branches() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        // Solo wins over hidden; no tags, no HEAD.
        let got = rev_args(&s(&["refs/heads/x"]), &s(&["refs/heads/feature/ไทย", "refs/remotes/origin/", "refs/remotes/up/main"])).unwrap();
        assert_eq!(got, s(&["--glob=refs/[h]eads/feature/ไทย", "--glob=refs/remotes/origin/*", "--glob=refs/[r]emotes/up/main"]));
    }

    // The globs above, run by real git: exact refs match only themselves
    // (not longer names that start the same), Thai names match, folders take
    // every level, and a missing branch matches nothing instead of failing.
    #[test]
    fn solo_globs_against_real_git() {
        let dir = std::env::temp_dir().join(format!("gitkrapao-solo-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let out = git_command(&dir, args).env("GIT_COMMITTER_DATE", "1700000000 +0000").env("GIT_AUTHOR_DATE", "1700000000 +0000").output().unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        run(&["init", "-q", "-b", "main"]);
        let id = ["-c", "user.name=t", "-c", "user.email=t@t"];
        let commit = |msg: &str, parent: &str| {
            let tree = run(&["write-tree"]);
            let mut a = id.to_vec();
            a.extend(["commit-tree", &tree, "-m", msg]);
            if !parent.is_empty() { a.extend(["-p", parent]); }
            run(&a)
        };
        let root = commit("root", "");
        for (name, msg) in [("refs/heads/sol", "sol"), ("refs/heads/solo", "solo"), ("refs/heads/feature/ไทย", "thai"),
                            ("refs/heads/feature/a/deep", "deep"), ("refs/remotes/origin/x", "x")] {
            let c = commit(msg, &root);
            run(&["update-ref", name, &c]);
        }
        let walk = |solo: &[&str]| {
            let mut a = vec!["log".to_string(), "--format=%s".to_string()];
            a.extend(rev_args(&[], &solo.iter().map(|x| x.to_string()).collect::<Vec<_>>()).unwrap());
            let mut v: Vec<String> = run(&a.iter().map(String::as_str).collect::<Vec<_>>()).lines().map(Into::into).collect();
            v.sort();
            v.join(",")
        };
        assert_eq!(walk(&["refs/heads/sol"]), "root,sol");
        assert_eq!(walk(&["refs/heads/feature/ไทย"]), "root,thai");
        assert_eq!(walk(&["refs/heads/feature/"]), "deep,root,thai");
        assert_eq!(walk(&["refs/remotes/origin/x", "refs/heads/solo"]), "root,solo,x");
        assert_eq!(walk(&["refs/heads/gone"]), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // stop_history: the slot is emptied and the stream told to stop only when
    // it is not newer than the gen the UI asks to stop (a stop that reaches the
    // backend after the next start_history must not kill the new stream).
    #[test]
    fn stop_stream_respects_gen() {
        let mk = |gen| Stream { gen, shared: Arc::default(), child: Arc::new(Mutex::new(None)), stop: Arc::default() };
        let slot: Mutex<Option<Stream>> = Mutex::new(None);
        stop_stream(&slot, 5);   // nothing to stop: no panic, nothing happens
        assert!(slot.lock().unwrap().is_none());

        *slot.lock().unwrap() = Some(mk(7));
        let flag = slot.lock().unwrap().as_ref().unwrap().stop.clone();
        stop_stream(&slot, 6);   // a newer stream than asked: kept
        assert_eq!(slot.lock().unwrap().as_ref().map(|s| s.gen), Some(7));
        assert!(!flag.load(Ordering::SeqCst));
        stop_stream(&slot, 7);
        assert!(slot.lock().unwrap().is_none());
        assert!(flag.load(Ordering::SeqCst));

        *slot.lock().unwrap() = Some(mk(3));
        stop_stream(&slot, 9);   // older than asked: removed
        assert!(slot.lock().unwrap().is_none());
    }

    // A stopped stream stops reading at once, even when killing `git` hits
    // only a launcher and the real git keeps writing: read_log drops the pipe
    // (git then exits on a broken pipe), returns, and reports no error.
    #[test]
    fn read_log_stops_when_asked() {
        let dir = std::env::temp_dir().join(format!("gitkrapao-stop-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = git_command(&dir, &["init", "-q", "-b", "main"]).output().unwrap();
        assert!(out.status.success());
        // One commit is enough: its subject is padded to 256 kB (`%<(N)`), far more
        // than a pipe buffer holds, and the record byte comes first so read_log
        // sees a record (and the stop) before git has written the rest.
        let script = "commit refs/heads/main\ncommitter t <t@t> 1700000000 +0000\ndata 2\nx\n\n";
        let mut fi = git_command(&dir, &["fast-import", "--quiet"]).stdin(Stdio::piped()).spawn().unwrap();
        {
            use std::io::Write;
            fi.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        }
        assert!(fi.wait().unwrap().success());

        let fmt = format!("--format=%x1e{}", "%<(16000)%s".repeat(16));   // git ignores a padding over ~16k
        let mut child = git_command(&dir, &["log", &fmt, "main"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let shared: Shared = Arc::default();
        let stop = Arc::new(AtomicBool::new(true));   // stopped before the first record arrives
        let (tx, rx) = mpsc::channel();
        let (sh, slot) = (shared.clone(), Arc::new(Mutex::new(Some(child))));
        std::thread::spawn(move || {
            read_log(stdout, stderr, sh, slot, stop);
            let _ = tx.send(());
        });
        assert!(rx.recv_timeout(Duration::from_secs(30)).is_ok(), "read_log did not return after a stop");
        let s = shared.0.lock().unwrap();
        assert!(s.done && s.error.is_none() && !s.capped, "done={} error={:?}", s.done, s.error);
        assert!(s.ends.len() <= 1, "read {} records after the stop", s.ends.len());
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Real `git stash list` output: a `stash push -u -m` with a Thai message
    // (three parents) and a plain `git stash` (two).
    #[test]
    fn parses_stashes() {
        let s = parse_stashes(include_bytes!("../tests/fixtures/stash-list.bin"));
        let got: Vec<_> = s.iter().map(|s| (s.name.as_str(), s.parents.len(), s.message.as_str())).collect();
        assert_eq!(got, vec![
            ("stash@{0}", 3, "On main: งานค้าง: แก้ a"),
            ("stash@{1}", 2, "WIP on main: 9a63ede first"),
        ]);
        assert!(s.iter().all(|s| is_sha(&s.sha) && s.time > 0 && s.parents[0].starts_with("9a63ede")));
        assert!(parse_stashes(b"").is_empty());
    }

    #[test]
    fn reads_azure_remotes() {
        let r = |org: &str, project: &str, repo: &str| Some(AzureRepo { org_url: org.into(), project: project.into(), repo: repo.into() });
        let p = parse_azure_remote;
        assert_eq!(p("https://acme@dev.azure.com/acme/Acme%20Portal/_git/Web%20App"), r("https://dev.azure.com/acme", "Acme Portal", "Web App"));
        assert_eq!(p("https://user:secret@dev.azure.com/acme/Portal/_git/web/"), r("https://dev.azure.com/acme", "Portal", "web"));
        assert_eq!(p("https://dev.azure.com/acme/_git/web"), r("https://dev.azure.com/acme", "web", "web"));
        assert_eq!(p("https://dev.azure.com/acme/Portal/_git/_optimized/web"), r("https://dev.azure.com/acme", "Portal", "web"));
        assert_eq!(p("https://acme.visualstudio.com/DefaultCollection/Portal/_git/web"), r("https://acme.visualstudio.com", "Portal", "web"));
        assert_eq!(p("https://acme.visualstudio.com/Portal/_git/web"), r("https://acme.visualstudio.com", "Portal", "web"));
        assert_eq!(p("git@ssh.dev.azure.com:v3/acme/Acme%20Portal/web"), r("https://dev.azure.com/acme", "Acme Portal", "web"));
        assert_eq!(p("ssh://git@ssh.dev.azure.com:22/v3/acme/Portal/web"), r("https://dev.azure.com/acme", "Portal", "web"));
        assert_eq!(p("acme@vs-ssh.visualstudio.com:v3/acme/Portal/web"), r("https://acme.visualstudio.com", "Portal", "web"));
        assert_eq!(p("https://github.com/git/git.git"), None);
        assert_eq!(p("https://example.com/acme/webapp.git"), None);
        assert_eq!(p("https://dev.azure.com/acme/Portal/web"), None);
        assert_eq!(pct_decode("%E0%B8%81%zz%"), "ก%zz%");
    }

    #[test]
    fn parses_pull_requests() {
        let r = AzureRepo { org_url: "https://dev.azure.com/acme".into(), project: "Acme Portal".into(), repo: "Web App".into() };
        let prs = parse_prs(include_bytes!("../tests/fixtures/az-pr-list.json"), &r).unwrap();
        assert_eq!(prs.len(), 2);
        let a = &prs[0];
        assert_eq!((a.id, a.title.as_str(), a.author.as_str()), (128, "ปรับข้อความแจ้งเตือนให้ชัดเจนขึ้น", "กมล ใจดี"));
        assert_eq!((a.source.as_str(), a.target.as_str(), a.draft, a.merge_status.as_str()), ("refs/heads/feature/notifications", "refs/heads/develop", false, "succeeded"));
        assert_eq!(a.source_sha.as_deref(), Some("24a48ded788f7bf05559a8b38a741b8df0db8709"));
        assert_eq!(a.reviewers.iter().map(|x| x.vote).collect::<Vec<_>>(), vec![10, -5, 0]);
        assert_eq!(a.url, "https://dev.azure.com/acme/Acme%20Portal/_git/Web%20App/pullrequest/128");
        assert!(a.description.starts_with("แก้ข้อความแจ้งเตือน"));
        let b = &prs[1];
        assert_eq!((b.id, b.draft, b.merge_status.as_str(), b.source_sha.is_none(), b.description.as_str()), (131, true, "conflicts", true, ""));
        assert!(parse_prs(b"not json", &r).is_err());
    }

    #[test]
    fn explains_az_errors() {
        assert!(az_error("ERROR: Before you can run Azure DevOps commands, you need to run the login command (az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.").contains("az login"));
        assert!(az_error("ERROR: The command requires the extension azure-devops. It will be installed first.").contains("az extension add"));
        assert_eq!(az_error("\nERROR: TF401019: The Git repository with name or identifier web does not exist.\n"), "TF401019: The Git repository with name or identifier web does not exist.");
        assert!(az_error("ERROR: 'repos' is misspelled or not recognized by the system.").contains("az extension add"));
        assert_eq!(az_error(""), "az exited with an error.");
        // Real output with the extension missing and no terminal to ask in
        // (stdout, then stderr).
        let missing = "The command requires the extension azure-devops. Do you want to install it now? The command will continue to run after the extension is installed. (Y/n): \nERROR: The command failed with an unexpected error. Here is the traceback:\nERROR: EOF when reading a line\nTraceback (most recent call last):\nEOFError: EOF when reading a line";
        assert!(az_error(missing).contains("az extension add"));
        assert!(az_error("ERROR: The command failed with an unexpected error. Here is the traceback:\nERROR: EOF when reading a line").contains("Run `az repos pr list` once"));
    }

    // Real for-each-ref output: ahead and behind, behind only, in sync (Thai
    // name), upstream deleted on the remote, and a branch with no upstream.
    #[test]
    fn parses_tracking() {
        let t = parse_tracking(include_str!("../tests/fixtures/tracking.txt"));
        let got: Vec<_> = t.iter().map(|t| (t.name.as_str(), t.upstream.as_str(), t.ahead, t.behind, t.gone)).collect();
        assert_eq!(got, vec![
            ("ahead", "refs/remotes/origin/main", 2, 1, false),
            ("both", "refs/remotes/origin/main", 1, 1, false),
            ("feature/ไทย", "refs/remotes/origin/feature/ไทย", 0, 0, false),
            ("gone-br", "refs/remotes/origin/gone-br", 0, 0, true),
            ("main", "refs/remotes/origin/main", 0, 2, false),
        ]);
    }
}
