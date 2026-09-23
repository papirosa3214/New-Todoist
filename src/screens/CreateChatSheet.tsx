// Шит создания чата с ролями-агентами. Открывается с экрана списка
// (FAB «+» в ChatsScreen), на месте же и закрывается — отдельного
// маршрута нет (решение от 21.09.2026: создание через модальный шит,
// чтобы /chats/:id был свободен сразу под новый чат, без
// промежуточного /chats/new).
//
// Логика выбора:
//   - читаем список агентов из useAgents();
//   - в пикер попадают только ролевые учётки (id начинается с "role_") —
//     это соглашение с сервером (server/src/routes/chats.ts:roleFromUserId:
//     type='ai' && role ∈ ROLE_NAMES);
//   - одна роль выбрана → kind:"direct", две и больше → "group";
//     сервер сам режет «прямой чат с самим собой» (B1, проверка
//     Гермеса 21.09.2026), так что тут защищаться не нужно — владелец
//     просто не сможет выбрать себя как «роль».
//   - для group-чата имя необязательное: если пусто, подставим «Чат с
//     N ролями», чтобы список не выглядел как «Без названия» x10.
//
// Каркас шторки — тот же useBottomSheet, что у ChatStatsSheet и
// RescheduleSheet: scrim + bg-card rounded-sheet-top + SheetHandle.
// Свайп вниз — закрывает, тап по scrim — закрывает, «Отмена» — закрывает.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, ErrorBanner, Icon, Loading, SheetHandle } from "../components/UI";
import { useBottomSheet } from "../lib/useBottomSheet";
import { useAgents } from "../api/agents";
import { useCreateChat } from "../api/chats";

/** Канонический порядок ролей в пикере: тот же, что в серверном
 *  ROLE_NAMES (server/src/roleRouting.ts). Если порядок расходится,
 *  сортировка по id выдаст «role_architect» раньше «role_analyst» —
 *  не то, что хочется видеть. Список тут — на стороне клиента, и его
 *  единственная задача — предсказуемо раскладывать чипы. */
const ROLE_ORDER = [
  "role_researcher",
  "role_analyst",
  "role_architect",
  "role_builder",
  "role_qa",
  "role_designer",
  "role_critic_verifier",
];

export function CreateChatSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const sheet = useBottomSheet({ open, onClose });
  const navigate = useNavigate();
  const create = useCreateChat();

  // Список ролей-агентов из общего /api/agents — там же, где и весь
  // состав команд, фильтруем по id-префиксу. Один запрос на всё
  // приложение через react-query — отдельного эндпоинта под «только
  // роли» не заводим, иначе дубль.
  const { data: agents = [], isLoading, isError, error } = useAgents();

  const roles = useMemo(
    () =>
      agents
        .filter((a) => a.id.startsWith("role_"))
        .sort(
          (a, b) =>
            ROLE_ORDER.indexOf(a.id) - ROLE_ORDER.indexOf(b.id) ||
            a.name.localeCompare(b.name, "ru"),
        ),
    [agents],
  );

  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const reset = () => {
    setSelected([]);
    setTitle("");
  };

  // Закрытие «по-настоящему» — после анимации useBottomSheet
  // выкидывает узел из DOM. Сбрасываем форму только тогда, иначе
  // повторное открытие показало бы старый черновик.
  const handleClose = () => {
    onClose();
    // Микротаск: сам unmount через useBottomSheet придёт после
    // анимации, но нам нужно вернуть форму к чистому виду до того,
    // как пользователь снова жмякнет «+». Не страшно, если это
    // случится дважды — setSelected([]) идемпотентен.
    queueMicrotask(reset);
  };

  const kind: "direct" | "group" = selected.length > 1 ? "group" : "direct";
  // Автоимя для group-чата без заголовка — чтобы карточка в списке
  // сразу читалась, без «Без названия». Для direct имя не нужно —
  // там в шапке комнаты и так виден единственный собеседник.
  const finalTitle = useMemo(() => {
    const trimmed = title.trim();
    if (trimmed) return trimmed;
    if (kind === "group") {
      return `Чат с ${selected.length} ролями`;
    }
    return null;
  }, [title, kind, selected.length]);

  const canSubmit = selected.length >= 1 && !create.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    try {
      const res = await create.mutateAsync({
        kind,
        member_ids: selected,
        title: finalTitle,
      });
      // Закрываем шит и сразу проваливаемся в созданный чат — без
      // отдельного шага «вернуться в список». Так и владельцу
      // удобнее, и тестовый канал проверки Гермеса ожидает именно
      // «создал → открылся».
      handleClose();
      navigate(`/chats/${res.chat.id}`);
    } catch {
      // Ошибка уже разложена в mutation.error — ErrorBanner ниже
      // покажет её сам, повторно не выводим.
    }
  };

  if (!sheet.mounted) return null;

  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={handleClose}
    >
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-3">
          <button
            onClick={handleClose}
            aria-label="Закрыть"
            className="w-[44px] h-[44px] -ml-2.5 flex items-center justify-center text-sub"
          >
            <Icon name="close" size={20} />
          </button>
          <h3 className="text-[17px] font-semibold">Новый чат</h3>
          <div className="w-[44px] h-[44px]" />
        </div>

        <p className="text-[13px] text-sub mb-2 px-1">
          {kind === "direct"
            ? "Персональный чат с одной ролью."
            : `Групповой чат: ${selected.length} ${pluralRoles(selected.length)}.`}
        </p>

        {isLoading && <Loading variant="block" />}
        {isError && (
          <ErrorBanner
            error={error}
            fallback="Не удалось загрузить список ролей."
          />
        )}

        {!isLoading && !isError && (
          <>
            <div className="mb-4">
              <h4 className="text-[13px] text-sub mb-2 px-1">Роли</h4>
              <div className="flex flex-wrap gap-2">
                {roles.length === 0 && (
                  <p className="text-[13px] text-dim px-1 py-2">
                    Ролевых учёток пока нет.
                  </p>
                )}
                {roles.map((r) => {
                  const on = selected.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggle(r.id)}
                      className={`h-9 px-3.5 rounded-full text-[13px] tap-fade ${
                        on
                          ? "bg-red text-white"
                          : "bg-card2 text-text border border-stroke"
                      }`}
                    >
                      {r.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {kind === "group" && (
              <div className="mb-4">
                <h4 className="text-[13px] text-sub mb-2 px-1">
                  Название (необязательно)
                </h4>
                <div className="bg-card2 rounded-2xl px-4 h-12 flex items-center">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={
                      finalTitle ??
                      `Чат с ${Math.max(selected.length, 2)} ролями`
                    }
                    maxLength={200}
                    className="w-full bg-transparent text-[15px] text-text placeholder:text-dim outline-none"
                  />
                </div>
              </div>
            )}

            <ErrorBanner
              error={create.error}
              fallback="Не удалось создать чат."
            />

            <div className="flex flex-col gap-2 mt-2">
              <Button
                variant="primary"
                onClick={submit}
                disabled={!canSubmit}
              >
                {create.isPending
                  ? "Создаём…"
                  : kind === "direct"
                    ? "Начать чат"
                    : "Создать чат"}
              </Button>
              <Button variant="secondary" onClick={handleClose}>
                Отмена
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 1 «роль», 2-4 «роли», 5+ «ролей» — мелочь, но без неё подпись
 *  «Групповой чат: 2 роль» режет глаз. */
function pluralRoles(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return "ролей";
  const mod10 = n % 10;
  if (mod10 === 1) return "роль";
  if (mod10 >= 2 && mod10 <= 4) return "роли";
  return "ролей";
}
