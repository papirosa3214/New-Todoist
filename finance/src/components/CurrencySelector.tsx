"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Выбор валюты аналитики на дашборде.
 *
 * Приложение не переводит валюты, поэтому разные валюты не складываются
 * (раздел 5.6). Вместо молчаливого скрытия блоков показываем аналитику по
 * одной валюте и даём владельцу переключить.
 */
export function CurrencySelector({
  currencies,
  value,
}: {
  currencies: string[];
  value: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function set(next: string) {
    const search = new URLSearchParams(params.toString());
    search.set("currency", next);
    startTransition(() => {
      router.push(`${pathname}?${search.toString()}`);
    });
  }

  return (
    <div className="w-full sm:w-48">
      <Select value={value} onValueChange={set} disabled={pending}>
        <SelectTrigger aria-label="Валюта аналитики" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {currencies.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}