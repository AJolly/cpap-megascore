(function() {
'use strict';
/**
 * Analysis Engine
 * 
 * A plugin system for analysis algorithms. Analyzers register themselves
 * and the engine runs them all against session data.
 * 
 * Features:
 * - Plugin registration with { id, name, process(), tableColumns }
 * - Column enable/disable (persisted to localStorage)
 * - Dynamic table column generation
 * - Weighted combined scoring across multi-session nights
 * 
 * To add a new analyzer, create a module that exports an object with:
 *   id: string          — Unique identifier
 *   name: string        — Display name in UI
 *   process(flowData, samplingRate, settings) → Object  — Analysis function
 *   tableColumns: [{ key, label, higherIsBad? }]        — Output column definitions
 * 
 * Then register it: AnalysisEngine.register(myAnalyzer)
 */
// Depends on: window.Settings (loaded from js/settings.js)

const COLUMN_STORAGE_KEY = 'megascore_enabled_columns';

window.AnalysisEngine = {
    analyzers: [],

    // Column enable/disable state (persisted to localStorage)
    _enabledColumns: null,

    /**
     * Register a new analysis tool/plugin.
     */
    register(analyzer) {
        if (!analyzer.id || !analyzer.process || !analyzer.tableColumns) {
            console.error("Failed to register analyzer: Missing required fields (id, process, tableColumns)");
            return;
        }
        // Prevent duplicate registration
        if (this.analyzers.some(a => a.id === analyzer.id)) {
            console.warn(`Analyzer '${analyzer.id}' already registered — skipping`);
            return;
        }
        this.analyzers.push(analyzer);
        console.log(`Registered: ${analyzer.name} (${analyzer.tableColumns.length} columns)`);
    },

    /**
     * Run all registered analyzers on a single session's flow data.
     * @param {Array<number>} flowData - Flow values (L/min)
     * @param {number} samplingRate - Hz
     * @returns {Object} Results keyed by analyzer ID
     */
    processSession(flowData, samplingRate) {
        const results = {};
        const currentSettings = Settings.current;

        for (const tool of this.analyzers) {
            try {
                results[tool.id] = tool.process(flowData, samplingRate, currentSettings);
            } catch (error) {
                console.error(`Error in analyzer [${tool.name}]:`, error);
                results[tool.id] = { error: error.message };
            }
        }
        return results;
    },

    /**
     * Get all table columns from all registered plugins.
     * Each column gets a `toolId` property for provenance.
     * @param {boolean} enabledOnly - If true, only return enabled columns
     * @returns {Array<{key, label, toolId, higherIsBad?}>}
     */
    getAllTableColumns(enabledOnly = false) {
        let columns = [];
        for (const tool of this.analyzers) {
            for (const col of tool.tableColumns) {
                const fullCol = { ...col, toolId: tool.id };
                if (enabledOnly) {
                    if (this.isColumnEnabled(tool.id, col.key)) {
                        columns.push(fullCol);
                    }
                } else {
                    columns.push(fullCol);
                }
            }
        }
        return columns;
    },

    // --- Column Enable/Disable (Scoring Registry) ---

    /**
     * Load enabled column state from localStorage.
     */
    _loadEnabledColumns() {
        if (this._enabledColumns !== null) return;
        try {
            const stored = localStorage.getItem(COLUMN_STORAGE_KEY);
            this._enabledColumns = stored ? JSON.parse(stored) : {};
        } catch (e) {
            this._enabledColumns = {};
        }
    },

    /**
     * Check if a specific column is enabled.
     * Defaults to true if not explicitly disabled.
     */
    isColumnEnabled(toolId, columnKey) {
        this._loadEnabledColumns();
        const key = `${toolId}.${columnKey}`;
        return this._enabledColumns[key] !== false; // default: enabled
    },

    /**
     * Toggle a column's enabled state.
     * @param {string} toolId
     * @param {string} columnKey
     * @param {boolean} enabled
     */
    toggleColumn(toolId, columnKey, enabled) {
        this._loadEnabledColumns();
        const key = `${toolId}.${columnKey}`;
        this._enabledColumns[key] = enabled;
        try {
            localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(this._enabledColumns));
        } catch (e) {
            console.warn('Failed to persist column toggle:', e);
        }
    },

    /**
     * Get all columns with their enabled state (for settings UI).
     * @returns {Array<{toolId, toolName, key, label, enabled}>}
     */
    getColumnToggleState() {
        const state = [];
        for (const tool of this.analyzers) {
            for (const col of tool.tableColumns) {
                state.push({
                    toolId: tool.id,
                    toolName: tool.name,
                    key: col.key,
                    label: col.label,
                    enabled: this.isColumnEnabled(tool.id, col.key)
                });
            }
        }
        return state;
    },

    /**
     * Compute a weighted combined score across multiple sessions.
     * Used for multi-session nights (duration-weighted average).
     * 
     * @param {Array<{results: Object, durationMin: number}>} sessions
     * @returns {Object} Combined results keyed by analyzer ID
     */
    combineSessionResults(sessions) {
        if (sessions.length === 0) return {};
        if (sessions.length === 1) return sessions[0].results;

        const combined = {};
        const totalDuration = sessions.reduce((s, sess) => s + (sess.durationMin || 1), 0);

        for (const tool of this.analyzers) {
            const toolResults = sessions
                .filter(s => s.results && s.results[tool.id])
                .map(s => ({ data: s.results[tool.id], weight: (s.durationMin || 1) / totalDuration }));

            if (toolResults.length === 0) continue;

            // Weighted average for numeric columns
            const avg = {};
            for (const col of tool.tableColumns) {
                const values = toolResults
                    .filter(r => typeof r.data[col.key] === 'number')
                    .map(r => ({ val: r.data[col.key], weight: r.weight }));

                if (values.length > 0) {
                    avg[col.key] = Math.round(100 *
                        values.reduce((s, v) => s + v.val * v.weight, 0)
                    ) / 100;
                }
            }
            combined[tool.id] = avg;
        }

        return combined;
    }
};

})();
