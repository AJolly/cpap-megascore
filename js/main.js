/**
 * Main application entrypoint.
 * Because we use type="module" in index.html, we can cleanly import classes.
 * 
 * Architecture:
 *   Parsers (edf.js) → AnalysisEngine (engine.js) → Rendering (heatmap.js, table)
 *   Plugins register via AnalysisEngine.register() and are auto-discovered for UI.
 */
import { Settings } from './settings.js';
import { AnalysisEngine } from './analysis/engine.js';
import { EDFParser } from './parsers/edf.js';

// Import analysis plugins
import { GlasgowAnalyzer } from './analysis/algorithms/glasgow_core.js';
import { WobbleAnalyzer } from './analysis/algorithms/wobble.js';

// Import rendering
import { renderHeatmap } from './rendering/heatmap.js';

// --- Global App State ---
const AppState = {
    activeTab: 'dashboard',
    sessions: []  // Processed session results
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {

    // 1. Register analysis plugins
    AnalysisEngine.register(GlasgowAnalyzer);
    AnalysisEngine.register(WobbleAnalyzer);

    // 2. Setup the UI Navigation
    setupTabs();

    // 3. Setup Settings Modal
    setupSettingsMenu();

    // 4. Setup File Upload Handlers
    setupUploadHandlers();

    // Build initial table headers based on what plugins exist
    buildDynamicTableHeaders();
});

function setupTabs() {
    const navLinks = document.querySelectorAll('.tab-nav a');
    const tabPanes = document.querySelectorAll('.tab-pane');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();

            // Remove active classes
            navLinks.forEach(l => l.classList.remove('active'));
            tabPanes.forEach(t => t.classList.remove('active'));

            // Add active class to clicked tab
            link.classList.add('active');
            const targetId = link.getAttribute('data-tab');
            document.getElementById(`tab-${targetId}`).classList.add('active');
            AppState.activeTab = targetId;
        });
    });
}

function setupSettingsMenu() {
    const modal = document.getElementById('settingsModal');
    const btnOpen = document.getElementById('navSettingsBtn');
    const btnClose = document.getElementById('closeSettingsBtn');
    const formContainer = document.getElementById('settingsForm');

    if (!btnOpen || !modal) return; // Guard for missing elements

    // Open Modal and render form
    btnOpen.onclick = function () {
        formContainer.innerHTML = Settings.generateFormHTML();

        document.getElementById('btnSaveSettings').onclick = () => {
            const inputs = formContainer.querySelectorAll('input.setting-input[data-key]');
            inputs.forEach(input => {
                Settings.update(input.getAttribute('data-key'), input.value);
            });
            modal.style.display = "none";
            alert("Settings saved to localStorage. They will apply to future analyses.");
        };

        document.getElementById('btnResetSettings').onclick = () => {
            if (confirm("Are you sure you want to reset all algorithm parameters to default?")) {
                Settings.reset();
                formContainer.innerHTML = Settings.generateFormHTML();
                modal.style.display = "none";
            }
        };

        modal.style.display = "flex";
    }

    if (btnClose) {
        btnClose.onclick = function () {
            modal.style.display = "none";
        }
    }

    window.onclick = function (event) {
        if (event.target == modal) {
            modal.style.display = "none";
        }
    }
}

function buildDynamicTableHeaders() {
    const headerRow = document.getElementById('resultsTableHeader');
    if (!headerRow) return;

    // Standard static columns
    let html = `
        <th>File Name</th>
        <th>Start Time</th>
        <th>Duration</th>
    `;

    // Dynamic columns from plugins
    const allColumns = AnalysisEngine.getAllTableColumns();
    allColumns.forEach(c => {
        html += `<th title="Provided by tool: ${c.toolId}">${c.label}</th>`;
    });

    headerRow.innerHTML = html;
}

/**
 * Process a single EDF file through all registered analysis plugins.
 * 
 * @param {File} file - The File object from the upload input
 * @returns {Promise<Object>} Session result with metadata + analysis scores
 */
async function processEDFFile(file) {
    const buffer = await file.arrayBuffer();
    const parsed = EDFParser.parse(buffer);

    if (!parsed.flowSignal) {
        console.warn(`${file.name}: No flow signal found — skipping analysis`);
        return {
            filename: file.name,
            metadata: parsed.metadata,
            error: 'No flow signal',
            results: null
        };
    }

    // Run all registered analyzers
    const flowData = parsed.flowSignal.physicalValues;
    const samplingRate = parsed.flowSignal.samplingRate;
    const analysisResults = AnalysisEngine.processSession(flowData, samplingRate);

    return {
        filename: file.name,
        metadata: parsed.metadata,
        flowSignal: parsed.flowSignal,
        results: analysisResults,
        startTime: parsed.metadata.recordingDate,
        durationMin: parsed.metadata.totalDurationMinutes
    };
}

/**
 * Add a session result row to the results table.
 */
function addResultRow(session) {
    const tbody = document.getElementById('resultsTableBody');
    if (!tbody) return;

    const row = document.createElement('tr');
    const allColumns = AnalysisEngine.getAllTableColumns();

    // Static columns
    let html = `
        <td>${session.filename}</td>
        <td>${session.startTime || 'N/A'}</td>
        <td>${session.durationMin ? session.durationMin.toFixed(1) + ' min' : 'N/A'}</td>
    `;

    // Dynamic columns from each plugin
    for (const col of allColumns) {
        const toolResult = session.results ? session.results[col.toolId] : null;
        let value = 'N/A';

        if (toolResult && toolResult[col.key] !== undefined) {
            const raw = toolResult[col.key];
            value = typeof raw === 'number' ? raw.toFixed(2) : raw;
        } else if (session.error) {
            value = '—';
        }

        html += `<td>${value}</td>`;
    }

    row.innerHTML = html;
    tbody.appendChild(row);
}

function setupUploadHandlers() {
    const fileUpload = document.getElementById('fileUpload');
    const folderUpload = document.getElementById('folderUpload');

    if (fileUpload) {
        fileUpload.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files).filter(f =>
                f.name.toLowerCase().endsWith('.edf')
            );

            if (files.length === 0) {
                alert('No EDF files found in selection.');
                return;
            }

            console.log(`Processing ${files.length} EDF files...`);

            for (const file of files) {
                try {
                    const session = await processEDFFile(file);
                    AppState.sessions.push(session);
                    addResultRow(session);

                    // If Glasgow data exists, render heatmap for the last file
                    if (session.results && session.results.glasgow_index) {
                        const canvas = document.getElementById('heatmapCanvas');
                        if (canvas) {
                            renderHeatmap(canvas, session.results.glasgow_index);
                        }
                    }

                    console.log(`✓ ${file.name} processed`);
                } catch (err) {
                    console.error(`✗ ${file.name}: ${err.message}`);
                }
            }
        });
    }

    if (folderUpload) {
        folderUpload.addEventListener('change', async (e) => {
            // For folder uploads, filter for BRP EDF files (ResMed flow waveforms)
            const files = Array.from(e.target.files).filter(f =>
                f.name.toLowerCase().endsWith('.edf') &&
                f.name.toUpperCase().includes('BRP')
            );

            if (files.length === 0) {
                alert('No BRP EDF files found. For ResMed data, look in DATALOG folders.');
                return;
            }

            console.log(`Processing ${files.length} BRP files from SD card...`);

            for (const file of files) {
                try {
                    const session = await processEDFFile(file);
                    AppState.sessions.push(session);
                    addResultRow(session);
                    console.log(`✓ ${file.name}`);
                } catch (err) {
                    console.error(`✗ ${file.name}: ${err.message}`);
                }
            }
        });
    }
}
