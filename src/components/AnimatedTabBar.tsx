import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Дословный порт ~/Проекты/CRM/CRM-Castom/frontend/src/components/ui/
// AnimatedTabBar.tsx (118 строк, эталон, утверждён владельцем 2026-07-29 в
// том проекте). Задача 2026-08-11: перенести «горбик» 1:1, а не «по мотивам»
// — предыдущая попытка изобрела свою calc()-формулу позиционирования и не
// взяла CSS-геометрию оригинала, за что была забракована.
// Логика этого файла НЕ ТРОНУТА относительно оригинала: измерение позиции
// активной кнопки через getBoundingClientRect, ResizeObserver, --timeOut
// трюк для мгновенного «прыжка» без анимации при ресайзе, ре-синхронизация
// activeIndex с defaultIndex. Единственное отличие от оригинала — имена CSS-
// классов: там `.menu`/`.menu__item`/`.menu__border`, здесь с префиксом
// `nt-tabbar-*`, чтобы не столкнуться с уже существующими классами проекта
// (в index.css уже есть свой смысл у слова «меню» — плавающее меню действий).
// Сама CSS-геометрия (размеры в em, форма волны clip-path, тени) перенесена
// без изменений в index.css, блок "AnimatedTabBar (перенос из CRM...)".

export interface TabItem {
  icon: ReactNode;
  // Только для aria-label — оригинал тоже не рисует подпись под иконкой
  // (см. AGENTS замечание в отчёте о переносе: подписи физически не влезают
  // в геометрию оригинала без правки его чисел, поэтому их здесь нет).
  label?: string;
}

export interface AnimatedTabBarProps {
  items: TabItem[];
  defaultIndex?: number;
  onTabChange?: (index: number) => void;
}

export function AnimatedTabBar({
  items,
  defaultIndex = 0,
  onTabChange,
}: AnimatedTabBarProps) {
  const [activeIndex, setActiveIndex] = useState(defaultIndex);
  const menuRef = useRef<HTMLMenuElement>(null);
  const menuBorderRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const offsetMenuBorder = useCallback(() => {
    const activeItem = itemRefs.current[activeIndex];
    const menu = menuRef.current;
    const menuBorder = menuBorderRef.current;
    if (!activeItem || !menu || !menuBorder) return;
    const offsetActiveItem = activeItem.getBoundingClientRect();
    const left = Math.floor(
      offsetActiveItem.left -
        menu.getBoundingClientRect().left -
        (menuBorder.offsetWidth - offsetActiveItem.width) / 2,
    );
    menuBorder.style.transform = `translate3d(${left}px, 0, 0)`;
  }, [activeIndex]);

  useLayoutEffect(() => {
    offsetMenuBorder();
    const snapInstantly = () => {
      menuRef.current?.style.setProperty("--timeOut", "none");
      offsetMenuBorder();
    };
    window.addEventListener("resize", snapInstantly);
    // ResizeObserver — бар может смонтироваться скрытым (мобильная/десктоп
    // раскладка Layout.tsx) и стать видимым без resize-события окна, иначе
    // бегунок застревает в translate3d(0,0,0).
    const ro = new ResizeObserver(snapInstantly);
    if (menuRef.current) ro.observe(menuRef.current);
    return () => {
      window.removeEventListener("resize", snapInstantly);
      ro.disconnect();
    };
  }, [offsetMenuBorder, items.length]);

  // Ре-синхронизация при смене вкладки извне (навигация не только кликом по
  // бару, а и, например, программным navigate()).
  useLayoutEffect(() => {
    setActiveIndex(defaultIndex);
  }, [defaultIndex]);

  const handleItemClick = (index: number) => {
    menuRef.current?.style.removeProperty("--timeOut");
    if (activeIndex === index) return;
    setActiveIndex(index);
    onTabChange?.(index);
  };

  return (
    <>
      <div className="nt-tabbar-svg-container" aria-hidden="true">
        <svg viewBox="0 0 202.9 45.5">
          <clipPath
            id="nt-tabbar-menu-clip-path"
            clipPathUnits="objectBoundingBox"
            transform="scale(0.0049285362247413 0.021978021978022)"
          >
            <path d="M6.7,45.5c5.7,0.1,14.1-0.4,23.3-4c5.7-2.3,9.9-5,18.1-10.5c10.7-7.1,11.8-9.2,20.6-14.3c5-2.9,9.2-5.2,15.2-7 c7.1-2.1,13.3-2.3,17.6-2.1c4.2-0.2,10.5,0.1,17.6,2.1c6.1,1.8,10.2,4.1,15.2,7c8.8,5,9.9,7.1,20.6,14.3c8.3,5.5,12.4,8.2,18.1,10.5 c9.2,3.6,17.6,4.2,23.3,4H6.7z" />
          </clipPath>
        </svg>
      </div>

      <menu className="nt-tabbar-menu" ref={menuRef}>
        {items.map((item, index) => (
          <button
            key={index}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            type="button"
            className={`nt-tabbar-menu__item ${activeIndex === index ? "active" : ""}`}
            onClick={() => handleItemClick(index)}
            aria-label={item.label ?? `Tab ${index + 1}`}
            aria-current={activeIndex === index ? "page" : undefined}
          >
            {item.icon}
          </button>
        ))}
        <div className="nt-tabbar-menu__border" ref={menuBorderRef} />
      </menu>
    </>
  );
}
