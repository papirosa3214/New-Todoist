import { db } from "@/db";
import { accounts } from "@/db/schema";
import { eq } from "drizzle-orm";

import { ImportClient } from "@/components/ImportClient";
import { PageHeader } from "@/components/PageHeader";

export default async function ImportPage() {
  const list = await db
    .select()
    .from(accounts)
    .where(eq(accounts.archived, false))
    .orderBy(accounts.name);
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <PageHeader
        title="Импорт операций"
        description="Выписка из личного кабинета банка: CSV или OFX/QFX. Дубли отбрасываются автоматически."
      />
      <ImportClient
        accounts={list.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
      />
    </div>
  );
}