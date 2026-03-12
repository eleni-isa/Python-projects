# Curve Dependency Grid

A WebSocket-driven dependency graph engine that mimics Excel's cell recalculation behaviour.

## Project Structure

```
project/
├── data/
│   └── curves.json          # Input timeseries data
├── backend/
│   └── main.py              # FastAPI + WebSocket + dependency graph
├── frontend/
│   └── index.html           # Editable grid, WebSocket client
├── requirements.txt
└── README.md
```

## Setup & Run

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Start the backend

```bash
cd backend
python -m uvicorn main:app --reload --port 8000
```

### 3. Open the frontend

Open `http://127.0.0.1:8000/` directly in your browser.

## How it works

1. On startup the backend reads `data/curves.json` and builds an in-memory dependency graph.
2. When the frontend connects via WebSocket it receives the full initial state (`type: init`).
3. When the user edits a cell in Curve A or Curve B, the frontend sends:
   ```json
   { "type": "edit", "curve": "A", "date": "2024-01-01", "value": 42.0 }
   ```
4. The backend applies the edit, walks the dependency graph (topological order), recomputes all affected derived nodes (Sum), and replies:
   ```json
   { "type": "updates", "updates": [{ "curve": "Sum", "date": "2024-01-01", "value": 85.0 }] }
   ```
5. The frontend updates only the affected Sum cell and flashes it.