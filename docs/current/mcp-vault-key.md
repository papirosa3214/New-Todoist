# TaskFlow MCP: действующий ключ vault

08.10.2026: сетевой MCP отвечал на инструменты, но его запросы к API получали 401 Invalid token. Служба была запущена с устаревшим ключом, сохранённым в памяти. Имя по умолчанию TASKFLOW_AGENT_TOKEN больше отсутствует в vault.

Действующий ключ: TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN. Отпечаток проверен против живой users: учётка «Оркестратор Claude», id 6848a89b-04fe-4015-bb1c-61b03782c378. Значение ключа не выводилось и не записывалось в настройки.

Исправлено имя по умолчанию server/scripts/mcp_server.py и добавлен user systemd drop-in ~/.config/systemd/user/taskflow-mcp-net.service.d/vault-key.conf с TASKFLOW_VAULT_KEY=TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN. Перезагружена конфигурация systemd и перезапущен только taskflow-mcp-net. Сервер TaskFlow и веб не перезапускались.

Проверка: py_compile; служба active; реальный MCP taskflow_projects успешно вернул проекты; реальный MCP создал карточку архива 57c69735-3ce7-449e-a7ac-89955132a8fe. Её план утверждён через API в пределах полномочий оркестратора, architecture действительно running.

Ключ TASKFLOW_MCP_TOKEN служит внешней авторизации MCP и не заменяет ключ API. При 401 следует проверять учётку и конфигурацию API-ключа, не объявлять TaskFlow умершим. Кто и когда убрал прежний ключ — не установлено. Автоматическая смена ключей и прав не добавлялась.
