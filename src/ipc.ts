/* Calls into the Rust side. Results are typed by the ts-rs bindings; the
   arguments of each command are written here because they are not structs. */
import type { CommitDetail } from './bindings/CommitDetail';
import type { GitResult } from './bindings/GitResult';
import type { FileDiff } from './bindings/FileDiff';
import type { Page } from './bindings/Page';
import type { PrList } from './bindings/PrList';
import type { RepoInfo } from './bindings/RepoInfo';
import type { Stash } from './bindings/Stash';
import type { StreamInfo } from './bindings/StreamInfo';
import type { SyncInfo } from './bindings/SyncInfo';
import type { Track } from './bindings/Track';
import type { WorkStatus } from './bindings/WorkStatus';

export type DiffKind = 'commit' | 'staged' | 'unstaged' | 'untracked';
export interface Commands {
  pick_repo: { args: Record<string, never>; result: RepoInfo | null };
  open_repo: { args: { path: string }; result: RepoInfo };
  start_history: { args: { path: string; hidden: string[]; solo: string[] }; result: StreamInfo };
  /** Stops the history stream unless one newer than gen has started (the UI left the repo). */
  stop_history: { args: { gen: number }; result: null };
  sync_history: { args: { path: string; exclude: string[]; hidden: string[]; solo: string[]; limit: number }; result: SyncInfo };
  history_page: { args: { gen: number; start: number; count: number }; result: Page };
  commit_detail: { args: { path: string; sha: string }; result: CommitDetail };
  work_status: { args: { path: string }; result: WorkStatus };
  file_diff: { args: { path: string; kind: DiffKind; sha: string | null; file: string; oldFile: string | null; context: number }; result: FileDiff };
  list_stashes: { args: { path: string }; result: Stash[] };
  pull_requests: { args: { path: string }; result: PrList };
  open_url: { args: { url: string }; result: null };
  branch_tracking: { args: { path: string }; result: Track[] };
  /** null while an operation (fetch, switch, create) runs in the repo: skip this poll. */
  repo_fingerprint: { args: { path: string }; result: string | null };
  /** Rejects with 'busy' when an operation already runs in the repo. */
  fetch: { args: { path: string }; result: GitResult };
  list_remotes: { args: { path: string }; result: string[] };
  /** target: refs/heads/x or refs/remotes/<remote>/x. Rejects with 'busy' like fetch. */
  switch_branch: { args: { path: string; target: string }; result: GitResult };
  /** at: a commit hash; checkout: switch to the new branch afterwards. Rejects with 'busy' like fetch. */
  create_branch: { args: { path: string; name: string; at: string; checkout: boolean }; result: GitResult };
  /** at: a commit hash; message: annotated tag, null: lightweight. Rejects with 'busy' like fetch. */
  create_tag: { args: { path: string; name: string; at: string; message: string | null }; result: GitResult };
}

const core = window.__TAURI__?.core;
/** Desktop (Tauri) when the bridge exists, otherwise plain browser with manual import. */
export const NATIVE = !!core;

export function invoke<K extends keyof Commands>(cmd: K, args: Commands[K]['args']): Promise<Commands[K]['result']> {
  if (!core) return Promise.reject(new Error('Not running in the desktop app'));
  return core.invoke(cmd, args) as Promise<Commands[K]['result']>;
}
