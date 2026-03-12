"""
routes.py
---------
FastAPI WebSocket endpoint and server-to-client payload builders.

All messages sent to the client are one of three types:

  "init"            Full dataset payload sent once on first connection.
  "updates"         Partial recalculated cells sent after a cell edit.
  "scenario_update" Full dataset sent after a scenario switch/create/revert.

The handler delegates all state mutations to ScenarioManager and all
recalculation to CalculationEngine — this module contains only routing
and serialisation logic.
"""

from __future__ import annotations
from fastapi import WebSocket, WebSocketDisconnect

from engine import INPUT_CURVES, DERIVED_CURVES, CalculationEngine
from scenarios import ScenarioManager


# ── Payload builders ──────────────────────────────────────────────────────────

def _build_rows(manager: ScenarioManager, engine: CalculationEngine) -> list[dict]:
    """
    Build one row dict per date containing all input values, all derived
    values, and a boolean override flag for each input curve.

    Used by the frontend to populate the data grid.
    """
    rows = []
    for date in manager.base.dates:
        row: dict = {
            "date":      date,
            "overrides": {c: manager.is_overridden(c, date) for c in INPUT_CURVES},
        }
        for curve in INPUT_CURVES:
            row[curve] = manager.resolve(curve, date)
        for curve in DERIVED_CURVES:
            row[curve] = round(engine.compute(curve, date, manager.resolve), 4)
        rows.append(row)
    return rows


def _build_curves_snapshot(manager: ScenarioManager, engine: CalculationEngine) -> dict:
    """
    Build a compact { curve_name: [value, ...] } snapshot aligned to base.dates.

    This array-per-curve format is used by the frontend chart and scenario
    cache, where indexed access by position is more efficient than by date key.
    """
    snapshot: dict[str, list] = {}
    for curve in INPUT_CURVES:
        snapshot[curve] = [manager.resolve(curve, d) for d in manager.base.dates]
    for curve in DERIVED_CURVES:
        snapshot[curve] = [
            round(engine.compute(curve, d, manager.resolve), 4)
            for d in manager.base.dates
        ]
    return snapshot


def _make_init_payload(manager: ScenarioManager, engine: CalculationEngine) -> dict:
    """Construct the full initialisation payload sent once on WebSocket connect."""
    curves = _build_curves_snapshot(manager, engine)
    return {
        "type":             "init",
        "rows":             _build_rows(manager, engine),
        "dates":            manager.base.dates,
        "curves":           curves,
        "available_curves": list(curves.keys()),
        "input_curves":     INPUT_CURVES,
        "derived_curves":   DERIVED_CURVES,
        "scenarios":        manager.scenario_names,
        "active_scenario":  manager.active_scenario,
        "meta":             manager.base.meta,
    }


def _make_scenario_payload(manager: ScenarioManager, engine: CalculationEngine) -> dict:
    """Construct the full dataset payload sent after any scenario state change."""
    curves = _build_curves_snapshot(manager, engine)
    return {
        "type":            "scenario_update",
        "rows":            _build_rows(manager, engine),
        "curves":          curves,
        "scenarios":       manager.scenario_names,
        "active_scenario": manager.active_scenario,
    }


# ── WebSocket handler ─────────────────────────────────────────────────────────

async def websocket_endpoint(
    websocket: WebSocket,
    manager:   ScenarioManager,
    engine:    CalculationEngine,
) -> None:
    """
    Handle a single WebSocket client connection for the full session lifetime.

    On connect: sends the full init payload.
    On each message: routes to the appropriate handler and replies.
    On disconnect: exits cleanly (no cleanup needed — state lives in manager).

    Accepted message types
    ----------------------
    edit            { curve, date, value }  Apply a cell override and propagate.
    create_scenario { name }               Create a new scenario and activate it.
    switch_scenario { name }               Switch to an existing scenario.
    revert          {}                     Clear all overrides in the active scenario.
    """
    await websocket.accept()
    await websocket.send_json(_make_init_payload(manager, engine))

    try:
        while True:
            data     = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "edit":
                curve = data["curve"]
                date  = data["date"]
                value = float(data["value"])

                # Write override first so the resolver sees the new value during propagation
                manager.apply_override(curve, date, value)
                updates = engine.propagate(curve, date, manager.resolve)

                await websocket.send_json({
                    "type":    "updates",
                    "updates": [u.to_dict() for u in updates],
                    "override": {
                        "curve":         curve,
                        "date":          date,
                        "is_overridden": True,
                    },
                })

            elif msg_type == "create_scenario":
                name = data.get("name", "").strip()
                if name:
                    manager.create(name)
                await websocket.send_json(_make_scenario_payload(manager, engine))

            elif msg_type == "switch_scenario":
                name = data.get("name", "")
                try:
                    manager.switch(name)
                except KeyError:
                    pass  # Silently ignore unknown scenario names
                await websocket.send_json(_make_scenario_payload(manager, engine))

            elif msg_type == "revert":
                manager.revert()
                await websocket.send_json(_make_scenario_payload(manager, engine))

    except WebSocketDisconnect:
        pass  # Client disconnected — nothing to clean up
