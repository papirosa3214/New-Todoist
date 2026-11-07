# Архитектурное решение: человекочитаемый отчёт в результате каждого этапа

Задача: `1238bb87-cc4b-4be1-8031-1fce8c1c2fd8` «Читаемый отчёт в результате каждого этапа».
Архитектурный шаг: `0ca78978-38ec-4395-8eaf-a333985eef3f`.
Дата: 09.10.2026.

## Что уже сделано (на сервере)

- `server/src/lib/roleReportPolicy.ts` — единая инструкция для восьми ролей, плюс структурная валидация `report_markdown`: обязательные разделы «Результат / Что сделано / Проверки / Ограничения / Материалы», отказ на пустом отчёте, JSON и отсутствии разделов, лимит 64 КБ.
- `server/src/lib/roleResultReport.ts` (`saveRoleResultReport`) — одна транзакция: создаёт запись в `user_notes` в папке `artifact_folder_id` задачи и пишет событие `task_events.kind=role_result_report`. Возвращает `noteId`.
- Обязательная валидация на всех путях сдачи: `routes/subtasks.ts:388` (обычное закрытие шага), `routes/subtask-artifacts.ts:95` (структурный артефакт), `routes/reviews.ts:146` (вердикт критика).
- `server/src/routes/task-collaboration-plans.ts:presentSingle` — каждый узел графа возвращает `result_document: {id, title}` через `roleResultDocument(subtaskId)`.
- `server/src/lib/submissionReceipt.ts:11-15` — `submission_receipt.document_id` равен `note_id` сохранённой заметки.
- `server/src/runtime/collaborationPlanContext.ts` — `predecessor_artifacts[].payload` равен переданному JSON, отчёт в этот JSON не вмешивается.

## Что осталось сделать (клиент)

Единственный пробел по критерию приёмки «ссылка «Отчёт о работе» в результате выбранного этапа открывает редактор заметок» — рендер ссылки в `src/components/CollaborationPlanPanel.tsx` (web) и симметричное место в iOS.

Клиент уже получает всё нужное:

- API `/api/tasks/:id/collaboration-plans` отдаёт `node.result_document = {id, title}` для каждого узла.
- Маршрут `/notes/:id` уже зарегистрирован в `src/App.tsx:188` и открывает `NoteEditorScreen` с реальным редактором заметок.
- В `CollaborationPlanPanel.tsx` рядом с меткой состояния узла нужно добавить ссылку «Отчёт о работы» при наличии `result_document` и состоянии `submitted/accepted/returned`; при `null` ссылка не показывается (старые узлы без отчёта).

Объём правки: ≤20 строк в `CollaborationPlanPanel.tsx` плюс зеркальная правка в iOS. Никаких новых API, схем БД и событий не требуется.

## Границы

- Без новой секции отчётов и без установки на iPhone.
- Существующие результаты и старые отчёты не переписываются автоматически; для узлов без `result_document` ссылка скрывается, как и было.
- Ручное закрытие владельцем галочкой не требует `report_markdown` (требование касается только сдачи ролью).
- `payload` артефакта следующей роли не меняется.

## Проверки на следующий этап

- `server/test/roleResultReport.test.ts` — 13 кейсов: обязательность, заметка в `artifact_folder_id` задачи, видимость в графе, неизменность JSON, sandbox-отказ, инструменты всех 8 ролей, финальный вердикт критика.
- Браузерный ручной кейс: сдать узел → увидеть ссылку «Отчёт о работе» → нажатие открывает редактор `/notes/:id` с текстом отчёта.
- Без ссылки для узлов без отчёта (старые результаты).

## Материалы

- Код: `server/src/lib/roleReportPolicy.ts`, `server/src/lib/roleResultReport.ts`, `server/src/lib/taskArtifactFolder.ts`, `server/src/routes/task-collaboration-plans.ts`, `server/src/lib/submissionReceipt.ts`.
- Тест: `server/test/roleResultReport.test.ts`.
- Документация: `docs/current/human-role-reports.md`, `docs/current/submission-receipt.md`.
- Клиентский пробел: `src/components/CollaborationPlanPanel.tsx`.
