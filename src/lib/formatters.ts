/**
 * Utility formatters that use backend-provided currency, unit, and locale strings.
 * No hardcoded currency symbols or date calculations.
 */

export function formatBackendDate(isoString: string | undefined | null, locale = "en-US"): string {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(d);
  } catch {
    return isoString;
  }
}

export function formatBackendNumber(
  value: number | string | null | undefined,
  options?: {
    currency?: string;
    unit?: string;
    locale?: string;
  }
): string {
  if (value === null || value === undefined) return "—";
  const num = typeof value === "number" ? value : parseFloat(value);
  if (isNaN(num)) return String(value);

  const locale = options?.locale || "en-US";

  if (options?.currency) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: options.currency,
        maximumFractionDigits: 2,
      }).format(num);
    } catch {
      return `${options.currency} ${num.toLocaleString(locale)}`;
    }
  }

  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 4,
  }).format(num);

  return options?.unit ? `${formatted} ${options.unit}` : formatted;
}

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
