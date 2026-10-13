import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accounts, operations } from "@/db/schema";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Валюта в правку не принимается: она наследуется от счёта (раздел 5, правило 4). */
const updateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  amount: z.number().refine((v) => v !== 0).optional(),
  description: z.string().min(1).max(500).optional(),
  accountId: z.string().min(1).optional(),
  categoryId: z.string().nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Войдите" } },
      { status: 401 },
    );
  }
  const { id } = await params;
  try {
    const body = await req.json();
    const parsed = updateSchema.parse(body);
    const current = await db
      .select({ accountId: operations.accountId })
      .from(operations)
      .where(eq(operations.id, id))
      .limit(1);
    if (!current[0]) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Операция не найдена" } },
        { status: 404 },
      );
    }
    // Валюта пересчитывается при каждой правке — так записи, созданные
    // старым кодом в валюте по умолчанию, чинятся из интерфейса без отдельного
    // инструмента (FIN-03).
    const targetAccountId = parsed.accountId ?? current[0].accountId;
    const target = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, targetAccountId))
      .limit(1);
    if (!target[0]) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Счёт не найден" } },
        { status: 404 },
      );
    }

    const patch: Record<string, unknown> = {
      accountId: targetAccountId,
      currency: target[0].currency,
      updatedAt: new Date().toISOString(),
    };
    if (parsed.date) patch.date = parsed.date.slice(0, 10);
    if (parsed.amount !== undefined) patch.amount = parsed.amount;
    if (parsed.description) patch.description = parsed.description;
    if (parsed.categoryId !== undefined)
      patch.categoryId = parsed.categoryId || null;
    await db.update(operations).set(patch).where(eq(operations.id, id));
    return NextResponse.json({ ok: true, currency: target[0].currency });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: { code: "INVALID_PARAMS", message: err.issues[0]?.message ?? "Ошибка" } },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Внутренняя ошибка" } },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Войдите" } },
      { status: 401 },
    );
  }
  const { id } = await params;
  await db.delete(operations).where(eq(operations.id, id));
  return NextResponse.json({ ok: true });
}