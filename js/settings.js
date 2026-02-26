/**
 * Settings Manager
 * 
 * Handles reading/writing configurable parameters to localStorage.
 * This makes it easy for users to tweak variables like thresholds
 * and weights without having to edit the actual algorithm code.
 */

const STORAGE_KEY = 'megascore_settings';

// These are the defaults for all our algorithms.
// If a user messes up, they can reset to these.
const DEFAULT_SETTINGS = {
    // General Analysis
    minBreathDurationSec: 0.5,
    maxBreathDurationSec: 20.0,
    
    // Flow Limitation (Wobble Port)
    flTopPercentage: 0.5,           // The percent of max flow to analyze for flatness
    flFlatnessTarget: 0.05,         // Variance target

    // Glasgow Index Parameters (Dave's Port)
    giExtrapolationSamples: 25,
    giTopThreshold90: 0.9,
    giGreyZoneUpper: 5,
    giGreyZoneLower: -10,

    // Arousal Detection
    arousalBaselineWindowSec: 120,  // How many seconds of history block for baseline
    arousalRateIncreaseMin: 0.20,   // 20% increase in resp rate = arousal
    arousalVolIncreaseMin: 0.30     // 30% increase in tidal vol = arousal
};

export const Settings = {
    
    current: { ...DEFAULT_SETTINGS },

    /**
     * Load settings from localStorage overrides (if any exist)
     */
    load() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                this.current = { ...DEFAULT_SETTINGS, ...parsed };
                console.log("Loaded custom settings from LocalStorage", this.current);
            }
        } catch(e) {
            console.error("Failed to load settings:", e);
        }
    },

    /**
     * Save current settings to localStorage
     */
    save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
            console.log("Saved custom settings to LocalStorage");
        } catch(e) {
            console.error("Failed to save settings:", e);
        }
    },

    /**
     * Update a specific setting
     */
    update(key, value) {
        if (this.current.hasOwnProperty(key)) {
            // Convert to number if it's supposed to be a number
            this.current[key] = parseFloat(value) || value;
            this.save();
        }
    },

    /**
     * Reset to default
     */
    reset() {
        this.current = { ...DEFAULT_SETTINGS };
        this.save();
    },

    /**
     * Generate HTML form fields dynamically based on the current settings
     */
    generateFormHTML() {
        let html = '';
        for (const [key, val] of Object.entries(this.current)) {
            // Just a bit of un-camelCase for display
            const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
            
            html += `
                <div class="setting-row">
                    <div class="setting-label">
                        <strong>${label}</strong>
                        <span>Internal Key: ${key}</span>
                    </div>
                    <input type="number" step="0.01" class="setting-input" data-key="${key}" value="${val}">
                </div>
            `;
        }
        
        html += `
            <div style="margin-top: 20px; display: flex; justify-content: space-between;">
                <button id="btnResetSettings" class="btn btn-secondary">Restore Defaults</button>
                <button id="btnSaveSettings" class="btn btn-primary">Save & Apply</button>
            </div>
        `;
        return html;
    }
};

// Auto-load on script execution
Settings.load();
