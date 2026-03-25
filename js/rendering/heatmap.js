(function() {
'use strict';
/**
 * Heatmap Rendering Module
 * 
 * Renders the Glasgow Index heatmap visualization on a canvas element.
 * Extracted from glasgow_core.js — this module handles all DOM/canvas operations.
 * 
 * Dependencies:
 *   - Expects analysis results from GlasgowAnalyzer.process()
 *   - Requires a canvas element with id "heatmapCanvas"
 */

// --- Color constants ---
const STD_COLOURS = ["#ffffff", "#bab8e0", "#aca9eb", "#8680ed", "#090387"];
const OVERALL_COLOURS = ["#ffffff", "#faacb7", "#f7798a", "#f7546a", "#ed0c2a"];
const BLACK_COLOUR = "#000000";

/**
 * Determine the colour from a sub-component index value (0-1 range).
 * Higher values = more severe = darker color.
 */
window.getColourFromValue = function getColourFromValue(indexValue) {
    if (indexValue === false || indexValue === 0) return STD_COLOURS[0];
    if (indexValue <= 0.25) return STD_COLOURS[1];
    if (indexValue <= 0.5) return STD_COLOURS[2];
    if (indexValue <= 0.75) return STD_COLOURS[3];
    return STD_COLOURS[4];
}

/**
 * Determine the colour from the overall index value (0-9 range).
 */
window.getOverallColourFromValue = function getOverallColourFromValue(indexValue) {
    if (indexValue === 0) return OVERALL_COLOURS[0];
    if (indexValue <= 2) return OVERALL_COLOURS[1];
    if (indexValue <= 4) return OVERALL_COLOURS[2];
    if (indexValue <= 6) return OVERALL_COLOURS[3];
    return OVERALL_COLOURS[4];
}

/**
 * Format hour in 12-hour AM/PM format.
 */
function formatHourAMPM(hour24) {
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 || 12;
    return `${hour12}${suffix}`;
}

/**
 * Render the full heatmap visualization for a session's analysis results.
 * 
 * @param {HTMLCanvasElement} canvas - The canvas element to render on
 * @param {Object} analysisResult - Output from GlasgowAnalyzer.process()
 * @param {Object} [options] - Display options
 */
window.renderHeatmap = function renderHeatmap(canvas, analysisResult, options = {}) {
    if (!canvas || !analysisResult || !analysisResult.inspirations) {
        console.warn('renderHeatmap: Missing required data');
        return;
    }

    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.parentElement?.clientWidth || 800;
    const height = canvas.height = options.height || 400;

    ctx.clearRect(0, 0, width, height);

    const inspirations = analysisResult.inspirations;
    if (inspirations.length === 0) return;

    // Calculate cells - each cell represents a group of inspirations
    const cellCount = Math.min(inspirations.length, width);
    const inspirPerCell = Math.max(1, Math.floor(inspirations.length / cellCount));
    const cellWidth = width / cellCount;

    // Row layout
    const rowHeight = 30;
    const labels = ['Skew', 'Flat', 'Top', 'Spike', 'Multi', 'Pause', 'Rate', 'Brth', 'Amp', 'All'];
    const labelWidth = 40;
    const plotLeft = labelWidth;
    const plotWidth = width - labelWidth;

    // Draw labels
    ctx.font = '10px monospace';
    ctx.fillStyle = '#666';
    for (let r = 0; r < labels.length; r++) {
        ctx.fillText(labels[r], 2, 50 + r * rowHeight + 18);
    }

    // Draw cells
    const components = ['skew', 'flatTop', 'topHeavy', 'spike', 'multiPeak', 'noPause', 'inspirRate', 'multiBreath', 'ampVar'];

    for (let c = 0; c < cellCount; c++) {
        const startIdx = c * inspirPerCell;
        const endIdx = Math.min(startIdx + inspirPerCell, inspirations.length);

        // Average the indices for this cell
        const cellValues = {};
        let overallSum = 0;
        let count = 0;

        for (let i = startIdx; i < endIdx; i++) {
            if (!inspirations[i].indices) continue;
            for (const comp of components) {
                cellValues[comp] = (cellValues[comp] || 0) + (inspirations[i].indices[comp] ? 1 : 0);
            }
            overallSum += inspirations[i].indices.overall || 0;
            count++;
        }

        if (count === 0) continue;

        const x = plotLeft + c * (plotWidth / cellCount);
        const w = plotWidth / cellCount;

        // Draw each component row
        for (let r = 0; r < components.length; r++) {
            const ratio = (cellValues[components[r]] || 0) / count;
            ctx.fillStyle = getColourFromValue(ratio);
            ctx.fillRect(x, 50 + r * rowHeight, w, rowHeight - 2);
        }

        // Overall row
        const avgOverall = overallSum / count;
        ctx.fillStyle = getOverallColourFromValue(avgOverall);
        ctx.fillRect(x, 50 + 9 * rowHeight, w, rowHeight - 2);
    }

    // Draw grid lines
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 0.5;
    for (let r = 0; r <= labels.length; r++) {
        ctx.beginPath();
        ctx.moveTo(plotLeft, 50 + r * rowHeight);
        ctx.lineTo(width, 50 + r * rowHeight);
        ctx.stroke();
    }

    // Title
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#333';
    ctx.fillText(`Glasgow Index: ${analysisResult.overall} — ${inspirations.length} breaths analyzed`, plotLeft, 25);
}

/**
 * Render a detailed flow graph for a specific time segment.
 * 
 * @param {HTMLCanvasElement} canvas - The canvas to render on
 * @param {Object} analysisResult - Output from GlasgowAnalyzer.process()
 * @param {number} startSample - Starting sample index
 * @param {number} sampleCount - Number of samples to show
 */
window.renderDetailFlow = function renderDetailFlow(canvas, analysisResult, startSample, sampleCount) {
    if (!canvas || !analysisResult || !analysisResult.dataArray) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const dataArray = analysisResult.dataArray;
    const idealArray = analysisResult.idealArray;
    const endSample = Math.min(startSample + sampleCount, dataArray.length);

    // Find y-axis range
    let yMin = 0, yMax = 0;
    for (let i = startSample; i < endSample; i++) {
        if (dataArray[i].y < yMin) yMin = dataArray[i].y;
        if (dataArray[i].y > yMax) yMax = dataArray[i].y;
    }
    yMax *= 1.1;
    yMin *= 1.1;

    const xScale = width / sampleCount;
    const yScale = height / (yMax - yMin);

    // Draw zero line
    ctx.strokeStyle = '#ccc';
    ctx.beginPath();
    const zeroY = height - (-yMin) * yScale;
    ctx.moveTo(0, zeroY);
    ctx.lineTo(width, zeroY);
    ctx.stroke();

    // Draw flow data
    ctx.strokeStyle = '#2196F3';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = startSample; i < endSample; i++) {
        const x = (i - startSample) * xScale;
        const y = height - (dataArray[i].y - yMin) * yScale;
        if (i === startSample) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw ideal flow overlay
    if (idealArray && idealArray.length > startSample) {
        ctx.strokeStyle = '#4CAF50';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = startSample; i < endSample && i < idealArray.length; i++) {
            const x = (i - startSample) * xScale;
            const y = height - (idealArray[i].y - yMin) * yScale;
            if (i === startSample) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
}

})();
