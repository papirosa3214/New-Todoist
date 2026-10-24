import { createContext, useContext } from "react";
import { useLocation, type Location } from "react-router-dom";

// Разнесено с backgroundLocation.tsx намеренно: там — единственный
// компонент (RealLocationProvider, react-refresh требует, чтобы .tsx-файл
// экспортировал только компоненты), здесь — контекст и функции вокруг него.
// Смысл обоих — см. комментарий в backgroundLocation.tsx.
export const RealLocationContext = createContext<Location | null>(null);

export function useRealLocation(): Location {
  const ctx = useContext(RealLocationContext);
  const fallback = useLocation();
  return ctx ?? fallback;
}

export interface OverlayState {
  backgroundLocation?: Location;
}

export function getOverlayState(location: Location): OverlayState | null {
  return (location.state as OverlayState | null) ?? null;
}
