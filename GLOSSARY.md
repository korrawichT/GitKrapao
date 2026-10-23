# GitKrapao

A desktop Git history viewer whose graph of commits, branches and merges is the main feature. It also makes a few changes to a repository when asked: fetch, switch, create, rename and delete.

## Language

**Branch**:
A local branch: a name in your own repository that points at a commit.
_Avoid_: Local branch, head

**Remote branch**:
A branch that lives on the server. You can see it only through its remote-tracking branch.
_Avoid_: Origin branch, upstream branch

**Remote-tracking branch**:
Your copy of a remote branch as of the last fetch, such as `origin/x`. It is shown as a label and is never renamed or deleted by the app.
_Avoid_: Remote branch, remote ref

**Unreachable commits**:
Commits that no branch, remote-tracking branch, tag, stash or HEAD reaches. Deleting a branch or tag can leave commits in this state.
_Avoid_: Orphaned commits, dangling commits, lost commits

**Undo**:
Putting back the last deleted branch or tag, in this repository only. It does not restore anything on a remote.
_Avoid_: Restore, revert, recover
