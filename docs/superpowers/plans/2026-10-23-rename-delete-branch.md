# แผน: เปลี่ยนชื่อ branch, ลบ branch/tag และ Undo

## สรุปแผน (อ่านส่วนนี้ส่วนเดียวก็เข้าใจว่าจะทำอะไร)

### ปัญหาที่เจอ
ตอนนี้ GitKrapao สร้าง branch และ tag ได้แล้วจาก PR #1 แต่ยังเปลี่ยนชื่อ branch ไม่ได้ ลบ branch ไม่ได้ และลบ tag ไม่ได้ ผู้ใช้ต้องสลับไปใช้ terminal ทุกครั้ง เกิดกับแอปเดสก์ท็อปทุกเครื่อง ไม่ขึ้นกับ environment

### แนวคิด
เพิ่มเมนูคลิกขวา **Rename branch…**, **Delete branch…** และ **Delete tag…** ทุกเมนูทำงานกับ ref ในเครื่องเท่านั้น และใช้กลไกเดียวกับ Create ทั้งหมด ได้แก่ ล็อกต่อ repo, trust check, Output drawer, แถบ error, ห้ามทำซ้อนในแท็บเดียวกัน และทำพร้อมกันได้ไม่เกิน 3 งานทั้งแอป หลังลบจะมีแถบ Undo ใต้ toolbar เอาไว้คืนสิ่งที่เพิ่งลบ

กรณีต่างๆ เป็นแบบนี้
- **Rename:**
  - พิมพ์ชื่อใหม่ในกล่องเดียวกับ Create ระบบตรวจชื่อขณะพิมพ์ด้วยกฎเดียวกัน ชื่อตัวเองไม่นับว่าซ้ำ
  - ชื่อที่ต่างจากเดิมแค่ตัวพิมพ์เล็ก/ใหญ่ (เช่น feat → Feat) ปฏิเสธ เพราะ Windows เก็บ ref เป็นไฟล์ที่ไม่แยกตัวพิมพ์ จึงมองว่าเป็นชื่อเดียวกัน
  - กดยืนยันในกล่องได้เลย ไม่มีหน้าต่างยืนยันอีกชั้น
  - upstream ของ branch คงเดิมตามพฤติกรรมของ `git branch -m`
  - branch ที่ checkout อยู่เปลี่ยนชื่อได้
  - ไม่มี Undo สำหรับ rename
- **Delete branch:**
  - branch ที่ checkout อยู่ลบไม่ได้ เมนูจางพร้อมบอกเหตุผล
  - ก่อนลบ แอปนับ commit ที่จะไม่อยู่บน branch, tag, remote branch, stash หรือ HEAD ใดๆ อีก
    - ถ้าได้ 0 จะยืนยันแบบปกติ
    - ถ้ามากกว่า 0 จะเตือนตามจริงว่า "N commits will no longer be on any branch. Undo brings them back; after that only via git reflog / git fsck."
    - ต้องบอกแบบนี้เพราะ `git branch -D` ลบ reflog ของ branch นั้นไปด้วย
  - ทุกครั้งต้องกดยืนยันในหน้าต่าง native ที่บอกชื่อ repo สคริปต์ในหน้าจะกดยืนยันแทนไม่ได้
  - ถ้า branch ขยับระหว่างที่หน้าต่างยืนยันเปิดอยู่ จะไม่ลบ
  - ถ้า branch ถูก checkout อยู่ใน worktree อื่น จะแสดง error ของ git
- **Delete tag:**
  - นับ commit ที่จะหายและยืนยันแบบเดียวกับ branch
  - ลบในเครื่องเสร็จแล้ว ถ้า repo มี remote ชื่อ origin จะถามต่อว่าลบบน origin ด้วยไหม และบอก URL ให้เห็น
    - ตอบใช่: แอปสั่ง push เพื่อลบ tag บนเซิร์ฟเวอร์ ใช้เวลาได้ไม่เกิน 90 วินาที
    - ไม่มี origin: ไม่ถาม
    - origin ไม่มี tag นี้อยู่แล้ว: ถือว่าสำเร็จ
    - push ล้มเหลว: แจ้ง error แต่ tag ในเครื่องถูกลบไปแล้ว และยังกด Undo ได้
  - ไม่มีเมนู rename tag
