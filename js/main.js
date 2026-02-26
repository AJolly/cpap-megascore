/**
 * Main application entrypoint.
 * Because we use type="module" in index.html, we can cleanly import classes.
 */
import { Settings } from './settings.js';
import { AnalysisEngine } from './analysis/engine.js';

// Import our example algorithm (and in the future, the Wobble and GI ports here)
import { MyCustomAnalyzer } from './analysis/algorithms/customExample.js';

// --- Global App State ---
const AppState = {
    activeTab: 'dashboard'
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {

    // 1. Register tools into the Engine
    AnalysisEngine.register(MyCustomAnalyzer);

    // We would register Wobble and Glasgow Index here in the next steps:
    // AnalysisEngine.register(WobblePlugin);
    // AnalysisEngine.register(GlasgowIndexPlugin);

    // 2. Setup the UI Navigation
    setupTabs();

    // 3. Setup Settings Modal
    setupSettingsMenu();

    // 4. Setup File Upload Handlers (we will implement parsing later)
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

    // Open Modal and render form
    btnOpen.onclick = function () {
        // Redraw form to pick up live values
        formContainer.innerHTML = Settings.generateFormHTML();

        // Attach event listeners for Save/Reset on the newly generated HTML
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
                formContainer.innerHTML = Settings.generateFormHTML(); // re-render
                document.getElementById('settingsModal').style.display = "none";
            }
        };

        modal.style.display = "flex";
    }

    // Close Modal
    btnClose.onclick = function () {
        modal.style.display = "none";
    }

    window.onclick = function (event) {
        if (event.target == modal) {
            modal.style.display = "none";
        }
    }
}

function buildDynamicTableHeaders() {
    // The engine knows what data all the tools are going to spit out.
    // We just ask it for the column headers!
    const headerRow = document.getElementById('resultsTableHeader');

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

function setupUploadHandlers() {
    // TODO: Phase 1 implementation - port edf parsing logic here
    document.getElementById('folderUpload').addEventListener('change', (e) => {
        alert("Folder upload triggered! Next step: port the SD Card scanner logic.");
    });

    document.getElementById('fileUpload').addEventListener('change', (e) => {
        alert("File upload triggered! Next step: wire up the EDF Parser + Engine processing.");
    });
}
