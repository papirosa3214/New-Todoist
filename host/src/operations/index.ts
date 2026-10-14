import { OP_NAMES, type OpName } from "../protocol.js";
import { bash } from "./bash.js";
import { edit } from "./edit.js";
import { find } from "./find.js";
import { gitPush } from "./git_push.js";
import { gitWorktree } from "./git_worktree.js";
import { grep } from "./grep.js";
import { ls } from "./ls.js";
import { read } from "./read.js";
import type { Operation } from "./types.js";
import { write } from "./write.js";

/**
 * Реестр операций хоста. Ключи совпадают с именами из протокола (OP_NAMES) —
 * иначе шлюз вызовет `git_worktree`, а хост ответит «операция неизвестна».
 */
export const OPERATIONS: Record<OpName, Operation> = {
  bash,
  read,
  write,
  edit,
  grep,
  find,
  ls,
  git_worktree: gitWorktree,
  git_push: gitPush,
};

export function isKnownOperation(name: string): name is OpName {
  return (OP_NAMES as readonly string[]).includes(name);
}

export { bash } from "./bash.js";
export { edit } from "./edit.js";
export { find } from "./find.js";
export { gitPush } from "./git_push.js";
export { gitWorktree, roleBranch } from "./git_worktree.js";
export { grep } from "./grep.js";
export { ls } from "./ls.js";
export { read } from "./read.js";
export { write } from "./write.js";
export * from "./types.js";