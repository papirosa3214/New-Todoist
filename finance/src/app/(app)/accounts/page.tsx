import { db } from "@/db";
import { accounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AccountsManager } from "@/components/AccountsManager";

export default async function AccountsPage() {
  const list = await db.select().from(accounts).orderBy(accounts.archived, accounts.name);
  return (
    <div className="px-6 py-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Счета</h1>
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