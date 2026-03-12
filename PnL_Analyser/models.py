"""
models.py
---------
Dataclasses representing the core domain objects passed between layers.

These are plain data containers with no business logic — the engine
and scenario manager operate on them, but they don't know about each other.
"""

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class CurveData:
    """
    The full dataset loaded from curves.json.

    Attributes:
        curves: Nested dict { curve_name: { date: value } }.
                Contains all three input curves: Units, Price, FX_Rate.
        meta:   Raw metadata dict from the JSON file (tickers, period, etc.).
        dates:  Sorted list of all dates in the dataset. Derived automatically
                from the first available curve if not explicitly provided.
    """
    curves: dict[str, dict[str, float]]
    meta:   dict
    dates:  list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.dates and self.curves:
            self.dates = sorted(next(iter(self.curves.values())).keys())


@dataclass
class UpdateResult:
    """
    A single recalculated derived cell, produced after an edit propagates
    through the dependency graph.

    A list of these is serialised into the "updates" WebSocket message
    sent back to the client after each edit.

    Attributes:
        curve: Name of the derived curve (e.g. 'Market_Value').
        date:  ISO date string this cell belongs to (e.g. '2025-06-01').
        value: The newly computed value.
    """
    curve: str
    date:  str
    value: float

    def to_dict(self) -> dict:
        """Serialise to a JSON-safe dict for WebSocket transmission."""
        return {"curve": self.curve, "date": self.date, "value": round(self.value, 4)}
