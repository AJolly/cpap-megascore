/**
 * Example Flow Analyzer Plugin
 * 
 * This file is meant to show how EASY it is for users or researchers 
 * to tweak and build their own CPAP data analysis without digging through 
 * exactly how the EDF file is parsed or how the HTML table renders.
 * 
 * To make a new tool:
 * 1) Copy this file
 * 2) Change the `id` and `name`
 * 3) Change the `tableColumns` to output your specific scores
 * 4) Write your math in `process(flowData, samplingRate, settings)`
 */

export const MyCustomAnalyzer = {
    // ------------------------------------
    // Configuration
    // ------------------------------------
    id: "custom_snore_check",
    name: "Acoustic / Snore Proxy (Example)",

    // What data should appear in the results table?
    tableColumns: [
        { key: "snoreScore", label: "Example Snore Score" },
        { key: "peakFlow", label: "Example Max Flow" }
    ],

    // ------------------------------------
    // The Execution Function
    // ------------------------------------
    /**
     * @param {Array<Number>} flowData - 1-dimensional array of the raw flow values
     * @param {Number} samplingRate - Samples per second (typically 25Hz for ResMed)
     * @param {Object} settings - The live parameters from the Settings UI panel
     * @returns {Object} An object holding the keys matching your `tableColumns`
     */
    process: function (flowData, samplingRate, settings) {
        // Step 1: Let's do some simple math. Get the absolute maximum flow.
        let maxFlow = 0;
        let totalVariation = 0;

        for (let i = 1; i < flowData.length; i++) {
            const val = Math.abs(flowData[i]);
            if (val > maxFlow) {
                maxFlow = val;
            }

            // Just a dummy metric: how much the flow jumps from point to point
            const delta = Math.abs(flowData[i] - flowData[i - 1]);
            totalVariation += delta;
        }

        // Just an absolutely made-up metric to proxy "snoring" vibration
        // Variation divided by length, scaled by settings 
        let averageVariation = totalVariation / flowData.length;
        let snoreScore = averageVariation * 100 * (settings.giGreyZoneUpper || 5); // Example of reading settings

        // Step 2: Return exactly what you promised in `tableColumns`
        return {
            snoreScore: snoreScore.toFixed(2),
            peakFlow: maxFlow.toFixed(2)
        };
    }
};
