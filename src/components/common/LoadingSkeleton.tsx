import React from "react";

interface SkeletonProps {
  className?: string;
  count?: number;
}

export const Skeleton: React.FC<SkeletonProps> = ({ className = "h-4 w-full", count = 1 }) => {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`animate-pulse rounded bg-neutral-800/60 ${className}`}
          aria-hidden="true"
        />
      ))}
    </>
  );
};

export const TableSkeleton: React.FC<{ rows?: number; cols?: number }> = ({
  rows = 5,
  cols = 4,
}) => {
  return (
    <div className="w-full space-y-3 p-4 bg-neutral-900/30 border border-neutral-800 rounded-xl">
      <div className="flex gap-4 border-b border-neutral-800 pb-2">
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} className="h-4 flex-1 bg-neutral-800" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 py-1.5">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1 bg-neutral-800/40" />
          ))}
        </div>
      ))}
    </div>
  );
};
