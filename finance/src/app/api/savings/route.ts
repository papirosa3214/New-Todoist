import { NextResponse } from "next/server";
import { z } from "zod";
import { ulid } from "ulid";
import { db } from "@/db";
import { savings } from "@/db/schema";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["deposit", "savings", "certificate", "other"]),
  currency: z.string().min(1).max(8),
  principal: z.number().nonnegative(),
  annualRate: z.number().min(-100).max(1000),
  compounding: z.enum(["monthly", "quarterly", "yearly", "none"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  months: z.number().int().min(1).max(600),
  note: z.string().max(500).optional().nullable(),
});

function unauthorized() {
  return NextResponse.json(
    { error: { code: "UNAUTHORIZED", message: "Войдите" } },
    { status: 401 },
  );
}

function invalid(message: string) {
  return NextResponse.json(
    { error: { code: "INVALID_PARAMS", message } },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return unauthorized();
  try {
    const parsed = schema.parse(await req.json());
    const id = ulid();
    await db.insert(savings).values({
      id,
      name: parsed.name.trim(),
      kind: parsed.kind,
      currency: parsed.currency,
      principal: parsed.principal,
      annualRate: parsed.annualRate,
      compounding: parsed.compounding,
      startDate: parsed.startDate.slice(0, 10),
      months: parsed.months,
      note: parsed.note?.trim() || null,
      archived: false,
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ id });
  } catch (err) {
    if (err instanceof z.ZodError) return invalid(err.issues[0]?.message ?? "Ошибка");
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Внутренняя ошибка" } },
      { status: 500 },
    );
  }
}