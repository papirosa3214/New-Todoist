import { db } from "@/db";
import { categories } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CategoriesManager } from "@/components/CategoriesManager";

export default async function CategoriesPage() {
  const list = await db
    .select()
    .from(categories)
    .orderBy(categories.archived, categories.name);
  return (
    <div className="px-6 py-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Категории</h1>
      <CategoriesManager
        items={list.map((c) => ({
          id: c.id,
          name: c.name,
          icon: c.icon,
          archived: !!c.archived,
        }))}
      />
    </div>
  );
}