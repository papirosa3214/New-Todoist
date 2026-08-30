// ═══════════ СВОДКА ЧАТА: КОГО ОЗАДАЧИВАЮТ ЧАЩЕ ВСЕГО ═══════════
//
// 28.08.2026, владелец: «чтобы потом статистику вести, кого озадачиваем чаще
// всего». Данные для неё появились только сейчас: пока адресат был
// необязательным, половина сообщений уходила «в никуда» и считать было
// нечего.
//
// Каркас — та же шторка, что у фильтров задач (scrim + bg-card
// rounded-sheet-top + SheetHandle): это не новый вид окна, а ещё одна
// шторка над списком.
//
// Три разреза, и все три отвечают на разные вопросы:
//   кому     — кого нагружают (то самое «кого чаще всего озадачиваем»)
//   от кого  — кто больше всех говорит
//   пары     — кто именно к кому ходит; здесь видно, идёт ли разговор
//              мимо Максима
//
// Полоска у строки — доля от самого нагруженного адресата, а не от всех
// сообщений: сравнивать глазами нужно участников между собой.
import type { ReactNode } from "react";
import { ErrorBanner, Icon, Loading, SheetHandle } from "./UI";
import { useChatStats } from "../api/chat";
import { useBottomSheet } from "../lib/useBottomSheet";

/** Русский счёт: 1 сообщение, 2 сообщения, 5 сообщений, 74 сообщения.
    Без этого в подписи стояло «74 сообщений» — мелочь, но читается как
    машинный текст. */
function plural(n: number, one: string, few: string, many: string) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function StatRows({
  rows,
  empty,
}: {
  rows: Array<{ имя: string; сообщений: number; выделить?: boolean }>;
  empty: string;
}) {
  if (rows.length === 0)
    return <p className="text-[13px] text-dim px-1 py-1">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.сообщений), 1);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.имя} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span
              className={`text-[14px] min-w-0 truncate ${
                r.выделить ? "text-red font-semibold" : "text-text"
              }`}
            >
              {r.имя}
            </span>
            <span className="text-[13px] text-sub shrink-0 tabular-nums">
              {r.сообщений}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-card2 overflow-hidden">
            <div
              className="h-full rounded-full bg-red"
              style={{ width: `${Math.round((r.сообщений / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[13px] text-sub px-1">{title}</h4>
      {children}
    </div>
  );
}

export function ChatStatsSheet({
  open,
  onClose,
  meId,
}: {
  open: boolean;
  onClose: () => void;
  /** Своя строка подсвечивается акцентом — «сколько озадачивают лично меня»
      это первое, что Максим ищет в этой сводке. */
  meId?: string;
}) {
  const sheet = useBottomSheet({ open, onClose });
  // Запрос идёт только при открытой шторке: цифры меняются с каждым
  // сообщением, держать их свежими в фоне незачем.
  const { data, isLoading, isError, error } = useChatStats(open);

  if (!sheet.mounted) return null;

  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
    >
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-3">
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center"
          >
            <Icon name="x" size={20} className="text-sub" />
          </button>
          <h3 className="text-[17px] font-semibold text-text">
            Кого озадачивают
          </h3>
          {/* Пустой блок в ширину кнопки — заголовок остаётся по центру. */}
          <span className="w-11" />
        </div>

        <ErrorBanner
          error={isError ? error : null}
          fallback="Не удалось посчитать сводку"
          variant="inline"
          className="mb-2"
        />
        {isLoading && <Loading className="my-6" />}

        {data && (
          <div className="flex flex-col gap-5 pb-4">
            <p className="text-[13px] text-dim px-1">
              Служебная переписка исполнителей: {data.всего}{" "}
              {plural(data.всего, "сообщение", "сообщения", "сообщений")}. Твой
              разговор с оркестратором сюда не входит.
            </p>

            <Section title="Кому пишут">
              <StatRows
                rows={data.кому.map((r) => ({
                  имя: r.имя,
                  сообщений: r.сообщений,
                  выделить: !!meId && r.id === meId,
                }))}
                empty="Ещё никому"
              />
            </Section>

            <Section title="Кто пишет">
              <StatRows
                rows={data.от_кого.map((r) => ({
                  имя: r.имя,
                  сообщений: r.сообщений,
                  выделить: !!meId && r.id === meId,
                }))}
                empty="Пока никто"
              />
            </Section>

            <Section title="Кто кому">
              <StatRows
                rows={data.пары.map((r) => ({
                  имя: `${r.от} → ${r.кому}`,
                  сообщений: r.сообщений,
                  выделить: !!meId && r.кому_id === meId,
                }))}
                empty="Переписки ещё не было"
              />
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
