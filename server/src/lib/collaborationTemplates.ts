/** Owner-approved workflow packages. Persist generated instructions in the plan, never
 * recompute running plans from a newer catalog. Skills are stage candidates, not proof of use. */
export const TEMPLATE_VERSION = 1;
export const TEMPLATE_PROFILES = ["single_executor", "research", "delivery", "full_cycle", "orchestrated", "product_feature", "bug_regression", "ux_concept", "api_integration", "audit"] as const;
const goals: Record<string, string> = {
 single_executor: "Выполни ограниченное поручение без формальных лишних этапов. Назови результат, доказательства и ограничения.",
 research: "Ответь на исследовательский вопрос. Вывод должен прослеживаться до первичных источников. Внедрение не входит.",
 delivery: "Доведи ясную задачу до реализации и независимой проверки исходного сценария владельца.",
 full_cycle: "Исследование → требования → параллельные техническое и UX-решения → реализация → QA → независимый вердикт.",
 orchestrated: "Оркестратор декомпозирует и раздаёт работу, затем принимает и интегрирует результаты команды. Соблюдай действующий протокол task.orchestrate; не заменяй команду собственной реализацией.",
 product_feature: "Реализуй продуктовую возможность по проверяемым критериям с техническим и UX-решением и проверкой результата.",
 bug_regression: "Воспроизведение → доказанная причина → ограниченное исправление → повтор исходного сценария и регрессии. Исчезновение симптома не доказывает причину.",
 ux_concept: "Создай проверяемую UX-концепцию и независимый разбор. Реализация продукта в этот шаблон не входит.",
 api_integration: "Официальный API-контракт → решение → параллельно реализация и подготовка проверок → проверка интеграции.",
 audit: "Независимо оцени объект по явным критериям. Только исследование и отчёт: исправления, деплой и изменение объекта автоматически в аудит НЕ входят.",
};
const roleFocus: Record<string, string> = {
 researcher: "Найди прежние решения и первичные источники; проверь версию и актуальность. Различай наблюдения и гипотезы. Не выдумывай интервью, ответы людей или результаты запуска.",
 analyst: "Зафиксируй цель, границы, сценарии и критерии. Сравни варианты по одинаковым основаниям, перечисли недостающие сведения и ограничения вывода.",
 architect: "Выбери соразмерное техническое решение; опиши интерфейсы, данные, риски, совместимость, проверку и откат. Выводы обоснуй фактами.",
 designer: "Изучи текущий интерфейс и пользовательскую задачу. Опиши основной путь, навигацию, загрузку, пустые состояния, ошибки и доступность. Дай прототип/макет и спецификацию поведения; используй дизайн-систему проекта.",
 builder: "Реализуй согласованное решение в границах карточки, сохрани смежное поведение. Передай ссылки на изменения, проверки, настройки и ограничения. Не расширяй работу попутным рефакторингом.",
 qa: "Проверь критерии и сценарий владельца, ошибки и связанные регрессии. Различай unit/mock, симулятор, устройство, sandbox и живой сервис; перечисли фактические доказательства и непроверенное.",
 critic_verifier: "Независимо сопоставь цель, результат и доказательства. Проверь ложные срабатывания и существенные пробелы, выдай обоснованный вердикт и конкретные замечания.",
 code_orchestrator: "Декомпозируй по результатам, назначь исполнителей и ответственного за интеграцию; прими результаты команды и собери итог по действующему процессу.",
};
const commonSkills: Record<string, string[]> = {
 researcher: ["writing-for-agents"], analyst: ["writing-for-agents"],
 architect: ["domain-modeling", "writing-for-agents"],
 designer: ["information-architecture", "ux-copy", "design-critique"],
 builder: ["verify-after-edit"], qa: ["unhappy"],
 critic_verifier: ["review-changes", "verdict-requires-live-scenario"],
 code_orchestrator: ["one-agent-one-task", "orchestrate-step-submission"],
};
export type TemplateNode = { slot_key: string; role_key: string; expected_result: string; instructions?: string | null; source_subtask_id?: string | null };
/** Pure snapshot builder. Platform skills are selected from the card at creation time. */
export function templateInstructions(profile: string, node: TemplateNode, taskText: string): string | null {
 if (!goals[profile] || node.source_subtask_id) return node.instructions ?? null;
 let skills = [...(commonSkills[node.role_key] ?? [])];
 let focus = roleFocus[node.role_key] ?? "Выполни назначенный этап по критериям карточки.";
 const apple = /\bios\b|iphone|ipad|swift|swiftui|appkit|macos|нативн/iu.test(taskText);
 const code = /код|code|репозитор|repo|swift|api|программ|typescript|backend|сервер/iu.test(taskText);
 if (node.role_key === "researcher") {
   if (code) skills.push("explore-codebase");
   if (/пользовател|интервью|usability|user research/iu.test(taskText)) skills.push("user-research");
   if (/интервью|отзыв|опрос|исследован|research/iu.test(taskText)) skills.push("research-synthesis");
 }
 if (node.role_key === "analyst" && /интервью|отзыв|опрос|исследован|research/iu.test(taskText)) skills.push("research-synthesis");
 if (profile === "bug_regression" && ["architect", "builder"].includes(node.role_key)) {
   skills.push("diagnosing-bugs");
   if (node.role_key === "architect") focus = "Проверь гипотезы логами и воспроизведением. Установи причину и связь с симптомом, дай границу исправления. На этом этапе код не исправляй.";
 }
 if (profile === "audit") {
   if (node.role_key === "analyst") focus = "Зафиксируй объект, версию/среду, цель, критерии, исключения и план покрытия аудита.";
   if (node.role_key === "architect") {
     focus = "Проведи предметный аудит по согласованным критериям. Для каждой находки дай место, доказательство, влияние, серьёзность, рекомендацию; отдельно покрытие и пробелы. Не начинай исправления.";
     skills = ["writing-for-agents", ...(code ? ["audit-context-building"] : [])];
   }
   if (node.role_key === "critic_verifier") {
     focus = "Проверь обоснованность находок, серьёзность, покрытие и ложные срабатывания. Вердикт относится к аудиту, а не к выполнению исправлений. Отдели подтверждённое от требующего проверки.";
     skills = ["writing-for-agents", ...(code ? ["audit-context-building"] : [])];
     if (/diff|изменени|коммит|commit|pull request/iu.test(taskText)) skills.push("differential-review");
   }
 }
 if (profile === "ux_concept" && node.role_key === "critic_verifier") skills = ["design-critique"];
 if (profile === "api_integration") {
   if (node.role_key === "researcher") focus = "Проверь официальную документацию: версию API, авторизацию, квоты, webhooks и ограничения тестовой среды. Приведи ссылки; доступность по документации не выдавай за успешный обмен.";
   if (node.role_key === "architect") focus += " Опиши отображение данных, ошибки, повторы, идемпотентность, тайм-ауты и хранение секретов.";
   if (["builder", "qa"].includes(node.role_key)) skills.push("property-based-testing");
   if (node.slot_key === "qa_prepare") focus = "По контракту подготовь сценарии: успех, отказы, квоты, повторная доставка, частичный сбой и истечение авторизации. Проверку ещё не реализованного обмена не объявляй пройденной.";
 }
 if (apple) {
   if (node.role_key === "designer") skills.push("ios-hig-design", "ios-accessibility");
   if (node.role_key === "builder") skills.push("swiftui-expert-skill", "swift-concurrency", "swift-testing-expert");
   if (node.role_key === "architect" && profile !== "audit") skills.push("swift-concurrency");
   if (node.role_key === "qa") skills.push("ios-accessibility", "swift-testing-expert", "ios-simulator-ui-check");
 }
 return [
   `Шаблон: ${profile}@${TEMPLATE_VERSION}. Этап: ${node.slot_key}.`,
   goals[profile], focus,
   "Вход: цель, описание и границы текущей карточки; результаты предшествующих этапов из контекста плана. Сначала проверь их полноту, не выдумывай отсутствующие факты. Уточнение, требующее решения владельца, направляй через существующий механизм вопросов.",
   `Результат и критерий этапа: ${node.expected_result}. Передай доказательства, ограничения и ссылки следующему участнику. Соблюдай объявленный контракт артефакта.`,
   `Навыки этапа: ${[...new Set(skills)].join(", ")}.`,
   "Прочитай подходящие SKILL.md из доступного набора перед применением. Учитывай ограничения description; наличие навыка не доказывает его применение. Если навыка нет, явно укажи ограничение. Общие правила роли и разрешения карточки сохраняются.",
 ].join("\n\n");
}
/** Only a persisted template snapshot narrows delivery; manual/legacy runs stay compatible. */
export function stageSkillNames(instructions?: string | null): string[] | null {
 if (!instructions || !/^Шаблон: [a-z_]+@\d+\. Этап: /mu.test(instructions)) return null;
 const names = /^Навыки этапа: ([a-z0-9, -]*)\.$/mu.exec(instructions)?.[1];
 return names === undefined ? null : names.split(",").map(s => s.trim()).filter(Boolean);
}

