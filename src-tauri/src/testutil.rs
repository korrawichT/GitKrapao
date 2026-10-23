//! Test helpers shared by create and refedit: a temp repo that never sees
//! the user's own git config, with every native question recorded.

use crate::create::OpCtx;
use crate::fetch::git_env;
use crate::refedit::UndoStore;
use crate::switch::SwitchCtx;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// One `confirm` question as asked.
#[derive(Debug, Clone)]
pub(crate) struct Asked {
    pub tail: String,
    pub ok: String,
    pub cancel: String,
    pub text: String,
}

/// A repo whose main has two commits, "one" and "two", each with its own
/// a.txt. No user config leaks in; the folder is removed on drop. Trust and
/// stash questions are recorded and answered with `trust` / `stash`; confirm
/// questions are recorded and answered from `answers` (OK once it is empty),
/// after running `during` (once) as if while the dialog was open.
pub(crate) struct Fixture {
    pub dir: PathBuf,
    pub global: String,
    pub trusted: RefCell<Vec<String>>,
    pub trust: Cell<bool>,
    pub asked: RefCell<Vec<String>>,
    pub stash: Cell<bool>,
    pub limit: Cell<Duration>,
    pub confirms: RefCell<Vec<Asked>>,
    pub answers: RefCell<VecDeque<bool>>,
    #[allow(clippy::type_complexity)]
    pub during: RefCell<Option<Box<dyn FnOnce(&Fixture)>>>,
}

impl Fixture {
    /// `name` must be unique across every test of the crate (they share one
    /// process id and run in parallel): prefix it with the module.
    pub(crate) fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("gitkrapao-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        let global = dir.join("empty-global").to_string_lossy().replace('\\', "/");
        std::fs::write(&global, "").unwrap();
        let f = Fixture {
            dir, global, trusted: RefCell::new(vec![]), trust: Cell::new(true), asked: RefCell::new(vec![]), stash: Cell::new(true),
            limit: Cell::new(Duration::from_secs(60)), confirms: RefCell::new(vec![]), answers: RefCell::new(VecDeque::new()),
            during: RefCell::new(None),
        };
        f.git(&["init", "-q", "-b", "main"]);
        f.write("a.txt", "one\n");
        f.git(&["add", "-A"]);
        f.git(&["commit", "-q", "-m", "one"]);
        f.write("a.txt", "two\n");
        f.git(&["commit", "-q", "-am", "two"]);
        f
    }
    pub(crate) fn repo(&self) -> PathBuf { self.dir.join("repo") }
    pub(crate) fn top(&self) -> String { self.repo().to_string_lossy().into_owned() }
    pub(crate) fn env(&self) -> Vec<(&str, &str)> {
        vec![
            ("GIT_CONFIG_GLOBAL", self.global.as_str()),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"),
            ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@t"),
        ]
    }
    pub(crate) fn git(&self, args: &[&str]) -> String { self.git_in(&self.repo(), args) }
    pub(crate) fn git_in(&self, dir: &Path, args: &[&str]) -> String {
        let out = git_env(dir, args, &self.env()).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
    pub(crate) fn fails(&self, args: &[&str]) -> bool {
        !git_env(&self.repo(), args, &self.env()).output().unwrap().status.success()
    }
    pub(crate) fn write(&self, name: &str, body: &str) {
        std::fs::write(self.repo().join(name), body).unwrap();
    }
    pub(crate) fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.repo().join(name)).unwrap_or_default()
    }
    /// Full hash of a revision.
    pub(crate) fn sha(&self, rev: &str) -> String { self.git(&["rev-parse", rev]) }
    pub(crate) fn head(&self) -> String { self.git(&["symbolic-ref", "-q", "HEAD"]) }
    pub(crate) fn refs(&self, prefix: &str) -> String { self.git(&["for-each-ref", "--format=%(refname)", prefix]) }
    /// A new commit on the checked-out branch; returns its hash.
    pub(crate) fn commit(&self, msg: &str) -> String {
        self.git(&["commit", "-q", "--allow-empty", "-m", msg]);
        self.sha("HEAD")
    }
    /// A bare repo `origin.git` next to the repo, added as its remote
    /// "origin", with main pushed and tracked.
    pub(crate) fn bare_origin(&self) -> PathBuf {
        let bare = self.dir.join("origin.git");
        self.git_in(&self.dir, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        self.git(&["remote", "add", "origin", &bare.to_string_lossy().replace('\\', "/")]);
        self.git(&["push", "-q", "-u", "origin", "main"]);
        bare
    }
    /// The context run_op would give an operation, answered by this fixture.
    pub(crate) fn op<R>(&self, undo: &UndoStore, key: &str, f: impl FnOnce(&OpCtx) -> R) -> R {
        let ask = |t: &str| { self.asked.borrow_mut().push(t.to_string()); self.stash.get() };
        let trust = |t: &str| { self.trusted.borrow_mut().push(t.to_string()); self.trust.get() };
        let confirm = |tail: &str, ok: &str, cancel: &str, text: &str| {
            self.confirms.borrow_mut().push(Asked { tail: tail.into(), ok: ok.into(), cancel: cancel.into(), text: text.into() });
            let during = self.during.borrow_mut().take();
            if let Some(during) = during {
                during(self);
            }
            self.answers.borrow_mut().pop_front().unwrap_or(true)
        };
        let env = self.env();
        let lock = Mutex::new(());
        let store = self.dir.join("trust.json");
        f(&OpCtx {
            cx: SwitchCtx { ask: &ask, trust: &trust, store: &store, store_lock: &lock, limit: self.limit.get(), env: &env, pid: None },
            confirm: &confirm,
            undo,
            key,
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
