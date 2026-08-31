import Foundation

/// Модель шаблона задачи — 1:1 полям `TaskTemplate` из `src/lib/templates.ts`
/// (см. `TemplatesScreen.swift` — источник для геометрии/логики этого экрана).
struct TaskTemplate: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var description: String?
    var priority: Int?
    var subtasks: [String]?
    var category: String?
    var isBuiltin: Bool
    var createdAt: String?
}

/// Порт веб-хранилища `TemplateStore` (`src/lib/templates.ts`) на
/// `UserDefaults` — спека §15 прямо требует локальное устройство, не
/// сервер. Формат JSON свой (Swift `Codable`, не совпадает байт-в-байт с
/// localStorage веба) — это ОТДЕЛЬНОЕ хранилище, шаблоны между вебом и
/// нативным приложением не синхронизируются, как и в браузере на другом
/// устройстве.
enum TemplateStore {
    private static let storageKey = "taskflow_native_user_templates_v1"

    static func userTemplates() -> [TaskTemplate] {
        guard let data = UserDefaults.standard.data(forKey: storageKey) else { return [] }
        return (try? JSONDecoder().decode([TaskTemplate].self, from: data)) ?? []
    }

    private static func write(_ templates: [TaskTemplate]) {
        guard let data = try? JSONEncoder().encode(templates) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }

    @discardableResult
    static func save(title: String, description: String?, priority: Int?, subtasks: [String], category: String) -> TaskTemplate {
        var templates = userTemplates()
        let template = TaskTemplate(
            id: "custom-\(Int(Date().timeIntervalSince1970 * 1000))-\(Int.random(in: 10000...99999))",
            title: title,
            description: description,
            priority: priority,
            subtasks: subtasks.isEmpty ? nil : subtasks,
            category: category,
            isBuiltin: false,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )
        // `unshift` в вебе — новые шаблоны сверху списка.
        templates.insert(template, at: 0)
        write(templates)
        return template
    }

    static func update(id: String, title: String, description: String?, priority: Int?, subtasks: [String], category: String) {
        var templates = userTemplates()
        guard let index = templates.firstIndex(where: { $0.id == id }) else { return }
        templates[index].title = title
        templates[index].description = description
        templates[index].priority = priority
        templates[index].subtasks = subtasks.isEmpty ? nil : subtasks
        templates[index].category = category
        write(templates)
    }

    static func delete(id: String) {
        write(userTemplates().filter { $0.id != id })
    }

    /// 6 встроенных образцов — дословный порт `BUILTIN_TEMPLATES`
    /// (`src/lib/templates.ts`), тексты и порядок подзадач не менялись.
    static let builtinTemplates: [TaskTemplate] = [
        TaskTemplate(
            id: "builtin-onboarding", title: "🚀 Старт нового проекта",
            description: "Пошаговый чеклист запуска нового проекта от идеи до первого релиза",
            priority: 1, subtasks: [
                "Собрать требования и составить ТЗ",
                "Описать архитектуру и схему базы данных",
                "Настроить репозиторий и CI/CD пайплайн",
                "Реализовать базовый каркас и API",
                "Написать unit-тесты для критических модулей",
                "Провести демо и собрать первую обратную связь",
            ], category: "Разработка", isBuiltin: true, createdAt: nil
        ),
        TaskTemplate(
            id: "builtin-weekly-review", title: "🎯 Еженедельный обзор (Weekly Review)",
            description: "Регулярная сверка планов, разбор входящих и актуализация приоритетов",
            priority: 2, subtasks: [
                "Разобрать Входящие (Inbox) до нуля",
                "Просмотреть задачи на текущую и следующую неделю",
                "Проверить статус работы у назначенных AI-агентов",
                "Актуализировать дедлайны и приоритеты",
                "Сформулировать топ-3 главные цели на неделю",
            ], category: "Продуктивность", isBuiltin: true, createdAt: nil
        ),
        TaskTemplate(
            id: "builtin-release-prep", title: "📦 Подготовка и выпуск релиза",
            description: "Чеклист проверки перед публикацией обновления в прод и на устройства",
            priority: 1, subtasks: [
                "Прогнать тесты фронтенда (npm test) и сервера (npm test)",
                "Собрать список изменений (Changelog) в STATUS.md",
                "Собрать production веб-бандл (npm run build)",
                "Собрать Release iOS-билд в Xcode",
                "Установить и протестировать на физическом iPhone",
                "Сделать git commit и git push в основной репозиторий",
            ], category: "Разработка", isBuiltin: true, createdAt: nil
        ),
        TaskTemplate(
            id: "builtin-bug-investigation", title: "🐛 Анализ и исправление бага",
            description: "Стандартный процесс локализации и устранения дефекта",
            priority: 2, subtasks: [
                "Воспроизвести проблему и зафиксировать шаги",
                "Собрать логи сервера и клиентские ошибки",
                "Локализовать причину в коде",
                "Написать тест, воспроизводящий дефект",
                "Реализовать исправление",
                "Проверить регрессию и закрыть инцидент",
            ], category: "Разработка", isBuiltin: true, createdAt: nil
        ),
        TaskTemplate(
            id: "builtin-travel-checklist", title: "🧳 Сборы в поездку / путешествие",
            description: "Чеклист необходимых вещей и документов перед выездом",
            priority: 3, subtasks: [
                "Проверить паспорт, билеты и бронь отеля",
                "Собрать зарядные устройства, кабели и пауэрбанк",
                "Подготовить аптечку и базовые медикаменты",
                "Собрать одежду по прогнозу погоды",
                "Проверить ключи, выключить электроприборы и воду дома",
            ], category: "Личное", isBuiltin: true, createdAt: nil
        ),
        TaskTemplate(
            id: "builtin-workout", title: "🏋️ Тренировка и ЗОЖ",
            description: "План регулярной тренировочной сессии",
            priority: 3, subtasks: [
                "Разминка и суставная гимнастика (10 мин)",
                "Основной блок упражнений (силовая / кардио 40 мин)",
                "Заминка и растяжка (10 мин)",
                "Зафиксировать вес, пульс и общее самочувствие",
            ], category: "Здоровье", isBuiltin: true, createdAt: nil
        ),
    ]
}
