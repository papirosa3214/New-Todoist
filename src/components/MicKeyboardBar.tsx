import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./UI";

// ═══════════ Микрофон над клавиатурой ═══════════
//
// Owner 2026-08-13 (пятый заход, итог): «влезть» физически поверх
// системной accessory-панели iOS (стрелочки/Done) невозможно — не баг
// вёрстки, архитектурное ограничение платформы. Та панель не DOM-узел
// страницы, а часть системного UI-слоя браузера (browser chrome),
// который композитится ОС/движком поверх содержимого страницы; веб-
// контенту (z-index, position:fixed — не важно что) туда доступа нет в
// принципе. Проверено не на глаз: тот же принцип независимо подтверждают
// Apple Developer Forums на соседнем случае — position:fixed контент
// физически обрезается, если пытается зайти под системные browser
// controls, а не отрисовывается поверх них.
// Четвёртый заход (компенсация -121px, прозрачный фон, «слиться» с
// системной панелью) исходил из неверной посылки — что раз нельзя
// добавить кнопку В панель, можно хотя бы нарисовать поверх нее; владелец
// проверил вживую — кнопка физически недоступна для тапа (закрыта
// системным слоем). Возврат к рабочему месту: `bottom: var(--kb-inset)`,
// ровно ВЫШЕ системной панели, там кнопка реально кликабельна — это
// подтверждённая рабочая зона, не гипотеза. Визуально — не полноширинная
// плашка (её раньше сочли слишком «в лоб»), а компактная плавающая
// кнопка-таблетка, полупрозрачный фон+блюр, чтобы не выглядеть чужеродной
// панелью, а лёгким плавающим элементом.
//
// Восьмой заход (owner 2026-08-13, живой баг на телефоне) — ГИПОТЕЗА НЕ
// ПОДТВЕРДИЛАСЬ, оставлено для истории, не повторять: считал, что причина —
// кратковременный провал --kb-inset к 0 при blur/focus между полями, и
// защищался max(var(--kb-inset), env(safe-area-inset-bottom)). Владелец
// проверил вживую: «ничего не изменилось, она продолжает прятаться и меняет
// позицию по отношению к подзадачам и задачам» — то есть смещение стойкое и
// разное ДЛЯ РАЗНЫХ ПОЛЕЙ, а не миг между кадрами; safe-area-inset-bottom
// (~34px) в принципе не может исправить провал внутрь зоны клавиатуры
// (~300px) — защита била не по той цели.
//
// Девятый заход (owner 2026-08-13): в useVisualViewportInset.ts инсет
// считается как `innerHeight - vv.height - vv.offsetTop` — offsetTop
// (насколько сам visualViewport сдвинут вниз при scroll-into-view
// сфокусированного поля) вычитается напрямую. Если WebKit скроллит/
// панорамирует видимую область по-разному для разных полей формы (что для
// поля ниже по форме, типа «Заметка», вероятно, т.к. авто-скролл к нему
// длиннее), --kb-inset будет стабильно разным для разных полей — кнопка
// с `bottom: var(--kb-inset)` НЕ моргает, а оседает НИЖЕ для «глубоких»
// полей, что на iOS может попадать в зону accessory-панели. Это не
// подтверждено численно — headless Chrome не воспроизводит настоящее
// panning visualViewport на iOS (offsetTop там всегда 0). Убрал
// transition-[bottom]: если смещение персистентное, а не миг, анимация
// только делает «уезжание» заметнее глазом, не лечит его. Добавлен
// временный диагностический оверлей (ниже) — снять реальные цифры с
// телефона на разных полях, прежде чем трогать сам хук.
export function MicKeyboardBar({
  onStart,
  ariaLabel,
}: {
  onStart: () => void;
  ariaLabel: string;
}) {
  return createPortal(
    <>
      {/* ВРЕМЕННЫЙ диагностический оверлей (owner 2026-08-13, девятый
          заход) — не элемент дизайна, снять после диагностики бага с
          кнопкой. Живые цифры вместо гипотез: если inset различается
          между title/desc/подзадачей, значит виноват vv.offsetTop в
          useVisualViewportInset, а не миг между кадрами. */}
      <MicDebugOverlay />
      <div
        // Прижата к правому краю (right-[18px] — тот же отступ, что у FAB
        // в UI.tsx, канон плавающих круглых кнопок этого проекта), а не по
        // центру экрана: владелец 2026-08-13 попросил сдвинуть её
        // максимально вправо.
        className="fixed right-[18px] z-[45] pb-2"
        style={{
          bottom: "max(var(--kb-inset, 0px), env(safe-area-inset-bottom, 0px))",
        }}
      >
        <button
          type="button"
          // data-атрибут только для ВРЕМЕННОГО MicDebugOverlay ниже — снять
          // вместе с ним.
          data-mic-debug-target="1"
          // Клик по кнопке не должен красть фокус у textarea (иначе blur
          // сорвал бы voiceTarget/keyboardFieldFocused раньше, чем onClick
          // успеет отработать) — preventDefault на mousedown держит фокус на
          // текстовом поле, стандартный приём для тулбар-кнопок.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onStart}
          aria-label={ariaLabel}
          // Тот же «стеклянный» приём, что уже держат ScreenHeader/
          // SearchScreen (bg-bg/90 backdrop-blur-xl, components/UI.tsx) — не
          // свой рецепт, канон проекта, просто ниже opacity (70, не 90) и
          // сильнее blur (xl вместо sm): та панель на всю ширину экрана под
          // контентом, эта — маленький плавающий круг на фоне клавиатуры,
          // ему нужна не почти-непрозрачная подложка, а настоящее стекло.
          className="tap-scale w-11 h-11 rounded-full bg-bg/70 backdrop-blur-xl border border-stroke shadow-[0_2px_10px_rgba(0,0,0,.35)] flex items-center justify-center"
        >
          <Icon name="mic" size={20} className="text-text" />
        </button>
      </div>
    </>,
    document.body,
  );
}

