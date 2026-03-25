(function() {
'use strict';
(function () {
    'use strict';
    /**
     * MegaScore Application — Main Orchestration Module
     * 
     * Replaces the inline <script> from megascore.html with organized code.
     * 
     * Dependencies (loaded via <script> tags in index.html before this file):
     *   - window.Settings           (js/settings.js)
     *   - window.AnalysisEngine     (js/analysis/engine.js)
     *   - window.EDFParser          (js/parsers/edf.js)
     *   - window.PhilipsParser      (js/parsers/philips.js)
     *   - window.ResMedParser       (js/parsers/resmed.js)
     *   - window.GlasgowAnalyzer    (js/analysis/algorithms/glasgow_core.js)
     *   - window.WobbleAnalyzer     (js/analysis/algorithms/wobble.js)
     *   - window.getGradientColor   (js/rendering/table.js)
     *   - window.renderHeatmap      (js/rendering/heatmap.js)
     * 
     * Also bridges to legacy globals:
     *   - EDFFile.js (parseEDFFile, etc.)
     *   - FlowLimits.js (formDataArray, findMins, etc.)
     *
     * NO BUILD STEP REQUIRED — just open index.html in a browser!
     */

    // ============ Global State ============
    let nightlyResults = [];
    let trendsChart = null;
    let componentsChart = null;
    let showSessionView = false;

    // ============ Initialization ============
    document.addEventListener('DOMContentLoaded', async () => {
        // Register analysis plugins
        AnalysisEngine.register(GlasgowAnalyzer);
        AnalysisEngine.register(WobbleAnalyzer);
        console.log('MegaScore initialized with', AnalysisEngine.analyzers.length, 'analysis plugins');

        // Setup UI handlers
        setupUploadHandlers();
        setupChartControls();
        setupSettingsModal();
        setupTableControls();

        // Check for cached sessions
        const count = await getCacheCount();
        if (count > 0) {
            document.getElementById('fileCount').innerHTML =
                `No files selected — <strong>${count} cached sessions</strong> available ` +
                `<button id="btnLoadCache" style="padding:2px 8px; font-size:11px; background:#28a745; color:white; border:none; border-radius:3px; cursor:pointer; margin-right:5px;">Load Cache</button>` +
                `<button id="btnClearCache" style="padding:2px 8px; font-size:11px; background:#dc3545; color:white; border:none; border-radius:3px; cursor:pointer;">Clear Cache</button>`;
            document.getElementById('btnLoadCache')?.addEventListener('click', loadCachedSessions);
            document.getElementById('btnClearCache')?.addEventListener('click', async () => {
                await clearResultCache();
                document.getElementById('fileCount').textContent = 'Cache cleared. No files selected.';
            });
        }
    });

    // ============ File Upload Handling ============
    function setupUploadHandlers() {
        const fileInput = document.getElementById('fileInput');
        const folderInput = document.getElementById('folderInput');
        const uploadSection = document.getElementById('uploadSection');

        if (fileInput) {
            fileInput.addEventListener('change', e => handleFiles(Array.from(e.target.files)));
        }
        if (folderInput) {
            folderInput.addEventListener('change', e => handleFiles(Array.from(e.target.files)));
        }

        // Drag and drop
        if (uploadSection) {
            uploadSection.addEventListener('dragover', e => {
                e.preventDefault();
                uploadSection.classList.add('drag-over');
            });
            uploadSection.addEventListener('dragleave', e => {
                e.preventDefault();
                uploadSection.classList.remove('drag-over');
            });
            uploadSection.addEventListener('drop', e => {
                e.preventDefault();
                uploadSection.classList.remove('drag-over');
                const items = e.dataTransfer.items;
                if (items) {
                    const promises = [];
                    for (let i = 0; i < items.length; i++) {
                        if (items[i].kind === 'file') {
                            const entry = items[i].webkitGetAsEntry();
                            if (entry) promises.push(processEntry(entry));
                        }
                    }
                    Promise.all(promises).then(results => {
                        const allFiles = results.flat();
                        if (allFiles.length > 0) handleFiles(allFiles);
                        else alert('No supported files found.');
                    });
                }
            });
        }
    }

    function processEntry(entry) {
        return new Promise(resolve => {
            if (entry.isFile) {
                entry.file(resolve);
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                reader.readEntries(entries => {
                    Promise.all(entries.map(processEntry)).then(r => resolve(r.flat()));
                });
            }
        });
    }

    /**
     * Main file handler — detects data format and routes to appropriate processor.
     */
    async function handleFiles(files) {
        const status = document.getElementById('processingStatus');
        const progress = document.getElementById('progressBar');
        const progressFill = document.getElementById('progressFill');

        // Auto-detect Philips
        if (PhilipsParser.isPhilipsDataSet(files)) {
            console.log('Detected Philips data set');
            await processPhilipsFiles(files, status, progress, progressFill);
            return;
        }

        // ResMed / generic EDF
        const brpFiles = files.filter(f => f.name.includes('_BRP.edf'));
        const allEdf = files.filter(f => f.name.endsWith('.edf'));

        if (brpFiles.length === 0 && allEdf.length === 0) {
            alert('No EDF files found. Please select folders containing ResMed data or individual BRP.edf files.');
            return;
        }

        // Use BRP files if available, otherwise all EDF
        const edfFiles = brpFiles.length > 0 ? brpFiles : allEdf;

        // Get additional files
        const strFiles = files.filter(f => f.name === 'STR.edf');
        const identFiles = files.filter(f => f.name === 'Identification.tgt' || f.name === 'Identification.json');

        document.getElementById('fileCount').textContent = `Processing ${edfFiles.length} EDF files...`;
        if (progress) progress.style.display = 'block';

        // Parse STR.edf for pressure settings
        let strSettings = {};
        if (strFiles.length > 0) {
            try {
                const strBuf = await strFiles[0].arrayBuffer();
                strSettings = ResMedParser.parseSTR(strBuf);
            } catch (e) {
                console.warn('Failed to parse STR.edf:', e);
            }
        }

        // Parse machine identification
        let machineType = 'ResMed';
        if (identFiles.length > 0) {
            try {
                const text = await identFiles[0].text();
                if (identFiles[0].name.endsWith('.json')) {
                    const data = JSON.parse(text);
                    machineType = data.ModelName || data.Product || 'ResMed';
                } else {
                    // .tgt format: extract product name
                    const match = text.match(/Product\s*=\s*(.+)/i);
                    if (match) machineType = match[1].trim();
                }
            } catch (e) { /* ignore */ }
        }

        // Process each EDF file
        for (let i = 0; i < edfFiles.length; i++) {
            const file = edfFiles[i];
            if (progressFill) progressFill.style.width = `${((i + 1) / edfFiles.length) * 100}%`;
            if (status) status.textContent = `Processing ${file.name} (${i + 1}/${edfFiles.length})...`;

            // Check cache first
            const cached = await getCachedResult(file.name);
            if (cached) {
                nightlyResults.push(cached);
                continue;
            }

            try {
                const result = await processEDFFile(file, machineType, strSettings);
                if (result) {
                    nightlyResults.push(result);
                    await setCachedResult(result);
                }
            } catch (e) {
                console.error(`Error processing ${file.name}:`, e);
            }
        }

        deduplicateResults();
        if (progress) progress.style.display = 'none';
        if (status) status.textContent = `Done — ${nightlyResults.length} sessions processed`;

        // Collapse upload section
        const uploadSection = document.getElementById('uploadSection');
        if (uploadSection) uploadSection.removeAttribute('open');

        displayResults();
    }

    /**
     * Process a single EDF file through the legacy GI pipeline + modular Wobble.
     */
    async function processEDFFile(file, machineType, strSettings) {
        const buffer = await file.arrayBuffer();

        // Use legacy parser (EDFFile.js global) for full compatibility
        const fileData = window.parseEDFFile ? window.parseEDFFile(buffer) : null;
        if (!fileData || !fileData.signals || fileData.signals.length === 0) return null;

        // Run legacy GI pipeline (FlowLimits.js globals)
        const dataArray = window.formDataArray(fileData);
        if (!dataArray || dataArray.length === 0) return null;

        // Duration and Wobble must be calculated BEFORE we release the raw parsed data
        const durationMin = (fileData.signals[0]?.physicalValues?.length || 0) / (fileData.signals[0]?.samplingRate || 25) / 60;
        const durationHrs = durationMin / 60;

        // Run modular Wobble analysis while physicalValues are still available
        let wobble = null;
        try {
            const flowSignal = fileData.signals.find(s => s.label.includes('Flow'));
            if (flowSignal) {
                const wobbleResult = WobbleAnalyzer.process(
                    flowSignal.physicalValues,
                    flowSignal.samplingRate || 25,
                    Settings.current
                );
                wobble = {
                    flScore: parseFloat(wobbleResult.wobbleFL),
                    regularityScore: parseFloat(wobbleResult.wobbleRegularity),
                    periodicityIndex: parseFloat(wobbleResult.wobblePeriodicity),
                    eai: parseFloat(wobbleResult.wobbleArousal),
                    composite: parseFloat(wobbleResult.wobbleFL) + parseFloat(wobbleResult.wobbleArousal) / 10 + parseFloat(wobbleResult.wobblePeriodicity) / 5
                };
            }
        } catch (e) {
            console.warn(`Wobble failed for ${file.name}:`, e.message);
        }

        // Fix 4: Release raw parsed data — no longer needed after formDataArray and Wobble
        fileData.signals.forEach(s => { s.digitalValues = null; s.physicalValues = null; });

        const results = { inspirations: [] };
        window.findMins(dataArray);
        window.findInspirations(dataArray, results);
        window.calcCycleBasedIndicators(dataArray, results);
        window.inspirationAmplitude(dataArray, results);
        window.prepIdealFlow(dataArray, results);
        window.results = results;   // FlowLimits.js flowBalance() reads global `results`
        window.flowBalance();
        delete window.results;
        const cumIndex = window.prepIndices(results);

        // Parse timestamps from filename
        const parsed = ResMedParser.parseFilename(file.name);
        const folderDate = ResMedParser.extractFolderDate(file) || (parsed.date ? parsed.date.replace(/-/g, '') : 'Unknown');

        // Determine sleep night date
        let sleepNightDate = folderDate;
        if (fileData.startDateTime) {
            sleepNightDate = ResMedParser.getSleepNightDate(fileData.startDateTime);
        }

        // Get STR settings for this date
        const dateSettings = strSettings[folderDate] || {};

        // wobble was calculated earlier, before nulling out physicalValues

        return {
            fileName: file.name,
            date: parsed.date || 'Unknown',
            time: parsed.time || 'Unknown',
            sleepNightDate,
            startDateTime: fileData.startDateTime || parsed.dateObj,
            endDateTime: fileData.startDateTime ? new Date(fileData.startDateTime.getTime() + durationHrs * 3600000) : null,
            duration: durationHrs,
            cumIndex,
            // Fix 1: Store compact y-values only (not full {x,y} objects) — ~95% memory savings
            flowYValues: dataArray.map(d => d.y),
            idealYValues: (results.idealArray || []).map(d => d.y),
            flowData: null,
            idealData: null,
            inspirations: results.inspirations,
            flowImbalance: results.flowImbalance,
            machineType,
            wobble,
            // Pressure settings from STR.edf
            ipap: dateSettings.ipap || 'N/A',
            epap: dateSettings.epap || 'N/A',
            minIPAP: 'N/A', maxIPAP: 'N/A',
            minEPAP: 'N/A', maxEPAP: 'N/A',
            ps: dateSettings.ps || 'N/A',
            papMode: decodePapMode(dateSettings.mode),
            riseTime: dateSettings.riseTime ?? 'N/A',
            trigger: dateSettings.trigger ?? 'N/A',
            cycle: 'N/A',
            easyBreathe: dateSettings.easyBreathe != null ?
                (dateSettings.easyBreathe > 0 ? 'On' : 'Off') : 'N/A'
        };
    }

    function decodePapMode(modeVal) {
        if (modeVal == null) return 'Unknown';
        const modes = {
            0: 'CPAP', 1: 'CPAP', 2: 'APAP', 3: 'AutoSet',
            4: 'AutoSet For Her', 5: 'VAuto', 6: 'S', 7: 'ST',
            8: 'PAC', 9: 'ASV', 10: 'ASVAuto', 11: 'iVAPS'
        };
        return modes[modeVal] || `Mode ${modeVal}`;
    }

    /**
     * Process Philips data files.
     */
    async function processPhilipsFiles(files, status, progress, progressFill) {
        const { sessions, propFile } = PhilipsParser.groupFiles(files);
        let machineInfo = { type: 'Philips DreamStation' };

        if (propFile) {
            try {
                const text = await propFile.text();
                machineInfo = PhilipsParser.parseProp(text);
            } catch (e) { /* ignore */ }
        }

        // Filter sessions with waveform data
        const waveformSessions = Array.from(sessions.entries()).filter(([, s]) => s.waveform);
        if (status) status.textContent = `Found ${waveformSessions.length} Philips waveform sessions`;
        if (progress) progress.style.display = 'block';

        for (let i = 0; i < waveformSessions.length; i++) {
            const [sessionId, sessionFiles] = waveformSessions[i];
            if (progressFill) progressFill.style.width = `${((i + 1) / waveformSessions.length) * 100}%`;
            if (status) status.textContent = `Processing Philips ${sessionId} (${i + 1}/${waveformSessions.length})...`;

            const cacheKey = `philips_${sessionId}.005`;
            const cached = await getCachedResult(cacheKey);
            if (cached) { nightlyResults.push(cached); continue; }

            try {
                const wavBuf = await sessionFiles.waveform.arrayBuffer();
                const waveResult = PhilipsParser.parseWaveform(wavBuf);
                if (!waveResult || waveResult.flowSamples.length === 0) continue;

                // Get timestamp from header
                let startDateTime = new Date();
                if (sessionFiles.header) {
                    const headerBuf = await sessionFiles.header.arrayBuffer();
                    const headerInfo = PhilipsParser.parseHeader(headerBuf);
                    if (headerInfo) startDateTime = headerInfo.startDateTime;
                }

                // Run GI via modular plugin
                const giResult = GlasgowAnalyzer.process(
                    waveResult.flowSamples,
                    waveResult.sampleRateHz,
                    Settings.current
                );

                // Run Wobble
                let wobble = null;
                try {
                    const wobbleResult = WobbleAnalyzer.process(
                        waveResult.flowSamples,
                        waveResult.sampleRateHz,
                        Settings.current
                    );
                    wobble = {
                        flScore: parseFloat(wobbleResult.wobbleFL),
                        regularityScore: parseFloat(wobbleResult.wobbleRegularity),
                        periodicityIndex: parseFloat(wobbleResult.wobblePeriodicity),
                        eai: parseFloat(wobbleResult.wobbleArousal),
                        composite: parseFloat(wobbleResult.wobbleFL) + parseFloat(wobbleResult.wobbleArousal) / 10 + parseFloat(wobbleResult.wobblePeriodicity) / 5
                    };
                } catch (e) { /* ignore */ }

                const durationHrs = waveResult.duration / 3600;
                const date = startDateTime.toISOString().split('T')[0];
                const time = `${String(startDateTime.getHours()).padStart(2, '0')}:${String(startDateTime.getMinutes()).padStart(2, '0')}:${String(startDateTime.getSeconds()).padStart(2, '0')}`;

                const result = {
                    fileName: cacheKey,
                    date, time,
                    sleepNightDate: ResMedParser.getSleepNightDate(startDateTime),
                    startDateTime, endDateTime: new Date(startDateTime.getTime() + durationHrs * 3600000),
                    duration: durationHrs,
                    cumIndex: {
                        overall: giResult.overall, skew: giResult.skew, spike: giResult.spike,
                        flatTop: giResult.flatTop, topHeavy: giResult.topHeavy, multiPeak: giResult.multiPeak,
                        noPause: giResult.noPause, inspirRate: giResult.inspirRate,
                        multiBreath: giResult.multiBreath, ampVar: giResult.ampVar
                    },
                    // Fix 1: Store compact y-values only
                    flowYValues: (giResult._rawResults.dataArray || []).map(d => d.y),
                    idealYValues: (giResult._rawResults.idealArray || []).map(d => d.y),
                    flowData: null,
                    idealData: null,
                    inspirations: giResult._rawResults.inspirations,
                    machineType: machineInfo.type,
                    wobble,
                    ipap: 'N/A', epap: 'N/A', minIPAP: 'N/A', maxIPAP: 'N/A',
                    minEPAP: 'N/A', maxEPAP: 'N/A', ps: 'N/A',
                    papMode: 'Unknown', riseTime: 'N/A', trigger: 'N/A',
                    cycle: 'N/A', easyBreathe: 'N/A'
                };

                nightlyResults.push(result);
                await setCachedResult(result);
            } catch (e) {
                console.error(`Error processing Philips session ${sessionId}:`, e);
            }
        }

        deduplicateResults();
        if (progress) progress.style.display = 'none';
        if (status) status.textContent = `Done — ${nightlyResults.length} Philips sessions processed`;
        const uploadSection = document.getElementById('uploadSection');
        if (uploadSection) uploadSection.removeAttribute('open');
        displayResults();
    }

    // ============ Results Display ============
    function displayResults() {
        if (nightlyResults.length === 0) return;
        document.getElementById('resultsSection').style.display = 'block';

        // Group into nights
        const nights = groupIntoNights(nightlyResults);

        // Update summary cards
        updateSummaryCards(nights);

        // Render table
        renderNightTable(nights);

        // Update charts
        updateTrendsChart(nights);
        updateComponentsChart(nights);

        // Populate night selector for heatmap
        populateNightSelector(nights);
    }

    function groupIntoNights(sessions) {
        const nightMap = {};
        sessions.forEach(s => {
            const key = s.sleepNightDate || s.date;
            if (!nightMap[key]) nightMap[key] = [];
            nightMap[key].push(s);
        });

        // Classify and aggregate
        const nights = Object.entries(nightMap).map(([date, sessions]) => {
            classifySessionsForNight(sessions);
            return recalculateNightFromSessions(date, sessions);
        });

        // Sort by date descending (newest first)
        nights.sort((a, b) => b.date.localeCompare(a.date));
        return nights;
    }

    function updateSummaryCards(nights) {
        const validNights = nights.filter(n => n.duration >= 1);
        document.getElementById('nightsCount').textContent = validNights.length;

        if (validNights.length === 0) return;
        const overalls = validNights.map(n => n.weightedGI.overall);
        const avg = overalls.reduce((s, v) => s + v, 0) / overalls.length;
        document.getElementById('avgOverallGI').textContent = avg.toFixed(2);
        document.getElementById('bestNightGI').textContent = Math.min(...overalls).toFixed(2);
        document.getElementById('worstNightGI').textContent = Math.max(...overalls).toFixed(2);
    }

    // ============ Night Table ============
    function renderNightTable(nights) {
        const tbody = document.getElementById('resultsTableBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        // Compute min/max stats for data-relative gradient (like megascore.html)
        const giComps = ['overall', 'skew', 'spike', 'flatTop', 'topHeavy', 'multiPeak', 'noPause', 'inspirRate', 'multiBreath', 'ampVar'];
        const wobbleComps = ['composite', 'flScore', 'regularityScore', 'periodicityIndex', 'eai'];
        _giStats = {};
        _wobbleStats = {};
        giComps.forEach(comp => {
            const vals = nights.map(n => n.weightedGI[comp]).filter(v => v !== undefined && !isNaN(v));
            if (vals.length > 0) _giStats[comp] = { min: Math.min(...vals), max: Math.max(...vals) };
        });
        wobbleComps.forEach(comp => {
            const vals = nights.map(n => n._wobbleAvg?.[comp]).filter(v => v !== undefined && v !== null && !isNaN(v));
            if (vals.length > 0) _wobbleStats[comp] = { min: Math.min(...vals), max: Math.max(...vals) };
        });

        nights.forEach(night => {
            const row = document.createElement('tr');
            row.className = 'night-row-expandable';
            const gi = night.weightedGI;
            const wb = night._wobbleAvg || {};

            row.innerHTML = `
            <td><span class="expand-toggle">▶</span>${night.date}${night.sessions > 1 ? `<span class="session-count-pill">${night.sessions} sessions</span>` : ''}</td>
            <td>${night.startTime || 'N/A'}</td>
            <td>${night.endTime || 'N/A'}</td>
            <td>${night.duration.toFixed(1)}</td>
            <td>${night.machineType || 'Unknown'}</td>
            <td>${night.papMode || 'Unknown'}</td>
            <td style="background:${getGIOverallBg(gi.overall)}">${gi.overall.toFixed(2)}</td>
            <td style="background:${getGICompBg('skew', gi.skew)}">${gi.skew.toFixed(2)}</td>
            <td style="background:${getGICompBg('spike', gi.spike)}">${gi.spike.toFixed(2)}</td>
            <td style="background:${getGICompBg('flatTop', gi.flatTop)}">${gi.flatTop.toFixed(2)}</td>
            <td style="background:${getGICompBg('topHeavy', gi.topHeavy)}">${gi.topHeavy.toFixed(2)}</td>
            <td style="background:${getGICompBg('multiPeak', gi.multiPeak)}">${gi.multiPeak.toFixed(2)}</td>
            <td style="background:${getGICompBg('noPause', gi.noPause)}">${gi.noPause.toFixed(2)}</td>
            <td style="background:${getGICompBg('inspirRate', gi.inspirRate)}">${gi.inspirRate.toFixed(2)}</td>
            <td style="background:${getGICompBg('multiBreath', gi.multiBreath)}">${gi.multiBreath.toFixed(2)}</td>
            <td style="background:${getGICompBg('ampVar', gi.ampVar)}">${gi.ampVar.toFixed(2)}</td>
            <td style="${getWobbleCellBg('composite', wb.composite)}">${fmtWobble(wb.composite, 1)}</td>
            <td style="${getWobbleCellBg('flScore', wb.flScore)}">${fmtWobble(wb.flScore, 1)}</td>
            <td style="${getWobbleCellBg('regularityScore', wb.regularityScore)}">${fmtWobble(wb.regularityScore, 1)}</td>
            <td style="${getWobbleCellBg('periodicityIndex', wb.periodicityIndex)}">${fmtWobble(wb.periodicityIndex, 1)}</td>
            <td style="${getWobbleCellBg('eai', wb.eai)}">${fmtWobble(wb.eai, 1)}</td>
            <td class="cpap-col">${night.ipap}</td>
            <td class="cpap-col">${night.minIPAP || 'N/A'}</td>
            <td class="cpap-col">${night.maxIPAP || 'N/A'}</td>
            <td class="cpap-col">${night.epap}</td>
            <td class="cpap-col">${night.minEPAP || 'N/A'}</td>
            <td class="cpap-col">${night.maxEPAP || 'N/A'}</td>
            <td class="cpap-col">${night.pressureSupport}</td>
            <td class="cpap-col">${night.easyBreathe}</td>
            <td class="cpap-col">${night.riseTime}</td>
            <td class="cpap-col">${night.trigger}</td>
            <td class="cpap-col">${night.cycle || 'N/A'}</td>
            <td></td>
            <td><button class="btn-sm" style="background:#007bff;" onclick="viewNightHeatmap('${night.date}')">🔍 View</button></td>
        `;

            // Click to expand sub-sessions
            row.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
                toggleSubSessions(row, night);
            });

            tbody.appendChild(row);
        });
    }

    function toggleSubSessions(row, night) {
        const toggle = row.querySelector('.expand-toggle');
        const existing = row.parentElement.querySelectorAll(`.sub-row-${night.date}`);
        if (existing.length > 0) {
            existing.forEach(r => r.remove());
            if (toggle) toggle.textContent = '▶';
            return;
        }
        if (toggle) toggle.textContent = '▼';

        const sessions = night._allSessions || [];
        sessions.forEach(s => {
            const subRow = document.createElement('tr');
            subRow.className = `sub-session-row sub-row-${night.date}${s._includedInDay ? '' : ' excluded'}`;
            const badge = getSessionTypeBadge(s._sessionType);
            subRow.innerHTML = `
            <td><input type="checkbox" class="include-cb" ${s._includedInDay ? 'checked' : ''} data-filename="${s.fileName}"> ${s.fileName} <span class="session-type-badge ${badge.cssClass}">${badge.emoji} ${badge.label}</span></td>
            <td>${s.time || 'N/A'}</td>
            <td></td>
            <td>${s.duration.toFixed(2)}</td>
            <td>${s.machineType || ''}</td>
            <td>${s.papMode || ''}</td>
            <td>${s.cumIndex?.overall ? `<span class="gi-value" style="background:${getGIOverallBg(s.cumIndex.overall)}">${s.cumIndex.overall.toFixed(2)}</span>` : 'N/A'}</td>
            <td>${s.cumIndex?.skew ? `<span class="gi-value" style="background:${getGICompBg('skew', s.cumIndex.skew)}">${s.cumIndex.skew.toFixed(2)}</span>` : ''}</td>
            <td>${s.cumIndex?.spike ? `<span class="gi-value" style="background:${getGICompBg('spike', s.cumIndex.spike)}">${s.cumIndex.spike.toFixed(2)}</span>` : ''}</td>
            <td>${s.cumIndex?.flatTop ? `<span class="gi-value" style="background:${getGICompBg('flatTop', s.cumIndex.flatTop)}">${s.cumIndex.flatTop.toFixed(2)}</span>` : ''}</td>
            <td>${s.cumIndex?.topHeavy ? `<span class="gi-value" style="background:${getGICompBg('topHeavy', s.cumIndex.topHeavy)}">${s.cumIndex.topHeavy.toFixed(2)}</span>` : ''}</td>
            <td>${s.cumIndex?.multiPeak ? `<span class="gi-value" style="background:${getGICompBg('multiPeak', s.cumIndex.multiPeak)}">${s.cumIndex.multiPeak.toFixed(2)}</span>` : ''}</td>
            <td>${s.cumIndex?.noPause ? `<span class="gi-value" style="background:${getGICompBg('noPause', s.cumIndex.noPause)}">${s.cumIndex.noPause.toFixed(2)}</span>` : ''}</td>
            <td>${s.cumIndex?.inspirRate ? `<span class="gi-value" style="background:${getGICompBg('inspirRate', s.cumIndex.inspirRate)}">${s.cumIndex.inspirRate.toFixed(2)}</span>` : ''}</td>
            <td>${s.cumIndex?.multiBreath ? `<span class="gi-value" style="background:${getGICompBg('multiBreath', s.cumIndex.multiBreath)}">${s.cumIndex.multiBreath.toFixed(2)}</span>` : ''}</td>
            <td>${s.cumIndex?.ampVar ? `<span class="gi-value" style="background:${getGICompBg('ampVar', s.cumIndex.ampVar)}">${s.cumIndex.ampVar.toFixed(2)}</span>` : ''}</td>
            <td>${fmtWobble(s.wobble?.composite, 1)}</td>
            <td>${fmtWobble(s.wobble?.flScore, 1)}</td>
            <td>${fmtWobble(s.wobble?.regularityScore, 1)}</td>
            <td>${fmtWobble(s.wobble?.periodicityIndex, 1)}</td>
            <td>${fmtWobble(s.wobble?.eai, 1)}</td>
            <td class="cpap-col" colspan="11"></td>
            <td></td>
            <td></td>
        `;
            // Checkbox handler
            subRow.querySelector('.include-cb')?.addEventListener('change', (e) => {
                s._includedInDay = e.target.checked;
                saveSessionInclusion(s.fileName, e.target.checked);
                subRow.classList.toggle('excluded', !e.target.checked);
                // Recalculate night
                const updatedNight = recalculateNightFromSessions(night.date, night._allSessions);
                Object.assign(night, updatedNight);
                // Re-render (simple approach: rebuild everything)
                displayResults();
            });

            row.after(subRow);
        });
    }

    // ============ Gradient helpers (data-relative) ============
    let _giStats = {};
    let _wobbleStats = {};
    function getGICompBg(comp, val) {
        const s = _giStats[comp];
        if (!s) return '';
        return getGradientColor(val, s.min, s.max);
    }
    function getGIOverallBg(val) {
        const s = _giStats['overall'];
        if (!s) return '';
        return getGradientColor(val, s.min, s.max);
    }
    function getWobbleCellBg(comp, val) {
        if (val === undefined || val === null || isNaN(val)) return 'background:#f5f0ff;';
        const s = _wobbleStats[comp];
        if (!s) return 'background:#f5f0ff;';
        if (comp === 'regularityScore') return 'background-color:' + getGradientColor(val, s.max, s.min) + ';color:#000;';
        return 'background-color:' + getGradientColor(val, s.min, s.max) + ';color:#000;';
    }
    function fmtWobble(val, d = 3) {
        if (val === undefined || val === null || isNaN(val)) return 'N/A';
        return Number(val).toFixed(d);
    }

    // ============ Session Classification ============
    function classifySessionsForNight(sessions) {
        if (!sessions || sessions.length === 0) return;
        sessions.sort((a, b) => {
            const timeDiff = new Date(a.startDateTime) - new Date(b.startDateTime);
            if (timeDiff !== 0 && !isNaN(timeDiff)) return timeDiff;
            return (a.fileName || '').localeCompare(b.fileName || '');
        });

        const isNighttimeHour = h => h >= 20 || h < 12;
        const isNearNoon = dt => Math.abs((dt.getHours() - 12) * 60 + dt.getMinutes()) <= 30;

        for (let i = 0; i < sessions.length; i++) {
            const s = sessions[i];
            const startDt = new Date(s.startDateTime);
            const startHour = startDt.getHours();

            if (i > 0) {
                const prev = sessions[i - 1];
                const prevEnd = new Date(prev.endDateTime || new Date(prev.startDateTime).getTime() + prev.duration * 3600000);
                const gapMin = (startDt - prevEnd) / 60000;

                if (gapMin >= 0 && gapMin <= 10) { s._sessionType = 'bathroom'; s._defaultIncluded = true; }
                else if (isNearNoon(prevEnd) && isNearNoon(startDt) && gapMin >= 0 && gapMin <= 30) { s._sessionType = 'noon-split'; s._defaultIncluded = true; }
                else if (gapMin >= 0 && gapMin <= 60 && isNighttimeHour(startHour)) { s._sessionType = gapMin <= 30 ? 'bathroom' : 'main'; s._defaultIncluded = true; }
            }

            if (!s._sessionType) {
                if (startHour >= 10 && startHour < 20 && s.duration <= 3) { s._sessionType = 'nap'; s._defaultIncluded = false; }
                else { s._sessionType = 'main'; s._defaultIncluded = true; }
            }

            const saved = getSessionInclusion(s.fileName);
            s._includedInDay = saved !== null ? saved : s._defaultIncluded;
        }
    }

    function getSessionTypeBadge(type) {
        const badges = {
            'main': { emoji: '🛏️', label: 'Main', cssClass: 'badge-main' },
            'noon-split': { emoji: '🔗', label: 'Continuation', cssClass: 'badge-noon-split' },
            'bathroom': { emoji: '🚿', label: 'Break', cssClass: 'badge-bathroom' },
            'nap': { emoji: '💤', label: 'Nap', cssClass: 'badge-nap' }
        };
        return badges[type] || badges['main'];
    }

    // ============ Night Aggregation ============
    function recalculateNightFromSessions(date, allSessions) {
        const included = allSessions.filter(s => s._includedInDay);
        const giKeys = ['skew', 'spike', 'flatTop', 'topHeavy', 'multiPeak', 'noPause', 'inspirRate', 'multiBreath', 'ampVar'];

        if (included.length === 0) {
            return {
                date, startTime: 'N/A', endTime: 'N/A', duration: 0,
                sessions: allSessions.length, _allSessions: allSessions,
                weightedGI: { overall: 0, ...Object.fromEntries(giKeys.map(k => [k, 0])) },
                machineType: allSessions[0]?.machineType || 'Unknown',
                ipap: 'N/A', epap: 'N/A', pressureSupport: 'N/A',
                papMode: 'Unknown', riseTime: 'N/A', trigger: 'N/A',
                cycle: 'N/A', easyBreathe: 'N/A'
            };
        }

        const totalDuration = included.reduce((s, sess) => s + sess.duration, 0);
        const weightedGI = {};
        giKeys.forEach(k => {
            weightedGI[k] = Math.round(100 * included.reduce((s, sess) => s + (sess.cumIndex?.[k] || 0) * (sess.duration / totalDuration), 0)) / 100;
        });
        weightedGI.overall = Math.round(100 * giKeys.reduce((s, k) => s + weightedGI[k], 0)) / 100;

        // Wobble weighted average
        const withWobble = included.filter(s => s.wobble && !isNaN(s.wobble.composite));
        let wobbleAvg = { flScore: 0, periodicityIndex: 0, regularityScore: 0, eai: 0, composite: 0 };
        if (withWobble.length > 0) {
            const wDur = withWobble.reduce((s, sess) => s + sess.duration, 0);
            if (wDur > 0) {
                ['flScore', 'periodicityIndex', 'regularityScore', 'eai', 'composite'].forEach(k => {
                    wobbleAvg[k] = Math.round(10 * withWobble.reduce((s, sess) => s + (sess.wobble[k] || 0) * (sess.duration / wDur), 0)) / 10;
                });
            }
        }

        included.sort((a, b) => {
            const timeDiff = new Date(a.startDateTime) - new Date(b.startDateTime);
            if (timeDiff !== 0 && !isNaN(timeDiff)) return timeDiff;
            return (a.fileName || '').localeCompare(b.fileName || '');
        });
        const first = included[0];
        const last = included[included.length - 1];

        return {
            date, sessions: allSessions.length, _allSessions: allSessions,
            startTime: first.startDateTime ? formatDateTimeAMPM(first.startDateTime) : first.time,
            endTime: last.endDateTime ? formatDateTimeAMPM(last.endDateTime) : 'N/A',
            duration: totalDuration,
            weightedGI,
            _wobbleAvg: wobbleAvg,
            machineType: first.machineType || 'Unknown',
            ipap: 'N/A', epap: 'N/A', minIPAP: 'N/A', maxIPAP: 'N/A',
            minEPAP: 'N/A', maxEPAP: 'N/A', pressureSupport: 'N/A',
            papMode: first.papMode || 'Unknown',
            riseTime: 'N/A', trigger: 'N/A', cycle: 'N/A', easyBreathe: 'N/A'
        };
    }

    // ============ Charts ============
    function setupChartControls() {
        document.getElementById('btnUpdateCharts')?.addEventListener('click', () => {
            const nights = groupIntoNights(nightlyResults);
            updateTrendsChart(nights);
            updateComponentsChart(nights);
        });

        document.getElementById('dateRangeSelect')?.addEventListener('change', function () {
            document.getElementById('customDateBlock').style.display = this.value === 'custom' ? 'inline' : 'none';
        });

        // Component filter buttons
        const compIds = ['comp_skew', 'comp_spike', 'comp_flatTop', 'comp_topHeavy', 'comp_multiPeak', 'comp_noPause', 'comp_inspirRate', 'comp_multiBreath', 'comp_ampVar'];
        document.getElementById('btnCompAll')?.addEventListener('click', () => { compIds.forEach(id => { const el = document.getElementById(id); if (el) el.checked = true; }); updateComponentsChart(groupIntoNights(nightlyResults)); });
        document.getElementById('btnCompNone')?.addEventListener('click', () => { compIds.forEach(id => { const el = document.getElementById(id); if (el) el.checked = false; }); updateComponentsChart(groupIntoNights(nightlyResults)); });
        document.getElementById('btnCompMain')?.addEventListener('click', () => { compIds.forEach(id => { const el = document.getElementById(id); if (el) el.checked = ['comp_noPause', 'comp_multiPeak', 'comp_flatTop'].includes(id); }); updateComponentsChart(groupIntoNights(nightlyResults)); });
        document.getElementById('btnCompFlow')?.addEventListener('click', () => { compIds.forEach(id => { const el = document.getElementById(id); if (el) el.checked = ['comp_skew', 'comp_spike', 'comp_flatTop', 'comp_topHeavy'].includes(id); }); updateComponentsChart(groupIntoNights(nightlyResults)); });
        document.getElementById('btnCompTiming')?.addEventListener('click', () => { compIds.forEach(id => { const el = document.getElementById(id); if (el) el.checked = ['comp_noPause', 'comp_inspirRate', 'comp_multiBreath'].includes(id); }); updateComponentsChart(groupIntoNights(nightlyResults)); });

        compIds.forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => updateComponentsChart(groupIntoNights(nightlyResults)));
        });
        document.getElementById('showTrendLines')?.addEventListener('change', () => updateComponentsChart(groupIntoNights(nightlyResults)));
    }

    function filterNightsByDateRange(nights) {
        const range = document.getElementById('dateRangeSelect')?.value || 'all';
        const hideShort = document.getElementById('hideShortNights')?.checked;
        let filtered = hideShort ? nights.filter(n => n.duration >= 4) : [...nights];

        if (range !== 'all' && range !== 'custom') {
            const days = parseInt(range);
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            filtered = filtered.filter(n => new Date(n.date) >= cutoff);
        } else if (range === 'custom') {
            const start = document.getElementById('customStartDate')?.value;
            const end = document.getElementById('customEndDate')?.value;
            if (start) filtered = filtered.filter(n => n.date >= start);
            if (end) filtered = filtered.filter(n => n.date <= end);
        }

        return filtered.sort((a, b) => a.date.localeCompare(b.date));
    }

    function updateTrendsChart(nights) {
        const filtered = filterNightsByDateRange(nights);
        const labels = filtered.map(n => n.date);
        const data = filtered.map(n => n.weightedGI.overall);

        if (trendsChart) trendsChart.destroy();
        const ctx = document.getElementById('trendsChart')?.getContext('2d');
        if (!ctx) return;

        trendsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Overall GI',
                    data,
                    borderColor: '#dc3545',
                    backgroundColor: 'rgba(220, 53, 69, 0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { y: { beginAtZero: true, title: { display: true, text: 'GI Score' } } },
                plugins: { legend: { display: false } }
            }
        });
    }

    function updateComponentsChart(nights) {
        const filtered = filterNightsByDateRange(nights);
        const labels = filtered.map(n => n.date);
        const components = [
            { id: 'comp_skew', key: 'skew', label: 'Skew', color: '#FF6384' },
            { id: 'comp_spike', key: 'spike', label: 'Spike', color: '#36A2EB' },
            { id: 'comp_flatTop', key: 'flatTop', label: 'Flat Top', color: '#FFCE56' },
            { id: 'comp_topHeavy', key: 'topHeavy', label: 'Top Heavy', color: '#4BC0C0' },
            { id: 'comp_multiPeak', key: 'multiPeak', label: 'Multi Peak', color: '#9966FF' },
            { id: 'comp_noPause', key: 'noPause', label: 'No Pause', color: '#FF9F40' },
            { id: 'comp_inspirRate', key: 'inspirRate', label: 'Inspir Rate', color: '#C9CBCF' },
            { id: 'comp_multiBreath', key: 'multiBreath', label: 'Multi Breath', color: '#7BC8A4' },
            { id: 'comp_ampVar', key: 'ampVar', label: 'Variable Amp', color: '#E7E9ED' }
        ];

        const datasets = components
            .filter(c => document.getElementById(c.id)?.checked)
            .map(c => ({
                label: c.label,
                data: filtered.map(n => n.weightedGI[c.key]),
                borderColor: c.color,
                backgroundColor: c.color + '33',
                tension: 0.3,
                pointRadius: 3
            }));

        if (componentsChart) componentsChart.destroy();
        const ctx = document.getElementById('componentsChart')?.getContext('2d');
        if (!ctx) return;

        componentsChart = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { y: { beginAtZero: true, max: 1, title: { display: true, text: 'Component Score' } } }
            }
        });
    }

    // ============ Heatmap ============
    function populateNightSelector(nights) {
        const select = document.getElementById('nightSelect');
        if (!select) return;
        select.innerHTML = '';
        nights.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n.date;
            opt.textContent = `${n.date} — GI: ${n.weightedGI.overall.toFixed(2)} (${n.duration.toFixed(1)}h)`;
            select.appendChild(opt);
        });

        select.addEventListener('change', () => updateNightHeatmap(nights));
        document.getElementById('nightPrev')?.addEventListener('click', () => { select.selectedIndex = Math.min(select.selectedIndex + 1, select.options.length - 1); updateNightHeatmap(nights); });
        document.getElementById('nightNext')?.addEventListener('click', () => { select.selectedIndex = Math.max(select.selectedIndex - 1, 0); updateNightHeatmap(nights); });

        if (nights.length > 0) updateNightHeatmap(nights);
    }

    // Fix 2: Lazy-load flow data from compact y-values on demand
    function ensureFlowData(session) {
        if (session.flowData && session.flowData.length > 0) return;
        if (session.flowYValues && session.flowYValues.length > 0) {
            const start = session.startDateTime || new Date();
            session.flowData = session.flowYValues.map((y, i) => ({
                x: formatChartDate(new Date(start.getTime() + i * 40)),
                y
            }));
            delete session.flowYValues;
        }
        if (!session.idealData && session.idealYValues && session.idealYValues.length > 0) {
            const start = session.startDateTime || new Date();
            session.idealData = session.idealYValues.map((y, i) => ({
                x: formatChartDate(new Date(start.getTime() + i * 40)),
                y
            }));
            delete session.idealYValues;
        }
    }

    function updateNightHeatmap(nights) {
        const select = document.getElementById('nightSelect');
        if (!select) return;
        const date = select.value;
        const night = nights.find(n => n.date === date);
        if (!night || !night._allSessions) return;

        // Find first included session with flow data (compact or expanded)
        const session = night._allSessions.find(s => s._includedInDay &&
            ((s.flowData && s.flowData.length > 0) || (s.flowYValues && s.flowYValues.length > 0)));
        if (!session) return;

        // Fix 2: Lazy-expand flow data only when heatmap needs it
        ensureFlowData(session);

        // Bridge to legacy FlowLimits.js heatmap
        window.dataArray = session.flowData;
        window.startDateTime = new Date(session.startDateTime);
        window.results = {
            inspirations: session.inspirations || [],
            flowImbalance: session.flowImbalance || [],
            idealArray: session.idealData || [],
            cumIndex: session.cumIndex || {}
        };

        if (typeof window.displayHeatMap === 'function') {
            window.displayHeatMap(window.results);
        }
    }

    // Make viewNightHeatmap accessible from inline onclick
    window.viewNightHeatmap = function (date) {
        const select = document.getElementById('nightSelect');
        if (select) { select.value = date; select.dispatchEvent(new Event('change')); }
    };

    // ============ Settings Modal ============
    function setupSettingsModal() {
        const modal = document.getElementById('settingsModal');
        const btnOpen = document.getElementById('navSettingsBtn') || document.querySelector('[data-action="settings"]');
        const btnClose = document.getElementById('closeSettingsBtn');
        const form = document.getElementById('settingsForm');

        if (!modal) return;

        // Create settings button in header if not present
        if (!btnOpen) {
            const header = document.querySelector('.header');
            if (header) {
                const btn = document.createElement('button');
                btn.textContent = '⚙️ Settings';
                btn.style.cssText = 'position:absolute; top:20px; right:20px; padding:8px 16px; background:#007bff; color:white; border:none; border-radius:4px; cursor:pointer;';
                btn.onclick = () => openSettings();
                header.style.position = 'relative';
                header.appendChild(btn);
            }
        } else {
            btnOpen.addEventListener('click', () => openSettings());
        }

        if (btnClose) btnClose.onclick = () => { modal.style.display = 'none'; };
        window.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

        function openSettings() {
            if (form) {
                form.innerHTML = Settings.generateFormHTML();
                document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
                    form.querySelectorAll('input.setting-input[data-key]').forEach(input => {
                        Settings.update(input.getAttribute('data-key'), input.value);
                    });
                    modal.style.display = 'none';
                    alert('Settings saved.');
                });
                document.getElementById('btnResetSettings')?.addEventListener('click', () => {
                    if (confirm('Reset all settings to defaults?')) { Settings.reset(); modal.style.display = 'none'; }
                });
            }
            modal.style.display = 'flex';
        }
    }

    // ============ Table Controls ============
    function setupTableControls() {
        document.getElementById('showCpapSettings')?.addEventListener('change', function () {
            document.querySelectorAll('.cpap-col').forEach(el => {
                el.style.display = this.checked ? '' : 'none';
            });
        });

        document.getElementById('btnExportCSV')?.addEventListener('click', exportCSV);
    }

    function exportCSV() {
        const table = document.getElementById('resultsTable');
        if (!table) return;
        const rows = table.querySelectorAll('tr');
        let csv = '';
        rows.forEach(row => {
            const cells = row.querySelectorAll('th, td');
            const values = Array.from(cells).map(c => `"${c.textContent.replace(/"/g, '""').trim()}"`);
            csv += values.join(',') + '\n';
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `megascore_export_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
    }

    // ============ IndexedDB Cache ============
    const CACHE_DB_NAME = 'megascore_cache';
    const CACHE_DB_VERSION = 2;  // bumped to invalidate stale v1 cache (was missing inspirations)
    const CACHE_STORE_NAME = 'sessions';

    function openCacheDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(CACHE_STORE_NAME))
                    db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'fileName' });
            };
        });
    }

    async function getCachedResult(fileName) {
        try {
            const db = await openCacheDB();
            return new Promise(resolve => {
                const tx = db.transaction(CACHE_STORE_NAME, 'readonly');
                const req = tx.objectStore(CACHE_STORE_NAME).get(fileName);
                req.onsuccess = () => {
                    const r = req.result;
                    if (r) {
                        if (r.startDateTime) r.startDateTime = new Date(r.startDateTime);
                        if (r.endDateTime) r.endDateTime = new Date(r.endDateTime);
                        // Fix 3: Keep compact flowYValues — ensureFlowData() will expand on demand
                    }
                    resolve(r || null);
                };
                req.onerror = () => resolve(null);
            });
        } catch (e) { return null; }
    }

    async function setCachedResult(result) {
        try {
            const db = await openCacheDB();
            const obj = { ...result };
            // Store compact y-values: handle both old format (flowData) and new (flowYValues)
            if (!obj.flowYValues && obj.flowData?.length > 0) {
                obj.flowYValues = obj.flowData.map(d => d.y);
            }
            if (!obj.idealYValues && obj.idealData?.length > 0) {
                obj.idealYValues = obj.idealData.map(d => d.y);
            }
            delete obj.flowData;
            delete obj.idealData;
            // Keep inspirations and cumIndex — needed for heatmap and table display
            const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
            tx.objectStore(CACHE_STORE_NAME).put(obj);
            return new Promise(r => { tx.oncomplete = () => r(true); tx.onerror = () => r(false); });
        } catch (e) { return false; }
    }

    async function clearResultCache() {
        try {
            const db = await openCacheDB();
            const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
            tx.objectStore(CACHE_STORE_NAME).clear();
            return new Promise(r => { tx.oncomplete = () => r(true); tx.onerror = () => r(false); });
        } catch (e) { return false; }
    }

    async function getCacheCount() {
        try {
            const db = await openCacheDB();
            return new Promise(r => {
                const req = db.transaction(CACHE_STORE_NAME, 'readonly').objectStore(CACHE_STORE_NAME).count();
                req.onsuccess = () => r(req.result);
                req.onerror = () => r(0);
            });
        } catch (e) { return 0; }
    }

    async function getAllCachedResults() {
        try {
            const db = await openCacheDB();
            return new Promise(r => {
                const req = db.transaction(CACHE_STORE_NAME, 'readonly').objectStore(CACHE_STORE_NAME).getAll();
                req.onsuccess = () => {
                    (req.result || []).forEach(res => {
                        if (res.startDateTime) res.startDateTime = new Date(res.startDateTime);
                        if (res.endDateTime) res.endDateTime = new Date(res.endDateTime);
                    });
                    r(req.result || []);
                };
                req.onerror = () => r([]);
            });
        } catch (e) { return []; }
    }

    async function loadCachedSessions() {
        document.getElementById('processingStatus').textContent = 'Loading cached sessions...';
        nightlyResults = await getAllCachedResults();
        if (nightlyResults.length > 0) {
            document.getElementById('processingStatus').textContent = `Loaded ${nightlyResults.length} sessions from cache!`;
            displayResults();
        } else {
            document.getElementById('processingStatus').textContent = 'No cached sessions found.';
        }
    }

    // ============ Session Inclusion Persistence ============
    const STORAGE_KEY_INCLUSION = 'glasgowIndex_sessionInclusion';

    function getSessionInclusion(fileName) {
        try {
            const data = JSON.parse(localStorage.getItem(STORAGE_KEY_INCLUSION) || '{}');
            return data.hasOwnProperty(fileName) ? data[fileName] : null;
        } catch (e) { return null; }
    }

    function saveSessionInclusion(fileName, included) {
        try {
            const data = JSON.parse(localStorage.getItem(STORAGE_KEY_INCLUSION) || '{}');
            data[fileName] = included;
            localStorage.setItem(STORAGE_KEY_INCLUSION, JSON.stringify(data));
        } catch (e) { /* ignore */ }
    }

    // ============ Helpers ============
    function deduplicateResults() {
        const seen = new Set();
        nightlyResults = nightlyResults.filter(r => {
            const key = (r.fileName || '') + '|' + r.date + '|' + r.time;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function formatDateTimeAMPM(date) {
        if (!date || !(date instanceof Date)) return 'Unknown';
        let h = date.getHours();
        const m = String(date.getMinutes()).padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${m} ${ampm}`;
    }

    function formatChartDate(d) {
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `${h}:${m}:${s}.${ms}`;
    }

    // Legacy bridge: expose scrollDetail functions for hidden buttons
    window.scrollDetailLeft = function () {
        if (!window.dataArray || !window.results) return;
        const MOVE = 1125;
        window.detailSampleSelected = Math.max(0, (window.detailSampleSelected || 0) - MOVE);
        if (typeof window.showDetailOneMinute === 'function')
            window.showDetailOneMinute(window.dataArray, window.results, window.detailSampleSelected);
    };
    window.scrollDetailRight = function () {
        if (!window.dataArray || !window.results) return;
        const MOVE = 1125;
        window.detailSampleSelected = Math.min(window.dataArray.length - 750, (window.detailSampleSelected || 0) + MOVE);
        if (typeof window.showDetailOneMinute === 'function')
            window.showDetailOneMinute(window.dataArray, window.results, window.detailSampleSelected);
    };

    // Wire detail buttons
    document.getElementById('btnDetailEarlier')?.addEventListener('click', window.scrollDetailLeft);
    document.getElementById('btnDetailLater')?.addEventListener('click', window.scrollDetailRight);

    // Override clearDetailGraph from FlowLimits.js
    window.clearDetailGraph = function () {
        const section = document.getElementById('detailChartSection');
        if (section) section.style.display = 'none';
    };

})();

})();
