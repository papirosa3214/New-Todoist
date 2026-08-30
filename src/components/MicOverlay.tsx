import { createPortal } from "react-dom";
import { Icon } from "./UI";
import { MicRing } from "./MicRing";

// ═══════════ Полноэкранный оверлей записи ═══════════
//
// Owner 2026-08-13: кольцо (320px, MicRing) встроенное в поток формы
// оказалось внизу длинной страницы — под последним полем («Метки»)
// физически меньше 260px CSS свободного места, кольцо обрезалось снизу
// экрана («ты его разместил вниз... круглешок никуда не влез»). Не сжимать
// геометрию кольца (она перенесена 1:1 из присланного файла) — вместо
// этого дать ей то пространство, для которого она спроектирована: в
// исходном voice-ring-2.html это была отдельная страница, центрированная
// на весь экран (`body{display:flex;align-items:center;justify-content:
// center}`), а не элемент в потоке. Portal в document.body + fixed inset-0
// воспроизводит ровно это — тот же паттерн fixed-позиционирования, что уже
// использует BottomNav/FAB (components/UI.tsx).
//
// z-[55], НЕ 50 (было до 20.08.2026): изначально запас брался только
// против BottomNav/FAB (z-35/z-30). Когда 20.08.2026 запись подключили ещё
// и внутри шторок (ReturnToWorkSheet, SubtaskFeed) — а те тоже z-50, тот же
// стэкинг-контекст body — оверлей с шторкой сравнивались бы по порядку
// вставки в DOM, что ненадёжно. 55 — выше шторок с тем же запасом, каким
// раньше 50 было выше BottomNav.
//
// Показывается только пока идёт запись/распознавание (state !== "idle") —
// в покое кнопка остаётся маленькой иконкой в потоке формы (TaskFormScreen),
// эта же крупная версия существует только в оверлее.
export function MicOverlay({
  state,
  elapsedLabel,
  getTimeDomainData,
  onStop,
}: {
  state: "recording" | "processing";
  elapsedLabel: string;
  getTimeDomainData: () => Uint8Array | null;
  onStop: () => void;
}) {
  return createPortal(
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      // Клик НЕ всплывает дальше. Портал уходит в document.body, но в React
      // событие всплывает по дереву КОМПОНЕНТОВ, а не по DOM: оверлей,
      // отрисованный изнутри шторки, отдаёт клик её подложке
      // (ReturnToWorkSheet: внешний div с onClick={onCancel}) — и шторка
      // закрывается прямо под записью. 27.08.2026, владелец: «невозможно
      // записать голосом комментарий про возврат на доработку».
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-[55] flex flex-col items-center justify-center bg-bg"
      role="dialog"
      aria-modal="true"
      aria-label={state === "recording" ? "Идёт запись" : "Распознаю речь"}
    >
      <MicRing
        active={state === "recording"}
        getTimeDomainData={getTimeDomainData}
      >
        {state === "recording" ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Остановить запись"
            className="tap-scale p-3 flex items-center justify-center"
          >
            <Icon name="mic" size={56} className="text-red" />
          </button>
        ) : (
          <div className="p-3 flex items-center justify-center">
            <Icon name="mic" size={56} className="text-dim" />
          </div>
        )}
      </MicRing>
      <div className="mt-6 text-[13px] text-dim tabular-nums">
        {state === "recording" ? elapsedLabel : "Распознаю…"}
      </div>
    </div>,
    document.body,
  );
}