- **Undo:**
  - แถบใต้ toolbar ข้อความประมาณ "Deleted branch feat/x (abc1234) [Undo] [×]"
  - แถบหายเมื่อกด ×, เริ่ม operation อื่น หรือสลับแท็บ ถ้าลบอันใหม่ แถบเดิมจะถูกแทน
  - Undo คืนเฉพาะในเครื่อง
    - branch กลับมาที่ commit เดิม พร้อมค่า upstream
    - annotated tag กลับมาเป็น tag object เดิม (ข้อความ tag ยังอยู่ครบ)
    - tag ที่ลบบน origin ไปแล้ว แถบจะบอกว่าบน origin ไม่ได้คืน
  - ถ้ามีคนใช้ชื่อนั้นไปแล้ว จะคืนไม่ได้และไม่แก้อะไรเลย
- **branch ที่ซ่อนหรือ solo อยู่:** rename แล้วรายการย้ายตามชื่อใหม่ ลบแล้วเอาออกจากรายการ ส่วนรายการที่เป็นทั้งโฟลเดอร์ไม่แตะ
- **ความปลอดภัย:**
  - ข้อมูลที่ใช้ Undo เก็บฝั่ง Rust หน้าเว็บได้แค่ token จึงสั่งคืน ref หรือ config ตามใจไม่ได้
  - ชื่อที่หน้าเว็บส่งมา backend ตรวจแบบตัวพิมพ์ตรงทุกตัว เพราะบน Windows ไฟล์ ref เปิดได้แม้ตัวพิมพ์ไม่ตรง
  - push ใช้ `--no-signed` จึงไม่รัน gpg

### ฝั่ง BE (Rust, src-tauri)
- **module ใหม่ `refedit.rs`:** มี 4 คำสั่ง คือ `rename_branch`, `delete_branch`, `delete_tag`, `restore_ref`
  - ใช้ตัวตรวจชื่อจาก `create.rs` ซ้ำ (`valid_name`, `windows_unsafe`, `taken`)
  - ใช้ตัวครอบการรันแบบเดียวกับ `run_create`
- **`GitResult`:** เพิ่ม field `deleted` เพื่อให้ UI รู้ว่าจะแสดงแถบ Undo
- **`AppState`:** เพิ่มที่เก็บข้อมูล Undo หนึ่งรายการต่อ repo
- **`TRUST_HOOKS`:** เพิ่ม `pre-push`
  - ทำให้ repo ที่มี pre-push hook ถูกถาม trust ใหม่หนึ่งครั้ง (ผู้ใช้ตกลงแล้ว)
  - ไม่กระทบ repo ที่ไม่มี hook นี้
- **`ask_native`:** เพิ่มให้ตั้งชื่อปุ่ม Cancel ได้ เช่น "Keep on origin"

### ฝั่งแอป (TypeScript, src)
- **เมนูคลิกขวา:**
  - branch ในเครื่องที่แผงซ้ายและป้าย branch บนกราฟ ได้ Rename และ Delete
  - ป้าย tag บนกราฟได้ Delete tag และ Copy tag name ตอนนี้คลิกขวาที่ tag ยังไม่มีเมนูของ tag เลย
  - ป้าย remote branch ไม่ได้เมนูใหม่
- **กล่อง rename:** ใช้ `#createDlg` ซ้ำ จึงได้การจัดการ Esc, F5 และ backdrop มาด้วย
- **`runOp`:** คืนผลลัพธ์ และมี callback ไว้แสดงแถบ Undo และอัปเดตรายการ hidden/solo
- **`refname.ts`:** `nameClash` เพิ่มพารามิเตอร์ชื่อตัวเอง เพื่อไม่นับชื่อตัวเองว่าซ้ำ และปฏิเสธชื่อที่ต่างแค่ตัวพิมพ์

