import React from "react";
import { Link } from "react-router-dom";
import { Sun, Moon, Server, ServerOff, User } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useConfig } from "../../context/ConfigContext";
import { useTheme } from "../../context/ThemeContext";

export const TopBar: React.FC = () => {
  const { user, isNotConnected: authNotConnected } = useAuth();
  const { isNotConnected: configNotConnected } = useConfig();
  const { theme, toggleTheme } = useTheme();

  const isConnected = !authNotConnected && !configNotConnected;

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
          Pipeline
        </Link>
        <Link to="/cases" className="hover:text-neutral-200 transition-colors">
          Case Review
        </Link>
        <Link to="/agent-status" className="hover:text-neutral-200 transition-colors">
          Agent Health
        </Link>
      </nav>

      {/* Zone 3: Actions, connection indicator, user profile & theme */}
      <div className="flex items-center gap-4">
        {/* Connection status indicator */}
        <Link
          to="/agent-status"
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
        </Link>

        {/* User Profile from /auth/me */}
        {user ? (
          <div className="flex items-center gap-2 text-xs text-neutral-300 border-l border-neutral-800 pl-3">
            <div className="w-6 h-6 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-300">
              <User className="w-3.5 h-3.5" />
            </div>
            <div className="flex flex-col text-left leading-none">
              <span className="font-medium text-neutral-200 truncate max-w-[120px]">
                {user.display_name}
              </span>
              <span className="text-[10px] text-neutral-500 font-mono mt-0.5">
                {user.role}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-xs text-neutral-500 border-l border-neutral-800 pl-3">
            <span>Session awaiting auth</span>
          </div>
        )}

        {/* Theme toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
          aria-label="Toggle visual theme"
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  );
};
