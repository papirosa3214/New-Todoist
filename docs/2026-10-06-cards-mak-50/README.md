# MAK-50 — карточки, строки списка, секции, разделители (2026-10-06)

Эталон iOS (`DESIGN-SYSTEM.md` §2.2/§2.7) на .110 не расшарен (см. kb:
`2026-10-05-designer-ios-etalons-not-on-server`), поэтому числа взяты из
формулировки задачи и уже принятых правил `DESIGN.md`. Примитивы живут в
`src/components/UI.tsx`; локальные копипасты строк в `SettingsScreen`
переведены на общий `ListRow`, заголовки секций — на `SectionHeader`.

## Что сделано

| §2.2/§2.7 | Реализация |
| --- | --- |
| карточка `card` — радиус 16, без рамки | `Card` в `UI.tsx` (`bg-card r-surface`), переехала из `TaskFields.tsx` с реэкспортом |
| разделитель 1px `stroke` | `Divider` (`h-px bg-stroke`) — в `Card` во всю ширину, в `FieldGroup` с `mx-4` |
| заголовок секции — ступень `action`, `sub` | `SectionHeader` (`tf-action text-sub px-1`) |
| строка списка: иконка 40×40/18% или 18px `dim` | `ListRow` (`iconColor` → плашка 40×40, иначе голые 18px `dim`) |
| заголовок / подзаголовок / значение / шеврон 13 | `tf-body` / `tf-action text-sub` / `tf-action text-sub` / `chevron` 13 |
| подсветка 4% | `tap-row`; без `onClick` рендерится `<div>` |
| группа полей — строки 52 | `FieldRow.minHeight` 48→52, `TextField` уже 52; значение → `tf-action` (13), шеврон 13 |

## Что изменилось

- `src/components/UI.tsx` — `Card`, `Divider`, `SectionHeader`, `ListRow`;
  `FieldGroup` использует `Divider`.
- `src/components/TaskFields.tsx` — `Card` уехала в UI (реэкспорт), `FieldRow`
  приведён к строке 52/значению 13/`tap-row`.
- `src/screens/SettingsScreen.tsx` — `Row`/`InfoRow`/`ToggleRow` стали
  обёртками над `ListRow` (плашка 28×28 → 40×40, `py-3` → строка 52);
  4 заголовка секций → `SectionHeader`.
- `src/screens/TemplatesScreen.tsx`, `IntegrationsScreen.tsx`,
  `VoiceModelsScreen.tsx` — заголовки секций с `tf-caption uppercase` →
  `SectionHeader`.
- `DESIGN.md` — раздел «Карточки, строки списка, секции, разделители»;
  в реестре Metrics отмечено, что 40×40 теперь осознанная единица `ListRow`.

## Кадры

`scripts/screenshot-mak50.mjs`, layout 402×874, DSR=2 (804×1748), обе темы
через persist `taskflow-ui` v4. В `web/light/` и `web/dark/`:

| Кадр | Что видно |
| --- | --- |
| `01-settings.png` | карточки, `SectionHeader`, `ListRow` 40×40, `FieldGroup` |
| `02-templates.png` | секции + карточки шаблонов |
| `03-integrations.png` | секции + карточки-аккордеоны |
| `04-task-form.png` | `FieldGroup`/`FieldRow` — строки 52 |

Запуск (dev-сервер должен отдавать этот worktree):

```
npx vite --host 0.0.0.0 --port 5221 --strictPort
node scripts/screenshot-mak50.mjs
```

Требует backend :3001 с `TASKFLOW_LAN_NO_AUTH=1` (RequireAuth сам логинится
через `/api/auth/lan` настоящим chromium, UA Mozilla/*).

## Проверки

- `npx tsc --noEmit -p tsconfig.app.json` — 6 pre-existing ошибок в файлах,
  которые задача не трогала (AttachmentViewerSheet, CollaborationPlanPanel,
  DayHours, UpcomingCalendar, LabelTasksScreen); новых нет.
- `npx vitest run` — 12 файлов / 168 тестов, зелёные.
- `npx vite build` — успех.

## Ограничения

- Переведены не все списки: `Projects`, `Notes`, `Labels`, `Agents` пока
  рисуют строки локально — переводятся на `ListRow` по мере правки (тот же
  подход, что у MAK-49/MAK-54).
- Сверка «рядом с iOS» кадрами — задача MAK-56: iOS-эталон доступен только
  на MacBook владельца, на .110 кадров iOS нет.
