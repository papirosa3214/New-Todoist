import { db } from "@/db";
import { accounts, categories, operations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { OperationForm } from "@/components/OperationForm";
import { PageHeader } from "@/components/PageHeader";

export default async function EditOperationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [op] = await db.select().from(operations).where(eq(operations.id, id));
  if (!op) notFound();

  const [allAccs, allCats] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.archived, false)).orderBy(accounts.name),
    db.select().from(categories).where(eq(categories.archived, false)).orderBy(categories.name),
  ]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 md:px-6">
      <PageHeader title="Редактировать операцию" />
      <OperationForm
        accounts={allAccs.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        categories={allCats.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))}
        initial={{
          id: op.id,
          date: op.date,
          amount: Math.abs(op.amount).toString(),
          // Тип берём из сохранённой операции явно: выводить его из знака суммы
          // нельзя, именно так доход превращался в расход при правке.
          direction: op.amount < 0 ? "expense" : "income",
          description: op.description,
          accountId: op.accountId,
          categoryId: op.categoryId ?? "",
        }}
      />
    </div>
  );
}