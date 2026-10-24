// Canonical 7-swatch palette for a project's color picker — used when
// creating a project (OverviewScreen's inline form, ProjectsScreen's
// create form) and when renaming/recoloring one (ProjectsScreen). Was
// duplicated verbatim in both screens; consolidated here so the palette
// can't quietly drift between the two entry points.
//
// NOT the same array as LabelsScreen's LABEL_COLORS: same 7 hex values,
// but a *different order* — labels default to the first entry (#FF7A8A,
// pink) and projects default to this array's first entry (#4A9FD8, blue),
// which is a deliberate, documented distinction (see LabelsScreen.tsx),
// not an accidental duplicate to merge away.
export const PROJECT_COLORS = [
  "#4A9FD8",
  "#A78BFA",
  "#E44332",
  "#FF9A14",
  "#FF7A8A",
  "#8FBF9F",
  "#35B8A3",
];
