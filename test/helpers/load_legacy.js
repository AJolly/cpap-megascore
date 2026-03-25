/**
 * Legacy Code Loader
 * 
 * Loads the browser-global FlowLimits.js and EDFFile.js into a Node.js context
 * using the `vm` module. This lets us run the analysis pipeline without a browser.
 * 
 * Usage:
 *   const { loadLegacyContext, parseEDFFromFile } = require('./load_legacy');
 *   const ctx = loadLegacyContext();
 *   const fileData = parseEDFFromFile(filePath);
 *   const dataArray = ctx.formDataArray(fileData);
 *   ctx.findMins(dataArray);
 *   // ... etc.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

/**
 * Creates a sandboxed context with all the legacy FlowLimits.js and EDFFile.js
 * functions available as globals.
 * 
 * We need to provide browser stubs (console, document, window) since the code
 * may reference them, but the analysis functions themselves are pure computation.
 * 
 * @returns {Object} A vm context with all legacy analysis functions
 */
function loadLegacyContext() {
    const projectRoot = path.resolve(__dirname, '..', '..');

    // Create sandbox with browser stubs
    const sandbox = {
        console: console,
        Math: Math,
        Date: Date,
        Array: Array,
        String: String,
        parseInt: parseInt,
        parseFloat: parseFloat,
        isNaN: isNaN,
        Uint8Array: Uint8Array,
        DataView: DataView,
        ArrayBuffer: ArrayBuffer,
        // Stub browser globals that rendering code may reference
        document: {
            getElementById: () => ({
                width: 800,
                height: 400,
                getContext: () => ({
                    fillText: () => { },
                    fillRect: () => { },
                    strokeRect: () => { },
                    beginPath: () => { },
                    moveTo: () => { },
                    lineTo: () => { },
                    stroke: () => { },
                    fill: () => { },
                    clearRect: () => { },
                    font: '',
                    fillStyle: '',
                    strokeStyle: '',
                    lineWidth: 1
                }),
                offsetLeft: 0,
                offsetTop: 0,
                clientLeft: 0,
                clientTop: 0,
                addEventListener: () => { },
                removeEventListener: () => { }
            }),
            createElement: () => ({ style: {}, appendChild: () => { }, id: '' }),
            body: { appendChild: () => { } }
        },
        window: { innerWidth: 1200, heatmapGeometry: null }
    };

    // Make sandbox properties accessible as globals
    const context = vm.createContext(sandbox);

    // Load EDFFile.js first
    const edfCode = fs.readFileSync(path.join(projectRoot, 'legacy', 'EDFFile.js'), 'utf-8');
    vm.runInContext(edfCode, context, { filename: 'EDFFile.js' });

    // Load FlowLimits.js
    const flowCode = fs.readFileSync(path.join(projectRoot, 'legacy', 'FlowLimits.js'), 'utf-8');
    vm.runInContext(flowCode, context, { filename: 'FlowLimits.js' });

    return context;
}

/**
 * Parse an EDF file from disk using the legacy parseEDFFile function.
 * 
 * @param {string} filePath - Absolute path to the .edf file
 * @param {Object} context - The vm context from loadLegacyContext()
 * @returns {Object} The parsed EDF file data
 */
function parseEDFFromFile(filePath, context) {
    const buffer = fs.readFileSync(filePath);
    // Convert Node Buffer to ArrayBuffer
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

    // Run parseEDFFile in the legacy context
    const parseCode = `parseEDFFile(inputBuffer)`;
    context.inputBuffer = arrayBuffer;
    const fileData = vm.runInContext(parseCode, context);
    delete context.inputBuffer;

    return fileData;
}

/**
 * Run the full GI analysis pipeline on a parsed EDF file.
 * 
 * Pipeline: formDataArray → findMins → findInspirations → 
 *           calcCycleBasedIndicators → inspirationAmplitude → prepIndices
 * 
 * @param {Object} fileData - Parsed EDF data from parseEDFFromFile
 * @param {Object} context - The vm context from loadLegacyContext()
 * @returns {Object} { dataArray, results, cumIndex }
 */
function runGIPipeline(fileData, context) {
    // Find the flow signal
    let flowSignal = null;
    for (const signal of fileData.signals) {
        if (signal.label.toLowerCase().includes('flow')) {
            flowSignal = signal;
            break;
        }
    }

    if (!flowSignal) {
        return { error: 'No flow signal found', dataArray: null, results: null, cumIndex: null };
    }

    // Store fileData in context and run the pipeline
    context._fileData = fileData;
    context._flowSignal = flowSignal;

    const pipelineCode = `
        var flowSamples = Array.from(_flowSignal.physicalValues);
        var hz = Math.round(1000 / _flowSignal.sampleIntervalmS);

        // Load modern plugin into context
        var coreCode = require('fs').readFileSync('K:/cc/megascore/js/analysis/algorithms/glasgow_core.js', 'utf8');
        eval(coreCode); // Load to local scope
        
        var analyzer = (typeof window !== "undefined" && window.GlasgowAnalyzer) ? window.GlasgowAnalyzer : GlasgowAnalyzer;
        
        var modularOutput = analyzer.process(flowSamples, hz, {});
        
        if (modularOutput) {
            modularOutput._dataArrayLen = flowSamples.length;
            modularOutput._inspirationCount = modularOutput._rawResults.inspirations.length;
            modularOutput._idealArrayLen = modularOutput._rawResults.idealArray ? modularOutput._rawResults.idealArray.length : 0;
            modularOutput; // Return it natively
        } else {
            null;
        }
    `;

    const result = vm.runInContext(pipelineCode, context);

    // Clean up
    delete context._fileData;
    delete context._flowSignal;

    if (!result) return { error: 'Pipeline returned null', dataArray: null, results: null, cumIndex: null };

    return {
        dataArrayLen: result._dataArrayLen,
        inspirationCount: result._inspirationCount,
        cumIndex: result,
        idealArrayLen: result._idealArrayLen
    };

    return result;
}

/**
 * Resolve a BRP filename to its full path in the test data directory.
 * 
 * @param {string} filename - e.g. "20260218_021954_BRP" (without .edf)
 * @param {string} testDataDir - Path to CPAP_TestData/Resp10
 * @returns {string|null} Full path to the .edf file, or null if not found
 */
function resolveTestFile(filename, testDataDir) {
    const edfName = filename + '.edf';
    // Search in DATALOG subdirectories
    const datalogDir = path.join(testDataDir, 'DATALOG');
    if (!fs.existsSync(datalogDir)) return null;

    const years = fs.readdirSync(datalogDir);
    for (const year of years) {
        const yearDir = path.join(datalogDir, year);
        if (!fs.statSync(yearDir).isDirectory()) continue;
        const candidate = path.join(yearDir, edfName);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

module.exports = {
    loadLegacyContext,
    parseEDFFromFile,
    runGIPipeline,
    resolveTestFile
};
