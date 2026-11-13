#!/usr/bin/env bash
# Идемпотентно: клон или fast-forward pull iOS-репозитория на машине сервера (.110).
# GitHub: papirosa3214/TaskFlowNativeBuild. Владелец 11.11.2026 — правки Разработчика
# на сервере через coding-tools Pi, не через Mac-хост.
set -euo pipefail

REPO_URL="${TASKFLOW_IOS_REPO_URL:-https://github.com/papirosa3214/TaskFlowNativeBuild.git}"
DEST="${TASKFLOW_IOS_REPO_PATH:-/home/maksim/Проекты/TaskFlowNativeBuild}"
BRANCH="${TASKFLOW_IOS_REPO_BRANCH:-main}"

# Роль работает под пользователем tfrole (server/src/runtime/localRoleOperations.ts:7-9).
# Без ACL роль в этом каталоге не может ни править файлы, ни создать
# .git/index.lock — 13.11.2026 именно это давало в отчётах «песочница запрещает
# коммит» на iOS-карточках, хотя сервер и репозиторий живут на одной машине.
grant_tfrole_access() {
  setfacl -R -m u:tfrole:rwX "${DEST}" 2>/dev/null || true
  find "${DEST}" -type d -exec setfacl -d -m u:tfrole:rwX {} + 2>/dev/null || true
}

if [[ -d "${DEST}/.git" ]]; then
  git -C "${DEST}" fetch origin "${BRANCH}"
  git -C "${DEST}" checkout "${BRANCH}"
  git -C "${DEST}" pull --ff-only origin "${BRANCH}"
  grant_tfrole_access
  printf '%s\n' "ok: updated ${DEST} @ $(git -C "${DEST}" rev-parse --short HEAD)"
  exit 0
fi

if [[ -e "${DEST}" ]]; then
  echo "ensure-ios-repo: ${DEST} exists but is not a git repo" >&2
  exit 1
fi

mkdir -p "$(dirname "${DEST}")"
git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${DEST}"
grant_tfrole_access
printf '%s\n' "ok: cloned ${DEST} @ $(git -C "${DEST}" rev-parse --short HEAD)"
