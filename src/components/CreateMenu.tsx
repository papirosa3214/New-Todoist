import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "./UI";
import { hapticTap } from "../lib/haptics";

// ═══════════ Меню «что создать» над центральной кнопкой ═══════════
//
// Владелец 27.08.2026 прислал референс: панель с четырьмя вкладками, в центре
// круглая кнопка, по нажатию — всплывающая карточка со списком того, что
// можно создать. «Она открывает типа создать проект, создать блокнот, ну
// заметку, и создать задачу».
//
// Отличие от референса — направление: там панель висит в середине экрана и
// карточка падает ВНИЗ, у нас панель прилипла к нижней кромке, поэтому
// карточка раскрывается ВВЕРХ, от кнопки. Точка роста (transform-origin)
// стоит внизу по центру, чтобы карточка «вырастала» из самой кнопки, а не
// возникала где-то над ней.
//
// Создание нигде не дублируется: и «Проекты», и «Дневник» уже умеют
// открывать свою форму по ?create=1 (см. ProjectsScreen/NotesScreen) — меню
// просто ведёт туда же, а не заводит второй путь создания.

export interface CreateMenuProps {
  open: boolean;
  onClose: () => void;
}

export function CreateMenu({ open, onClose }: CreateMenuProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Esc закрывает — на телефоне не нужно, но панель живёт и в браузере.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const go = (path: string) => {
    hapticTap();
    onClose();
    navigate(path);
  };

  const items = [
    {
      icon: "check",
      label: "Задача",
      hint: "Со сроком и шагами",
      // На «Сегодня» задача заводится сразу на сегодня — то же правило, по
      // которому раньше работала плавающая кнопка.
      onPress: () =>
        go(
          location.pathname === "/today" ? "/task/new?due=today" : "/task/new",
        ),
    },
    {
      icon: "notebook",
      label: "Заметка",
      hint: "Запись в дневнике",
      onPress: () => go("/notes?create=1"),
    },
    {
      icon: "inbox",
      label: "Проект",
      hint: "Задачи и документация",
      onPress: () => go("/projects?create=1"),
    },
  ];

  return (
    <>
      {/* Подложка ловит тап мимо меню. Не затемняет — карточка маленькая, и
          затемнение всего экрана ради трёх строк выглядело бы как модалка. */}
      {open && (
        <button
          type="button"
          aria-label="Закрыть меню создания"
          onClick={onClose}
          className="fixed inset-0 z-[34] cursor-default"
        />
      )}

      <div
        // Всегда в DOM: так карточка сворачивается с анимацией, а не исчезает
        // мгновенно. Скрытая — не кликабельна и не читается скринридером.
        className={`absolute left-1/2 -translate-x-1/2 z-[36] origin-bottom transition-all duration-200 ${
          open
            ? "opacity-100 scale-100 pointer-events-auto"
            : "opacity-0 scale-95 pointer-events-none"
        }`}
        style={{ bottom: "calc(100% + 8px)" }}
        aria-hidden={!open}
      >
        <div className="w-[232px] bg-card rounded-2xl border border-stroke shadow-xl overflow-hidden">
          {items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              tabIndex={open ? 0 : -1}
              onClick={item.onPress}
              className={`tap-row w-full flex items-center gap-3 px-4 py-3 text-left ${
                i > 0 ? "border-t border-stroke" : ""
              }`}
            >
              <span className="w-[32px] h-[32px] rounded-xl bg-white/10 flex items-center justify-center text-text shrink-0">
                <Icon name={item.icon} size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-medium text-text">
                  {item.label}
                </span>
                <span className="block text-[12px] text-sub">
                  {item.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
