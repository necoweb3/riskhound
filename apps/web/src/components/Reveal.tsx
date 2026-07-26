import type { ElementType, ReactNode } from "react";

type Variant = "rise" | "sm" | "fade" | "growX" | "growY";

const CLASS: Record<Variant, string> = {
  rise: "rk-reveal",
  sm: "rk-reveal rk-reveal--sm",
  fade: "rk-reveal rk-reveal--fade",
  growX: "rk-reveal rk-reveal--growX",
  growY: "rk-reveal rk-reveal--growY",
};

/**
 * Scroll-driven reveal wrapper. No client JS: the animation is linked to the
 * element's own view() timeline in globals.css, so it works in server
 * components and never fights React re-renders.
 *
 *   <Reveal as="section" className="rk-card">…</Reveal>
 */
export function Reveal({
  as,
  variant = "rise",
  className,
  children,
  ...rest
}: {
  as?: ElementType;
  variant?: Variant;
  className?: string;
  children?: ReactNode;
} & Record<string, unknown>) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag className={[CLASS[variant], className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}
