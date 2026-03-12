"""
engine.py
---------
The dependency graph and calculation engine.

Curve dependency rules
----------------------
  Market_Value(t)          = Units(t) * Price(t)
  Market_Value_Base_CCY(t) = Units(t) * Price(t) * FX_Rate(t)
  Daily_PnL(t)             = Market_Value_Base_CCY(t) - Market_Value_Base_CCY(t-1)

The graph is built once at startup from the sorted date list. Editing any
input node triggers a BFS traversal that returns the ordered list of
downstream derived nodes to recompute.
"""


from __future__ import annotations
from models import UpdateResult

# Ordered curve names — these must match the keys in curves.json
INPUT_CURVES:   list[str] = ["Units", "Price", "FX_Rate"]
DERIVED_CURVES: list[str] = ["Market_Value", "Market_Value_Base_CCY", "Daily_PnL"]

# A graph node is a (curve_name, date) pair
Node = tuple[str, str]


class DependencyGraph:
    """
    A directed acyclic graph of (curve, date) node dependencies.

    Each node represents one cell in the data grid. Edges run from
    inputs toward the derived nodes that consume them, and from earlier
    derived values to later ones (e.g. MVB(t-1) → PnL(t)).

    Attributes:
        dependents: Maps each node to the list of nodes that depend on it.
                    Used during propagation to find what needs recomputing.
    """

    def __init__(self, dates: list[str]) -> None:
        # dependents[node] = list of nodes that read from node
        self.dependents: dict[Node, list[Node]] = {}
        self._build(dates)

    def _build(self, dates: list[str]) -> None:
        """Populate the dependents map for every (curve, date) combination."""
        for i, date in enumerate(dates):
            units_node = ("Units",   date)
            price_node = ("Price",   date)
            fx_node    = ("FX_Rate", date)
            mv_node    = ("Market_Value", date)
            mvb_node   = ("Market_Value_Base_CCY", date)
            pnl_node   = ("Daily_PnL", date)

            # Market_Value(t) ← Units(t), Price(t)
            self.dependents.setdefault(units_node, []).append(mv_node)
            self.dependents.setdefault(price_node, []).append(mv_node)

            # Market_Value_Base_CCY(t) ← Units(t), Price(t), FX_Rate(t)
            self.dependents.setdefault(units_node, []).append(mvb_node)
            self.dependents.setdefault(price_node, []).append(mvb_node)
            self.dependents.setdefault(fx_node,    []).append(mvb_node)

            # Daily_PnL(t) ← MVB(t) and MVB(t-1)
            self.dependents.setdefault(mvb_node, []).append(pnl_node)
            if i > 0:
                prev_mvb = ("Market_Value_Base_CCY", dates[i - 1])
                self.dependents.setdefault(prev_mvb, []).append(pnl_node)

    def downstream_derived(self, start: Node) -> list[Node]:
        """
        Return all derived nodes reachable from `start` via BFS,
        in propagation order (only derived-curve nodes are included).

        Args:
            start: The node whose edit triggered the propagation.

        Returns:
            Ordered list of (curve, date) nodes to recompute.
        """
        visited: set[Node]  = set()
        order:   list[Node] = []
        queue:   list[Node] = [start]

        while queue:
            node = queue.pop(0)
            if node in visited:
                continue
            visited.add(node)
            if node[0] in DERIVED_CURVES:
                order.append(node)
            for downstream in self.dependents.get(node, []):
                if downstream not in visited:
                    queue.append(downstream)

        return order


class CalculationEngine:
    """
    Computes values for derived curve nodes given a value resolver callable.

    The resolver decouples the engine from the scenario store: the engine
    asks for values by (curve, date) and the caller provides whatever
    resolution logic is appropriate (base data, scenario overrides, etc.).

    Attributes:
        graph: The DependencyGraph used for propagation traversal.
    """

    def __init__(self, dates: list[str], graph: DependencyGraph) -> None:
        self.graph = graph
        self._dates      = dates
        self._date_index = {d: i for i, d in enumerate(dates)}

    def compute(self, curve: str, date: str, resolve) -> float:
        """
        Compute the value of a single derived curve node.

        Args:
            curve:   Name of the derived curve to evaluate.
            date:    ISO date string for this cell.
            resolve: Callable(curve, date) -> float that returns the
                     current effective value for any (curve, date) pair.

        Returns:
            The computed float value.

        Raises:
            ValueError: If `curve` is not a known derived curve.
        """
        if curve == "Market_Value":
            return resolve("Units", date) * resolve("Price", date)

        if curve == "Market_Value_Base_CCY":
            return resolve("Units", date) * resolve("Price", date) * resolve("FX_Rate", date)

        if curve == "Daily_PnL":
            idx = self._date_index[date]
            if idx == 0:
                return 0.0  # No prior period on the first date
            prev_date = self._dates[idx - 1]
            return (
                self.compute("Market_Value_Base_CCY", date,      resolve) -
                self.compute("Market_Value_Base_CCY", prev_date, resolve)
            )

        raise ValueError(f"Unknown derived curve: {curve!r}")

    def propagate(self, curve: str, date: str, resolve) -> list[UpdateResult]:
        """
        Recompute all derived nodes downstream of the edited (curve, date) node.

        Args:
            curve:   The input curve that was edited.
            date:    The date of the edited cell.
            resolve: Value resolver callable — must already reflect the new value.

        Returns:
            Ordered list of UpdateResult objects ready for WebSocket serialisation.
        """
        affected = self.graph.downstream_derived((curve, date))
        return [
            UpdateResult(c, d, self.compute(c, d, resolve))
            for c, d in affected
        ]
