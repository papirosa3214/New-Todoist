# Pi Runtime Real Integration — Implementation Plan

> Спек: [`2026-09-18-pi-runtime-real-integration.md`](../specs/2026-09-18-pi-runtime-real-integration.md).
> Фаза 2: фасад из фазы 1 становится реальным.

## Global Constraints

- `main` only.
- Каждый Task — отдельный коммит.
- `trigger.py` не переписывается; `subprocess.Popen`/`make_cmd` выносятся в
  `server/scripts/start_agent_run.py` (JSON stdin/stdout, без shell=True).
- Контракт `/api/roles` неизменен.
- vitest и pytest зелёные после каждого Task.
- Credential не логируется ни в одном слое.

---

## Task 1: Launcher `server/scripts/start_agent_run.py`

**Files:**
- Create: `server/scripts/start_agent_run.py`
- Modify: `server/scripts/trigger.py`

- [ ] **Step 1.** Прочитать `trigger.py:L2270–L2420` (формирование `cmd`,
  env, `subprocess.Popen` с цепочкой заходов, `silence_watch`, heartbeat).

- [ ] **Step 2.** Создать `server/scripts/start_agent_run.py` с функцией
  ```python
  def start_agent_run(input: dict) -> dict
  ```
  Контракт:
  - `input` читается из stdin как JSON: `{task_id, agent_id, role, model,
    reply_only, resume_sid, fork, mcp_profile, skills}`.
  - Формирует argv-массив для `Popen([PI_BIN, "--mcp-config", ..., "-p", text])`
    **строго без shell=True**.
  - Возвращает JSON в stdout: `{status, proc_pid, task_id, session_id?,
    spent?, returncode, error?}`.
  - Логи (stderr) — без credential, без ключей, без текста задачи (только
    `provider`, `model`, `task_id[:8]`).
  - Цепочка заходов, env-переменные, MCP-профиль — всё здесь.

- [ ] **Step 3.** В `trigger.py` заменить блок L2270–L2420 на
  ```python
  from start_agent_run import start_agent_run
  result = start_agent_run(input_dict)
  ```
  Удалить импорт `subprocess` если больше не нужен, удалить `make_cmd`,
  удалить `claude_session_args` если она была приватной для запуска.

- [ ] **Step 4.** Прогнать dry-run:
  ```bash
  TASKFLOW_TRIGGER_DRY=1 timeout 5 python3 server/scripts/trigger.py 2>&1 | head -30
  ```
  Без `NameError`/`ImportError`.

- [ ] **Step 5.** Прогнать pytest:
  ```bash
  python3 -m pytest server/scripts/ -v 2>&1 | tail -30
  ```

- [ ] **Step 6.** Коммит: `refactor(trigger): launcher start_agent_run.py, JSON stdin/stdout`.

---

## Task 2: `listModels()` через `pi --list-models`

**Files:**
- Modify: `server/src/runtime/PiRuntimeAdapter.ts`
- Modify: `server/test/runtime/PiRuntimeAdapter.test.ts`

- [ ] **Step 1.** Добавить helper `parsePiListModels(output: string):
  Array<{provider: string, id: string}>` в `PiRuntimeAdapter.ts`.
  Парсит TSV-вывод `pi --list-models`, пропускает шапку и пустые строки,
  устойчив к разному количеству колонок.

- [ ] **Step 2.** Добавить кэш `listModelsCache: { at: number; models:
  Model[] } | null` с TTL 10 c. Метод `invalidateListModelsCache()`.

- [ ] **Step 3.** В `listModels()`:
  1. Если кэш свежий — вернуть кэш.
  2. Иначе `execFile('pi', ['--list-models'], {timeout: 15000})`.
  3. Распарсить, дедуп по `(provider, id)`.
  4. Для каждого уникального провайдера — `pi auth check --provider X --json`
     для определения `available`.
  5. Сохранить в кэш, вернуть.

- [ ] **Step 4.** Тест `listModels returns models from pi` — mock
  `execFile`, проверить минимум один провайдер, `runtime_id === "runtime:pi"`.

- [ ] **Step 5.** Тест `listModels cache hit returns same array` — два
  вызова подряд, второй не зовёт execFile.

- [ ] **Step 6.** Коммит: `feat(runtime): listModels через pi --list-models, кэш 10 c`.

---

## Task 3: `listProviders()` через `pi auth check`

