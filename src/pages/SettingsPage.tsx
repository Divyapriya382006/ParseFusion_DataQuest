import React from "react";
import { Settings, Sliders, Moon, Sun, Shield, Terminal } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";
import { CAPABILITY_KEYS } from "../config/capabilityKeys";

export const SettingsPage: React.FC = () => {
  const { theme, density, toggleTheme, setDensity } = useTheme();
  const { user, hasCapability } = useAuth();

  const canAdmin = hasCapability(CAPABILITY_KEYS.ADMIN_SETTINGS);

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6 text-xs">
      <div>
        <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
          <Settings className="w-5 h-5 text-neutral-400" />
          <span>System & Interface Settings</span>
        </h1>
        <p className="text-xs text-neutral-400 mt-1">
          Configure interface density, visual presentation, and backend connection details.
        </p>
      </div>

      {/* Interface Preferences */}
      <div className="p-5 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-4">
        <div className="text-[11px] font-semibold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
          <Sliders className="w-3.5 h-3.5 text-sky-400" />
          <span>Interface Display Preferences</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Theme */}
          <div className="p-3 bg-neutral-950/60 border border-neutral-800 rounded-lg flex items-center justify-between">
            <div>
              <div className="font-medium text-neutral-200">Color Palette Theme</div>
              <div className="text-[11px] text-neutral-500">Dark / Light presentation</div>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
            >
              {theme === "dark" ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
              <span className="capitalize">{theme}</span>
            </button>
          </div>

          {/* Density */}
          <div className="p-3 bg-neutral-950/60 border border-neutral-800 rounded-lg flex items-center justify-between">
            <div>
              <div className="font-medium text-neutral-200">Information Density</div>
              <div className="text-[11px] text-neutral-500">Row spacing and padding</div>
            </div>
            <select
              value={density}
              onChange={(e) => setDensity(e.target.value as "comfortable" | "compact")}
              className="bg-neutral-800 border border-neutral-700 rounded px-2.5 py-1 text-neutral-200"
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact (High Density)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Backend Wiring Instructions */}
      <div className="p-5 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3">
        <div className="text-[11px] font-semibold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-amber-400" />
          <span>Backend Connection Setup</span>
        </div>
        <p className="text-neutral-400 leading-relaxed">
          ParseFusion communicates with your 24 specialized backend agents via the base URL configured in your environment.
        </p>
        <div className="p-3 bg-neutral-950 rounded-lg border border-neutral-800 font-mono text-[11px] text-neutral-300 space-y-1">
          <div className="text-neutral-500"># In .env or hosting environment:</div>
          <div>VITE_API_BASE_URL="http://localhost:8000"</div>
        </div>
      </div>

      {/* Admin Gated Section */}
      {canAdmin ? (
        <div className="p-5 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3">
          <div className="text-[11px] font-semibold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-emerald-400" />
            <span>Administrator Governance Panel</span>
          </div>
          <div className="text-neutral-400">
            Current user role: <span className="font-mono text-neutral-200">{user?.role}</span> with full administrative capabilities.
          </div>
        </div>
      ) : null}
    </div>
  );
};
