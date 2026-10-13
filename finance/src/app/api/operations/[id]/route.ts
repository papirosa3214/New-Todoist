import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { operations } from "@/db/schema";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (parsed.date) patch.date = parsed.date.slice(0, 10);
    if (parsed.amount !== undefined) patch.amount = parsed.amount;
    if (parsed.description) patch.description = parsed.description;
    if (parsed.accountId) patch.accountId = parsed.accountId;
    if (parsed.categoryId !== undefined)
      patch.categoryId = parsed.categoryId || null;
    await db.update(operations).set(patch).where(eq(operations.id, id));
    return NextResponse.json({ ok: true });
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