import { db } from "@/db";
import { categories, operations } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

import { CategoriesManager } from "@/components/CategoriesManager";
import { PageHeader } from "@/components/PageHeader";

export default async function CategoriesPage() {
  const [list, counts] = await Promise.all([
    db.select().from(categories).orderBy(categories.archived, categories.name),
    db
      .select({
        categoryId: operations.categoryId,
        c: sql<number>`COUNT(*)`.as("c"),
      })
      .from(operations)
      .groupBy(operations.categoryId),
  ]);
  const byId = new Map(counts.map((r) => [r.categoryId ?? "", Number(r.c) || 0]));

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <PageHeader
        title="Категории"
        description="Категории группируют расходы в аналитике дашборда"
      />
      <CategoriesManager
        items={list.map((c) => ({
          id: c.id,
          name: c.name,
          icon: c.icon,
          archived: !!c.archived,
          operationsCount: byId.get(c.id) ?? 0,
        }))}
      />
    </div>
  );
}