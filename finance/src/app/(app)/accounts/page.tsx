import { db } from "@/db";
import { accounts } from "@/db/schema";
import { eq } from "drizzle-orm";

import { AccountsManager } from "@/components/AccountsManager";
import { PageHeader } from "@/components/PageHeader";

export default async function AccountsPage() {
  const list = await db.select().from(accounts).orderBy(accounts.archived, accounts.name);
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <PageHeader
        title="Счета"
        description="Карта, вклад или наличные. Суммы по разным валютам не складываются."
      />
      <AccountsManager
        items={list.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          currency: a.currency,
          openingBalance: a.openingBalance,
          openingDate: a.openingDate,
          archived: !!a.archived,
        }))}
      />
    </div>
  );
}