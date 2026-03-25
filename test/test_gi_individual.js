/**
 * test_gi_individual.js — Per-file Glasgow Index Regression Tests
 * 
 * Parses each BRP EDF file individually through the *new modular* GlasgowAnalyzer
 * to verify it still evaluates 100% identically to the legacy pipeline scores.
 * 
 * Usage:
 *   node test/test_gi_individual.js
 * 
 * Reference: CPAP_TestData/Resp10/glasgow inc individual.txt
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const TEST_DATA_DIR = path.resolve(__dirname, '..', 'CPAP_TestData', 'Resp10');
const expected = require('./fixtures/gi_expected.json');

// We need EDFFile.js to parse the EDF, but NOT FlowLimits.js, so we construct
// a clean isolated VM context with just our new analyzer.
function loadCleanContext() {
    const sandbox = {
        console: console, Math: Math, Date: Date, Array: Array, String: String,
        parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN,
        Uint8Array: Uint8Array, DataView: DataView, ArrayBuffer: ArrayBuffer,
        window: {}, document: { getElementById: () => ({}), createElement: () => ({}) }
    };
    const context = vm.createContext(sandbox);

    // 1. Load Legacy EDF Parser 
    const edfCode = fs.readFileSync(path.join(__dirname, '..', 'legacy', 'EDFFile.js'), 'utf-8');
    vm.runInContext(edfCode, context);

    // 2. Load Modular GlasgowAnalyzer
    const giCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'analysis', 'algorithms', 'glasgow_core.js'), 'utf-8');
    vm.runInContext(giCode, context);

    return context;
}

function resolveTestFile(filename, testDataDir) {
    const edfName = filename + '.edf';
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

async function main() {
    console.log('GI Individual File Tests (using Modular GlasgowAnalyzer)');
    console.log('======================================================');
    console.log(`Test data: ${TEST_DATA_DIR}`);
    console.log(`Tolerance: ±0.02\n`);

    const ctx = loadCleanContext();
    const entries = Object.entries(expected.individual);
    let passed = 0;
    let failed = 0;
    let total = 0;

    for (const [filename, expectedScores] of entries) {
        if (expectedScores.overall === null) continue;
        total++;
        const filePath = resolveTestFile(filename, TEST_DATA_DIR);
        if (!filePath) {
            console.error(`[FAIL] ${filename}.edf - File not found`);
            failed++;
            continue;
        }

        try {
            const buffer = fs.readFileSync(filePath);
            const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

            ctx.inputBuffer = arrayBuffer;
            const fileData = vm.runInContext('parseEDFFile(inputBuffer)', ctx);

            let flowSignal = null;
            for (const signal of fileData.signals) {
                if (signal.label.toLowerCase().includes('flow')) {
                    flowSignal = signal; break;
                }
            }
            if (!flowSignal) throw new Error("No flow signal found");

            const flowSamples = Array.from(flowSignal.physicalValues);
            const hz = Math.round(1000 / flowSignal.sampleIntervalmS);

            ctx._flowSamples = flowSamples;
            ctx._hz = hz;
            const result = vm.runInContext('(typeof window !== "undefined" ? window.GlasgowAnalyzer : GlasgowAnalyzer).process(_flowSamples, _hz, {})', ctx);

            const delta = Math.abs(result.overall - expectedScores.overall);
            if (delta <= 0.02) {
                console.log(`[PASS] ${filename}.edf  Overall: ${result.overall} (expected ${expectedScores.overall})`);
                passed++;
            } else {
                console.log(`[FAIL] ${filename}.edf  Overall: ${result.overall} (expected ${expectedScores.overall})`);
                failed++;
            }
        } catch (e) {
            console.error(`[ERR]  ${filename}.edf: ${e.message}`);
            failed++;
        }
    }
    console.log(`\nResults: ${passed}/${total} passed`);
    process.exit(failed > 0 ? 1 : 0);
}

main();
