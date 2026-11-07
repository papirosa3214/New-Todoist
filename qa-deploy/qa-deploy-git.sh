#!/usr/bin/env bash
# Выкладка ветки роли в боевой main инфра-панели (.110).
# Выполняется от пользователя maksim (владелец каталога боевого репозитория).
set -uo pipefail

LIVE=/home/maksim/Проекты/infra-panel
CLONE=/home/maksim/.local/state/taskflow-runs/worktrees/cac65b0c-5ad1-4730-a46b-cb444a03794b/infra-panel
BRANCH=roles/cac65b0c-chat-limits
BACKUP=/home/maksim/.local/state/taskflow-runs/worktrees/cac65b0c-5ad1-4730-a46b-cb444a03794b/qa-deploy

cd "$LIVE" || exit 1

echo "== ДО =="
echo "HEAD_BEFORE=$(git rev-parse HEAD)"
echo "BRANCH_BEFORE=$(git rev-parse --abbrev-ref HEAD)"

# Резервная копия чужих незакоммиченных правок (страховка, если stash pop даст конфликт).
git status --porcelain > "$BACKUP/git-status-before.txt" 2>&1
git diff > "$BACKUP/chuzhie-pravki.patch" 2>&1
git diff --stat > "$BACKUP/chuzhie-pravki.stat" 2>&1
echo "backup_files=$(wc -l < "$BACKUP/chuzhie-pravki.patch")"

echo "== 1. stash чужих правок =="
git stash push -m 'чужие правки' || echo "STASH_FAILED"
echo "stash_list_after_push:"; git stash list

echo "== 2. fetch ветки роли =="
git fetch "$CLONE" "$BRANCH" || echo "FETCH_FAILED"
echo "FETCH_HEAD=$(git rev-parse FETCH_HEAD 2>&1)"

echo "== 3. merge --ff-only =="
git merge --ff-only FETCH_HEAD || echo "MERGE_FAILED"
echo "HEAD_AFTER_MERGE=$(git rev-parse HEAD)"

echo "== 4. stash pop =="
git stash pop || echo "STASH_POP_CONFLICT"

echo "== ПОСЛЕ =="
echo "HEAD_AFTER=$(git rev-parse HEAD)"
echo "status_after:"; git status --porcelain
echo "stash_list_after_pop:"; git stash list
echo "api_py_has_chat_router=$(grep -c 'infra_panel.agent.chat' backend/api.py)"
echo "api_py_has_sensitive_ports_9120=$(grep -c '9120' backend/api.py)"