**Files:**
- Modify: `server/src/runtime/PiRuntimeAdapter.ts`
- Modify: `server/test/runtime/PiRuntimeAdapter.test.ts`

- [ ] **Step 1.** Добавить helper `checkProviderStatus(provider: string):
  Promise<{status, authType, providerId}>` — вызывает
  `execFile('pi', ['auth', 'check', '--provider', provider, '--json', '--no-refresh'])`.

- [ ] **Step 2.** В `listProviders()` убрать `providerStatusFromEnv`,
  вместо этого `Promise.all(KNOWN_PROVIDERS.map(checkProviderStatus))`.
  Маппинг статусов Pi → фасадные.

- [ ] **Step 3.** Тест `listProviders returns connected when pi auth check
  returns ready` (mock).

- [ ] **Step 4.** Тест `listProviders filters provider_not_found`.

- [ ] **Step 5.** Коммит: `refactor(runtime): listProviders через pi auth check, ENV TASKFLOW_*_TOKEN убран`.

---

## Task 4: `connectProvider()` + `authInstruction()`

**Files:**
- Modify: `server/src/runtime/RuntimeAdapter.ts`
- Modify: `server/src/runtime/PiRuntimeAdapter.ts`
- Modify: `server/test/runtime/PiRuntimeAdapter.test.ts`

- [ ] **Step 1.** Расширить интерфейс `RuntimeAdapter`:
  ```ts
  type ConnectProviderInput = { apiKey?: string };
  type AuthInstruction = {
    status: "auth_required" | "ready";
    provider: string;
    command?: string;
    note?: string;
  };
  connectProvider(provider: string, body: ConnectProviderInput): Promise<ProviderConnection>;
  authInstruction(provider: string): Promise<AuthInstruction>;
  ```

- [ ] **Step 2.** Реализовать `connectProvider`:
  - Определить тип провайдера через `pi auth check --provider X --json`:
    - `not_ready credentials_not_configured` + запрошен apiKey → писать.
    - `not_ready credentials_not_configured` + apiKey не запрошен → 400
      `api_key_required`.
    - `ready` → идемпотентный no-op (или возвращает текущий статус).
    - oauth → 400 `oauth_use_auth_instruction`.
  - Запись: lockfile (`proper-lockfile`) на `~/.pi/agent/auth.json`,
    `writeFileSync` во временный файл в той же директории, `renameSync`,
    `chmodSync(0o600)`.
  - Credential **не логируется**: в логах только `provider` и длина ключа.
  - После записи — `invalidateListModelsCache()` + повторный
    `pi auth check --provider X --json`.
  - Возвращает `ProviderConnection`.

- [ ] **Step 3.** Реализовать `authInstruction(provider)`:
  - Статус из `pi auth check`.
  - Для OAuth: `command = "pi --provider <name> --model <любая доступная>
    \\"ping\\""`, `note` с пояснением.
  - Для api_key: `command = undefined`, `note` указывает, что нужно
    передать apiKey через форму.

- [ ] **Step 4.** Тест `connectProvider writes api key to auth.json` —
  временный auth.json в tmp-каталоге через mock `getAuthPath()`.

- [ ] **Step 5.** Тест `connectProvider for oauth returns 400`.

- [ ] **Step 6.** Тест `connectProvider does not log api key` —
  spy на `console.log`, проверить что значение apiKey не встретилось.

- [ ] **Step 7.** Тест `authInstruction returns command for oauth`.

- [ ] **Step 8.** Коммит: `feat(runtime): connectProvider + authInstruction, lockfile + atomic write`.

---

## Task 5: `ownerOrApiToken` preHandler

**Files:**
- Modify: `server/src/auth.ts`
- Modify: `server/test/auth.test.ts`

- [ ] **Step 1.** Расширить модель api-токенов: добавить поле `scopes:
  string[]` (json) в meta токена (или отдельная колонка `scopes` в
  api_tokens).

- [ ] **Step 2.** В `auth.ts`:
  ```ts
  export async function ownerOrApiToken(req, reply) {
    const apiOk = await checkApiToken(req);
    if (apiOk) {
      if (req.apiToken.scopes?.includes("runtime:auth")) return;
      return reply.code(403).send({ error: "runtime:auth scope required" });
    }
    const userOk = await checkUserToken(req);
    if (!userOk) return reply.code(401).send({ error: "unauthorized" });
    if (req.user.role !== "owner" && req.user.role !== "service") {
      return reply.code(403).send({ error: "owner_or_service_required" });
    }
  }
  ```