// ВРЕМЕННЫЙ диагностический компонент (owner 2026-08-13) — снять вместе
// с комментарием девятого захода выше, как только баг с положением кнопки
// будет объяснён числами и исправлен. Опрашивает те же источники, что и
// useVisualViewportInset (window.innerHeight, visualViewport.height/
// offsetTop), плюс реальную позицию самой кнопки на экране — чтобы
// подтвердить или опровергнуть гипотезу про offsetTop без гадания.
function MicDebugOverlay() {
  const [info, setInfo] = useState("…");

  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      const btn = document.querySelector<HTMLButtonElement>(
        '[data-mic-debug-target="1"]',
      );
      const rect = btn?.getBoundingClientRect();
      const inset = getComputedStyle(document.documentElement).getPropertyValue(
        "--kb-inset",
      );
      const active = document.activeElement;
      const activeLabel =
        active instanceof HTMLElement
          ? active.getAttribute("placeholder") || active.tagName
          : "none";
      setInfo(
        [
          `focus: ${activeLabel}`,
          `innerH: ${window.innerHeight}`,
          `vv.h: ${vv ? Math.round(vv.height) : "—"}`,
          `vv.top: ${vv ? Math.round(vv.offsetTop) : "—"}`,
          `--kb-inset: ${inset.trim()}`,
          `btn.bottom→viewport: ${rect ? Math.round(window.innerHeight - rect.bottom) : "—"}`,
        ].join("  |  "),
      );
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    const id = setInterval(update, 300);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      clearInterval(id);
    };
  }, []);

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[999] bg-red-600 text-white text-[10px] leading-tight px-2 py-1 font-mono"
      style={{ paddingTop: "env(safe-area-inset-top, 4px)" }}
    >
      {info}
    </div>
  );
}
