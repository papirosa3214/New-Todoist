import * as React from "react";

import { cn } from "@/lib/utils";

/** Раздел 2.7: высота поля 40 на десктопе, 44 на телефоне; радиус 8. */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-10 max-md:h-11 w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-base",
        "placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-accent-600 focus-visible:ring-2 focus-visible:ring-accent-600/20",
        "disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger-500 aria-invalid:ring-danger-500/20",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };