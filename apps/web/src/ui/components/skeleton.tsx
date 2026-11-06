import { cn } from "../lib/cn";

type SkeletonProps = {
  className?: string;
};

/** Decorative loading block. Hidden from assistive tech; label the region instead. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div aria-hidden="true" className={cn("animate-pulse rounded-lg bg-white/5", className)} />
  );
}
