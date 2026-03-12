/**
 * app.js — Portfolio P&L Attribution frontend
 *
 * Architecture
 * ============
 * Five classes with clearly separated responsibilities, coordinated by
 * the App class which owns the WebSocket connection and top-level state.
 *
 *   CurveRegistry  — Static curve metadata: colours, display labels, formatters.
 *                    Pure static class; no instances needed.
 *
 *   ScenarioCache  — Stores resolved curve values per scenario so compare mode
 *                    and the chart can look up any scenario without re-querying
 *                    the server. Shape: { scenario: { curve: { date: value } } }
 *
 *   GridManager    — Owns all DOM interactions for the data table: builds headers,
 *                    builds/refreshes rows, updates individual cells, controls
 *                    editability. Calls back to App on cell edits.
 *
 *   ChartManager   — Owns the Chart.js instance. Builds/rebuilds datasets when
 *                    selected curves change, handles compare overlay rendering,
 *                    and updates individual data points after live edits.
 *
 *   App            — Top-level controller. Owns the WebSocket, all UI state
 *                    (active scenario, compare mode), and wires all event
 *                    listeners. Routes incoming messages to the sub-managers.
 */

'use strict';

const WS_URL = 'ws://localhost:8000/ws';

// =============================================================================
// CurveRegistry
// =============================================================================

/**
 * Static registry of per-curve display metadata.
 *
 * All curve-name → visual mapping lives here so it's easy to extend
 * without touching business logic. Import/use as CurveRegistry.color(name) etc.
 */
