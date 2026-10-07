import React, { useState } from "react";
import { Table, Lock, Eye, KeyRound } from "lucide-react";
import type { AccessTable } from "../../agents/23_accessControl";
import { LockedCell } from "../common/LockedCell";

interface SchemaBrowserProps {
  tables: AccessTable[];
  onPreviewTable: (resourceId: string) => void;
  onRequestAccess: (resourceId: string, tableName: string, columns?: string[]) => void;
}

export const SchemaBrowser: React.FC<SchemaBrowserProps> = ({
  tables,
  onPreviewTable,
  onRequestAccess,
}) => {
  const [selectedTableId, setSelectedTableId] = useState<string>(
    tables[0]?.resource_id || ""
  );

  const activeTable = tables.find((t) => t.resource_id === selectedTableId) || tables[0];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
      {/* Tables List */}
      <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-3 space-y-2">
        <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider px-1">
          Governed Catalog ({tables.length} tables)
        </div>

        <div className="space-y-1">
          {tables.map((tbl) => (
            <div
              key={tbl.resource_id}
              onClick={() => setSelectedTableId(tbl.resource_id)}
              className={`p-2.5 rounded-lg border transition-all cursor-pointer flex items-center justify-between ${
                tbl.resource_id === selectedTableId
                  ? "bg-neutral-800 text-neutral-100 border-sky-500/60 shadow-sm"
                  : "bg-neutral-950/60 text-neutral-400 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/40"
              }`}
            >
              <div className="flex items-center gap-2 truncate">
                <Table className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                <span className="font-medium truncate">{tbl.name}</span>
                <span className="font-mono text-[10px] text-neutral-500">
                  ({tbl.columns.length})
                </span>
              </div>
              {tbl.locked && (
                <span title="Table locked">
                  <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Selected Table Detail / Columns */}
      {activeTable && (
        <div className="md:col-span-2 bg-neutral-900/60 border border-neutral-800 rounded-xl p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-neutral-800">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-neutral-100 text-sm">
                  {activeTable.schema}.{activeTable.name}
                </span>
                <span className="font-mono text-[11px] text-neutral-500">
                  {activeTable.resource_id}
                </span>
              </div>
              <div className="text-neutral-400 text-[11px] mt-0.5">
                {activeTable.columns.filter((c) => c.locked).length} restricted columns
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onPreviewTable(activeTable.resource_id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Preview Governed Rows</span>
              </button>

              {activeTable.locked && (
                <button
                  type="button"
                  onClick={() => onRequestAccess(activeTable.resource_id, activeTable.name)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Request Table Access</span>
                </button>
              )}
            </div>
          </div>

          {/* Columns Grid */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
              Columns & Policy Status
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {activeTable.columns.map((col) => (
                <div
                  key={col.name}
                  className={`p-3 rounded-lg border flex items-center justify-between gap-2 ${
                    col.locked
                      ? "bg-neutral-950/80 border-amber-500/30"
                      : "bg-neutral-950/40 border-neutral-800"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-neutral-200 truncate">{col.name}</span>
                    {col.type && (
                      <span className="font-mono text-[10px] text-neutral-500">
                        {col.type}
                      </span>
                    )}
                  </div>

                  {col.locked ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <LockedCell compact label="Locked" />
                      <button
                        type="button"
                        onClick={() =>
                          onRequestAccess(activeTable.resource_id, activeTable.name, [col.name])
                        }
                        className="text-[11px] text-amber-400 hover:text-amber-300 underline"
                      >
                        Request
                      </button>
                    </div>
                  ) : (
                    <span className="text-[10px] text-emerald-400 font-mono shrink-0">
                      Permitted
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
