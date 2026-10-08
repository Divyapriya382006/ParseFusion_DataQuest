import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Server, ServerOff, User } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useConfig } from "../../context/ConfigContext";

export const TopBar: React.FC = () => {
  const { user, isNotConnected: authNotConnected, switchDemoRole } = useAuth();
  const { isNotConnected: configNotConnected } = useConfig();
  const [menuOpen, setMenuOpen] = useState(false);
  const [roleSwitchError, setRoleSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const isConnected = !authNotConnected && !configNotConnected;

  const changeRole = async (role: "admin" | "viewer") => {
    setSwitching(true);
    setRoleSwitchError(null);
    try {
      await switchDemoRole(role);
      setMenuOpen(false);
    } catch (error) {
      setRoleSwitchError(error instanceof Error ? error.message : "Could not switch demo role");
    } finally {
      setSwitching(false);
    }
  };

  return (
    <header className="h-14 border-b border-neutral-800 bg-neutral-900/90 backdrop-blur px-6 flex items-center justify-between z-30 shrink-0">
      {/* Zone 1: Single text element wordmark */}
      <Link
        to="/"
        className="text-base font-semibold tracking-tight text-neutral-100 hover:text-white transition-colors flex items-center gap-2"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
        <span>ParseFusion</span>
      </Link>

      {/* Zone 2: Navigation shortcuts / Status */}
      <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-neutral-400">
        <Link to="/" className="hover:text-neutral-200 transition-colors">
          Ingestion
        </Link>
        <Link to="/batch" className="hover:text-neutral-200 transition-colors">
          Batch &amp; Case Analysis
        </Link>
        <Link to="/cases" className="hover:text-neutral-200 transition-colors">
          Case Review
        </Link>
      </nav>

      {/* Zone 3: Connection indicator and user profile */}
      <div className="flex items-center gap-4">
        {/* Connection status indicator */}
        <div
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors bg-neutral-950/60 border-neutral-800 hover:border-neutral-700"
          title={isConnected ? "Backend connected" : "Backend not connected"}
        >
          {isConnected ? (
            <>
              <Server className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden sm:inline text-neutral-300">Live API</span>
            </>
          ) : (
            <>
              <ServerOff className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline text-amber-300">Awaiting Backend</span>
            </>
          )}
        </div>

        {/* User Profile from /auth/me */}
        {user ? (
          <div className="relative border-l border-neutral-800 pl-3">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen((open) => !open); setRoleSwitchError(null); }}
              className="flex items-center gap-2 text-xs text-neutral-300 hover:text-white"
            >
              <span className="w-6 h-6 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-300">
                <User className="w-3.5 h-3.5" />
              </span>
              <span className="flex flex-col text-left leading-none">
                <span className="font-medium text-neutral-200 truncate max-w-[120px]">{user.display_name}</span>
                <span className="mt-0.5 flex items-center gap-1 text-[10px] text-neutral-500 font-mono">
                  {user.role}<ChevronDown className="h-3 w-3" />
                </span>
              </span>
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-xl">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-500">Demo role</div>
                {user.demo_role_switch_enabled && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={switching}
                    onClick={() => changeRole(user.role === "admin" ? "viewer" : "admin")}
                    className="w-full rounded px-2 py-2 text-left text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
                  >
                    Switch to {user.role === "admin" ? "Viewer" : "Admin"}
                  </button>
                )}
                {user.role === "viewer" && (
                  <Link
                    role="menuitem"
                    to="/access"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded px-2 py-2 text-xs text-sky-300 hover:bg-neutral-800"
                  >
                    Request document access
                  </Link>
                )}
                <p className="px-2 pt-1 text-[10px] leading-4 text-neutral-500">
                  Local demo only; switching changes the role for this backend instance.
                </p>
                {roleSwitchError && <p role="alert" className="px-2 pt-2 text-[10px] text-rose-300">{roleSwitchError}</p>}
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-neutral-500 border-l border-neutral-800 pl-3">
            <span>Session awaiting auth</span>
          </div>
        )}

      </div>
    </header>
  );
};
