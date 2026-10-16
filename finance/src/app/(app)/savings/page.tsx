import { db } from "@/db";
import { savings } from "@/db/schema";
import { desc } from "drizzle-orm";
import { SavingsManager } from "@/components/SavingsManager";
import { SavingsCalculator } from "@/components/SavingsCalculator";
import { DISCLAIMER } from "@/lib/instruments";

export const dynamic = "force-dynamic";

export default async function SavingsPage() {
  const items = await db.select().from(savings).orderBy(desc(savings.createdAt));

  return (
    <div className="px-6 py-6 max-w-6xl">
      <h1 className="text-2xl font-semibold mb-1">Накопления и вклады</h1>
      <p className="text-sm text-ink-500 mb-4">{DISCLAIMER}</p>

      <div className="space-y-6">
        <SavingsManager
          items={items.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            currency: s.currency,
            principal: s.principal,
            annualRate: s.annualRate,
            compounding: s.compounding,
            startDate: s.startDate,
            months: s.months,
            monthlyContribution: s.monthlyContribution,
            note: s.note,
          }))}
        />
        <SavingsCalculator />
      </div>
    </div>
  );
}