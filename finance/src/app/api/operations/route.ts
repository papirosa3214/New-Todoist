import { NextResponse } from "next/server";
import { ulid } from "ulid";
import { z } from "zod";
import { db } from "@/db";
import { operations } from "@/db/schema";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  amount: z.number().refine((v) => v !== 0, "Сумма не должна быть нулём"),
  description: z.string().min(1).max(500),
  accountId: z.string().min(1),
  categoryId: z.string().nullable().optional(),
  currency: z.string().min(1).optional(),
});

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Войдите" } },
      { status: 401 },
    );
  }
  try {
    const body = await req.json();
    const parsed = createSchema.parse(body);
    const id = ulid();
    const now = new Date().toISOString();
    await db.insert(operations).values({
      id,
      accountId: parsed.accountId,
      date: parsed.date.slice(0, 10),
      amount: parsed.amount,
      currency: parsed.currency ?? "RUB",
      description: parsed.description,
      merchant: null,
      categoryId: parsed.categoryId ?? null,
      source: "manual",
      externalId: null,
      importedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return NextResponse.json({ id });
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