class CurveRegistry {
  /** @type {Object.<string, string>} */
  static #COLORS = {
    Units: '#00d4ff', Price: '#ff6b35', FX_Rate: '#c084fc',
    Market_Value: '#fbbf24', Market_Value_Base_CCY: '#a8ff78', Daily_PnL: '#34d399',
  };

  /** @type {Object.<string, string>} */
  static #LABELS = {
    Units: 'Units', Price: 'Price (USD)', FX_Rate: 'FX Rate',
    Market_Value: 'Mkt Val (USD)', Market_Value_Base_CCY: 'MV Base CCY (GBP)', Daily_PnL: 'Daily P&L (GBP)',
  };

  /** Return the chart/UI colour for a curve, falling back to a neutral tone. */
  static color(name) { return this.#COLORS[name] ?? '#b8c4d8'; }

  /** Return the full display label for a curve, falling back to the raw name. */
  static label(name) { return this.#LABELS[name] ?? name; }

  /**
   * Format a raw number for display, applying curve-specific precision rules.
   * @param {number} value
   * @param {string} curve
   * @returns {string}
   */
  static format(value, curve) {
    if (curve === 'FX_Rate') return value.toFixed(4);
    if (curve === 'Units')   return value.toLocaleString('en-GB', { maximumFractionDigits: 0 });
    return value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /**
   * Return the CSS class for a P&L cell value.
   * @param {number} v
   * @returns {'cell-pnl-pos'|'cell-pnl-neg'|'cell-pnl-zero'}
   */
  static pnlClass(v) {
    if (v > 0) return 'cell-pnl-pos';
    if (v < 0) return 'cell-pnl-neg';
    return 'cell-pnl-zero';
  }

  /**
   * Return the th colour class for a derived curve column header.
   * @param {string} curve
   * @returns {string}
   */
  static thClass(curve) {
    if (curve === 'Market_Value')          return 'col-mv';
    if (curve === 'Market_Value_Base_CCY') return 'col-mvb';
    return 'col-pnl';
  }

  /**
   * Return the input cell colour class for an input curve.
   * @param {string} curve
   * @returns {string}
   */
  static inputClass(curve) {
    if (curve === 'Units') return 'col-units';
    if (curve === 'Price') return 'col-price';
    return 'col-fx';
  }
}


// =============================================================================
// ScenarioCache
// =============================================================================

/**
 * Per-scenario data store for chart rendering and compare mode.
 *
 * The server sends curve snapshots as parallel arrays (one value per date).
 * This cache converts them to { date → value } maps so both the chart and
 * the compare grid can efficiently look up any (scenario, curve, date) triple.
 *
 * Shape: { scenarioName: { curveName: { date: value } } }
 */
class ScenarioCache {
  constructor() {
    /** @type {Object.<string, Object.<string, Object.<string, number>>>} */
    this._data = {};
  }

  /**
   * Populate (or overwrite) all curves for a scenario from a snapshot.
   *
   * @param {string}   scenarioName
   * @param {string[]} dates        — ordered date list aligned to the snapshot arrays
   * @param {Object.<string, number[]>} curves — { curveName: [value, ...] }
   */
  populate(scenarioName, dates, curves) {
    this._data[scenarioName] = {};
    for (const [curve, values] of Object.entries(curves)) {
      this._data[scenarioName][curve] = Object.fromEntries(
        dates.map((d, i) => [d, values[i]])
      );
    }
  }

  /**
   * Update a single (scenario, curve, date) entry — used after live edits
   * so the cache stays in sync without a full repopulate.
   *
   * @param {string} scenarioName
   * @param {string} curveName
   * @param {string} date
   * @param {number} value
   */
  set(scenarioName, curveName, date, value) {
    this._data[scenarioName]               ??= {};
    this._data[scenarioName][curveName]    ??= {};
    this._data[scenarioName][curveName][date] = value;
  }

  /**
   * Return the full { curve: { date: value } } map for a scenario.
   * Returns an empty object if the scenario hasn't been cached yet.
   *
   * @param {string} scenarioName
   * @returns {Object.<string, Object.<string, number>>}
   */
  get(scenarioName) {
    return this._data[scenarioName] ?? {};
  }

  /**
   * Look up one specific value. Returns undefined if not found.
   *
   * @param {string} scenarioName
   * @param {string} curveName
   * @param {string} date
   * @returns {number|undefined}
   */
  getValue(scenarioName, curveName, date) {
    return this._data[scenarioName]?.[curveName]?.[date];
  }
}


// =============================================================================
// GridManager
// =============================================================================

/**
 * Owns all DOM operations for the data grid (table).
 *
 * Responsibilities:
 *   - Build and rebuild the thead (normal and compare layouts)
 *   - Build all tbody rows from scratch (buildRows)
 *   - Patch rows in-place when values change (refreshRows)
 *   - Render the compare-mode tbody from two scenario data sets
 *   - Update single derived cells after live edit propagation
 *   - Toggle override highlights on input cells
 *   - Enable/disable all input cells
 *   - Update the panel header text
 *
 * rowMap indexes all live cells by date:
 *   { date: { inputs: { curve: { td, input } }, derived: { curve: td } } }
 */
class GridManager {
  /**
   * @param {HTMLElement} thead
   * @param {HTMLElement} tbody
   * @param {HTMLElement} panelHeader   — the <span> showing grid title
   * @param {function(string, string, string): void} onEdit
   *        Callback invoked when the user commits a cell edit: (curve, date, value)
   */
  constructor(thead, tbody, panelHeader, onEdit) {
    this._thead       = thead;
    this._tbody       = tbody;
    this._panelHeader = panelHeader;
    this._onEdit      = onEdit;

    /**
     * Live cell references, keyed by date.
     * @type {Object.<string, {inputs: Object, derived: Object}>}
     */
    this.rowMap = {};
  }

  // ── Header builders ────────────────────────────────────────────────────────

  /** Render the standard single-scenario column header row. */
  buildNormalHeader() {
    this._thead.innerHTML = `<tr>
      <th class="col-date">Date</th>
      <th class="col-units">Units</th>
      <th class="col-price">Price (USD)</th>
      <th class="col-fx">FX Rate</th>
      <th class="col-mv derived-start">Mkt Val (USD)</th>
      <th class="col-mvb">MV Base CCY (GBP)</th>
      <th class="col-pnl">Daily P&L (GBP)</th>
    </tr>`;
  }

  /**
   * Render the two-row compare-mode header.
   * Each derived curve gets three columns: Left scenario / Right scenario / Diff.
   *
   * @param {string[]} derivedCurves
   * @param {string}   leftLabel   — name of the left (active) scenario
   * @param {string}   rightLabel  — name of the right (compare) scenario
   */
  buildCompareHeader(derivedCurves, leftLabel, rightLabel) {
    // First row: one merged cell per derived curve
    let row1 = `<tr><th class="col-date" rowspan="2">Date</th>`;
    for (let i = 0; i < derivedCurves.length; i++) {
      const borderCls = i === 0 ? 'section-start' : '';
      row1 += `<th colspan="3" class="${CurveRegistry.thClass(derivedCurves[i])} ${borderCls}">
                 ${CurveRegistry.label(derivedCurves[i])}
               </th>`;
    }
    row1 += `</tr>`;

    // Second row: Left / Right / Diff sub-headers per curve
    let row2 = `<tr>`;
    for (let i = 0; i < derivedCurves.length; i++) {
      const borderCls = i === 0 ? 'section-start' : '';
      row2 += `<th class="${borderCls}" style="color:#8a96aa">${leftLabel}</th>`;
      row2 += `<th style="color:#8a96aa">${rightLabel}</th>`;
      row2 += `<th class="col-diff">Diff</th>`;
    }
    row2 += `</tr>`;

    this._thead.innerHTML = row1 + row2;
  }

  // ── Row builders ───────────────────────────────────────────────────────────

  /**
   * Fully rebuild the tbody from a server-provided rows array.
   * Also resets rowMap.
   *
   * @param {Object[]} rows          — row objects from the server payload
   * @param {string[]} inputCurves
   * @param {string[]} derivedCurves
   */
  buildRows(rows, inputCurves, derivedCurves) {
    this._tbody.innerHTML = '';
    this.rowMap = {};

    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.appendChild(this._makeDateCell(row.date));

      const inputCells   = this._buildInputCells(row, inputCurves);
      const derivedCells = this._buildDerivedCells(row, derivedCurves);

      for (const { td } of Object.values(inputCells))   tr.appendChild(td);
      for (const td       of Object.values(derivedCells)) tr.appendChild(td);

      this._tbody.appendChild(tr);
      this.rowMap[row.date] = { inputs: inputCells, derived: derivedCells };
    }
  }

  /**
   * Patch existing rows in-place after a scenario switch/revert.
   * Avoids a full DOM rebuild, which would lose scroll position.
   *
   * @param {Object[]} rows
   * @param {string[]} inputCurves
   * @param {string[]} derivedCurves
   */
  refreshRows(rows, inputCurves, derivedCurves) {
    for (const row of rows) {
      const cells = this.rowMap[row.date];
      if (!cells) continue;

      for (const curve of inputCurves) {
        cells.inputs[curve].input.value = row[curve];
        cells.inputs[curve].td.classList.toggle('overridden', !!row.overrides?.[curve]);
      }
      for (const curve of derivedCurves) {
        const td = cells.derived[curve];
        td.textContent = CurveRegistry.format(row[curve], curve);
        if (curve === 'Daily_PnL') {
          td.className = 'cell-derived ' + CurveRegistry.pnlClass(row[curve]);
        }
      }
    }
  }

  /**
   * Rebuild the tbody for compare mode using pre-cached scenario data.
   * rowMap is not populated in compare mode (no live editing).
   *
   * @param {string[]} dates
   * @param {string[]} derivedCurves
   * @param {Object}   leftData   — ScenarioCache.get(activeScenario)
   * @param {Object}   rightData  — ScenarioCache.get(compareScenario)
   */
  renderCompareRows(dates, derivedCurves, leftData, rightData) {
    this._tbody.innerHTML = '';
    this.rowMap = {};

    for (const date of dates) {
      const tr = document.createElement('tr');
      tr.appendChild(this._makeDateCell(date));

      for (let i = 0; i < derivedCurves.length; i++) {
        const curve = derivedCurves[i];
        const lv    = leftData[curve]?.[date]  ?? 0;
        const rv    = rightData[curve]?.[date] ?? 0;
        const diff  = rv - lv;

        tr.appendChild(this._makeDerivedValueCell(curve, lv, i === 0));
        tr.appendChild(this._makeDerivedValueCell(curve, rv, false));
        tr.appendChild(this._makeDiffCell(curve, diff));
      }
      this._tbody.appendChild(tr);
    }
  }

  // ── Live cell updates ──────────────────────────────────────────────────────

  /**
   * Update a single derived cell's text and colour class.
   * Called after the server pushes back a propagation result.
   *
   * @param {string} curve
   * @param {string} date
   * @param {number} value
   */
  updateDerivedCell(curve, date, value) {
    const cells = this.rowMap[date];
    if (!cells?.derived?.[curve]) return;
    const td = cells.derived[curve];
    td.textContent = CurveRegistry.format(value, curve);
    if (curve === 'Daily_PnL') {
      td.className = 'cell-derived ' + CurveRegistry.pnlClass(value);
    }
    this._flash(td);
  }

  /**
   * Toggle the override visual on an input cell.
   *
   * @param {string}  curve
   * @param {string}  date
   * @param {boolean} isOverridden
   */
  markOverride(curve, date, isOverridden) {
    this.rowMap[date]?.inputs?.[curve]?.td.classList.toggle('overridden', isOverridden);
  }

  /**
   * Enable or disable all input cells across the entire grid.
   * Base scenario cells are always shown as read-only.
   *
   * @param {boolean} editable
   */
  setEditable(editable) {
    for (const cells of Object.values(this.rowMap)) {
      if (!cells.inputs) continue;
      for (const { input } of Object.values(cells.inputs)) {
        input.disabled      = !editable;
        input.style.opacity = editable ? '1' : '0.32';
        input.style.cursor  = editable ? 'text' : 'default';
      }
    }
  }

  /** Update the panel header text (e.g. "Data Grid — Base"). */
  setPanelHeader(text) {
    this._panelHeader.textContent = text;
  }

  // ── Private cell factory helpers ──────────────────────────────────────────

  _makeDateCell(date) {
    const td = document.createElement('td');
    td.className   = 'cell-date';
    td.textContent = date;
    return td;
  }

  /**
   * Build all input cells for one row.
   * Attaches change listeners that fire the onEdit callback.
   *
   * @returns {Object.<string, {td: HTMLElement, input: HTMLInputElement}>}
   */
  _buildInputCells(row, inputCurves) {
    const cells = {};
    for (const curve of inputCurves) {
      const td  = document.createElement('td');
      if (row.overrides?.[curve]) td.classList.add('overridden');

      const inp = document.createElement('input');
      inp.type  = 'number';
      inp.step  = 'any';
      inp.classList.add('cell-input', CurveRegistry.inputClass(curve));
      inp.value = row[curve];

      // Capture curve and date in closure — both are fixed for this row
      inp.addEventListener('change', () => this._onEdit(curve, row.date, inp.value));

      td.appendChild(inp);
      cells[curve] = { td, input: inp };
    }
    return cells;
  }

  /**
   * Build all derived cells for one row.
   *
   * @returns {Object.<string, HTMLElement>}
   */
  _buildDerivedCells(row, derivedCurves) {
    const cells = {};
    for (let i = 0; i < derivedCurves.length; i++) {
      cells[derivedCurves[i]] = this._makeDerivedValueCell(derivedCurves[i], row[derivedCurves[i]], i === 0);
    }
    return cells;
  }

  /**
   * Create a single derived value <td> with the appropriate colour class.
   *
   * @param {string}  curve
   * @param {number}  value
   * @param {boolean} isFirst — if true, adds the left-border section divider class
   * @returns {HTMLElement}
   */
  _makeDerivedValueCell(curve, value, isFirst) {
    const td = document.createElement('td');
    td.classList.add('cell-derived');
    if (isFirst) td.classList.add('derived-start');

    if (curve === 'Market_Value')               td.classList.add('cell-mv');
    else if (curve === 'Market_Value_Base_CCY') td.classList.add('cell-mvb');
    else if (curve === 'Daily_PnL')             td.classList.add(CurveRegistry.pnlClass(value));

    td.textContent = CurveRegistry.format(value, curve);
    return td;
  }

  /**
   * Create a diff <td> for compare mode (Right − Left).
   *
   * @param {string} curve — used for number formatting
   * @param {number} diff  — rv - lv
   * @returns {HTMLElement}
   */
  _makeDiffCell(curve, diff) {
    const td = document.createElement('td');
    td.classList.add('cell-diff', diff > 0 ? 'pos' : diff < 0 ? 'neg' : 'zero');
    td.textContent = (diff >= 0 ? '+' : '') + CurveRegistry.format(diff, curve);
    return td;
  }

  /** Briefly flash a cell to indicate it just received an update. */
  _flash(td) {
    td.classList.add('flash');
    setTimeout(() => td.classList.remove('flash'), 380);
  }
}


// =============================================================================
// ChartManager
// =============================================================================

/**
 * Owns the Chart.js instance and all chart rendering logic.
 *
 * Responsibilities:
 *   - Create the chart once on first data load (init)
 *   - Toggle curves on/off via chip controls
 *   - Update single data points after live edits (updatePoint)
 *   - Swap the full dataset on scenario switch (setCurves)
 *   - Render compare-mode overlay (solid vs dashed lines per scenario)
 *
 * The chart delegates dataset construction to _buildDatasets, which reads
 * from either the flat curves array (normal mode) or the ScenarioCache
 * (compare mode).
 */
class ChartManager {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement}       chipContainer — container for curve toggle chips
   * @param {ScenarioCache}     cache         — shared scenario data cache
   */
  constructor(canvas, chipContainer, cache) {
    this._canvas        = canvas;
    this._chipContainer = chipContainer;
    this._cache         = cache;

    /** @type {Chart|null} */
    this._chart = null;

    /** @type {string[]} Ordered date list, set on init */
    this._dates = [];

    /**
     * Current curve snapshot (normal mode).
     * @type {Object.<string, number[]>}
     */
    this._curves = {};

    /** Curves toggled on by the user. */
    this._selected = new Set(['Market_Value_Base_CCY', 'Daily_PnL']);

    // Compare state — kept in sync by App
    this.compareMode     = false;
    this.activeScenario  = '';
    this.compareScenario = '';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Create the Chart.js instance. Must be called once after the first
   * "init" WebSocket message, when dates and curves are first known.
   *
   * @param {string[]} dates
   * @param {Object.<string, number[]>} curves
   */
  init(dates, curves) {
    this._dates  = dates;
    this._curves = curves;

    this._chart = new Chart(this._canvas.getContext('2d'), {
      type: 'line',
      data: { labels: dates, datasets: this._buildDatasets() },
      options: this._buildOptions(),
    });
  }

  // ── Public update API ──────────────────────────────────────────────────────

  /**
   * Swap in a new full curves snapshot (e.g. after scenario switch).
   * @param {Object.<string, number[]>} curves
   */
  setCurves(curves) {
    this._curves = curves;
    this._redraw();
  }

  /**
   * Patch a single data point in the current curves snapshot.
   * Called after a live edit propagation to keep the chart in sync.
   *
   * @param {string} curveName
   * @param {string} date
   * @param {number} value
   */
  updatePoint(curveName, date, value) {
    if (!this._curves[curveName]) return;
    const idx = this._dates.indexOf(date);
    if (idx !== -1) this._curves[curveName][idx] = value;
    this._redraw();
  }

  /**
   * Build the curve-toggle chip controls from the available curve list.
   * Chips are interactive labels that toggle a curve on/off in the chart.
   *
   * @param {string[]} availableCurves
   */
  buildChips(availableCurves) {
    this._chipContainer.innerHTML = '';

    for (const name of availableCurves) {
      const isSelected = this._selected.has(name);
      const color      = CurveRegistry.color(name);

      const chip = document.createElement('label');
      chip.className   = 'curve-chip' + (isSelected ? ' active' : '');
      chip.style.color = isSelected ? color : '';

      // Hidden checkbox — state is mirrored in this._selected and chip classes
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = isSelected;

      const dot = document.createElement('span');
      dot.className        = 'chip-dot';
      dot.style.background = color;

      chip.append(cb, dot, document.createTextNode(CurveRegistry.label(name)));
      this._chipContainer.appendChild(chip);

      chip.addEventListener('click', () => {
        cb.checked = !cb.checked;
        if (cb.checked) {
          this._selected.add(name);
          chip.classList.add('active');
          chip.style.color = color;
        } else {
          this._selected.delete(name);
          chip.classList.remove('active');
          chip.style.color = '';
        }
        this._redraw();
      });
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Push updated datasets to Chart.js and trigger a re-render. */
  _redraw() {
    if (!this._chart) return;
    this._chart.data.datasets = this._buildDatasets();
    this._chart.update();
  }

  /**
   * Build the Chart.js dataset array for the current render state.
   *
   * Normal mode:  one solid line per selected curve.
   * Compare mode: one solid + one dashed line per selected curve,
   *               sourced from the scenario cache.
   *
   * @returns {Object[]} Chart.js dataset objects
   */
  _buildDatasets() {
    const datasets = [];

    if (this.compareMode && this.compareScenario) {
      const leftData  = this._cache.get(this.activeScenario);
      const rightData = this._cache.get(this.compareScenario);

      for (const name of this._selected) {
        if (!this._curves[name]) continue;
        const color = CurveRegistry.color(name);

        // Left scenario — solid line
        datasets.push({
          label:           `${CurveRegistry.label(name)} [${this.activeScenario}]`,
          data:            this._dates.map(d => leftData[name]?.[d] ?? null),
          borderColor:     color,
          backgroundColor: 'transparent',
          borderWidth: 2, pointRadius: 4, tension: 0.3,
        });

        // Right scenario — dashed line with triangle points
        datasets.push({
          label:           `${CurveRegistry.label(name)} [${this.compareScenario}]`,
          data:            this._dates.map(d => rightData[name]?.[d] ?? null),
          borderColor:     color,
          backgroundColor: 'transparent',
          borderWidth:     2,
          borderDash:      [5, 4],
          pointRadius:     4,
          pointStyle:      'triangle',
          tension:         0.3,
        });
      }
    } else {
      for (const name of this._selected) {
        if (!this._curves[name]) continue;
        const color = CurveRegistry.color(name);
        datasets.push({
          label:           CurveRegistry.label(name),
          data:            [...this._curves[name]],
          borderColor:     color,
          backgroundColor: color + '12',
          borderWidth:     2,
          pointRadius:     4,
          pointHoverRadius: 6,
          tension:         0.3,
          fill:            false,
        });
      }
    }

    return datasets;
  }

  /**
   * Build the Chart.js options object.
   * Extracted to keep init() readable.
   */
  _buildOptions() {
    const mono = { family: 'Space Mono' };
    return {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 300 },
      plugins: {
        legend: {
          labels: { color: '#b8c4d8', font: { ...mono, size: 11 }, boxWidth: 12, boxHeight: 2, padding: 16 },
        },
        tooltip: {
          backgroundColor: 'rgba(10,14,24,0.94)',
          borderColor:     'rgba(255,255,255,0.1)', borderWidth: 1,
          titleColor:      '#e8edf5', bodyColor: '#b8c4d8',
          titleFont:       { ...mono, size: 11 }, bodyFont: { ...mono, size: 11 },
          padding: 12, cornerRadius: 8,
        },
      },
      scales: {
        x: {
          ticks:  { color: '#48566a', font: { ...mono, size: 10 }, maxRotation: 45 },
          grid:   { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
        y: {
          ticks:  { color: '#48566a', font: { ...mono, size: 10 } },
          grid:   { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    };
  }
}


// =============================================================================
// App
// =============================================================================

/**
 * Top-level application controller.
 *
 * Responsibilities:
 *   - Open the WebSocket connection and handle auto-reconnect
 *   - Own all top-level state: activeScenario, compareMode, dates, curve lists
 *   - Route incoming WebSocket messages to GridManager and ChartManager
 *   - Wire all toolbar and scenario UI event listeners
 *   - Keep the ScenarioCache up to date
 *
 * The App does not directly manipulate the grid or chart — it delegates
 * entirely to GridManager and ChartManager for all DOM and Chart.js work.
 */
class App {
  constructor() {
    // ── DOM refs ──────────────────────────────────────────────────────────────
    this._overlay           = document.getElementById('overlay');
    this._statusDot         = document.getElementById('statusDot');
    this._statusText        = document.getElementById('statusText');
    this._scenarioSelect    = document.getElementById('scenarioSelect');
    this._compareSelect     = document.getElementById('compareSelect');
    this._compareSelectWrap = document.getElementById('compareSelectWrap');
    this._btnNewScenario    = document.getElementById('btnNewScenario');
    this._btnRevert         = document.getElementById('btnRevert');
    this._btnCompare        = document.getElementById('btnCompare');
    this._newScenarioWrap   = document.getElementById('newScenarioWrap');
    this._newScenarioName   = document.getElementById('newScenarioName');
    this._btnConfirmNew     = document.getElementById('btnConfirmNew');
    this._btnCancelNew      = document.getElementById('btnCancelNew');
    this._metaBar           = document.getElementById('metaBar');
    this._explainModal      = document.getElementById('explainModal');
    this._modalClose        = document.getElementById('modalClose');

    // ── Top-level state ───────────────────────────────────────────────────────
    /** @type {WebSocket|null} */
    this._ws = null;

    this._activeScenario  = '';
    this._compareMode     = false;
    this._compareScenario = '';
    this._dates           = [];
    this._inputCurves     = [];
    this._derivedCurves   = [];

    // ── Shared cache ──────────────────────────────────────────────────────────
    this._cache = new ScenarioCache();

    // ── Sub-managers ──────────────────────────────────────────────────────────
    this._grid = new GridManager(
      document.getElementById('gridHead'),
      document.getElementById('tbody'),
      document.getElementById('gridPanelHeader'),
      (curve, date, value) => this._sendEdit(curve, date, value),
    );

    this._chart = new ChartManager(
      document.getElementById('myChart'),
      document.getElementById('chipContainer'),
      this._cache,
    );

    this._bindEvents();
  }

  /** Start the application — opens the WebSocket connection. */
  start() {
    this._connect();
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  _connect() {
    this._setStatus('', 'Connecting...');
    this._ws           = new WebSocket(WS_URL);
    this._ws.onmessage = e => this._handleMessage(e);
    this._ws.onclose   = () => {
      this._overlay.classList.remove('hidden');
      this._setStatus('disconnected', 'Disconnected — retrying in 3s...');
      setTimeout(() => this._connect(), 3000);
    };
    this._ws.onerror = () => this._ws.close();
  }

  /** Send a JSON message to the server if the socket is open. */
  _send(obj) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  /**
   * Optimistically update the cache and chart before sending the edit,
   * so the UI feels instant even on slow connections.
   */
  _sendEdit(curve, date, rawValue) {
    const value = parseFloat(rawValue);
    this._cache.set(this._activeScenario, curve, date, value);
    this._chart.updatePoint(curve, date, value);
    this._setStatus('updating', 'Recalculating...');
    this._send({ type: 'edit', curve, date, value });
  }

  // ── Message routing ────────────────────────────────────────────────────────

  _handleMessage(event) {
    const msg = JSON.parse(event.data);
    if      (msg.type === 'init')            this._onInit(msg);
    else if (msg.type === 'updates')         this._onUpdates(msg);
    else if (msg.type === 'scenario_update') this._onScenarioUpdate(msg);
  }

  /**
   * Handle the "init" message — full dataset on first connection.
   * Bootstraps all managers and hides the loading overlay.
   */
  _onInit(msg) {
    this._inputCurves   = msg.input_curves;
    this._derivedCurves = msg.derived_curves;
    this._dates         = msg.dates;

    this._cache.populate(msg.active_scenario, msg.dates, msg.curves);

    this._grid.buildNormalHeader();
    this._grid.buildRows(msg.rows, msg.input_curves, msg.derived_curves);
    this._grid.setEditable(msg.active_scenario !== 'Base');

    this._chart.init(msg.dates, msg.curves);
    this._chart.buildChips(msg.available_curves);

    this._syncScenarioUI(msg.scenarios, msg.active_scenario);
    this._renderMetaBar(msg.meta ?? {});

    this._overlay.classList.add('hidden');
    this._setStatus('connected', 'Connected');
  }

  /**
   * Handle "updates" — partial cell propagation results after an edit.
   * Updates derived cells, chart, and cache; optionally refreshes compare view.
   */
  _onUpdates(msg) {
    for (const upd of msg.updates) {
      this._grid.updateDerivedCell(upd.curve, upd.date, upd.value);
      this._chart.updatePoint(upd.curve, upd.date, upd.value);
      this._cache.set(this._activeScenario, upd.curve, upd.date, upd.value);
    }

    if (msg.override) {
      this._grid.markOverride(msg.override.curve, msg.override.date, msg.override.is_overridden);
    }

    // Refresh compare grid to keep diff columns current
    if (this._compareMode) this._renderCompareGrid();

    this._setStatus('connected', 'Connected');
  }

  /**
   * Handle "scenario_update" — full dataset after switch/create/revert.
   * Re-populates cache, chart, and grid for the new active scenario.
   */
  _onScenarioUpdate(msg) {
    this._cache.populate(msg.active_scenario, this._dates, msg.curves);
    this._chart.setCurves(msg.curves);
    this._syncScenarioUI(msg.scenarios, msg.active_scenario);
    this._grid.setEditable(msg.active_scenario !== 'Base');

    if (this._compareMode) {
      this._grid.buildCompareHeader(this._derivedCurves, msg.active_scenario, this._compareScenario);
      this._renderCompareGrid();
    } else {
      this._grid.refreshRows(msg.rows, this._inputCurves, this._derivedCurves);
    }

    this._setStatus('connected', `Scenario: ${msg.active_scenario}`);
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  _setStatus(state, text) {
    this._statusDot.className    = 'status-dot ' + state;
    this._statusText.textContent = text;
  }

  /**
   * Sync all scenario-related UI elements after any scenario state change.
   * Updates both dropdowns, the panel header, and the Revert button state.
   *
   * @param {string[]} scenarios  — current scenario list from server
   * @param {string}   active     — newly active scenario name
   */
  _syncScenarioUI(scenarios, active) {
    this._activeScenario = active;

    this._populateSelect(this._scenarioSelect, scenarios, active);
    this._populateSelect(
      this._compareSelect,
      scenarios,
      this._compareScenario || scenarios.find(s => s !== active) || active,
    );

    this._grid.setPanelHeader(
      this._compareMode
        ? `Compare: ${active} vs ${this._compareScenario}`
        : `Data Grid \u2014 ${active}`,
    );
    this._btnRevert.disabled = (active === 'Base');

    // Keep chart compare state in sync
    this._chart.activeScenario = active;
  }

  _populateSelect(select, scenarios, active) {
    select.innerHTML = '';
    for (const name of scenarios) {
      const opt = document.createElement('option');
      opt.value       = name;
      opt.textContent = name;
      opt.selected    = name === active;
      select.appendChild(opt);
    }
  }

  /** Render the compare grid using the current active and compare scenarios. */
  _renderCompareGrid() {
    this._grid.renderCompareRows(
      this._dates,
      this._derivedCurves,
      this._cache.get(this._activeScenario),
      this._cache.get(this._compareScenario),
    );
  }

  /**
   * Render the asset/FX/date-range meta bar in the grid panel header.
   * Also updates the ticker placeholder in the data dictionary modal.
   *
   * @param {Object} meta — from the server init payload
   */
  _renderMetaBar(meta) {
    if (!meta?.price_ticker) { this._metaBar.textContent = ''; return; }

    const first = this._dates[0] ?? '';
    const last  = this._dates[this._dates.length - 1] ?? '';

    // Also update the modal ticker placeholder
    const modalTicker = document.getElementById('modalTicker');
    if (modalTicker) modalTicker.textContent = meta.price_ticker;

    this._metaBar.innerHTML = '';
    const items = [
      { label: 'Asset', value: meta.price_ticker },
      { label: 'FX',    value: meta.fx_ticker },
      { label: 'Range', value: (first && last) ? `${first} \u2192 ${last}` : '\u2014' },
    ];

    items.forEach((item, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'meta-divider';
        this._metaBar.appendChild(sep);
      }
      const w = document.createElement('span');
      w.className = 'meta-item';
      w.innerHTML = `<span class="meta-item-label">${item.label}</span>
                     <span class="meta-item-value">${item.value}</span>`;
      this._metaBar.appendChild(w);
    });
  }

  // ── Event bindings ─────────────────────────────────────────────────────────

  /**
   * Attach all UI event listeners. Called once in the constructor.
   * Kept in one place to make the full event surface easy to scan.
   */
  _bindEvents() {
    // ── Scenario select ───────────────────────────────────────────────────────
    this._scenarioSelect.addEventListener('change', () =>
      this._send({ type: 'switch_scenario', name: this._scenarioSelect.value })
    );

    // ── Compare scenario select ───────────────────────────────────────────────
    this._compareSelect.addEventListener('change', () => {
      this._compareScenario       = this._compareSelect.value;
      this._chart.compareScenario = this._compareScenario;
      this._grid.setPanelHeader(`Compare: ${this._activeScenario} vs ${this._compareScenario}`);
      this._renderCompareGrid();
      this._chart._redraw();
    });

    // ── New scenario flow ─────────────────────────────────────────────────────
    this._btnNewScenario.addEventListener('click', () => {
      this._newScenarioWrap.classList.add('visible');
      this._newScenarioName.focus();
    });
    this._btnCancelNew.addEventListener('click', () => {
      this._newScenarioWrap.classList.remove('visible');
      this._newScenarioName.value = '';
    });
    this._btnConfirmNew.addEventListener('click',  () => this._confirmNewScenario());
    this._newScenarioName.addEventListener('keydown', e => {
      if (e.key === 'Enter')  this._confirmNewScenario();
      if (e.key === 'Escape') this._btnCancelNew.click();
    });

    // ── Revert ────────────────────────────────────────────────────────────────
    this._btnRevert.addEventListener('click', () => {
      if (this._activeScenario !== 'Base') this._send({ type: 'revert' });
    });

    // ── Compare mode toggle ───────────────────────────────────────────────────
    this._btnCompare.addEventListener('click', () => {
      this._compareMode        = !this._compareMode;
      this._chart.compareMode  = this._compareMode;
      this._btnCompare.classList.toggle('active', this._compareMode);
      this._compareSelectWrap.classList.toggle('visible', this._compareMode);

      if (this._compareMode) {
        // Entering compare mode — build compare header and render diff grid
        this._compareScenario       = this._compareSelect.value;
        this._chart.compareScenario = this._compareScenario;
        this._grid.setPanelHeader(`Compare: ${this._activeScenario} vs ${this._compareScenario}`);
        this._grid.buildCompareHeader(this._derivedCurves, this._activeScenario, this._compareScenario);
        this._renderCompareGrid();
      } else {
        // Leaving compare mode — restore normal header and rebuild from cache
        this._grid.setPanelHeader(`Data Grid \u2014 ${this._activeScenario}`);
        this._grid.buildNormalHeader();
        this._grid.buildRows(
          this._rowsFromCache(),
          this._inputCurves,
          this._derivedCurves,
        );
        this._grid.setEditable(this._activeScenario !== 'Base');
      }

      this._chart._redraw();
    });

    // ── Modal ─────────────────────────────────────────────────────────────────
    this._modalClose.addEventListener('click', () =>
      this._explainModal.classList.remove('visible')
    );
    this._explainModal.addEventListener('click', e => {
      if (e.target === this._explainModal) this._explainModal.classList.remove('visible');
    });
  }

  /** Confirm and send a create_scenario message. */
  _confirmNewScenario() {
    const name = this._newScenarioName.value.trim();
    if (!name) return;
    this._send({ type: 'create_scenario', name });
    this._newScenarioName.value = '';
    this._newScenarioWrap.classList.remove('visible');
  }

  /**
   * Reconstruct a rows array from the scenario cache for the active scenario.
   * Used when exiting compare mode to rebuild the normal grid without a
   * server round-trip.
   *
   * @returns {Object[]}
   */
  _rowsFromCache() {
    return this._dates.map(date => {
      const row = { date, overrides: {} };
      for (const c of [...this._inputCurves, ...this._derivedCurves]) {
        row[c] = this._cache.getValue(this._activeScenario, c, date) ?? 0;
      }
      return row;
    });
  }
}


// =============================================================================
// Bootstrap
// =============================================================================

const app = new App();
app.start();
