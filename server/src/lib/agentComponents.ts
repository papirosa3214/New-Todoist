// Интерфейс от агента одним форматом (AG-UI generative UI, 27.10.2026):
// роль шлёт имя компонента и данные, телефон рисует по имени свой нативный
// компонент из реестра. Блоки ```widget и элементы ```tf-json сводятся сюда;
// старые поля блока (`json`) остаются для клиентов, которые формат не знают.

export interface AgentComponent {
  name: string;
  props: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Блок ```widget: имя — его `type`, данные — весь JSON. */
export function componentOfWidget(value: unknown): AgentComponent | null {
  if (!isObject(value) || typeof value.type !== "string" || !value.type) return null;
  return { name: value.type, props: value };
}

/** Конверт ```tf-json: каждый блок `output` — компонент; `widget` разворачивается. */
export function componentsOfStructured(envelope: unknown): AgentComponent[] | null {
  if (!isObject(envelope) || !Array.isArray(envelope.output)) return null;
  const out: AgentComponent[] = [];
  for (const block of envelope.output) {
    const component = isObject(block) && block.type === "widget" ? componentOfWidget(block.widget) : componentOfWidget(block);
    if (component) out.push(component);
  }
  return out;
}
