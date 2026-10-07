import React, { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";
type Density = "comfortable" | "compact";

interface ThemeContextType {
  theme: Theme;
  density: Density;
  toggleTheme: () => void;
  setDensity: (d: Density) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "dark",
  density: "comfortable",
  toggleTheme: () => {},
  setDensity: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("pf_ui_theme");
    return saved === "light" ? "light" : "dark";
  });

  const [density, setDensityState] = useState<Density>(() => {
    const saved = localStorage.getItem("pf_ui_density");
    return saved === "compact" ? "compact" : "comfortable";
  });

  useEffect(() => {
    localStorage.setItem("pf_ui_theme", theme);
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("pf_ui_density", density);
    const root = document.documentElement;
    if (density === "compact") {
      root.classList.add("density-compact");
    } else {
      root.classList.remove("density-compact");
    }
  }, [density]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  const setDensity = (d: Density) => setDensityState(d);

  return (
    <ThemeContext.Provider value={{ theme, density, toggleTheme, setDensity }}>
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextType {
  return useContext(ThemeContext);
}
