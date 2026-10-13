import { NextResponse } from "next/server";
import { z } from "zod";
import { ulid } from "ulid";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["cash", "card", "deposit", "investment", "other"]),
  currency: z.string().min(1).max(8),
  openingBalance: z.number(),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
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
    await db.insert(accounts).values({
      id,
      name: parsed.name,
      type: parsed.type,
      currency: parsed.currency,
      openingBalance: parsed.openingBalance,
      openingDate: parsed.openingDate.slice(0, 10),
      archived: false,
      providerId: null,
      externalId: null,
      createdAt: new Date().toISOString(),
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