- [ ] **Step 3.** Тест: 401 без токена, 403 для обычного пользователя,
  403 для api-токена без scope, 200 для owner/service/api-токена со scope.

- [ ] **Step 4.** Коммит: `feat(auth): ownerOrApiToken с scope runtime:auth для api-токенов`.

---

## Task 6: POST /auth + фильтрация GET /providers

**Files:**
- Modify: `server/src/routes/runtime.ts`
- Modify: `server/test/runtime/providers.test.ts`

- [ ] **Step 1.** В `runtime.ts` сменить preHandler POST
  `/api/runtime/providers/:provider/auth` на `ownerOrApiToken`. Вызвать
  `piRuntime.connectProvider(name, body)`. Если провайдер OAuth — вызвать
  `piRuntime.authInstruction(name)` и вернуть как есть (200 + JSON).
  Если api_key с переданным ключом — записать, вернуть обновлённый статус.

- [ ] **Step 2.** GET `/api/runtime/providers` фильтрует ответ: оставляет
  только `{provider, status, authType}`. Убирает из ответа `runtime_id`,
  `managedBy`, `lastCheckedAt`, любые credential details.

- [ ] **Step 3.** Тест: 403 для обычного пользователя, 200 для owner.
  Для api_key — тело с `apiKey`, проверка записи в auth.json (через mock).
  Для OAuth — возвращается `{status: "auth_required", command, note}`,
  запись не делается.

- [ ] **Step 4.** Тест GET `/providers` — ответ содержит только
  `{provider, status, authType}`, никаких credential details.

- [ ] **Step 5.** Коммит: `feat(runtime): POST /auth подключён к connectProvider, GET фильтрует credential details`.

---

## Task 7: `nextModelForProfile` вместо `nextShellForRole`

**Files:**
- Modify: `server/src/routes/agent-state.ts`
- Modify: `server/src/roleRouting.ts`
- Modify: `server/test/agent-state.test.ts`

- [ ] **Step 1.** В `agent-state.ts` заменить вызов `nextShellForRole(...)`
  на `nextModelForProfile(...)`. Возвращаемый `ModelRoute` маппится в
  `task.attempt_*` поля (`model`, `provider`).

- [ ] **Step 2.** В `roleRouting.ts` удалить `nextShellForRole()`.
  `loadRoleRouting` оставить как deprecated алиас для `loadRuntimeConfig`
  (UI ещё читает). Проверить, что ни один файл не импортирует
  `nextShellForRole`.

- [ ] **Step 3.** Тест: при провайдер-лимите лесенка идёт по моделям,
  не по оболочкам. Runtime остаётся `runtime:pi`.

- [ ] **Step 4.** Коммит: `refactor: fallback по моделям, nextShellForRole удалён`.

---

## Task 8: API GET/PUT `/api/runtime/routing`

**Files:**
- Modify: `server/src/routes/runtime.ts`
- Modify: `server/src/runtime/PiRuntimeAdapter.ts` (хелпер
  `getAvailableModels()` + `modelExists(modelId)`)
- Create: `server/test/runtime/routing.test.ts`

- [ ] **Step 1.** В `PiRuntimeAdapter.ts` добавить `getAvailableModels():
  Promise<Set<string>>` (использует `listModels()`).

- [ ] **Step 2.** GET `/api/runtime/routing` — возвращает текущий
  `RoleRouting` через `loadRuntimeConfig()`.

- [ ] **Step 3.** PUT `/api/runtime/routing/:role`:
  - preHandler `ownerOrApiToken`,
  - schema validation (primary — непустая строка, fallbacks — массив
    строк, может быть пустым),
  - проверка моделей через `getAvailableModels()`,
  - проверка уникальности (primary ∉ fallbacks),
  - lockfile на `role-routing.yaml`, atomic rename,
  - инвалидация кэша `loadRuntimeConfig` (или перечитывание файла).

- [ ] **Step 4.** Тест: успешный PUT, 403 для не-owner, 422 для
  несуществующей модели, 422 для дубликата.

- [ ] **Step 5.** Коммит: `feat(runtime): API /api/runtime/routing с редактированием моделей`.

---

## Task 9: `startRun()` через `spawn start_agent_run.py`

