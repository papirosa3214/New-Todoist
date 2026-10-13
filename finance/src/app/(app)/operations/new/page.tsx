import { db } from "@/db";
import { accounts, categories } from "@/db/schema";
import { eq } from "drizzle-orm";
import { OperationForm } from "@/components/OperationForm";

export default async function NewOperationPage() {
  const allAccs = await db
    .select()
    .from(accounts)
    .where(eq(accounts.archived, false))
    .orderBy(accounts.name);
  const allCats = await db
    .select()
    .from(categories)
    .where(eq(categories.archived, false))
    .orderBy(categories.name);
  return (
    <div className="px-6 py-6 max-w-2xl">
      <h1 className="text-2xl font-semibold mb-4">Новая операция</h1>
      <OperationForm
        accounts={allAccs.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        categories={allCats.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))}
      />
    </div>
  );
}