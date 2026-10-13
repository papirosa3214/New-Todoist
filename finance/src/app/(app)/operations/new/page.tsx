import { db } from "@/db";
import { accounts, categories } from "@/db/schema";
import { eq } from "drizzle-orm";

import { OperationForm } from "@/components/OperationForm";
import { PageHeader } from "@/components/PageHeader";

export default async function NewOperationPage() {
  const [allAccs, allCats] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.archived, false)).orderBy(accounts.name),
    db.select().from(categories).where(eq(categories.archived, false)).orderBy(categories.name),
  ]);
  return (
    <div className="mx-auto max-w-2xl px-4 py-6 md:px-6">
      <PageHeader title="Новая операция" />
      <OperationForm
        accounts={allAccs.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        categories={allCats.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))}
      />
    </div>
  );
}