**Files:**
- Modify: `server/src/runtime/PiRuntimeAdapter.ts`
- Modify: `server/test/runtime/PiRuntimeAdapter.test.ts`

- [ ] **Step 1.** В `startRun()`:
  - Загрузить задачу из БД.
  - Сформировать JSON input для launcher (task_id, agent_id, role,
    model, mcp_profile, skills).
  - `child_process.spawn('python3', ['server/scripts/start_agent_run.py'],
    {stdio: ['pipe', 'pipe', 'ignore']})`, stdin → JSON, stdout → JSON.
  - Вернуть `{runId: "run-<short>", sessionId: null, status: "queued"}`.
  - **Не блокировать** event loop: stdout читается асинхронно, после
    парсинга JSON пишем в tasks.agent_state.

- [ ] **Step 2.** Тест `startRun spawns python and returns runId` —
  mock spawn, проверить runId и `status: "queued"`.

- [ ] **Step 3.** Коммит: `feat(runtime): startRun запускает start_agent_run.py через spawn`.

---

## Task 10: UI — экран «Провайдеры»

**Files:**
- Modify: `src/screens/ProvidersScreen.tsx` (new)
- Modify: `src/App.tsx`
- Modify: `src/api/runtime.ts` (new)

- [ ] **Step 1.** `src/api/runtime.ts`:
  - `getRuntimeStatus()`, `getProfiles()`, `getModels()`,
    `getProviders()`, `connectProvider(name, body)`, `getAuthInstruction(name)`,
    `getRouting()`, `putRouting(role, body)`.

- [ ] **Step 2.** `ProvidersScreen.tsx`:
  - Заголовок, описание.
  - Карточки для каждого провайдера: имя, статус (badge),
    `authType`.
  - Для `connected` — кнопка «Переподключить» (вызывает
    `getAuthInstruction`, показывает модалку).
  - Для `disconnected` api_key — поле ввода ключа + кнопка «Подключить»
    (вызывает `connectProvider`).
  - Для `disconnected`/`expired` OAuth — кнопка «Инструкция» (модалка
    с командой из `authInstruction`, без deep-link).

- [ ] **Step 3.** Маршрут `/providers` + пункт меню.

- [ ] **Step 4.** Проверка UI в браузере: minimax → ввести ключ → connected.

- [ ] **Step 5.** Коммит: `feat(ui): экран Провайдеры`.

---

## Task 11: UI — экран «Агенты»

**Files:**
- Modify: `src/screens/AgentsScreen.tsx` (new)
- Modify: `src/App.tsx`

- [ ] **Step 1.** `AgentsScreen.tsx`:
  - 8 ролей, для каждой — текущая primary + fallbacks.
  - Select для primary (источник `getModels()`).
  - Multi-select для fallbacks (та же модель не может быть в обоих).
  - Кнопка «Сохранить» → `putRouting(role, {primary, fallbacks})`.

- [ ] **Step 2.** Маршрут `/agents` + пункт меню.

- [ ] **Step 3.** Проверка UI: сменить модель архитектора, убедиться
  что `role-routing.yaml:models.architect` обновился.

- [ ] **Step 4.** Коммит: `feat(ui): экран Агенты с выбором моделей`.

---

## Task 12: Финальный осмотр

**Files:** (нет новых правок)

- [ ] **Step 1.** Прогнать всё:
  ```bash
  cd /home/maksim/Проекты/New-Todoist
  npx vitest run server/test/ 2>&1 | tail -30
  python3 -m pytest server/scripts/ -v 2>&1 | tail -30
  npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -30
  ```
- [ ] **Step 2.** `git status` — только откоммиченное.
- [ ] **Step 3.** Закрыть карточку в `review`.

---

## Self-Review

- **Coverage спека:** A (launcher) → Task 1. B (listModels) → Task 2.
  C (listProviders) → Task 3. D (connectProvider) → Tasks 4, 6.
  E (auth) → Tasks 5, 6. F (nextModelForProfile) → Task 7.
  G (routing API) → Task 8. H (UI) → Tasks 10, 11. I (spawn) → Task 9.
- **Placeholders:** нет.
- **Type consistency:** `ConnectProviderInput`/`AuthInstruction` единые
  во всех Tasks.
- **Risk review:** Task 1 — после него dry-run обязателен. Task 4 —
  lockfile + atomic write + chmod 0600 + без логов credential. Task 6 —
  фильтрация GET-ответа, credential не утекает.
