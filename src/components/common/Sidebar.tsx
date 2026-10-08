import React from "react";
import { NavLink } from "react-router-dom";
import {
  Upload,
  Layers,
  LayoutDashboard,
  FolderGit2,
  FileCheck,
  ShieldCheck,
  Download,
  ScrollText,
  MessageSquareText,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { CAPABILITY_KEYS } from "../../config/capabilityKeys";

interface NavItemDef {
  label: string;
  path: string;
  icon: React.ElementType;
  capability?: string;
  capabilitiesAny?: string[];
  alwaysShow?: boolean;
}

const NAV_ITEMS: NavItemDef[] = [
  {
    label: "Ingestion & Upload",
    path: "/",
    icon: Upload,
    capability: CAPABILITY_KEYS.UPLOAD,
  },
  {
    label: "Batch & Case Analysis",
    path: "/batch",
    icon: Layers,
    capabilitiesAny: [CAPABILITY_KEYS.BATCH_VIEW, CAPABILITY_KEYS.CASE_REVIEW],
  },
  {
    label: "Results Dashboard",
    path: "/dashboard",
    icon: LayoutDashboard,
    capability: CAPABILITY_KEYS.DASHBOARD_VIEW,
  },
  {
    label: "Case Review",
    path: "/cases",
    icon: FolderGit2,
    capability: CAPABILITY_KEYS.CASE_REVIEW,
  },
  {
    label: "Action Review",
    path: "/actions",
    icon: FileCheck,
    capability: CAPABILITY_KEYS.ACTION_APPROVE,
  },
  {
    label: "Access Control",
    path: "/access",
    icon: ShieldCheck,
    capability: CAPABILITY_KEYS.ACCESS_BROWSE,
  },
  {
    label: "Exports",
    path: "/exports",
    icon: Download,
    capability: CAPABILITY_KEYS.EXPORT_VIEW,
  },
  {
    label: "Document Chat",
    path: "/chat",
    icon: MessageSquareText,
    alwaysShow: true,
  },
  {
    label: "Audit Log",
    path: "/audit",
    icon: ScrollText,
    capability: CAPABILITY_KEYS.AUDIT_VIEW,
  },
];

export const Sidebar: React.FC = () => {
  const { hasCapability, user, isNotConnected } = useAuth();

  // Filter items based solely on backend-returned capabilities array
  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.alwaysShow) return true;
    // If backend is not connected yet, show all items so operator can inspect every page
    // and see the specific "Backend not connected: <endpoint>" state for that page!
    if (isNotConnected || !user) return true;
    if (!item.capability) return true;
    if (item.capabilitiesAny) return item.capabilitiesAny.some(hasCapability);
    if (!item.capability) return true;
    return hasCapability(item.capability);
  });

  return (
    <aside className="w-64 border-r border-neutral-800 bg-neutral-900/60 flex flex-col shrink-0">
      <div className="p-3 flex-1 overflow-y-auto space-y-1">
        <div className="px-3 py-2 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
          Workspaces
        </div>
        {visibleItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-neutral-800 text-neutral-100 shadow-sm"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50"
                }`
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </NavLink>
          );
        })}
      </div>

      {user && (
        <div className="p-3 border-t border-neutral-800/80 bg-neutral-950/40 text-[11px] text-neutral-400">
          <div className="flex items-center justify-between">
            <span>Capabilities:</span>
            <span className="font-mono text-neutral-300 tabular-nums">
              {user.capabilities.length} active
            </span>
          </div>
        </div>
      )}
    </aside>
  );
};