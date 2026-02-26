/**
 * Analysis Engine
 * 
 * A "plugin system" style engine. To make it super easy for people
 * to add their own custom math or flow analysis, they just register
 * a new analyzer here.
 */
import { Settings } from '../settings.js';

export const AnalysisEngine = {
    // The list of active plugins/tools
    analyzers: [],

    /**
     * Register a new custom tool.
     * @param {Object} analyzer 
     * @param {string} analyzer.id - Unique ID (e.g., 'custom_snore_check')
     * @param {string} analyzer.name - Display name
     * @param {function} analyzer.process - Function that takes (flowData, samplingRate, settings) and returns an object
     * @param {Array} analyzer.tableColumns - Array of { key, label } defining what data this analyzer outputs for the results table
     */
    register(analyzer) {
        if (!analyzer.id || !analyzer.process || !analyzer.tableColumns) {
            console.error("Failed to register analyzer: Missing required fields");
            return;
        }
        this.analyzers.push(analyzer);
        console.log(`Registered Analysis Engine Tool: ${analyzer.name}`);
    },

    /**
     * Runs all registered analyzers on a single session's data
     * @param {Array} flowData - Array of float values representing flow
     * @param {number} samplingRate - Hz
     * @returns {Object} A combined results map keyed by the analyzer ID
     */
    processSession(flowData, samplingRate) {
        const results = {};

        // Pass the live user-configurable settings to all tools
        const currentSettings = Settings.current;

        for (const tool of this.analyzers) {
            try {
                // Each tool returns a custom object of its findings
                results[tool.id] = tool.process(flowData, samplingRate, currentSettings);
            } catch (error) {
                console.error(`Error running analyzer [${tool.name}]:`, error);
                results[tool.id] = { error: error.message };
            }
        }
        return results;
    },

    /**
     * Get an array of all table columns contributed by all registered plugins.
     * Useful for building the TH row of the HTML table dynamically.
     */
    getAllTableColumns() {
        let columns = [];
        for (const tool of this.analyzers) {
            for (const col of tool.tableColumns) {
                columns.push({ ...col, toolId: tool.id });
            }
        }
        return columns;
    }
};