### ผลกระทบ
- **repo อื่นที่เรียกใช้:** ไม่มี
- **แอปเวอร์ชันเก่า:** ไม่กระทบ ไม่มี localStorage key ใหม่ ส่วน `lanes.hidden` และ `lanes.solo` ใช้รูปแบบเดิม
- **DB / config / secret:** ไม่มี
- **cache:** ไม่มี
- **สิ่งที่ผู้ใช้จะเห็นเปลี่ยน:**
  - เมนูใหม่สามรายการ
  - แถบ Undo
  - repo ที่มี pre-push hook ถูกถาม trust อีกหนึ่งครั้ง
  - README เปลี่ยนจากเดิมที่ว่า "never … pushes, or deletes branches or tags"
- **Security / PDPA:**
  - การลบ tag บน origin ติดต่อเซิร์ฟเวอร์ด้วย credential หรือ SSH ของผู้ใช้เอง โดยต้องยืนยันก่อนทุกครั้ง
  - ไม่มีการเก็บรหัสผ่าน
- **ข้อจำกัดที่ยังเหลือ:**
  - rename และลบ branch บน remote ยังทำไม่ได้ จะเป็นงานถัดไป
  - Undo คืน tag บน origin ไม่ได้ และเพื่อนร่วมทีมที่ fetch ไปแล้วยังมี tag นั้นอยู่
  - ถ้ารัน `gc --prune` ไปแล้ว Undo จะใช้ไม่ได้
  - รายการ hidden/solo ของ worktree ที่ไม่ได้เปิดเป็นแท็บอยู่จะไม่ถูกอัปเดต

### การทดสอบ
- **cargo (TDD):** `cargo test --lib refedit`
  - rename:
    - upstream และ reflog ยังอยู่
    - HEAD ตามชื่อใหม่
    - ชื่อภาษาไทย
    - ปฏิเสธชื่อที่ต่างแค่ตัวพิมพ์ ชื่อที่มีอยู่แล้ว (ทั้ง loose และ packed) และชื่อที่ Windows เก็บไม่ได้
    - เปลี่ยน feat เป็น feat/x ได้
    - ถาม trust ก่อนรัน hook และหยุด hook ที่ค้างได้
  - ลบ branch:
    - merge แล้วนับได้ 0
    - ยังไม่ merge นับได้ N ตรงกับ `rev-list`
    - commit ที่ tag, remote, stash, detached HEAD หรือ worktree อื่นยังไปถึง ไม่นับ
    - กด Cancel แล้วไม่มีอะไรเปลี่ยน
    - branch ที่ checkout อยู่ลบไม่ได้
    - branch ที่ขยับระหว่างเปิดหน้าต่างยืนยันจะไม่ถูกลบ
    - ปฏิเสธชื่อที่ตัวพิมพ์ไม่ตรง
  - ลบ tag:
    - ทั้ง lightweight และ annotated
    - ไม่มี origin ไม่ถาม
    - ตอบใช่แล้ว tag หายจาก bare origin ตอบไม่ใช่ tag ยังอยู่
    - origin ไม่มี tag ถือว่าสำเร็จ
    - pre-push hook ต้องผ่าน trust
    - gpg ไม่ถูกรัน
    - URL ผิดแล้วยังได้ `deleted` สำหรับ Undo
    - push ที่เกินเวลาถูกหยุด
  - restore:
    - branch กลับมาพร้อม upstream
    - tag กลับมาเป็น object เดิม
    - ชื่อถูกใช้ไปแล้วจะคืนไม่ได้
    - token จาก repo อื่นใช้ไม่ได้ และใช้ซ้ำครั้งที่สองไม่ได้
  - fetch: hash ของ trust ไม่เปลี่ยนใน repo ที่ไม่มี pre-push
- **UI:**
  - `tests/ui/refedit.suite.mjs` ใช้ fake `__TAURI__` และรันกับ prod bundle ด้วย
    - เมนูทุกแบบ
    - กล่อง rename
    - ข้อความระหว่างทำงาน
    - แถบ Undo กับ token
    - hidden/solo ตามชื่อใหม่แล้ว reload
    - ผลของแท็บพื้นหลัง
  - เพิ่ม case ใน `refname.suite.mjs`
