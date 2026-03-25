(function() {
'use strict';
/**
 * ResMed SD Card Parser
 * 
 * Handles ResMed AirSense/AirCurve SD card file organization:
 *   - File type classification (BRP, PLD, SAD, CSL, EVE)
 *   - Night grouping by DATALOG folder date
 *   - STR.edf pressure settings extraction
 *   - Session metadata parsing from filenames
 * 
 * ResMed SD card structure:
 *   /DATALOG/YYYYMMDD/YYYYMMDD_HHMMSS_BRP.edf (breathing/flow waveform)
 *   /DATALOG/YYYYMMDD/YYYYMMDD_HHMMSS_PLD.edf (pressure data)
 *   /DATALOG/YYYYMMDD/YYYYMMDD_HHMMSS_SAD.edf (summary/statistics)
 *   /DATALOG/YYYYMMDD/YYYYMMDD_HHMMSS_EVE.edf (events: apneas, hypopneas)
 *   /DATALOG/YYYYMMDD/YYYYMMDD_HHMMSS_CSL.edf (csl data)
 *   /STR.edf (settings/pressure configuration — one file for entire card)
 *   /Identification.tgt or /Identification.json (machine type)
 * 
 * NOTE: Hacked firmware (e.g., aircracked AirSense 10) may report incorrect
 * PAP modes in STR.edf. Account for this when debugging mode detection.
 * 
 * Reference: OSCAR source at K:\cc\sleepanalysis\OSCAR-code\oscar\SleepLib\loader_plugins\resmed_loader.cpp
 */

// Depends on: window.EDFParser (loaded from js/parsers/edf.js)

window.ResMedParser = {

    /** ResMed EDF file type suffixes */
    FILE_TYPES: {
        BRP: { suffix: '_BRP.edf', label: 'Breathing/Flow Waveform', hasFlow: true },
        PLD: { suffix: '_PLD.edf', label: 'Pressure Data', hasFlow: false },
        SAD: { suffix: '_SAD.edf', label: 'Summary/Statistics', hasFlow: false },
        EVE: { suffix: '_EVE.edf', label: 'Events (Apneas, Hypopneas)', hasFlow: false },
        CSL: { suffix: '_CSL.edf', label: 'CSL Data', hasFlow: false },
        STR: { suffix: 'STR.edf', label: 'Settings/Pressure Config', hasFlow: false }
    },

    /**
     * Classify a ResMed EDF file by its suffix.
     * @param {string} filename
     * @returns {string|null} Type key (BRP, PLD, SAD, EVE, CSL, STR) or null
     */
    classifyFile(filename) {
        const upper = filename.toUpperCase();
        for (const [type, info] of Object.entries(this.FILE_TYPES)) {
            if (upper.endsWith(info.suffix.toUpperCase())) return type;
        }
        if (upper === 'STR.EDF') return 'STR';
        return null;
    },

    /**
     * Detect if a file list is ResMed data (has BRP files).
     * @param {Array<File>} files
     * @returns {boolean}
     */
    isResMedDataSet(files) {
        return files.some(f => f.name.includes('_BRP.edf'));
    },

    /**
     * Extract the DATALOG folder date from a file's webkitRelativePath.
     * Path format: DATALOG/20250724/20250724_232010_BRP.edf
     * The folder name (YYYYMMDD) represents the sleep night.
     * 
     * @param {File} file
     * @returns {string|null} YYYYMMDD date string or null
     */
    extractFolderDate(file) {
        if (file.webkitRelativePath) {
            const pathMatch = file.webkitRelativePath.match(/\/(\d{8})\//);
            if (pathMatch) return pathMatch[1];
        }
        return null;
    },

    /**
     * Extract session timestamp from a ResMed filename.
     * Format: YYYYMMDD_HHMMSS_TYPE.edf → { date: "YYYY-MM-DD", time: "HH:MM:SS" }
     * 
     * @param {string} filename
     * @returns {Object} { date, time, dateObj, folderDate }
     */
    parseFilename(filename) {
        const match = filename.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
        if (!match) return { date: null, time: null, dateObj: null };

        const [_, y, m, d, h, min, s] = match;
        const dateStr = `${y}-${m}-${d}`;
        const timeStr = `${h}:${min}:${s}`;
        const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d),
            parseInt(h), parseInt(min), parseInt(s));

        return { date: dateStr, time: timeStr, dateObj };
    },

    /**
     * Group BRP files by sleep night.
     * Uses DATALOG folder date when available, falls back to filename date.
     * 
     * ResMed uses a noon-to-noon day boundary: sessions starting after noon
     * belong to the NEXT night (the folder date handles this automatically).
     * 
     * @param {Array<File>} files - All files from the SD card
     * @returns {Object} { nights: Map<dateStr, File[]>, brpFiles: File[], strFile: File|null, identFile: File|null }
     */
    groupByNight(files) {
        const brpFiles = files.filter(f => f.name.includes('_BRP.edf'));
        const strFile = files.find(f => f.name === 'STR.edf') || null;
        const identFile = files.find(f =>
            f.name === 'Identification.tgt' || f.name === 'Identification.json'
        ) || null;

        const nights = new Map();

        for (const file of brpFiles) {
            // Prefer folder date (DATALOG/YYYYMMDD/) over filename parsing
            let dateKey = this.extractFolderDate(file);

            if (!dateKey) {
                // Fall back to filename date
                const match = file.name.match(/(\d{8})_/);
                if (match) dateKey = match[1];
            }

            if (dateKey) {
                if (!nights.has(dateKey)) nights.set(dateKey, []);
                nights.get(dateKey).push(file);
            }
        }

        // Sort files within each night by timestamp
        for (const [date, nightFiles] of nights) {
            nightFiles.sort((a, b) => a.name.localeCompare(b.name));
        }

        return { nights, brpFiles, strFile, identFile };
    },

    /**
     * Parse STR.edf to extract pressure settings per session.
     * 
     * STR.edf contains one data record per day with settings signals:
     *   S.EPR.EPRLevel, S.EPR.EPRType, S.C.StartPress, S.AS.MaxPress, etc.
     *   S.RiseTime, S.Trigger, S.EasyBreathe, S.Mode (PAP mode)
     * 
     * @param {ArrayBuffer} buffer - Contents of STR.edf
     * @returns {Object} Map of date → settings { epap, ipap, ps, mode, riseTime, trigger, easyBreathe }
     */
    parseSTR(buffer) {
        const parsed = EDFParser.parse(buffer);
        if (!parsed || !parsed.signals || parsed.signals.length === 0) {
            return {};
        }

        // Build a map of signal label → physical values array
        const signalMap = {};
        for (const sig of parsed.signals) {
            signalMap[sig.label.trim()] = sig.physicalValues;
        }

        // Each data record = one day. Extract per-day settings.
        const settings = {};
        const numRecords = parsed.metadata.numDataRecords;
        const startDate = new Date(parsed.metadata.recordingDate);

        for (let r = 0; r < numRecords; r++) {
            const dayDate = new Date(startDate);
            dayDate.setDate(dayDate.getDate() + r);
            const dateKey = dayDate.toISOString().split('T')[0].replace(/-/g, '');

            const getValue = (label) => {
                const sig = signalMap[label];
                if (!sig || r >= sig.length) return null;
                const val = sig[r];
                return isNaN(val) ? null : val;
            };

            settings[dateKey] = {
                epap: getValue('S.C.StartPress') || getValue('S.EPR.SetPress'),
                ipap: getValue('S.AS.MaxPress'),
                ps: getValue('S.PS'),
                mode: getValue('S.Mode'),
                riseTime: getValue('S.RiseTime'),
                trigger: getValue('S.Trigger'),
                easyBreathe: getValue('S.EasyBreathe'),
                eprLevel: getValue('S.EPR.EPRLevel'),
                eprType: getValue('S.EPR.EPRType')
            };
        }

        return settings;
    },

    /**
     * Compute sleep night date using ResMed's noon-to-noon convention.
     * Sessions starting after noon belong to the CURRENT calendar date's night.
     * Sessions starting before noon belong to the PREVIOUS calendar date's night.
     * 
     * @param {Date} startDateTime - Session start time
     * @returns {string} Sleep night date as YYYYMMDD
     */
    getSleepNightDate(startDateTime) {
        const dt = new Date(startDateTime);
        if (dt.getHours() < 12) {
            // Before noon → belongs to previous night
            dt.setDate(dt.getDate() - 1);
        }
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const d = String(dt.getDate()).padStart(2, '0');
        return `${y}${m}${d}`;
    }
};

})();
