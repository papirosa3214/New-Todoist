# QA-отчёт: «Планы коллаборации — красные тесты» (карточка 39fe9350)

## Результат

Все 9 перечисленных тестов группы «Планы коллаборации» остаются красными при повторном серверном прогоне от 12.10.2026. Реализация по этой группе в рабочей ветке роли QA (`roles/39fe9350-844b-40fe-8f44-b1343fed20f2`) не выполнена: ветка не содержит коммитов относительно `main` (HEAD == main == 7dcddc35), рабочий каталог чист. **Вердикт: needs_changes.** Без правок со стороны разработчика ни один из 9 тестов не проходит.

## Что сделано

- Прочитал карточку и выделил 9 конкретных тестов по описанию (названия + файлы).
- Прогнал тесты в рабочем дереве 39fe9350 изолированно, отдельным запуском vitest для пяти файлов с этими 9 кейсами: `planReviewLifecycle.test.ts`, `collaborationPlanContext.test.ts`, `mak67SingleExecutor.test.ts`, `subtaskRoleFanout.test.ts`, `task-collaboration-plans.test.ts`.
- Все 9 тестов упали с конкретными AssertionError / TypeError; собраны сообщения и стек каждого падения.
- Сравнил ветку с main: 0 коммитов впереди, статус рабочего каталога чист. Реализации в рабочей ветке нет.

## Проверки

Запуск: `npx vitest run planReviewLifecycle.test.ts collaborationPlanContext.test.ts mak67SingleExecutor.test.ts subtaskRoleFanout.test.ts task-collaboration-plans.test.ts`. Все тесты гонялись на временной БД через app.inject, как заведено в проекте.

| # | Тест | Файл | Ожидалось | Фактически |
|---|---|---|---|---|
| 1 | `attaches one queued critic with incoming arrow, without launching another hidden verifier` | planReviewLifecycle | finishPlanIfComplete возвращает true | возвращает false (assert в фикстуре) |
| 2 | `replays a sequential segment, queues new-version recheck and keeps the previous results` | planReviewLifecycle | finishPlanIfComplete возвращает true | возвращает false (assert в фикстуре) |
| 3 | `rejects two sequential recipients and permits two independent parallel arrows` | planReviewLifecycle | finishPlanIfComplete возвращает true | возвращает false (assert в фикстуре) |
| 4 | `keeps review rounds separate and stops after two rework cycles` | planReviewLifecycle | finishPlanIfComplete возвращает true | возвращает false (assert в фикстуре) |
| 5 | `подзадачи с разными ролями — предлагает draft-план, занимающий существующие строки` | subtaskRoleFanout | 2 подзадачи входят в план после approve | 0 подзадач с collaboration_plan_id |
| 6 | `manual + утверждённый план: слоты 2 и 3 стартуют сами по графу` | mak67SingleExecutor | approve < 300 | 409 (условие approve не выполнено) |
| 7 | `передаёт submitted по старому ребру accepted без /accept` | collaborationPlanContext | контекст узла собирается | TypeError: Cannot read properties of undefined (reading 'id') |
| 8 | `T03 product_feature: минимальный маршрут A1→V1 без флагов` | task-collaboration-plans | корректный ответ API | TypeError: Cannot read properties of undefined (reading 'status') |
| 9 | `PATCH редактирует draft (нельзя редактировать approved/чужой профиль)` | task-collaboration-plans | PATCH после approve возвращает 409 | возвращает 200 (правка принята) |

Сводка vitest: `Test Files 5 failed (5); Tests 9 failed | 30 passed (39)`. Все 9 ключевых — красные.

## Ограничения

- Реализация в ветке отсутствует. В плане этой карточки нет слота разработчика: исполнитель по дочерним карточкам не назначен (см. parent 71c1cd6e, шаг executor «не в работе»). Без правки кода 9 тестов не закрыть. QA-шаг может лишь зафиксировать дефекты и вернуть их автору.
- Нужен явный шаг разработчика для этой группы (коммит в `roles/39fe9350-…`) и повторная проверка QA после его появления. Текущий шаг QA нельзя принять.

## Материалы

- Запуск vitest: `/tmp/qa-test-output-final.log` (5 файлов, 9 упавших тестов).
- Полный прогон тех же файлов в проекте: `server/test/{planReviewLifecycle,collaborationPlanContext,mak67SingleExecutor,subtaskRoleFanout,task-collaboration-plans}.test.ts`.
- Этот отчёт: `qa/qa-report.md` в рабочем дереве карточки.
- Сводка прогона 12.10.2026: `/tmp/dsh-test-results/server.log` (указан в описании как источник красных тестов).