import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  name: z.string().min(1).max(80).optional(),
  icon: z.string().max(8).nullable().optional(),
  archived: z.boolean().optional(),
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
    const parsed = schema.parse(body);
    await db.update(categories).set(parsed).where(eq(categories.id, id));
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