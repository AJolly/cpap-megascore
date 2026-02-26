/**
 * Unified EDF Parser
 * Merges functionalities from Wobble's edfParser and Dave's EDFFile.js.
 * Extracts ALL signals and converts them to physical values using the scaling factors.
 * 
 * Returns robust metadata and a map of signal labels -> physical value arrays.
 */

export const EDFParser = {

    /**
     * Parse an ArrayBuffer of an EDF file.
     * @param {ArrayBuffer} buffer
     * @returns {Object} { header: {}, signals: [] }
     */
    parse: function (buffer) {
        const view = new DataView(buffer);
        const decoder = new TextDecoder('ascii');

        // Helper to get exactly N ascii chars
        const getStr = (offset, len) => decoder.decode(new Uint8Array(buffer, offset, len)).trim();

        // Parse File Header (First 256 Bytes)
        let offset = 0;
        const header = {
            version: getStr(offset, 8),
            patientId: getStr(offset + 8, 80),
            recordingId: getStr(offset + 88, 80),
            startDate: getStr(offset + 168, 8),
            startTime: getStr(offset + 176, 8),
            headerBytes: parseInt(getStr(offset + 184, 8)),
            reserved: getStr(offset + 192, 44),
            numDataRecords: parseInt(getStr(offset + 236, 8)),
            recordDurationSec: parseFloat(getStr(offset + 244, 8)),
            numSignals: parseInt(getStr(offset + 252, 4))
        };

        const totalDurationMinutes = (header.numDataRecords * header.recordDurationSec) / 60;

        // Construct a proper Date object
        const dateParts = header.startDate.split('.'); // dd.mm.yy
        let year = parseInt(dateParts[2]);
        if (!isNaN(year)) {
            year += (year < 85) ? 2000 : 1900;
        }
        const timeParts = header.startTime.split('.'); // hh.mm.ss

        const recordingDateStr = new Date(
            year, parseInt(dateParts[1]) - 1, parseInt(dateParts[0]),
            parseInt(timeParts[0]) || 0, parseInt(timeParts[1]) || 0, parseInt(timeParts[2]) || 0
        ).toISOString();

        header.recordingDate = recordingDateStr;
        header.totalDurationMinutes = totalDurationMinutes;

        // Parse Signal Headers
        offset = 256;
        const signals = [];

        for (let i = 0; i < header.numSignals; i++) {
            signals.push({ label: getStr(offset + i * 16, 16) });
        }
        offset += header.numSignals * 16;

        for (let i = 0; i < header.numSignals; i++) signals[i].transducer = getStr(offset + i * 80, 80);
        offset += header.numSignals * 80;

        for (let i = 0; i < header.numSignals; i++) signals[i].physicalDimension = getStr(offset + i * 8, 8);
        offset += header.numSignals * 8;

        for (let i = 0; i < header.numSignals; i++) signals[i].physicalMin = parseFloat(getStr(offset + i * 8, 8));
        offset += header.numSignals * 8;

        for (let i = 0; i < header.numSignals; i++) signals[i].physicalMax = parseFloat(getStr(offset + i * 8, 8));
        offset += header.numSignals * 8;

        for (let i = 0; i < header.numSignals; i++) signals[i].digitalMin = parseInt(getStr(offset + i * 8, 8));
        offset += header.numSignals * 8;

        for (let i = 0; i < header.numSignals; i++) signals[i].digitalMax = parseInt(getStr(offset + i * 8, 8));
        offset += header.numSignals * 8;

        for (let i = 0; i < header.numSignals; i++) signals[i].prefiltering = getStr(offset + i * 80, 80);
        offset += header.numSignals * 80;

        for (let i = 0; i < header.numSignals; i++) {
            signals[i].numSamplesPerRecord = parseInt(getStr(offset + i * 8, 8));
            // Calculate sampling rate
            signals[i].samplingRate = signals[i].numSamplesPerRecord / header.recordDurationSec;
            // Precalculate scaling factor: (physMax - physMin) / (digMax - digMin)
            signals[i].scaleFactor = (signals[i].physicalMax - signals[i].physicalMin) / (signals[i].digitalMax - signals[i].digitalMin);
            // Array to hold the full physical waveform
            signals[i].physicalValues = [];
        }
        offset += header.numSignals * 8;

        // Skip reserved bytes
        offset += header.numSignals * 32;

        // Parse Data Records
        // The data is tightly packed 16-bit integers (little-endian)
        // Data records follow immediately after the header string (headerBytes)
        // Each record contains a block of `numSamplesPerRecord` samples for each signal sequentially
        offset = header.headerBytes;

        for (let record = 0; record < header.numDataRecords; record++) {
            for (let sig = 0; sig < header.numSignals; sig++) {
                const signal = signals[sig];
                const samples = signal.numSamplesPerRecord;

                for (let s = 0; s < samples; s++) {
                    const digitalValue = view.getInt16(offset, true); // true = little-endian
                    offset += 2; // 2 bytes per Int16

                    // Convert to physical value
                    let physVal = (digitalValue - signal.digitalMin) * signal.scaleFactor + signal.physicalMin;

                    // Special case for ResMed Flow in L/min, per Dave's tool
                    if (signal.label.toLowerCase().includes("flow") && signal.physicalDimension.toLowerCase() !== "l/min") {
                        // Typically flow is saved in L/sec. If the code or user expects L/min, some conversion might be needed.
                        // Wobble just kept raw physical, Dave's multiplied by 60 for Flow.
                        // We will stick to Dave's convention for Flow to keep GI accurate: L/min or raw? 
                        // Let's just store the exact physical value as described by the header.
                        // Wait, Dave's code multiplied by 60 if label included "Flow" and physFactor was applied.
                        // Often Resmed flow physical max is 30, but it's L/min or L/sec? Let's keep it raw for now,
                        // GI plugin can scale it if needed.
                    }

                    signal.physicalValues.push(physVal);
                }
            }
        }

        // To make it easy for algorithms to find the flow signal
        const flowSignal = signals.find(s => s.label.toLowerCase().includes('flow') || s.label.toLowerCase().includes('flw'));

        return {
            metadata: header,
            signals: signals,
            flowSignal: flowSignal || null
        };
    }
};
