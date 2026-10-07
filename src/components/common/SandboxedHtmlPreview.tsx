import React from "react";

interface SandboxedHtmlPreviewProps {
  htmlContent: string;
  title?: string;
  className?: string;
}

/**
 * Sandboxed renderer for HTML previews returned by backend.
 * Uses strict sandbox attribute without allow-scripts to prevent execution.
 */
export const SandboxedHtmlPreview: React.FC<SandboxedHtmlPreviewProps> = ({
  htmlContent,
  title = "HTML Preview",
  className = "w-full h-96",
}) => {
  return (
    <div className="w-full border border-neutral-800 rounded-xl overflow-hidden bg-white">
      <iframe
        title={title}
        srcDoc={htmlContent}
        sandbox=""
        className={className}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    </div>
  );
};
