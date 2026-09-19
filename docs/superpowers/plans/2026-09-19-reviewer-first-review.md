# Reviewer-first Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New TaskFlow cards require a commented Reviewer verdict before their owner can perform the final close; an owner may opt a card out.

**Architecture:** Keep `agent_state='review'` as the only review state. Store the routing decision on `tasks.requires_reviewer_review`; store the Reviewer verdict on the current result version in `reviews`. The server enforces the state and close gates; web and iOS only render the actions the server permits.

**Tech Stack:** Fastify + SQLite + Vitest; React + TanStack Query; SwiftUI + XCTest.

**Spec:** `docs/superpowers/specs/2026-09-19-reviewer-first-review-design.md`

## Global Constraints

- Existing cards migrate to `requires_reviewer_review=0`; new cards default to `1`.
- Reviewer approval and return both require non-blank text.
- Reviewer approval never closes a card; only the owner can set `status='completed'`.
- A Reviewer verdict applies only to the current result version.
- Keep unrelated dirty working-tree changes intact; stage only files named in each commit.

---

### Task 1: Persist and expose the per-card route

**Files:**
- Modify: `server/src/db.ts`, `server/src/migrations.ts`, `server/src/routes/tasks.ts`
- Modify: `src/api/types.ts`, `src/api/tasks.ts`, `src/screens/TaskFormScreen.tsx`
- Test: `server/test/reviewerFirstReview.test.ts`

**Interfaces:**
- Produces `tasks.requires_reviewer_review` as `0 | 1`.
- Produces `requires_reviewer_review?: boolean` in the web task types.

- [ ] **Step 1: Write the failing server contract tests.**

```ts
it("makes a new task reviewer-first when the field is omitted", async () => {
  const res = await owner.post("/api/tasks", { title: "Новая" });
  expect(res.statusCode).toBe(201);
  expect(res.json().task.requires_reviewer_review).toBe(1);
});

it("lets the owner explicitly opt a task out", async () => {
  const res = await owner.patch(`/api/tasks/${taskId}`, {
    requires_reviewer_review: false,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().task.requires_reviewer_review).toBe(0);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the field is absent.**

```bash
cd server && npm test -- --run test/reviewerFirstReview.test.ts
```

- [ ] **Step 3: Add the idempotent migration and owner-only route handling.**

```ts
if (!taskCols.some((c) => c.name === "requires_reviewer_review")) {
  db.exec("ALTER TABLE tasks ADD COLUMN requires_reviewer_review INTEGER NOT NULL DEFAULT 1");
  db.exec("UPDATE tasks SET requires_reviewer_review = 0");
}
```

Include the flag in task hydration and create. Validate boolean PATCH input and permit it only for the owner.

- [ ] **Step 4: Add the web model and creation/edit toggle.**

```ts
export interface CreateTaskInput {
  // existing fields
  requires_reviewer_review?: boolean;
}
const [requiresReviewerReview, setRequiresReviewerReview] = useState(true);
```

Send the flag on create and in `buildDirtyPatch()` only when it differs from the loaded card.

- [ ] **Step 5: Verify the task contract and web compilation.**

```bash
cd server && npm test -- --run test/reviewerFirstReview.test.ts
cd .. && npm run build
```

- [ ] **Step 6: Commit only Task 1 files.**

```bash
git add server/src/db.ts server/src/migrations.ts server/src/routes/tasks.ts server/test/reviewerFirstReview.test.ts src/api/types.ts src/api/tasks.ts src/screens/TaskFormScreen.tsx
git commit -m "feat(tasks): add reviewer-first routing flag"
```

### Task 2: Запретить агентский обход ревьюера (владелец вне процесса)

**Files:**
- Modify: `server/src/resultVersions.ts`, `server/src/routes/reviews.ts`, `server/src/routes/agent-state.ts`, `server/src/routes/tasks.ts`
- Test: `server/test/reviewerFirstReview.test.ts`

**Граница:** все ограничения этой задачи — ТОЛЬКО для агентов. Владелец вне
процесса: закрывает, возвращает и удаляет карточку в любой момент без
одобрения Reviewer. `hasReviewerApprovedCurrentVersion` — сигнал для UI и
маршрута, не гейт для владельца.

**Interfaces:**
- Produces `hasReviewerApprovedCurrentVersion(taskId): boolean`.
- `POST /api/reviews` requires non-empty `findings` from Reviewer.

- [ ] **Step 1: Add failing lifecycle tests.**

```ts
it("владелец закрывает reviewer-first задачу в любой момент, без одобрения Reviewer", async () => {
  await submitToReview(taskId);
  expect((await owner.patch(`/api/tasks/${taskId}`, { status: "completed" })).statusCode)
    .toBe(200);
});