const artifact = (key: string, required_fields: string[]) => ({ key, type: "report", format: "json" as const, required_fields });
const node = (slot_key: string, role_key: string, expected_result: string, key: string, fields: string[]) => ({slot_key, role_key, required: true, expected_result, output_artifact: artifact(key, fields), source_subtask_id: null});
const edge = (from_slot_key: string, to_slot_key: string, artifact_key: string) => ({from_slot_key, to_slot_key, start_condition: "artifact_ready", artifact_key});
export function additionalTemplate(profile: string) {
 if (profile === "ux_concept") return {
   rationale: "UX-концепция: дизайнер → независимый критик; без реализации продукта.",
   nodes: [node("design", "designer", "UX-концепция: сценарии, состояния, доступность, прототип и спецификация поведения", "ux_concept", ["scenarios", "states", "accessibility", "prototype_refs", "limitations"]),
     node("critique", "critic_verifier", "Независимый разбор UX-концепции и вердикт", "ux_review", ["findings", "evidence", "verdict", "limitations"])],
   edges: [edge("design", "critique", "ux_concept")],
 };
 if (profile === "api_integration") return {
   rationale: "API-интеграция: исследование → архитектура → [разработка ∥ подготовка QA] → проверка QA.",
   nodes: [node("research", "researcher", "Официальный API-контракт и подтверждённые ограничения", "api_research", ["sources", "version", "auth", "limits", "sandbox", "open_questions"]),
     node("architecture", "architect", "Контракт реализации интеграции", "api_contract", ["data_mapping", "errors", "retries", "idempotency", "secrets", "acceptance_criteria"]),
     node("delivery", "builder", "Реализация интеграции и конфигурация", "api_implementation", ["change_refs", "configuration", "tests", "limitations"]),
     node("qa_prepare", "qa", "Подготовленные сценарии проверки API-контракта", "api_test_plan", ["scenarios", "fixtures", "environments"]),
     node("qa_verify", "qa", "Проверка обмена и значимых ошибок интеграции", "api_test_report", ["acceptance_matrix", "evidence", "environment", "defects", "limitations"])],
   edges: [edge("research", "architecture", "api_research"), edge("architecture", "delivery", "api_contract"), edge("architecture", "qa_prepare", "api_contract"), edge("delivery", "qa_verify", "api_implementation"), edge("qa_prepare", "qa_verify", "api_test_plan")],
 };
 if (profile === "audit") return {
   rationale: "Аудит: рамки и критерии → предметная проверка → независимый разбор находок. Исправления не входят.",
   nodes: [node("scope", "analyst", "Объект, критерии, исключения и план покрытия аудита", "audit_scope", ["object", "version", "criteria", "exclusions", "coverage_plan"]),
     node("inspection", "architect", "Доказательные находки и покрытие аудита", "audit_findings", ["findings", "evidence", "severity", "coverage", "gaps"]),
     node("review", "critic_verifier", "Проверка находок, ложных срабатываний и итог аудита", "audit_review", ["confirmed", "false_positives", "coverage", "recommendations", "limitations"])],
   edges: [edge("scope", "inspection", "audit_scope"), edge("inspection", "review", "audit_findings")],
 };
 return null;
}
