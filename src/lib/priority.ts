// ═══════════ PRIORITY ═══════════
// Single canonical source for priority label/name/color — previously
// duplicated as ad-hoc `PRIORITY_COLORS` maps (InboxScreen) and hardcoded
// `border-red` (Today/Upcoming, wrong for every priority but P1). Anything
// touching priority — a colored dot, a P1..P4 pill, a picker list — should
// import from here rather than redefine its own copy.
//
// Lives in lib/, not components/UI.tsx, purely so UI.tsx stays
// component-only exports (oxlint's react/only-export-components — mixing
// components and plain consts in one file defeats Vite Fast Refresh for
// that file). Re-exported from UI.tsx, so `from "../components/UI"` still
// works everywhere.
export const PRIORITIES = [
  { key: 1, label: "P1", name: "Срочный", color: "#E44332" },
  { key: 2, label: "P2", name: "Высокий", color: "#FF9A14" },
  { key: 3, label: "P3", name: "Средний", color: "#4A9FD8" },
  { key: 4, label: "P4", name: "Низкий", color: "#A6A6A6" },
] as const;

export type PriorityInfo = (typeof PRIORITIES)[number];

// Flat { 1: "#E44332", ... } map — for the common case of just needing a
// color (e.g. a priority dot's border), without pulling in the full
// PRIORITIES metadata.
export const PRIORITY_COLORS: Record<number, string> = Object.fromEntries(
  PRIORITIES.map((p) => [p.key, p.color]),
);

// Tailwind has no dynamic class names (`border-${x}` does not work — the
// class has to appear as a literal string somewhere for the JIT compiler to
// find it), so a per-task color always has to go through inline `style`,
// never a class. Use like:
//   <div className="w-[18px] h-[18px] rounded-full border-2 shrink-0"
//        style={{ borderColor: getPriorityColor(task.priority) }} />
// Defaults to P4's gray for null/undefined/out-of-range input so a missing
// priority never renders as an unstyled/transparent border.
export function getPriorityColor(priority: number | null | undefined): string {
  return PRIORITY_COLORS[priority ?? 4] ?? PRIORITY_COLORS[4];
}
