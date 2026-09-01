import XCTest
import SnapshotTesting
@testable import TaskFlow

/// Snapshot-тесты дизайн-системы (задание Б3). Каркас — реальные эталоны
/// ещё не записаны; при первом прогоне нужно включить `record = true`,
/// запустить тесты, затем выключить.
///
/// ⚠️ Сейчас все 4 теста в этом файле падают на первом прогоне — это норм:
/// snapshotTesting требует существующего эталона. После первой записи эталона
/// (`record = true` + запуск + `record = false`) они начнут сравнивать.
final class TaskRowSnapshotTests: XCTestCase {

    private let deviceConfig: ViewImageConfig = .iPhone13Pro
    // Эталоны уже записаны (record = true → прогон → false → коммит PNG).
    // По разбору ревьюера: PNG должны быть в git, иначе каждый CI красный
    // при чистой копии (rsync --delete сносит эталоны на маке).
    private var record: Bool { false }

    private func make(
        id: String,
        title: String,
        dueDate: String? = nil,
        projectId: String? = nil,
        projectName: String? = nil,
        assigneeId: String? = nil,
        assigneeName: String? = nil,
        assigneeInitials: String? = nil,
        priority: Int = 1,
        status: TaskStatus = .active
    ) -> ApiTask {
        var json: [String: Any] = [
            "id": id,
            "title": title,
            "priority": priority,
            "status": status == .completed ? "completed" : "active",
            "pinned": 0,
            "creator_id": "u-owner"
        ]
        if let dueDate { json["due_date"] = dueDate }
        if let projectId { json["project_id"] = projectId }
        if let projectName { json["project_name"] = projectName }
        if let assigneeId { json["assignee_id"] = assigneeId }
        if let assigneeName { json["assignee_name"] = assigneeName }
        if let assigneeInitials { json["assignee_initials"] = assigneeInitials }
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(ApiTask.self, from: data)
    }

    func testTaskRowОбычная() {
        let задача = make(
            id: "t1", title: "Сходить в магазин",
            projectId: "p1", projectName: "Личное",
            assigneeId: "u1", assigneeName: "Максим", assigneeInitials: "М"
        )
        let row = TodayTaskRow(
            task: задача, overdue: false,
            onOpen: {}, onComplete: {}, onReschedule: {}, onDelete: {}
        )
        .frame(width: 420)
        .padding()
        assertSnapshot(of: row, as: .image(layout: .device(config: deviceConfig)), record: record)
    }

    func testTaskRowПросроченная() {
        let задача = make(
            id: "t2", title: "Старая задача", dueDate: "2025-01-01",
            projectId: "p2", projectName: "Работа",
            assigneeId: "u1", assigneeName: "Максим", assigneeInitials: "М"
        )
        let row = TodayTaskRow(
            task: задача, overdue: true,
            onOpen: {}, onComplete: {}, onReschedule: {}, onDelete: {}
        )
        .frame(width: 420)
        .padding()
        assertSnapshot(of: row, as: .image(layout: .device(config: deviceConfig)), record: record)
    }

    func testTodayEmptyIllustration() {
        let view = TodayEmptyIllustration()
            .frame(width: 420, height: 600)
        assertSnapshot(of: view, as: .image(layout: .device(config: deviceConfig)), record: record)
    }
}