- **คำสั่งที่ต้องผ่าน:**
  - `pnpm run typecheck`
  - `pnpm run test:ui`
  - `pnpm run check:bindings`
  - `cd src-tauri && cargo test --lib`
- **ทดสอบด้วยมือ:** ใน `pnpm run dev` กับ mock repo และสำเนาที่มี bare origin ในเครื่อง ห้ามใช้ repo งานจริง
  - rename `feature/auth-v2` แล้วป้ายกับแผงซ้ายต้องเปลี่ยนชื่อ
  - ลบ branch ที่ยังไม่ merge แล้วต้องเห็นตัวเลขเตือน จากนั้นกด Undo แล้ว branch ต้องกลับมาพร้อม ↑↓
  - ลบ tag แล้วตอบลบบน origin แล้ว tag ต้องหายจาก bare origin
  - หน้าต่าง native ต้องมีชื่อ repo

### Commit / PR
- **branch:** `feature/rename-delete-branch` แตกจาก `develop`
- **commit:** ข้อความภาษาไทยแบบ thai-commit แบ่งเป็นงานละ commit ไม่ใส่ Co-Authored-By
  - `เพิ่ม(refedit): …`
  - `ปรับปรุง(fetch): เพิ่ม pre-push ใน trust check`
  - `เอกสาร(refedit): …`
- **PR:** เข้า `develop`
- **หัวข้อข้อจำกัดใน PR:**
  - ยังไม่มีการทำกับ remote branch
  - Undo คืน tag บน origin ไม่ได้
  - repo ที่มี pre-push hook จะถูกถาม trust อีกครั้ง
  - Undo ใช้ไม่ได้หลัง `gc`

### ลำดับ deploy
1. ผมทำงานทีละ task บน `feature/rename-delete-branch` และรันเทสต์ทั้งหมดให้ผ่าน
2. คุณทดสอบด้วยมือตามหัวข้อการทดสอบ
3. merge เข้า `develop` หรือเปิด PR ตามที่คุณสั่ง ไม่น่ามี conflict ถ้า `develop` ไม่มีงานใหม่เข้ามา แต่ถ้ามี conflict น่าจะอยู่ที่ `src/app.ts`, `CLAUDE.md` และ `README.md`
4. ออก release ตาม git flow มาตรฐาน คุณเป็นคนสั่ง
   - แตก `release/x.y.z`
   - merge เข้า `main` แล้วติด tag บน merge commit
   - merge กลับเข้า `develop`
   - ไม่ fast-forward `main`

---

รายละเอียดสำหรับลงมือทำอยู่ในหัวข้อถัดไป

## Context
- Create branch/tag shipped in PR #1 (`src-tauri/src/create.rs`, `src/refname.ts`, `#createDlg`).
- The user wants rename and delete next. Decided with the user:
  - local refs only;
  - delete tag, then an optional delete on `origin`;
  - no rename for tags;
  - an unreachable-commit count with a truthful warning, for both branch and tag;
  - an Undo bar for deletes only, restoring local refs only;
  - `pre-push` joins `TRUST_HOOKS`;
  - every other default as proposed.
- Glossary terms settled in this session go into a new `GLOSSARY.md`:
  - **Branch** (local);
  - **Remote branch** (on the server);
  - **Remote-tracking branch** (`origin/x` as last fetched);
  - **Unreachable commits**;
  - **Undo**.

## Change

### Rust: `src-tauri/src/refedit.rs` (new; add `mod refedit;` and register its commands in `generate_handler!`, lib.rs ~1504)
- **Shared helpers:**
  - Make `valid_name`, `windows_unsafe` and `taken` in `create.rs` `pub(crate)`.
  - Generalize `run_create` (create.rs:144) into a shared `run_op(app, state, op, path, f)` that also passes a `confirm(title_tail, ok, cancel, text)` closure. Its title is `"{op} — {repo}: {tail}"`.
  - `ask_native` (fetch.rs:628) gains a `cancel` label; existing callers pass `"Cancel"`.
  - `SwitchCtx` (switch.rs:42) derives `Clone, Copy`, so the push can use `limit: 90s`.
  - Reuse `Steps`/`SAFE_CONFIG` (switch.rs:61–83), `GitResult::not_run` (fetch.rs:58), `git_error`, `sanitize` and `rev`.
