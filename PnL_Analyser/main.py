"""
main.py
-------
Application entry point. Wires together FastAPI, middleware, and shared state.

All business logic lives in the other modules:
  models.py    — data containers
  engine.py    — dependency graph and calculation
  scenarios.py — scenario state management
  routes.py    — WebSocket handler and payload serialisation

Usage:
    uvicorn main:app --reload
"""

from pathlib import Path
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from engine import DependencyGraph, CalculationEngine
from scenarios import ScenarioManager, load_curve_data
from routes import websocket_endpoint
from fastapi.staticfiles import StaticFiles

# ── App setup ─────────────────────────────────────────────────────────────────

app = FastAPI(title="Portfolio P&L Attribution")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Shared state (initialised once at startup) ────────────────────────────────

DATA_FILE = Path(__file__).parent / "data" / "curves.json"

# Load base data from disk — never mutated at runtime
base_data = load_curve_data(DATA_FILE)

# Dependency graph and engine are stateless after construction — built once
graph  = DependencyGraph(base_data.dates)
engine = CalculationEngine(base_data.dates, graph)

# Scenario manager holds all mutable runtime state
manager = ScenarioManager(base_data)

# ── Routes ────────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    """WebSocket entry point — delegates entirely to routes.websocket_endpoint."""
    await websocket_endpoint(websocket, manager, engine)

@app.get("/test")
async def test():
    import os
    files = os.listdir(Path(__file__).parent)
    return {"files": files}

app.mount("/", StaticFiles(directory=Path(__file__).parent, html=True), name="static")
