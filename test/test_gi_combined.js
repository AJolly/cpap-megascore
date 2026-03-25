/**
 * test_gi_combined.js — Combined Night GI Regression Tests
 * 
 * Tests weighted-average GI scores for multi-session nights.
 * The Glasgow Index tool combines sessions by duration-weighted averaging.
 * 
 * Usage:
 *   node test/test_gi_combined.js
 *   node test/test_gi_combined.js --verbose
 */

const path = require('path');
const { loadLegacyContext, parseEDFFromFile, runGIPipeline, resolveTestFile } = require('./helpers/load_legacy');

const TOLERANCE = 0.02;
const TEST_DATA_DIR = path.resolve(__dirname, '..', 'CPAP_TestData', 'Resp10');
const GI_COMPONENTS = ['skew', 'spike', 'flatTop', 'topHeavy', 'multiPeak', 'noPause', 'inspirRate', 'multiBreath', 'ampVar'];
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

const expected = require('./fixtures/gi_expected.json');

async function main() {
    console.log('GI Combined Night Tests');
    console.log('========================');

    let ctx;
    try {
        ctx = loadLegacyContext();
        console.log('✓ Legacy code loaded');
    } catch (e) {
        console.error('✗ Failed to load legacy code:', e.message);
        process.exit(1);
    }

    const results = { total: 0, passed: 0, failed: 0, errors: 0, failures: [] };

    for (const [nightDate, nightExpected] of Object.entries(expected.combined)) {
        results.total++;
        const files = nightExpected.files;

        try {
            // Run pipeline on each file and collect results
            const sessionResults = [];
            for (const filename of files) {
                const filePath = resolveTestFile(filename, TEST_DATA_DIR);
                if (!filePath) {
                    throw new Error(`File not found: ${filename}`);
                }
                const fileData = parseEDFFromFile(filePath, ctx);
                const pipeline = runGIPipeline(fileData, ctx);
                if (pipeline.error) throw new Error(pipeline.error);

                // Get duration from expected individual data
                const indiv = expected.individual[filename];
                const duration = indiv ? indiv.duration : 1;
                sessionResults.push({ cumIndex: pipeline.cumIndex, duration });
            }

            // Weighted average by duration
            const totalDuration = sessionResults.reduce((s, r) => s + r.duration, 0);
            const combined = {};
            for (const comp of GI_COMPONENTS) {
                combined[comp] = sessionResults.reduce(
                    (s, r) => s + r.cumIndex[comp] * r.duration, 0
                ) / totalDuration;
                combined[comp] = Math.round(combined[comp] * 100) / 100;
            }
            combined.overall = Math.round(100 * GI_COMPONENTS.reduce((s, c) => s + combined[c], 0)) / 100;

            // Compare
            let nightPass = true;
            const nightFailures = [];

            const overallDelta = Math.abs(combined.overall - nightExpected.overall);
            if (overallDelta > TOLERANCE) {
                nightPass = false;
                nightFailures.push(`Overall: ${combined.overall} (expected ${nightExpected.overall}, Δ=${overallDelta.toFixed(3)})`);
            }

            for (const comp of GI_COMPONENTS) {
                const delta = Math.abs(combined[comp] - nightExpected[comp]);
                if (delta > TOLERANCE) {
                    nightPass = false;
                    nightFailures.push(`${comp}: ${combined[comp]} (expected ${nightExpected[comp]}, Δ=${delta.toFixed(3)})`);
                }
            }

            if (nightPass) {
                results.passed++;
                console.log(`✓ ${nightDate}  [${files.length} files]  Overall: ${combined.overall} (expected ${nightExpected.overall})`);
            } else {
                results.failed++;
                console.log(`✗ ${nightDate}  [${files.length} files]`);
                for (const f of nightFailures) console.log(`    ${f}`);
                results.failures.push({ night: nightDate, issues: nightFailures });
            }

            if (verbose) {
                console.log(`    Sessions: ${files.join(', ')}`);
                console.log(`    Duration: ${totalDuration.toFixed(1)}h`);
            }

        } catch (e) {
            console.error(`✗ ${nightDate}  ERROR: ${e.message}`);
            results.errors++;
        }
    }

    console.log('');
    console.log(`Summary: ${results.passed}/${results.total} passed, ${results.failed} failed, ${results.errors} errors`);
    process.exit(results.failed > 0 || results.errors > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