it("исполнитель не может вернуть reviewer-first задачу; Reviewer может — с комментарием", async () => {
  await submitToReview(taskId);
  expect((await agent.post(`/api/tasks/${taskId}/state`, { state: "in_progress", comment: "x" })).statusCode).toBe(400);
  expect((await reviewer.post("/api/reviews", approval(taskId, ""))).statusCode).toBe(400);
  expect((await reviewer.post("/api/reviews", approval(taskId, "Проверил сценарии и результат"))).statusCode).toBe(201);
  expect((await reviewer.post(`/api/tasks/${taskId}/state`, { state: "in_progress", comment: "Доработайте обработку ошибок" })).statusCode).toBe(200);
});

it("владелец возвращает reviewer-first задачу без ограничений", async () => {
  await submitToReview(taskId);
  expect((await owner.post(`/api/tasks/${taskId}/state`, { state: "in_progress", comment: "Верну сам" })).statusCode).toBe(200);
});
```

- [ ] **Step 2: Run the lifecycle tests and confirm old behavior fails.**

```bash
cd server && npm test -- --run test/reviewerFirstReview.test.ts
```

- [ ] **Step 3: Implement version-scoped Reviewer approval (сигнал).**

Add `hasReviewerApprovedCurrentVersion`: true, если для текущей версии
результата есть `approved`-запись, автор которой проходит `isReviewer`.
Reviewer-одобрение требует непустого `findings`. Владельческие записи
одобрения этот helper не удовлетворяют, но владельца это ни к чему не
обязывает — он не гейтится.

- [ ] **Step 4: Загейтить только агентский возврат.**

В `review → in_progress` для `requires_reviewer_review=1` запрещать переход
исполнителю (`400`, как прочие недопустимые переходы); Reviewer и владелец — разрешены. В `PATCH
status=completed` владельцу не ставить требований Reviewer — закрытие
проходит всегда. Владельца не ограничивать ни на одном переходе.

- [ ] **Step 5: Add the stale-approval test and run the whole server suite.**

```ts
it("does not reuse Reviewer approval after a return and resubmission", async () => {
  await reviewerApprove(taskId, "Версия 1 проверена");
  await reviewerReturn(taskId, "Нужна правка");
  await submitToReview(taskId);
  expect(await hasReviewerApprovedCurrentVersion(taskId)).toBe(false);
});
```

```bash
cd server && npm test -- --reporter=dot
```

- [ ] **Step 6: Commit only Task 2 files.**

```bash
git add server/src/resultVersions.ts server/src/routes/reviews.ts server/src/routes/agent-state.ts server/src/routes/tasks.ts server/test/reviewerFirstReview.test.ts
git commit -m "feat(review): запретить агентский обход ревьюера (владелец вне процесса)"
```

### Task 3: Render and submit the web review workflow

**Files:**
- Create: `src/api/reviews.ts`
- Modify: `src/api/types.ts`, `src/components/TaskJournal.tsx`, `src/screens/TaskFormScreen.tsx`
- Test: `src/components/reviewerFirstReview.test.tsx`

**Interfaces:**
- Produces `useTaskVersions(taskId)` and a review mutation carrying `findings`.
- Consumes the `reviews` list for the current result version from `GET /api/tasks/:id/versions`.

- [ ] **Step 1: Write failing component tests.**

```tsx
it("hides owner actions while a reviewer-first task awaits Reviewer", () => {
  render(<AgentOwnerActions task={reviewerFirstAwaitingTask} isOwner />);
  expect(screen.queryByRole("button", { name: /закрыть|принять/i })).not.toBeInTheDocument();
  expect(screen.getByText("На ревью у Reviewer")).toBeVisible();
});

