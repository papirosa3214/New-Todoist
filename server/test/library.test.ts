// 119_kb_root_folder — пометка корневой папки TaskFlow Library и
// хелперы навигации по подпапкам.
// Тест против временной БД (через vitest setup.ts): каждый прогон чистый.
import { beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.js";
import db, { migrate } from "../src/db.js";
import {
  getKbRoot,
  isKbRoot,
  isUnderKbRoot,
  pathToFolder,
} from "../src/lib/notesFolders.js";

migrate();
runMigrations();

beforeAll(() => {
  if (getKbRoot()) return;
  const insertFolder = db.prepare(
    "INSERT INTO journal_folders (parent_id, name, position, is_kb_root) VALUES (?, ?, ?, ?)",
  );
  const rootInfo = insertFolder.run(null, "TaskFlow Library", 0, 1);
  const rootId = Number(rootInfo.lastInsertRowid);
  for (const sub of ["Roles", "Workflows", "Norms", "Knowledge Base"]) {
    insertFolder.run(rootId, sub, 0, 0);
  }
});

function makeOrphan(name: string): string {
  const stmt = db.prepare(
    "INSERT INTO journal_folders (parent_id, name, position, is_kb_root) VALUES (NULL, ?, 0, 0)",
  );
  const r = stmt.run(name);
  return String(r.lastInsertRowid);
}

describe("TaskFlow Library structure", () => {
  it("getKbRoot returns root folder", () => {
    const root = getKbRoot();
    expect(root).not.toBeNull();
    expect(root && root.is_kb_root).toBe(1);
    expect(root && root.parent_id).toBeNull();
    expect(root && root.name).toBe("TaskFlow Library");
  });

  it("isKbRoot distinguishes root from subfolders", () => {
    const root = getKbRoot();
    expect(root).not.toBeNull();
    if (!root) return;
    expect(isKbRoot(root.id)).toBe(true);
    const sub = db
      .prepare("SELECT id FROM journal_folders WHERE parent_id = ? LIMIT 1")
      .get(root.id) as { id: number } | undefined;
    if (sub) expect(isKbRoot(sub.id)).toBe(false);
  });

  it("isUnderKbRoot finds folders under root", () => {
    const root = getKbRoot();
    if (!root) return;
    expect(isUnderKbRoot(root.id)).toBe(true);
    const sub = db
      .prepare("SELECT id FROM journal_folders WHERE parent_id = ? LIMIT 1")
      .get(root.id) as { id: number } | undefined;
    if (sub) expect(isUnderKbRoot(sub.id)).toBe(true);
  });

  it("isUnderKbRoot returns false for foreign folder", () => {
    const id = makeOrphan("Orphan-A");
    expect(isUnderKbRoot(Number(id))).toBe(false);
  });

  it("pathToFolder builds path from root", () => {
    const root = getKbRoot();
    if (!root) return;
    const sub = db
      .prepare("SELECT id, name FROM journal_folders WHERE parent_id = ? LIMIT 1")
      .get(root.id) as { id: number; name: string } | undefined;
    if (!sub) return;
    const p = pathToFolder(sub.id);
    expect(p[0]).toBe(root.name);
    expect(p[p.length - 1]).toBe(sub.name);
  });

  it("pathToFolder returns empty for foreign folder", () => {
    const id = makeOrphan("Orphan-B");
    expect(pathToFolder(Number(id))).toEqual([]);
  });
});