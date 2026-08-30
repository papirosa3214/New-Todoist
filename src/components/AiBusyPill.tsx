// ═══════════ Плашка «ИИ работает» под Dynamic Island ═══════════
//
// 26.08.2026, просьба Максима: «когда я использую ИИшку, надо чтобы там
// „думает“ — такая подпись была под Dynamic Island». Раньше это была
// серая строчка в теле экрана, под тулбаром: её легко не заметить, а
// работа ИИ может занять секунды.
//
// Это НЕ настоящая Live Activity: та живёт в самом островке, требует
// нативного ActivityKit (lib/liveActivity.ts + виджет-расширение) и
// жёстко завязана на задачу — startTaskActivity принимает taskId и рисует
// прогресс подзадач. Здесь просто плашка в верхней части экрана, ровно
// под вырезом. Плюс: работает на любом устройстве и не требует пересборки
// виджета. Минус: видна только пока приложение открыто.
//
// Отступ сверху НЕ добавляем: в native-сборке StatusBar работает с
// overlaysWebView:false (capacitor.config.ts), то есть WebView и так
// начинается под вырезом. Лишний safe-area-inset-top увёл бы плашку
// заметно ниже островка.
import { Icon } from "./UI";

export function AiBusyPill({
  visible,
  label = "ИИ думает…",
}: {
  visible: boolean;
  /** Что именно делает ИИ — «Собираю задачи…», «Сокращаю текст…». */
  label?: string;
}) {
  return (
    <div
      aria-hidden={!visible}
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-0 inset-x-0 z-[60] flex justify-center"
      style={{
        // Уезжает вверх за край, а не просто гаснет: движение читается
        // как «прилетело сверху», в том же жанре, что системные баннеры.
        transform: visible ? "translateY(8px)" : "translateY(-100%)",
        opacity: visible ? 1 : 0,
        transition: "transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease",
      }}
    >
      <div className="flex items-center gap-2 h-9 pl-3 pr-3.5 rounded-full bg-card2/95 backdrop-blur-xl shadow-dropdown border border-stroke">
        {/* Звёздочка — та же иконка ИИ, что в шапке: человек связывает
            плашку с кнопкой, которую только что нажал. Вращается, чтобы
            было видно, что работа идёт, а не подвисла. */}
        <Icon
          name="sparkles"
          size={15}
          className="text-red shrink-0 animate-spin"
          style={{ animationDuration: "1.8s" }}
        />
        <span className="text-[13px] font-medium text-text whitespace-nowrap">
          {label}
        </span>
      </div>
    </div>
  );
}