it("does not enable Reviewer approval without a comment", () => {
  render(<ReviewerActions task={reviewerFirstAwaitingTask} />);
  expect(screen.getByRole("button", { name: "Одобрить" })).toBeDisabled();
});
```

- [ ] **Step 2: Run the component test and verify it fails because the Reviewer controls do not exist.**

```bash
npx vitest run src/components/reviewerFirstReview.test.tsx --reporter=dot
```

- [ ] **Step 3: Implement both Reviewer sheets and owner gating.**

Use the existing bottom-sheet comment pattern. Approval posts `findings`; return calls the existing state endpoint. Both use trimmed mandatory text. Before approval, show owner text “На ревью у Reviewer”; after approval, show final close only. Preserve opted-out and legacy owner actions.

- [ ] **Step 4: Run focused tests, build, and dead-control check.**

```bash
npx vitest run src/components/reviewerFirstReview.test.tsx --reporter=dot
npm run build
npm run check:dead-controls
```

- [ ] **Step 5: Commit only Task 3 files.**

```bash
git add src/api/reviews.ts src/api/types.ts src/components/TaskJournal.tsx src/screens/TaskFormScreen.tsx src/components/reviewerFirstReview.test.tsx
git commit -m "feat(web): add Reviewer review actions"
```

### Task 4: Bring iOS to the same server contract

**Files:**
- Modify: `Sources/Core/Models/Task.swift`, `Sources/Core/Networking/APIClient+Tasks.swift`, `Sources/Core/Networking/APIClient+Reviews.swift`
- Modify: `Sources/Features/Task/TaskFormViewModel.swift`, `Sources/Features/Task/TaskFormScreen.swift`
- Test: `Tests/TaskReviewTests.swift`

**Interfaces:**
- Produces `ApiTask.requiresReviewerReview: Bool` decoded from `requires_reviewer_review`.
- Extends `TaskResultVersion` to decode its `reviews`, so native UI can see a current Reviewer approval.
- Produces a Reviewer approval request with required findings.

- [ ] **Step 1: Write failing iOS tests.**

```swift
func testTaskDecodesReviewerFirstFlag() throws {
    let task = try decodeTask(#"{"id":"t","title":"T","status":"active","requires_reviewer_review":1}"#)
    XCTAssertTrue(task.requiresReviewerReview)
}

func testReviewerApprovalRejectsBlankFindingsBeforeRequest() {
    XCTAssertNil(TaskFormViewModel.reviewerFindingsForSubmission(" \n "))
}
```

- [ ] **Step 2: Run the focused test and verify the contract is unimplemented.**

```bash
xcodebuild test -project TaskFlow.xcodeproj -scheme TaskFlow -destination 'id=ED3C7DF7-F895-45B6-8A28-F67C02362103' -only-testing:TaskFlowTests/TaskReviewTests
```

- [ ] **Step 3: Implement the model, request fields, and view-model state.**

Decode the integer boolean using `decodeIntBool`. New tasks send true by default; PATCH sends a changed value. Add a normalized findings helper and Reviewer approval action that posts a review without changing `agent_state`.

- [ ] **Step 4: Implement SwiftUI controls.**

Add `Toggle("Сначала ревьюер", isOn: ...)` to the task form. Hide owner close/return on a reviewer-first card until the current Reviewer verdict is approved. For the Reviewer account, show alert-backed approval and return actions; both submits remain disabled until their text is non-blank. Preserve opted-out cards.

- [ ] **Step 5: Run focused and full iOS tests.**

```bash
xcodebuild test -project TaskFlow.xcodeproj -scheme TaskFlow -destination 'id=ED3C7DF7-F895-45B6-8A28-F67C02362103' -only-testing:TaskFlowTests/TaskReviewTests
xcodebuild test -project TaskFlow.xcodeproj -scheme TaskFlow -destination 'id=ED3C7DF7-F895-45B6-8A28-F67C02362103' -only-testing:TaskFlowTests
```

- [ ] **Step 6: Commit only Task 4 files.**

```bash
git add Sources/Core/Models/Task.swift Sources/Core/Networking/APIClient+Tasks.swift Sources/Core/Networking/APIClient+Reviews.swift Sources/Features/Task/TaskFormViewModel.swift Sources/Features/Task/TaskFormScreen.swift Tests/TaskReviewTests.swift
git commit -m "feat(ios): support Reviewer-first task review"
```

### Task 5: Verify deployed server and cross-client compatibility

**Files:**
- Modify: documentation only if verification exposes a specification defect
- Test: server reviewer lifecycle and iOS review tests

**Interfaces:** Consumes the completed server and both client contracts; produces deployment evidence.

- [ ] **Step 1: Run full verification.**

```bash
cd /home/maksim/Проекты/New-Todoist && npm test && npm run build && npm run check:dead-controls
cd server && npm test -- --reporter=dot
cd /Users/max/Проекты/TaskFlowNativeBuild && xcodebuild test -project TaskFlow.xcodeproj -scheme TaskFlow -destination 'id=ED3C7DF7-F895-45B6-8A28-F67C02362103' -only-testing:TaskFlowTests
```

- [ ] **Step 2: Read the non-production lifecycle test output.**

Verify that commented Reviewer approval retains `status='active'`, the subsequent owner close completes the card, and a Reviewer return creates the executor inbox item.

- [ ] **Step 3: Inspect final changes without disturbing pre-existing work.**

```bash
git diff --check
git log --oneline -4
git status --short
```

- [ ] **Step 4: Save a KB lesson only if implementation uncovers a new reusable failure.**

Use `~/kb/kb_add.py` only for a newly discovered migration or cross-client-contract issue; do not duplicate this spec.
