import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/** Раздел 2.7: высота 40 на десктопе, 44 на телефоне; радиус 8; сенсорная цель 44. */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors h-10 md:h-10 max-md:h-11 min-w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        default: "bg-accent-600 text-white hover:bg-accent-700",
        secondary: "bg-ink-100 text-ink-700 hover:bg-ink-200",
        outline:
          "border border-ink-200 bg-white text-ink-700 hover:bg-ink-100",
        ghost: "text-ink-700 hover:bg-ink-100",
        destructive: "bg-danger-500 text-white hover:bg-danger-600",
        link: "text-accent-700 underline underline-offset-4 hover:text-accent-600",
      },
      size: {
        default: "px-4",
        sm: "px-3 text-sm",
        lg: "px-5 text-base",
        icon: "px-0 w-10 max-md:w-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };