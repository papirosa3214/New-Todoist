import XCTest
@testable import TaskFlow

/// Юнит-тесты на `TodayFilterEngine`.
final class TodayFilterEngineTests: XCTestCase {

    private func make(_ id: String, projectId: String? = nil, labelIds: [String] = [], assigneeId: String? = nil, status: TaskStatus = .active) -> ApiTask {
        TestTaskFactory.make(id, projectId: projectId, labelIds: labelIds, assigneeId: assigneeId, status: status)
    }

    // MARK: matches / filter

    func testEmptyFilterПропускаетАктивные() {
        let t = make("t1", projectId: "p1", labelIds: ["l1"], assigneeId: "u1")
        XCTAssertTrue(TodayFilterEngine.matches(t, .empty))
    }

    func testФильтрПоПроекту() {
        XCTAssertTrue(TodayFilterEngine.matches(make("t1", projectId: "p1"), TodayTaskFilters(projectId: "p1")))
        XCTAssertFalse(TodayFilterEngine.matches(make("t2", projectId: "p2"), TodayTaskFilters(projectId: "p1")))
        XCTAssertFalse(TodayFilterEngine.matches(make("t3", projectId: nil), TodayTaskFilters(projectId: "p1")))
    }

    func testФильтрПоМетке() {
        let filter = TodayTaskFilters(labelId: "l1")
        XCTAssertTrue(TodayFilterEngine.matches(make("t1", labelIds: ["l1", "l2"]), filter))
        XCTAssertFalse(TodayFilterEngine.matches(make("t2", labelIds: ["l2"]), filter))
        XCTAssertFalse(TodayFilterEngine.matches(make("t3", labelIds: []), filter))
        XCTAssertFalse(TodayFilterEngine.matches(make("t4", labelIds: ["l1"]), TodayTaskFilters(labelId: "no-such")))
    }

    func testФильтрПоИсполнителю() {
        let filter = TodayTaskFilters(assigneeKey: "u1")
        XCTAssertTrue(TodayFilterEngine.matches(make("t1", assigneeId: "u1"), filter))
        XCTAssertFalse(TodayFilterEngine.matches(make("t2", assigneeId: "u2"), filter))
        XCTAssertFalse(TodayFilterEngine.matches(make("t3", assigneeId: nil), filter))
    }

    func testФильтрБезИсполнителя() {
        let filter = TodayTaskFilters(assigneeKey: "__none")
        XCTAssertTrue(TodayFilterEngine.matches(make("t1", assigneeId: nil), filter))
        XCTAssertFalse(TodayFilterEngine.matches(make("t2", assigneeId: "u1"), filter))
    }

    func testShowCompletedПоУмолчаниюСкрываетВыполненные() {
        XCTAssertFalse(TodayFilterEngine.matches(make("t", status: .completed), .empty))
    }

    func testShowCompletedВключаетВыполненные() {
        XCTAssertTrue(TodayFilterEngine.matches(make("t", status: .completed), TodayTaskFilters(showCompleted: true)))
    }

    func testКомбинацияФильтровЭтоИ() {
        let filter = TodayTaskFilters(projectId: "p1", labelId: "l1", assigneeKey: "u1")
        XCTAssertTrue(TodayFilterEngine.matches(make("t1", projectId: "p1", labelIds: ["l1"], assigneeId: "u1"), filter))
        XCTAssertFalse(TodayFilterEngine.matches(make("t2", projectId: "p1", labelIds: ["l2"], assigneeId: "u1"), filter))
        XCTAssertFalse(TodayFilterEngine.matches(make("t3", projectId: "p2", labelIds: ["l1"], assigneeId: "u1"), filter))
    }

    // MARK: projectOptions / labelOptions / assigneeOptions

    func testProjectOptionsБезДублей() {
        let options = TodayFilterEngine.projectOptions([
            TestTaskFactory.makeTask(id: "t1", projectId: "p1", projectName: "Работа"),
            TestTaskFactory.makeTask(id: "t2", projectId: "p1", projectName: "Работа"),
            TestTaskFactory.makeTask(id: "t3", projectId: "p2", projectName: "Личное")
        ])
        XCTAssertEqual(options.count, 2)
    }

    func testLabelOptionsБезДублей() {
        let options = TodayFilterEngine.labelOptions([
            make("t1", labelIds: ["l1", "l2"]),
            make("t2", labelIds: ["l1"]),
            make("t3", labelIds: [])
        ])
        XCTAssertEqual(Set(options.map(\.id)), Set(["l1", "l2"]))
    }

    func testAssigneeOptionsБезДублейИСигналитОUnassigned() {
        let (list, hasUnassigned) = TodayFilterEngine.assigneeOptions([
            TestTaskFactory.makeTask(id: "t1", assigneeId: "u1", assigneeName: "А", assigneeInitials: "А"),
            TestTaskFactory.makeTask(id: "t2", assigneeId: "u1", assigneeName: "А", assigneeInitials: "А"),
            TestTaskFactory.makeTask(id: "t3", assigneeId: "u2", assigneeName: "Б", assigneeInitials: "Б"),
            TestTaskFactory.makeTask(id: "t4")
        ])
        XCTAssertEqual(list.map(\.id), ["u1", "u2"])
        XCTAssertTrue(hasUnassigned)
    }

    // MARK: isActive

    func testIsActiveПустой() {
        XCTAssertFalse(TodayTaskFilters.empty.isActive)
    }

    func testIsActiveЛюбойФильтрВключён() {
        XCTAssertTrue(TodayTaskFilters(projectId: "p1").isActive)
        XCTAssertTrue(TodayTaskFilters(labelId: "l1").isActive)
        XCTAssertTrue(TodayTaskFilters(assigneeKey: "u1").isActive)
        XCTAssertTrue(TodayTaskFilters(assigneeKey: "__none").isActive)
        XCTAssertTrue(TodayTaskFilters(showCompleted: true).isActive)
    }
}
