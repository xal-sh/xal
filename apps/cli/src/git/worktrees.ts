import { resolve } from "node:path"
import { appInfo } from "../app-info"
import { worktreesDir } from "../config/paths"
import {
  nativeCreateManagedWorktree,
  nativeManagedWorktreeAt,
  nativeRemoveManagedWorktree,
  nativeUnmanageWorktree,
  type NativeManagedWorktree,
  type NativeWorktreeRequest,
} from "../native"

export type ManagedWorktree = NativeManagedWorktree

const MARKER = `${appInfo.name}-worktree.json`

function request(cwd: string, signal?: AbortSignal): NativeWorktreeRequest {
  return {
    cwd,
    worktreesDir: resolve(worktreesDir()),
    appName: appInfo.name,
    displayName: appInfo.displayName,
    markerName: MARKER,
    aborted: signal?.aborted ?? false,
  }
}

export function createManagedWorktree(cwd: string, name: string, signal?: AbortSignal): Promise<ManagedWorktree> {
  return nativeCreateManagedWorktree({ ...request(cwd, signal), name }, signal)
}

export function managedWorktreeAt(cwd: string, signal?: AbortSignal): Promise<ManagedWorktree | undefined> {
  return nativeManagedWorktreeAt(request(cwd, signal), signal)
}

export function removeManagedWorktree(worktree: ManagedWorktree, force: boolean, signal?: AbortSignal): Promise<void> {
  return nativeRemoveManagedWorktree({ ...request(worktree.path, signal), worktree, force }, signal)
}

export function unmanageWorktree(worktree: ManagedWorktree, signal?: AbortSignal): Promise<void> {
  return nativeUnmanageWorktree({ ...request(worktree.path, signal), worktree }, signal)
}
