"""
scenarios.py
------------
Scenario state management.

A scenario is a named sparse set of cell overrides layered on top of the
immutable base dataset. Only cells that have been explicitly edited are
stored — all other lookups fall through to the base data.

The ScenarioManager is the single source of truth for:
  - Which scenarios exist and their insertion order
  - Which scenario is currently active
  - The override values for each scenario
  - Value resolution (override-wins-over-base)
"""

from __future__ import annotations
from pathlib import Path
import json

from models import CurveData

DEFAULT_SCENARIO = "Base"


def load_curve_data(data_file: Path) -> CurveData:
    """
    Load and parse curves.json into a CurveData instance.

    The JSON schema is:
        {
          "meta": { ... },
          "curves": {
            "CurveName": [{"date": "YYYY-MM-DD", "value": 0.0}, ...]
          }
        }

    Args:
        data_file: Path to the JSON file on disk.

    Returns:
        CurveData with curves keyed as { curve_name: { date: value } }.

    Raises:
        FileNotFoundError: If data_file does not exist.
        KeyError:          If the JSON is missing required fields.
    """
    raw = json.loads(data_file.read_text())
    curves = {
        name: {point["date"]: point["value"] for point in points}
        for name, points in raw["curves"].items()
    }
    return CurveData(curves=curves, meta=raw.get("meta", {}))


class ScenarioManager:
    """
    Manages named scenario state layered over an immutable base dataset.

    Scenarios are stored as sparse override dicts:
        { scenario_name: { curve_name: { date: value } } }

    The "Base" scenario always exists and is read-only — it has no overrides
    and cannot be reverted or edited. All other scenarios start empty (no
    overrides) and accumulate changes as the user edits cells.

    Attributes:
        base:            The immutable CurveData loaded from disk.
        active_scenario: Name of the currently selected scenario.
    """

    def __init__(self, base: CurveData) -> None:
        self.base = base
        self.active_scenario: str = DEFAULT_SCENARIO

        # Overrides per scenario: { scenario_name: { curve: { date: value } } }
        # The Base entry is always present and always empty.
        self._overrides: dict[str, dict[str, dict[str, float]]] = {
            DEFAULT_SCENARIO: {}
        }

    # ── Scenario management ───────────────────────────────────────────────────

    @property
    def scenario_names(self) -> list[str]:
        """Return all scenario names in insertion order."""
        return list(self._overrides.keys())

    def create(self, name: str) -> None:
        """
        Create a new scenario with no overrides and activate it.

        If the name already exists, the existing scenario is activated
        without clearing its overrides (idempotent on name collision).

        Args:
            name: Display name for the new scenario. Leading/trailing
                  whitespace should be stripped by the caller.
        """
        if name not in self._overrides:
            self._overrides[name] = {}
        self.active_scenario = name

    def switch(self, name: str) -> None:
        """
        Activate an existing scenario by name.

        Args:
            name: The scenario to switch to.

        Raises:
            KeyError: If the scenario does not exist.
        """
        if name not in self._overrides:
            raise KeyError(f"Scenario {name!r} does not exist.")
        self.active_scenario = name

    def revert(self) -> None:
        """
        Clear all overrides in the active scenario, restoring it to
        the base dataset values. Has no effect on the Base scenario.
        """
        self._overrides[self.active_scenario] = {}

    # ── Value resolution ──────────────────────────────────────────────────────

    def resolve(self, curve: str, date: str) -> float:
        """
        Return the effective value for (curve, date) in the active scenario.

        Resolution order: scenario override → base dataset.

        Args:
            curve: Curve name (e.g. 'Price').
            date:  ISO date string (e.g. '2025-06-01').

        Returns:
            The override value if one exists, otherwise the base value.
        """
        overrides = self._overrides[self.active_scenario]
        if curve in overrides and date in overrides[curve]:
            return overrides[curve][date]
        return self.base.curves[curve][date]

    def is_overridden(self, curve: str, date: str) -> bool:
        """
        Return True if (curve, date) has an explicit override in the
        active scenario (regardless of whether it differs from base).
        """
        overrides = self._overrides[self.active_scenario]
        return curve in overrides and date in overrides[curve]

    def apply_override(self, curve: str, date: str, value: float) -> None:
        """
        Write an override for (curve, date) in the active scenario.

        The engine's propagation should be called *after* this so that
        the resolver already sees the new value during recomputation.

        Args:
            curve: The input curve being edited.
            date:  The date being edited.
            value: The new user-supplied value.
        """
        overrides = self._overrides[self.active_scenario]
        overrides.setdefault(curve, {})[date] = value
