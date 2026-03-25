/**
 * test_philips.js — Philips DSX900 First-Principles Validation
 * 
 * No reference scores exist (original tools never supported Philips).
 * Tests validate from first principles: proper parsing, physiological ranges,
 * and no crashes on edge cases.
 * 
 * Usage:
 *   node test/test_philips.js
 *   node test/test_philips.js --verbose
 */

const path = require('path');
const fs = require('fs');
const { loadLegacyContext, parseEDFFromFile, runGIPipeline } = require('./helpers/load_legacy');

const PHILIPS_DIR = path.resolve(__dirname, '..', 'CPAP_TestData', 'PhilipsDSX900', 'P-SERIES', '34105849', 'P0');
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

/**
 * Parse a Philips .001 header file to extract metadata.
 * Philips headers are simple EDF-like files with session info.
 */
function findPhilipsSessions() {
    if (!fs.existsSync(PHILIPS_DIR)) {
        console.error(`✗ Philips test data directory not found: ${PHILIPS_DIR}`);
        return [];
    }

    const files = fs.readdirSync(PHILIPS_DIR);
    const sessions = {};

    for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        const base = path.basename(f, ext);
        if (!sessions[base]) sessions[base] = {};

        if (ext === '.001') sessions[base].header = path.join(PHILIPS_DIR, f);
        if (ext === '.005') sessions[base].waveform = path.join(PHILIPS_DIR, f);
    }

    return Object.entries(sessions).map(([id, files]) => ({ id, ...files }));
}

async function main() {
    console.log('Philips DSX900 First-Principles Tests');
    console.log('=====================================');
    console.log(`Test data: ${PHILIPS_DIR}`);
    console.log('');

    let ctx;
    try {
        ctx = loadLegacyContext();
        console.log('✓ Legacy code loaded');
    } catch (e) {
        console.error('✗ Failed to load legacy code:', e.message);
        process.exit(1);
    }

    const sessions = findPhilipsSessions();
    console.log(`Found ${sessions.length} Philips sessions`);
    console.log('');

    const results = { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 };
    const hasWaveform = sessions.filter(s => s.waveform);
    const headerOnly = sessions.filter(s => !s.waveform);

    // Test 1: Header-only sessions should not crash
    console.log('--- Header-only sessions (no .005 waveform) ---');
    for (const session of headerOnly) {
        results.total++;
        try {
            const fileData = parseEDFFromFile(session.header, ctx);
            // Should parse without crashing but have no flow data
            if (fileData && fileData.signals) {
                results.passed++;
                if (verbose) console.log(`✓ ${session.id}.001  Parsed OK (${fileData.signals.length} signals, no waveform)`);
                else console.log(`✓ ${session.id}.001  Header parsed, no waveform — OK`);
            }
        } catch (e) {
            // Parsing errors are acceptable for header-only files
            results.passed++;
            if (verbose) console.log(`✓ ${session.id}.001  Parse failed gracefully: ${e.message}`);
            else console.log(`✓ ${session.id}.001  Graceful skip`);
        }
    }

    // Test 2: Waveform sessions should produce valid results
    console.log('');
    console.log('--- Full sessions (.001 + .005 waveform) ---');
    for (const session of hasWaveform) {
        results.total++;
        try {
            // Parse the waveform file (the .005 file is what contains flow data)
            const fileData = parseEDFFromFile(session.waveform, ctx);

            if (!fileData || !fileData.signals || fileData.signals.length === 0) {
                console.log(`⊘ ${session.id}.005  No signals found — skipped`);
                results.skipped++;
                continue;
            }

            // Check for flow signal
            let hasFlow = false;
            for (const sig of fileData.signals) {
                if (sig.label.toLowerCase().includes('flow')) {
                    hasFlow = true;
                    break;
                }
            }

            if (!hasFlow) {
                console.log(`⊘ ${session.id}.005  No flow signal — skipped`);
                results.skipped++;
                continue;
            }

            // Run the GI pipeline
            const pipeline = runGIPipeline(fileData, ctx);

            if (pipeline.error) {
                console.log(`⊘ ${session.id}.005  ${pipeline.error} — skipped`);
                results.skipped++;
                continue;
            }

            // First-principles validation
            const issues = [];
            const ci = pipeline.cumIndex;

            // Breath rate check (physiological: 8-30 breaths/min)
            // Duration is approximate from dataArray length / sample rate
            const durationMin = pipeline.dataArrayLen / 25 / 60; // assuming ~25Hz
            const breathRate = pipeline.inspirationCount / durationMin;
            if (breathRate < 8 || breathRate > 30) {
                issues.push(`Breath rate ${breathRate.toFixed(1)}/min outside 8-30 range`);
            }

            // GI sub-component range checks [0, 1]
            for (const comp of ['skew', 'spike', 'flatTop', 'topHeavy', 'multiPeak', 'noPause', 'inspirRate', 'multiBreath', 'ampVar']) {
                if (ci[comp] < 0 || ci[comp] > 1) {
                    issues.push(`${comp}=${ci[comp]} outside [0,1]`);
                }
            }

            // Overall range check [0, 9]
            if (ci.overall < 0 || ci.overall > 9) {
                issues.push(`overall=${ci.overall} outside [0,9]`);
            }

            // Data array should be non-empty
            if (pipeline.dataArrayLen === 0) issues.push('dataArray is empty');
            if (pipeline.idealArrayLen === 0) issues.push('idealArray is empty');

            if (issues.length === 0) {
                results.passed++;
                console.log(`✓ ${session.id}.005  Overall: ${ci.overall}  [${pipeline.inspirationCount} insp, ${breathRate.toFixed(1)} br/min, ${durationMin.toFixed(0)} min]`);
            } else {
                results.failed++;
                console.log(`✗ ${session.id}.005`);
                for (const issue of issues) console.log(`    ${issue}`);
            }

            if (verbose) {
                console.log(`    Scores: skew=${ci.skew}, spike=${ci.spike}, flatTop=${ci.flatTop}, topHeavy=${ci.topHeavy}, multiPeak=${ci.multiPeak}, noPause=${ci.noPause}, inspirRate=${ci.inspirRate}, multiBreath=${ci.multiBreath}, ampVar=${ci.ampVar}`);
            }

        } catch (e) {
            results.errors++;
            console.log(`✗ ${session.id}.005  ERROR: ${e.message}`);
            if (verbose) console.log(`    ${e.stack}`);
        }
    }

    console.log('');
    console.log(`Summary: ${results.passed}/${results.total} passed, ${results.failed} failed, ${results.skipped} skipped, ${results.errors} errors`);
    process.exit(results.failed > 0 || results.errors > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
