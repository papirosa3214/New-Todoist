import { NextResponse } from "next/server";
import { z } from "zod";
import { ulid } from "ulid";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(8).nullable().optional(),
  parentId: z.string().nullable().optional(),
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
    const parsed = schema.parse(body);
    const id = ulid();
    await db.insert(categories).values({
      id,
      name: parsed.name,
      icon: parsed.icon ?? null,
      parentId: parsed.parentId ?? null,
      archived: false,
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