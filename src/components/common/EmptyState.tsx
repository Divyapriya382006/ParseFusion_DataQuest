import React from "react";
import { Inbox } from "lucide-react";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  action,
  icon,
}) => {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center border border-dashed border-neutral-800 rounded-xl bg-neutral-900/20 my-2">
      <div className="w-10 h-10 rounded-lg bg-neutral-800/80 border border-neutral-700/60 flex items-center justify-center text-neutral-400 mb-3">
        {icon || <Inbox className="w-5 h-5" />}
      </div>
      <h4 className="text-sm font-medium text-neutral-200">{title}</h4>
      {description && (
        <p className="text-xs text-neutral-400 max-w-sm mt-1">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
};
