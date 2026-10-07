import React from "react";
import { MessageSquareCode } from "lucide-react";
import { ChatSqlView } from "../components/chat/ChatSqlView";

export const ChatPage: React.FC = () => {
  return (
    <div className="p-8 max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
          <MessageSquareCode className="w-5 h-5 text-sky-400" />
          <span>Governed Natural Language SQL Assistant</span>
        </h1>
        <p className="text-xs text-neutral-400 mt-1">
          Query cross-document facts, compare reconciliations, and inspect structured data through policy-governed SQL.
        </p>
      </div>

      <ChatSqlView />
    </div>
  );
};
