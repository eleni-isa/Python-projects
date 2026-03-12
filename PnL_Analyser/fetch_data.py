"""
fetch_data.py
-------------
Fetches real market data for the Portfolio P&L Attribution project.

Pulls:
  - VUSA.L    : Vanguard S&P 500 UCITS ETF (USD, listed on LSE)
  - GBPUSD=X  : GBP/USD FX rate

Writes: data/curves.json

Usage:
    pip install yfinance
    python fetch_data.py
"""

import json
from pathlib import Path
from datetime import datetime

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

TICKER_PRICE = "VUSA.L"
TICKER_FX    = "GBPUSD=X"
PERIOD       = "12mo"
INTERVAL     = "1mo"

# Units held — flat number or dict with rebalancing dates
UNITS = {
    "default": 1000,
    # "2024-06-01": 1500,  # uncomment to simulate rebalancing
}

OUTPUT_FILE = Path(__file__).parent / "data" / "curves.json"

# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def extract_close(df, ticker):
    """
    Robustly extract the Close price series from a yfinance DataFrame,
    handling both single-level and multi-level column structures.
    """
    import pandas as pd

    # Multi-level columns: (field, ticker) — newer yfinance
    if isinstance(df.columns, pd.MultiIndex):
        if ("Close", ticker) in df.columns:
            return df[("Close", ticker)].dropna()
        # Try first Close column regardless of ticker name
        close_cols = [(f, t) for f, t in df.columns if f == "Close"]
        if close_cols:
            return df[close_cols[0]].dropna()

    # Single-level columns — older yfinance
    if "Close" in df.columns:
        series = df["Close"].dropna()
        # If it's still a DataFrame (can happen), take first column
        if hasattr(series, 'iloc') and len(series.shape) > 1:
            series = series.iloc[:, 0]
        return series

    raise ValueError(f"Could not find Close column in data for {ticker}. Columns: {list(df.columns)}")


def resolve_units(dt):
    if isinstance(UNITS, (int, float)):
        return float(UNITS)
    result = float(UNITS.get("default", 1000))
    for date_str, units in UNITS.items():
        if date_str == "default":
            continue
        rebal = datetime.strptime(date_str, "%Y-%m-%d").date()
        if dt.date() >= rebal:
            result = float(units)
    return result


def fetch():
    try:
        import yfinance as yf
    except ImportError:
        print("ERROR: yfinance not installed. Run: pip install yfinance")
        raise

    print(f"Fetching {TICKER_PRICE} ({INTERVAL} intervals, period={PERIOD})...")
    price_df = yf.download(TICKER_PRICE, period=PERIOD, interval=INTERVAL,
                           auto_adjust=True, progress=False)

    print(f"Fetching {TICKER_FX}...")
    fx_df = yf.download(TICKER_FX, period=PERIOD, interval=INTERVAL,
                        auto_adjust=True, progress=False)

    if price_df.empty:
        raise ValueError(f"No data returned for {TICKER_PRICE}.")
    if fx_df.empty:
        raise ValueError(f"No data returned for {TICKER_FX}.")

    prices = extract_close(price_df, TICKER_PRICE)
    fx     = extract_close(fx_df,    TICKER_FX)

    # Align on common dates
    common_dates = sorted(set(prices.index) & set(fx.index))
    if not common_dates:
        raise ValueError("No overlapping dates between price and FX data.")

    print(f"Found {len(common_dates)} common data points.")

    price_curve = []
    fx_curve    = []
    units_curve = []

    for dt in common_dates:
        date_str = dt.strftime("%Y-%m-%d")
        p = float(prices.loc[dt])
        f = float(fx.loc[dt])
        u = resolve_units(dt)

        price_curve.append({"date": date_str, "value": round(p, 4)})
        fx_curve.append(   {"date": date_str, "value": round(f, 6)})
        units_curve.append({"date": date_str, "value": u})

    output = {
        "meta": {
            "generated":    datetime.now().isoformat(),
            "price_ticker": TICKER_PRICE,
            "fx_ticker":    TICKER_FX,
            "interval":     INTERVAL,
            "period":       PERIOD,
            "note":         "Price in USD. FX is GBP/USD (USD per GBP). MV Base CCY = MV / FX_Rate to get GBP."
        },
        "curves": {
            "Units":   units_curve,
            "Price":   price_curve,
            "FX_Rate": fx_curve,
        }
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(output, indent=2))

    print(f"\nSuccess! Written to {OUTPUT_FILE}")
    print(f"\nSample data (first 3 rows):")
    for i in range(min(3, len(common_dates))):
        print(f"  {price_curve[i]['date']} | Price: ${price_curve[i]['value']:.2f} | "
              f"FX: {fx_curve[i]['value']:.4f} | Units: {units_curve[i]['value']:.0f}")

    print(f"\nRestart the backend to load the new data.")


if __name__ == "__main__":
    fetch()