- **`exact(repo, ns, name) -> Option<String>`:**
  - Reads `for-each-ref --format=%(objectname) %(refname) refs/heads|refs/tags` and requires an exact byte match.
  - Never use `show-ref`/`rev-parse` to check a name the page sent: Windows matches loose refs case-insensitively.
- **`unreachable(repo, full_ref, tip) -> Option<u32>`:**
  - Runs `git rev-list --count <tip> --not --exclude=<full_ref> --all`.
  - `--all` covers branches, remotes, tags, the stash, HEAD and linked worktrees' HEADs. A cargo test pins the linked-worktree part.
  - `None` (an error or a timeout) → the dialog says the count failed.
- **`rename_branch(path, from, to)`:**
  1. `exact(heads, from)`.
  2. `valid_name` and `windows_unsafe` on `to`.
  3. `taken(heads, to)`:
     - a hit on `from` when `to != from` → refuse the case-only rename;
     - any other hit → refuse.
  4. `trust_gate("Rename branch")`.
  5. `git branch -m <from> <to>`.
- **`delete_branch(path, name)`:**
  1. `exact` gives the tip.
  2. Refuse if HEAD's symref is this branch.
  3. Capture `branch.<name>.*` from `git config --local -z --list`: the key prefix must match exactly and the remainder must have no dot.
  4. `unreachable`.
  5. `trust_gate("Delete branch")`.
  6. `confirm`, with plain or warning text.
  7. Re-run `exact`. If the tip moved, refuse "moved while the dialog was open; nothing deleted".
  8. `git branch -D <name>` (git checks other worktrees and drops the config section).
- **`delete_tag(path, name)`:**
  1. `exact(tags)` gives the object.
  2. Peel it to the commit for the count.
  3. `trust_gate("Delete tag")`.
  4. `confirm`.
  5. `git update-ref -d refs/tags/<name> <obj>`.
  6. If `git remote` lists origin, run `confirm("also delete on origin?", "Delete on origin", "Keep on origin", text)`. The text includes the sanitized `git remote get-url --push origin`.
  7. On yes: `git push --no-signed --no-recurse-submodules origin --delete refs/tags/<name>` with a 90 s limit.
  8. Outcomes:
     - "remote ref does not exist" → ok, "…origin had no tag";
     - any other failure → `ok:false`, with `deleted` kept so Undo is offered.
- **`restore_ref(path, token)`:**
  1. Take the entry from `AppState.undo`; it must have the same lock key.
  2. `taken` is case-insensitive; a hit refuses.
  3. `cat-file -e <sha>`.
  4. `trust_gate("Undo delete")`.
  5. `git update-ref -m "GitKrapao: undo delete" refs/<ns>/<name> <sha> <zero-oid>`, so it fails if the name has been taken meanwhile.
  6. For a branch with no `branch.<name>.*` now: `git config --local --add` each saved key, in order.
- **`AppState.undo`:** `Mutex<HashMap<lock_key, (u64, Deleted)>>`, with a global counter. Each delete replaces that repo's entry.
- **`GitResult.deleted`:**
  - `Option<DeletedRef { token: number, kind, name, short, onOrigin }>`, with `skip_serializing_if` and `ts(optional)`.
  - Add `deleted: None` in `not_run`, `Steps::result`, `then_switch` and `fetch_in`.
  - Regenerate the bindings.
- **Push safety and trust:**
  - `TRUST_HOOKS` (fetch.rs:34) gains `"pre-push"`.
  - `git_command` already sets `GIT_TERMINAL_PROMPT=0`.

### UI
- **`src/refname.ts`:**
  - `nameClash(name, kind, names, self?)` drops `self` from the list.
  - If `name` equals `self` ignoring case but is not the same, it returns "Only the letter case changes; Windows stores both names as one file."
