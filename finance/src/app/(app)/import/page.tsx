import { db } from "@/db";
import { accounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ImportClient } from "@/components/ImportClient";

export default async function ImportPage() {
  const list = await db
    .select()
    .from(accounts)
    .where(eq(accounts.archived, false))
    .orderBy(accounts.name);
  return (
    <div className="px-6 py-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-2">Импорт операций</h1>
      <p className="text-sm text-ink-600 mb-6">
        Загрузите выписку из личного кабинета банка в формате CSV (1СClientBankExchange,
        Сбербанк или generic CSV с колонками date,amount,description) или OFX/QFX.
        Приложение определит формат автоматически, дедупликация по
        external_id / хешу (source, account_id, date, amount, description).
      </p>
      <ImportClient
        accounts={list.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
      />
    </div>
  );
}