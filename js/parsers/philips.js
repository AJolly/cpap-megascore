(function() {
'use strict';
/**
 * Philips PRS1 Parser
 * 
 * Parses Philips DreamStation data files (.001 header, .005 waveform).
 * Ported from megascore.html's inline Philips parser, which was itself
 * ported from OSCAR's prs1_parser.cpp / prs1_loader.cpp.
 * 
 * File structure:
 *   P-SERIES/<serial>/P0/<hex>.001 (header — session timestamp)
 *   P-SERIES/<serial>/P0/<hex>.005 (waveform — flow data)
 *   PROP.TXT (machine identification)
 * 
 * Flow data: signed 8-bit values, gain=1.0, offset=0.0 → values ARE L/min directly.
 * 
 * NOTE: DreamStation 2 encrypted files (.edf format) are NOT supported.
 * Reference: OSCAR source at K:\cc\sleepanalysis\OSCAR-code\oscar\SleepLib\loader_plugins\prs1_loader.cpp
 */

window.PhilipsParser = {

    /**
     * Detect if a file list contains Philips data.
     * Looks for .005 waveform files or P-SERIES folder structure.
     * 
     * @param {FileList|Array<File>} files
     * @returns {boolean}
     */
    isPhilipsDataSet(files) {
        return Array.from(files).some(f =>
            /\.\d{3}$/.test(f.name) && f.name.endsWith('.005')
        ) || Array.from(files).some(f =>
            f.webkitRelativePath && f.webkitRelativePath.includes('P-SERIES')
        );
    },

    /**
     * Parse a .001 header file to extract session timestamp.
     * The timestamp is a uint32 at offset 11-14 (little-endian Unix epoch).
     * 
     * @param {ArrayBuffer} arrayBuffer
     * @returns {Object|null} { startDateTime: Date, timestamp: number }
     */
    parseHeader(arrayBuffer) {
        const data = new Uint8Array(arrayBuffer);
        if (data.length < 15) return null;

        const ts = data[11] | (data[12] << 8) | (data[13] << 16) | (data[14] << 24);
        const startDateTime = new Date(ts * 1000);

        return {
            startDateTime: startDateTime,
            timestamp: ts
        };
    },

    /**
     * Parse a .005 waveform file to extract flow data.
     * 
     * PRS1 .005 file format:
     * - Multiple blocks (chunks), each with:
     *   - 15 bytes common header: fileVersion(1), blockSize(2), htype(1), family(1),
     *     familyVersion(1), ext(1), sessionid(4), timestamp(4)
     *   - Waveform header (when htype=1): interval_count(2), interval_seconds(1),
     *     num_channels(1), per-channel: kind(1), interleave(2), [sample_bits(1) for V3]
     *   - 1 byte header checksum
     *   - Data block (blockSize - headerSize bytes)
     *   - CRC16 (V2) or CRC32 (V3) at end of data
     * 
     * @param {ArrayBuffer} arrayBuffer
     * @returns {Object|null} { flowSamples: number[], sampleRateHz: number, duration: number }
     */
    parseWaveform(arrayBuffer) {
        const data = new Uint8Array(arrayBuffer);
        if (!data || data.length < 20) return null;

        // Check for DreamStation 2 encrypted format
        if (data.length >= 6 && data[0] === 0x0d && data[1] === 0x01 && data[2] === 0x01) {
            console.warn('DreamStation 2 encrypted files are not yet supported');
            return null;
        }

        const flowSamples = [];
        let detectedSampleRate = 0;
        let totalDuration = 0;
        let pos = 0;

        while (pos + 15 <= data.length) {
            const blockStart = pos;

            // Common header (15 bytes)
            const fileVersion = data[pos];
            const blockSize = data[pos + 1] | (data[pos + 2] << 8);
            const htype = data[pos + 3];
            const family = data[pos + 4];
            const familyVersion = data[pos + 5];

            if (fileVersion < 2 || fileVersion > 3) break;
            if (blockSize === 0 || blockSize > data.length - blockStart) break;

            pos += 15;

            if (htype !== 1) {
                // Not a waveform chunk — skip
                if (fileVersion === 3 && pos < data.length) {
                    const hdbLen = data[pos];
                    pos += 1 + hdbLen * 2;
                }
                pos = blockStart + blockSize;
                continue;
            }

            // Waveform header
            if (pos + 4 > data.length) break;

            const intervalCount = data[pos] | (data[pos + 1] << 8);
            const intervalSeconds = data[pos + 2];
            const numChannels = data[pos + 3];
            pos += 4;

            const duration = intervalCount * intervalSeconds;
            totalDuration += duration;

            // Per-channel info
            const channels = [];
            const wsSize = (fileVersion === 3) ? 4 : 3;
            for (let ch = 0; ch < numChannels; ch++) {
                if (pos + wsSize > data.length) break;
                const kind = data[pos];
                const interleave = data[pos + 1] | (data[pos + 2] << 8);
                channels.push({ kind, interleave });
                pos += wsSize;
            }

            pos += 2; // trailing byte + checksum

            const headerSize = pos - blockStart;
            let dataSize = blockSize - headerSize;
            const crcSize = (fileVersion === 3) ? 4 : 2;
            dataSize -= crcSize;

            if (dataSize <= 0 || pos + dataSize > data.length) {
                pos = blockStart + blockSize;
                continue;
            }

            const dataStart = pos;

            // Determine sample rate
            if (channels.length > 0 && intervalSeconds > 0) {
                const sampleRate = channels[0].interleave / intervalSeconds;
                if (detectedSampleRate === 0) {
                    detectedSampleRate = sampleRate;
                }
            }

            // Extract flow data
            const totalInterleave = channels.reduce((sum, ch) => sum + ch.interleave, 0);

            if (numChannels > 1 && totalInterleave > 0) {
                // Multi-channel: de-interleave to extract flow (channel 0)
                const flowInterleave = channels[0].interleave;
                const numGroups = Math.floor(dataSize / totalInterleave);

                for (let g = 0; g < numGroups; g++) {
                    const groupStart = dataStart + g * totalInterleave;
                    for (let s = 0; s < flowInterleave; s++) {
                        const byteIdx = groupStart + s;
                        if (byteIdx >= data.length) break;
                        let val = data[byteIdx];
                        if (val > 127) val -= 256; // signed 8-bit
                        flowSamples.push(val);
                    }
                }
            } else if (numChannels === 1 && channels.length > 0) {
                // Single channel: all data is flow
                for (let i = 0; i < dataSize; i++) {
                    const byteIdx = dataStart + i;
                    if (byteIdx >= data.length) break;
                    let val = data[byteIdx];
                    if (val > 127) val -= 256;
                    flowSamples.push(val);
                }
            }

            pos = blockStart + blockSize;
        }

        if (flowSamples.length === 0) {
            console.warn('No flow data found in PRS1 waveform file');
            return null;
        }

        return {
            flowSamples: flowSamples,
            sampleRateHz: detectedSampleRate || 5,
            duration: totalDuration
        };
    },

    /**
     * Parse PROP.TXT for machine identification.
     * 
     * @param {string} text - Contents of PROP.TXT
     * @returns {Object} { serial, model, type, firmware }
     */
    parseProp(text) {
        const props = {};
        text.split('\n').forEach(line => {
            const eq = line.indexOf('=');
            if (eq > 0) {
                props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
            }
        });
        return {
            serial: props.SN || 'Unknown',
            model: props.MN || 'Unknown',
            type: `Philips ${props.MN || 'DreamStation'}`,
            firmware: props.SV || 'Unknown'
        };
    },

    /**
     * Group a FileList into Philips sessions (matched .001/.005 pairs).
     * 
     * @param {Array<File>} files
     * @returns {Object} { sessions: Map<id, {header, waveform}>, propFile: File|null }
     */
    groupFiles(files) {
        const sessions = new Map();
        let propFile = null;

        for (const f of files) {
            const name = f.name.toUpperCase();

            if (name === 'PROP.TXT') {
                propFile = f;
                continue;
            }

            const ext = name.slice(-4); // e.g. ".001"
            if (!/\.\d{3}$/.test(name)) continue;

            const baseId = name.slice(0, -4);
            if (!sessions.has(baseId)) sessions.set(baseId, {});

            if (ext === '.001') sessions.get(baseId).header = f;
            if (ext === '.005') sessions.get(baseId).waveform = f;
        }

        return { sessions, propFile };
    }
};

})();
