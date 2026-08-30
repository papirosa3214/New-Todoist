import { useState, useLayoutEffect, type ReactNode } from "react";

// Порт нижней панели из клиентского мини-аппа CRM (~/Проекты/CRM/CRM-Castom/
// frontend/src/components/ui/AnimatedTabBar.tsx). От оригинала осталась суть —
// ряд иконок, где активная подсвечивается кругом, — но два его фирменных
// приёма сняты по решению владельца 27.08.2026:
//
//  • ГОРБ («пузырь» с clip-path, ехавший за активной вкладкой) убран целиком:
//    «по бокам кнопочки, никакого горбика не надо». Вместе с ним ушли расчёт
//    позиции через getBoundingClientRect, ResizeObserver и трюк --timeOut —
//    двигать больше нечего, ряд статичный.
//  • ПОДЪЁМ активной вкладки убран там же: круг-«шарик» появляется под
//    иконкой прямо в полосе (CSS-анимация scale, см. index.css).
//
// Что добавлено против оригинала — центральная кнопка создания: по референсу
// владельца (скриншот 27.08.2026) четыре вкладки стоят по бокам, а посередине
// круглая кнопка, открывающая меню «что создать». Она НЕ вкладка: активной не
// бывает, в нумерации вкладок не участвует.

export interface TabItem {
  icon: ReactNode;
  // Только для aria-label — панель не рисует подписи под иконками
  // (в геометрию оригинала они не влезают, и владелец их не просил).
  label?: string;
}

export interface CenterAction {
  label: string;
  onPress: () => void;
  /** Меню открыто — кнопка доворачивает «плюс» в «крестик». */
  open?: boolean;
}

export interface AnimatedTabBarProps {
  items: TabItem[];
  defaultIndex?: number;
  onTabChange?: (index: number) => void;
  /** Кнопка создания в середину ряда. Без неё панель — просто ряд вкладок. */
  centerAction?: CenterAction;
}

export function AnimatedTabBar({
  items,
  defaultIndex = 0,
  onTabChange,
  centerAction,
}: AnimatedTabBarProps) {
  const [activeIndex, setActiveIndex] = useState(defaultIndex);

  // Ре-синхронизация при смене вкладки извне (программный navigate, переход
  // по ссылке, экран вне вкладок — тогда приходит -1 и активной нет ни одной).
  useLayoutEffect(() => {
    setActiveIndex(defaultIndex);
  }, [defaultIndex]);

  const handleItemClick = (index: number) => {
    if (activeIndex === index) return;
    setActiveIndex(index);
    onTabChange?.(index);
  };

  // Кнопка встаёт ровно в середину: при четырёх вкладках это две слева и две
  // справа — то, что владелец и просил («получится у нас как раз 4 кнопки по
  // бокам, центральная посередине»).
  const centerAt = Math.ceil(items.length / 2);

  return (
    <menu className="nt-tabbar-menu">
      {items.slice(0, centerAt).map((item, index) => (
        <TabButton
          key={index}
          item={item}
          index={index}
          active={activeIndex === index}
          onClick={handleItemClick}
        />
      ))}

      {centerAction && (
        <button
          type="button"
          className={`nt-tabbar-menu__action ${centerAction.open ? "open" : ""}`}
          onClick={centerAction.onPress}
          aria-label={centerAction.label}
          aria-expanded={centerAction.open ?? false}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}

      {items.slice(centerAt).map((item, i) => {
        const index = centerAt + i;
        return (
          <TabButton
            key={index}
            item={item}
            index={index}
            active={activeIndex === index}
            onClick={handleItemClick}
          />
        );
      })}
    </menu>
  );
}

function TabButton({
  item,
  index,
  active,
  onClick,
}: {
  item: TabItem;
  index: number;
  active: boolean;
  onClick: (index: number) => void;
}) {
  return (
    <button
      type="button"
      className={`nt-tabbar-menu__item ${active ? "active" : ""}`}
      onClick={() => onClick(index)}
      aria-label={item.label ?? `Tab ${index + 1}`}
      aria-current={active ? "page" : undefined}
    >
      {item.icon}
    </button>
  );
}
