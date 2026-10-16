import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { savings } from "@/db/schema";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(["deposit", "savings", "certificate", "other"]).optional(),
  currency: z.string().min(1).max(8).optional(),
  principal: z.number().nonnegative().optional(),
  annualRate: z.number().min(-100).max(1000).optional(),
  compounding: z.enum(["monthly", "quarterly", "yearly", "none"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  months: z.number().int().min(1).max(600).optional(),
  monthlyContribution: z.number().nonnegative().optional(),
  note: z.string().max(500).optional().nullable(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Войдите" } },
      { status: 401 },
    );
  }
  const { id } = await params;
  try {
    const parsed = schema.parse(await req.json());
    const patch: Partial<typeof savings.$inferInsert> = { ...parsed };
    if (patch.startDate) patch.startDate = patch.startDate.slice(0, 10);
    await db.update(savings).set(patch).where(eq(savings.id, id));
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

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Войдите" } },
      { status: 401 },
    );
  }
  const { id } = await params;
  try {
    await db.delete(savings).where(eq(savings.id, id));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Внутренняя ошибка" } },
      { status: 500 },
    );
  }
}