import React from "react";
import { CheckCircle2, AlertCircle, HelpCircle } from "lucide-react";
import { useConfig } from "../../context/ConfigContext";

interface ConfidenceIndicatorProps {
  confidence: number; // 0 to 1
  showPercent?: boolean;
  size?: "sm" | "md";
}

export const ConfidenceIndicator: React.FC<ConfidenceIndicatorProps> = ({
  confidence,
  showPercent = true,
  size = "md",
}) => {
  const { config } = useConfig();

  // Find matching band from backend config.confidence_bands
  const band = config?.confidence_bands?.find(
    (b) => confidence >= b.min && confidence <= b.max
  );

  const percentText = `${Math.round(confidence * 100)}%`;
  const label = band?.label || percentText;

  // Design-token styling mapped from band id or value
  let colorStyle = "text-neutral-400 border-neutral-700 bg-neutral-800/40";
  let Icon = HelpCircle;

  if (confidence >= 0.85) {
    colorStyle = "text-emerald-400 border-emerald-500/20 bg-emerald-500/10";
    Icon = CheckCircle2;
  } else if (confidence >= 0.65) {
    colorStyle = "text-amber-400 border-amber-500/20 bg-amber-500/10";
    Icon = AlertCircle;
  } else {
    colorStyle = "text-rose-400 border-rose-500/20 bg-rose-500/10";
    Icon = AlertCircle;
  }

  return (
    <div
      className={`inline-flex items-center gap-1.5 border rounded font-mono tabular-nums ${colorStyle} ${
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs"
      }`}
      title={`Confidence: ${percentText} (${label})`}
    >
      <Icon className={size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5"} />
      <span>{showPercent ? percentText : label}</span>
    </div>
  );
};
