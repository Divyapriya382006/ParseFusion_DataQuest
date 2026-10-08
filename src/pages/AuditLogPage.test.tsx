import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "../test/utils";
import { AuditLogPage } from "./AuditLogPage";

const events = [
  {
    event_id: "ev-1", timestamp: "2026-10-08T09:00:00Z", actor_id: "alice", actor_role: "analyst",
    event_type: "access_requested", object_type: "access_request", object_id: "req-1",
    details: {}, prev_hash: "a".repeat(64), hash: "b".repeat(64),
  },
  {
    event_id: "ev-2", timestamp: "2026-10-08T09:01:00Z", actor_id: "system", actor_role: "system",
    event_type: "action_submitted", object_type: "action", object_id: "act-1",
    details: {}, prev_hash: "b".repeat(64), hash: "c".repeat(64),
  },
];

vi.mock("../agents/19_audit", () => ({
  fetchAuditLog: vi.fn(async (filters: { actor?: string; event_type?: string }) => ({
    events: events.filter((event) =>
      (!filters.actor || filters.actor === event.actor_id) &&
      (!filters.event_type || filters.event_type === event.event_type)
    ),
    chain_valid: true,
  })),
}));

describe("AuditLogPage filters", () => {
  it("offers event types and actors present in the loaded table", async () => {
    renderWithApp(<AuditLogPage />);
    await waitFor(() => expect(screen.getByRole("cell", { name: "access_requested" })).toBeInTheDocument());

    const eventType = screen.getByRole("combobox", { name: "Filter by event type" });
    const actor = screen.getByRole("combobox", { name: "Filter by actor" });
    expect(eventType).toHaveTextContent("access_requested");
    expect(eventType).toHaveTextContent("action_submitted");
    expect(actor).toHaveTextContent("alice (analyst)");
    expect(actor).toHaveTextContent("system (system)");

    fireEvent.change(eventType, { target: { value: "access_requested" } });
    await waitFor(() => expect(screen.queryByRole("cell", { name: "action_submitted" })).not.toBeInTheDocument());
    fireEvent.change(actor, { target: { value: "alice" } });
    await waitFor(() => expect(screen.getByRole("cell", { name: "access_requested" })).toBeInTheDocument());
  });
});
