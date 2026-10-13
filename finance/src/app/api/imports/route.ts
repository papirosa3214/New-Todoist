import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "@/db";
import { operations, accounts } from "@/db/schema";
import { currentUser } from "@/lib/session";
import { PROVIDERS } from "@/importers";
import { deterministicExternalId } from "@/lib/dedupe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Войдите" } },
      { status: 401 },
    );
  }

  try {
    const form = await req.formData();
    const accountId = String(form.get("accountId") ?? "");
    const providerId = String(form.get("provider") ?? "csv");
    const file = form.get("file");
    if (!accountId) {
      return NextResponse.json(
        { error: { code: "INVALID_PARAMS", message: "Не выбран счёт" } },
        { status: 400 },
      );
    }
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: { code: "INVALID_PARAMS", message: "Не выбран файл" } },
        { status: 400 },
      );
    }

    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!account) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Счёт не найден" } },
        { status: 404 },
      );
    }

    const provider = PROVIDERS[providerId];
    if (!provider) {
      return NextResponse.json(
        { error: { code: "INVALID_PARAMS", message: "Неизвестный провайдер" } },
        { status: 400 },
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = await provider.parse(buf);

    // Дедупликация: проверяем уникальность по (account_id, source, external_id).
    // Если external_id не задан — генерируем детерминированный.
    const source = provider.id;
    let imported = 0;
    let duplicates = 0;
    const errors = [...parsed.summary.errors];
    const now = new Date().toISOString();
    // Валюта операции наследуется от счёта (раздел 5, правило 4). Если файл
    // объявил другую — пишем предупреждение, а не молча пишем чужую валюту:
    // иначе остаток счёта считается в единицах, которых в нём нет.
    const foreignInFile = new Set(
      parsed.operations
        .map((o) => o.currency)
        .filter((c): c is string => Boolean(c) && c !== account.currency),
    );
    if (foreignInFile.size > 0) {
      parsed.warnings.push(
        `Файл указывает валюту ${[...foreignInFile].join(", ")}, а счёт — ${account.currency}. ` +
          `Операции записаны в валюте счёта; другой счёт в этой валюте даст честный остаток.`,
      );
    }

    for (const raw of parsed.operations) {
      const externalId =
        raw.externalId ??
        deterministicExternalId({
          source,
          accountId,
          date: raw.date,
          amount: raw.amount,
          description: raw.description,
        });
      // Проверяем, есть ли уже такая операция.
      const existing = await db
        .select()
        .from(operations)
        .where(eq(operations.externalId, externalId))
        .limit(20);
      const clash = existing.find(
        (op) => op.accountId === accountId && op.source === source,
      );
      if (clash) {
        duplicates++;
        continue;
      }
      try {
        await db.insert(operations).values({
          id: ulid(),
          accountId,
          date: raw.date,
          amount: raw.amount,
          currency: account.currency,
          description: raw.description,
          merchant: raw.merchant ?? null,
          categoryId: null,
          source,
          externalId,
          importedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        imported++;
      } catch (err) {
        errors.push({ line: 0, reason: `ошибка вставки: ${String(err).slice(0, 120)}` });
      }
    }

    return NextResponse.json({
      imported,
      duplicates,
      failed: errors.length,
      warnings: parsed.warnings,
      errors,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL",
          message: `Импорт не удался: ${String(err).slice(0, 160)}`,
        },
      },
      { status: 500 },
    );
  }
}