- **`src/ipc.ts`:** add `rename_branch`, `delete_branch`, `delete_tag` and `restore_ref` to `Commands`.
- **`src/app.ts`, `runOp` (~2666):**
  - Becomes `runOp(kind, call, { switching?, done? }): Promise<GitResult | null>`.
  - Calls `hideUndo()` at the start.
  - `done(r, info)` runs after `logOp` for active and background tabs alike. It returns whether the hide or solo lists changed. If they did and the repo is active → `loadRepo(current, { keep: true })` instead of `syncRepo()`.
  - New `OpKind`s and `OP_BUSY` entries: `rename` "Renaming branch…", `delBranch` "Deleting branch…", `delTag` "Deleting tag…", `restore` "Restoring…".
- **Hide and solo:**
  - `saveHidden(list, path?)`.
  - New `followRef(paths, old, new|null)` rewrites or removes exact `refs/heads/<old>` entries in `lanes.hidden`/`lanes.solo` for every open tab with the same lockKey.
- **Menus** (off reason `createOff`):
  - **Panel leaf** (~2066): only for `refs/heads/` refs, Rename and Delete are added after Copy. Delete on `is-head` is off with "The checked-out branch cannot be deleted".
  - **Graph branch label** (~2103): the same items when `g.local`, before `createEntries`.
  - **Tag pill:** new `pillTag(e)` (the `.pill[data-g]` group with `kind === 'tag'`) → "Delete tag …", "Copy tag name", then `createEntries(c)`.
- **Rename dialog:**
  - Reuse `#createDlg` with `createFor.mode = 'rename'`: hide `.c-at`, `#cMsgRow` and `#cSwitchRow`; title "Rename branch", button "Rename".
  - Prefill and select the old name; Go is off while the name is unchanged.
  - `checkCreate` passes `self`.
  - Submit keeps the existing lockKey check.
  - The keydown gate (~2876) already covers it.
- **Undo bar:**
  - `index.html`: `#undoBar` (`role=status`, `#undoMsg`, `#undoBtn`, `#undoClose`) after `#banner`; CSS next to `.banner`.
  - It is shown by `done` only when `r.deleted` is set and the repo is active.
  - `hideUndo()` runs on ×, at `runOp` start and in `dropRepo`.
  - `#undoBtn` is off via `capOff()`; `updateFetchBtn` refreshes it.
  - Undo calls `runOp('restore', p => invoke('restore_ref', { path: p, token }))`.

### Docs
- **README line 5:**
  - Operations: Fetch, Switch branch, Create/Rename/Delete a branch, Create/Delete a tag.
  - Never commits, merges your work or rebases.
  - Pushes only when you confirm deleting a tag on origin.
  - Add the new menu items to the feature list.
- **CLAUDE.md:**
  - New section "Rename / delete branch, delete tag (src-tauri/src/refedit.rs)".
  - Fetch section: `TRUST_HOOKS` includes pre-push; the op list.
  - Tabs: the Undo bar's lifecycle.
- **`GLOSSARY.md`:** the five terms above, with no implementation detail.

## Tests
- **Cargo:**
  - Move create.rs's test `Fixture` into a shared `#[cfg(test)]` helper and add `bare_origin()` (pattern from fetch.rs:687–750).
  - Cases exactly as listed in the Thai "การทดสอบ" section.
  - Plus: `--all` counts a linked worktree's detached HEAD, and `git branch -m feat feat/x` succeeds.
- **UI:**
  - `tests/ui/refedit.suite.mjs` (`prodSafe`), modelled on `tests/ui/create.suite.mjs`: fake answers, `ctx()`, `pick()`, `type()`, `last()`.
  - Extend `tests/ui/refname.suite.mjs` (self exclusion, case-only).

## Verification
- `pnpm run typecheck`, `pnpm run test:ui` (all suites), `pnpm run check:bindings`, and `cd src-tauri && cargo test --lib`: all green.
- Manual run in `pnpm run dev` on `.mock/demo-repo`, plus a throwaway clone with a local bare origin, as listed in the Thai section.

## Commit / PR
- Branch `feature/rename-delete-branch` from `develop`.
- One commit per task, with Thai messages and no Co-Authored-By trailer.
- PR into `develop` with the limitations listed above.
- Release later through canonical git flow (release branch → main merge commit tagged → merge back), never fast-forwarding main.
