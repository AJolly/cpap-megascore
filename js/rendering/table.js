(function() {
'use strict';
/**
 * Table Rendering Module
 * 
 * Renders results tables with dynamic columns from registered analysis plugins.
 * Handles gradient shading, row expansion for sub-sessions, and CPAP column toggling.
 * 
 * Extracted from megascore.html to enable modular rendering.
 */

/**
 * Gradient color calculation for score cells.
 * Maps a value in [0, maxVal] to a color from green (good) to red (bad).
 * 
 * @param {number} value - The score value
 * @param {number} maxVal - Maximum expected value (defines the "worst" end)
 * @param {boolean} higherIsBad - If true, higher values → red. If false, higher → green.
 * @returns {string} CSS background color string
 */
window.getGradientColor = function getGradientColor(value, min, max) {
    if (min === max) return '#ffffff';
    let ratio = (value - min) / (max - min);
    if (ratio < 0) ratio = 0;
    if (ratio > 1) ratio = 1;
    let r, g, b;
    if (ratio < 0.5) {
        const subRatio = ratio * 2;
        r = Math.round(144 + (255 - 144) * subRatio);
        g = Math.round(238 + (255 - 238) * subRatio);
        b = Math.round(144 + (100 - 144) * subRatio);
    } else {
        const subRatio = (ratio - 0.5) * 2;
        r = 255;
        g = Math.round(255 + (99 - 255) * subRatio);
        b = Math.round(100 + (71 - 100) * subRatio);
    }
    return 'rgb(' + r + ', ' + g + ', ' + b + ')';
}

/**
 * Get background style for a GI sub-component score (0-1 range).
 * @param {number} value
 * @returns {string} CSS background style
 */
window.getGIBgStyle = function getGIBgStyle(value) {
    return getGradientColor(value, 1, true);
}

/**
 * Get background style for a GI overall score (0-9 range).
 * @param {number} value
 * @returns {string} CSS background style
 */
window.getGIOverallBgStyle = function getGIOverallBgStyle(value) {
    return getGradientColor(value, 4, true); // cap gradient at 4 for visual range
}

/**
 * Get background style for Wobble scores.
 * @param {number} value
 * @param {string} key - Score key to determine appropriate scale
 * @returns {string} CSS background style
 */
window.getWobbleBgStyle = function getWobbleBgStyle(value, key) {
    const scales = {
        wobbleFL: { max: 100, higherIsBad: true },
        wobbleArousal: { max: 200, higherIsBad: true },
        wobbleRegularity: { max: 100, higherIsBad: false },
        wobblePeriodicity: { max: 100, higherIsBad: true }
    };
    const scale = scales[key] || { max: 100, higherIsBad: true };
    return getGradientColor(value, scale.max, scale.higherIsBad);
}

/**
 * Render a results table row for a single session.
 * 
 * @param {Object} session - Session data with results
 * @param {Array} columns - Column definitions from AnalysisEngine.getAllTableColumns()
 * @returns {HTMLTableRowElement}
 */
window.createResultRow = function createResultRow(session, columns) {
    const row = document.createElement('tr');

    // Static columns
    const cells = [
        session.filename || 'Unknown',
        session.startTime || 'N/A',
        session.durationMin ? `${session.durationMin.toFixed(1)} min` : 'N/A'
    ];

    // Dynamic columns from plugins
    for (const col of columns) {
        const toolResult = session.results ? session.results[col.toolId] : null;
        let value = 'N/A';
        let bgColor = '';

        if (toolResult && toolResult[col.key] !== undefined) {
            const raw = toolResult[col.key];
            value = typeof raw === 'number' ? raw.toFixed(2) : raw;

            // Apply gradient based on column metadata
            if (typeof raw === 'number') {
                if (col.toolId === 'glasgow_index') {
                    bgColor = col.key === 'overall'
                        ? getGIOverallBgStyle(raw)
                        : getGIBgStyle(raw);
                } else if (col.toolId === 'wobble_core') {
                    bgColor = getWobbleBgStyle(raw, col.key);
                }
            }
        }

        cells.push({ value, bgColor });
    }

    // Build HTML
    let html = '';
    for (let i = 0; i < 3; i++) {
        html += `<td>${cells[i]}</td>`;
    }
    for (let i = 3; i < cells.length; i++) {
        const cell = cells[i];
        const style = cell.bgColor ? ` style="background: ${cell.bgColor}"` : '';
        html += `<td${style}>${cell.value}</td>`;
    }

    row.innerHTML = html;
    return row;
}

/**
 * Build table header row from engine columns.
 * 
 * @param {Array} columns - From AnalysisEngine.getAllTableColumns()
 * @returns {string} HTML for <tr> content
 */
window.buildHeaderHTML = function buildHeaderHTML(columns) {
    let html = `
        <th>File Name</th>
        <th>Start Time</th>
        <th>Duration</th>
    `;

    for (const col of columns) {
        const title = `Provided by: ${col.toolId}`;
        html += `<th title="${title}">${col.label}</th>`;
    }

    return html;
}

})();
