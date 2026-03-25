/* 
Copyright 2026
This file contains the parser for Philips PRS1 (e.g. DreamStation) CPAP data files.
Ported from OSCAR's prs1_parser.cpp / prs1_loader.cpp.
*/

/**
 * Detect Philips by presence of .005 waveform files or P-SERIES folder structure
 */
function isPhilipsDataSet(files) {
    return files.some(f => /\.\d{3}$/.test(f.name) && f.name.endsWith('.005')) ||
        files.some(f => f.webkitRelativePath && f.webkitRelativePath.includes('P-SERIES'));
}

/**
 * Parse a Philips PRS1 .001 header file to extract session timestamp.
 * The timestamp is a uint32 at offset 11-14 (little-endian Unix epoch).
 */
function parsePhilipsHeader(arrayBuffer) {
    const data = new Uint8Array(arrayBuffer);
    if (data.length < 15) return null;

    // Read timestamp: little-endian uint32 at offset 11
    const ts = data[11] | (data[12] << 8) | (data[13] << 16) | (data[14] << 24);
    const startDateTime = new Date(ts * 1000);

    return {
        startDateTime: startDateTime,
        timestamp: ts
    };
}

/**
 * Parse a Philips PRS1 .005 waveform file to extract flow and pressure data.
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
 * Channel 0 is flow (signed 8-bit, gain=1.0) -> values ARE L/min directly.
 * Channel 1 is mask pressure (unsigned 8-bit, gain varies by family).
 *
 * Returns: { flowSamples: number[], pressureSamples: number[], sampleRateHz: number, duration: number }
 */
function parsePhilipsWaveform(arrayBuffer) {
    const data = new Uint8Array(arrayBuffer);
    if (!data || data.length < 20) return null;

    // Check for DreamStation 2 encrypted format
    if (data.length >= 6 && data[0] === 0x0d && data[1] === 0x01 && data[2] === 0x01) {
        console.warn('DreamStation 2 encrypted files are not yet supported in browser');
        return null;
    }

    const flowSamples = [];
    const pressureSamples = [];
    let detectedSampleRate = 0;
    let totalDuration = 0;
    let pos = 0;
    let pressureGain = 0.1; // Standard pressure gain

    // Parse blocks/chunks
    while (pos + 15 <= data.length) {
        const blockStart = pos;

        // --- Common header (15 bytes) ---
        const fileVersion = data[pos];       // Should be 2 or 3
        const blockSize = data[pos + 1] | (data[pos + 2] << 8);
        const htype = data[pos + 3];          // 0=normal, 1=waveform/interval
        const family = data[pos + 4];
        const familyVersion = data[pos + 5];
        const ext = data[pos + 6];
        // sessionid at [7..10], timestamp at [11..14]

        // Determine pressure gain based on family and version (like prs1_loader.cpp)
        if ((family === 5 && (familyVersion === 2 || familyVersion === 3)) ||
            (family === 3 && familyVersion === 6)) {
            pressureGain = 0.125;
        }

        // Sanity checks
        if (fileVersion < 2 || fileVersion > 3) {
            console.warn(`PRS1 block at ${pos}: unsupported fileVersion ${fileVersion}, stopping`);
            break;
        }
        if (blockSize === 0 || blockSize > data.length - blockStart) {
            console.warn(`PRS1 block at ${pos}: blockSize ${blockSize} exceeds file, stopping`);
            break;
        }

        pos += 15; // past common header

        if (htype !== 1) {
            // Not a waveform chunk (normal chunk)
            // Skip to end of block based on fileVersion
            if (fileVersion === 3) {
                // V3 has extra header fields: 1 byte count + count*2 bytes key-value pairs
                if (pos < data.length) {
                    const hdbLen = data[pos];
                    pos += 1 + hdbLen * 2;
                }
            }
            // Skip 1 byte header checksum + remaining data
            pos = blockStart + blockSize;
            continue;
        }

        // --- Waveform header ---
        if (pos + 4 > data.length) break;

        const intervalCount = data[pos] | (data[pos + 1] << 8);  // number of intervals
        const intervalSeconds = data[pos + 2];                    // seconds per interval
        const numChannels = data[pos + 3];                        // number of waveform channels
        pos += 4;

        const duration = intervalCount * intervalSeconds;
        totalDuration += duration;

        // Parse per-channel waveform info
        const channels = [];
        const wsSize = (fileVersion === 3) ? 4 : 3;
        for (let ch = 0; ch < numChannels; ch++) {
            if (pos + wsSize > data.length) break;
            const kind = data[pos];
            const interleave = data[pos + 1] | (data[pos + 2] << 8); // samples per interval
            // fileVersion 3 has an extra byte (sample size in bits, always 8)
            channels.push({ kind, interleave });
            pos += wsSize;
        }

        // Skip trailing byte (always 0) + 1 byte header checksum
        pos += 2;  // trailing byte + checksum

        // Calculate data size
        const headerSize = pos - blockStart;
        let dataSize = blockSize - headerSize;
        // CRC at end: 2 bytes for V2, 4 bytes for V3
        const crcSize = (fileVersion === 3) ? 4 : 2;
        dataSize -= crcSize;

        if (dataSize <= 0 || pos + dataSize > data.length) {
            pos = blockStart + blockSize;
            continue;
        }

        const dataStart = pos;

        // Determine sample rate from first channel
        if (channels.length > 0 && intervalSeconds > 0) {
            const sampleRate = channels[0].interleave / intervalSeconds;
            if (detectedSampleRate === 0) {
                detectedSampleRate = sampleRate;
                console.log(`PRS1 waveform: ${numChannels} channels, ` +
                    `${channels[0].interleave} samples/interval, ` +
                    `${intervalSeconds}s intervals → ${sampleRate} Hz, ` +
                    `family F${family}V${familyVersion}`);
            }
        }

        // Calculate total interleave stride (bytes per sample group)
        const totalInterleave = channels.reduce((sum, ch) => sum + ch.interleave, 0);

        if (numChannels > 1 && totalInterleave > 0) {
            // Multi-channel: de-interleave to extract flow (channel 0) and pressure (channel 1)
            // Each "sample group" has channels[0].interleave bytes of flow,
            // then channels[1].interleave bytes of pressure, etc.
            const flowInterleave = channels[0].interleave;
            const pressureInterleave = channels.length > 1 ? channels[1].interleave : 0;
            const numGroups = Math.floor(dataSize / totalInterleave);

            for (let g = 0; g < numGroups; g++) {
                const groupStart = dataStart + g * totalInterleave;
                
                // Extract flow samples for this group
                for (let s = 0; s < flowInterleave; s++) {
                    const byteIdx = groupStart + s;
                    if (byteIdx >= data.length) break;
                    // Signed 8-bit: raw value IS L/min (gain=1.0, offset=0.0)
                    let val = data[byteIdx];
                    if (val > 127) val -= 256;  // Convert to signed
                    flowSamples.push(val);
                }
                
                // Extract pressure samples for this group
                if (pressureInterleave > 0) {
                    const pressureGroupStart = groupStart + flowInterleave;
                    for (let s = 0; s < pressureInterleave; s++) {
                        const byteIdx = pressureGroupStart + s;
                        if (byteIdx >= data.length) break;
                        // Unsigned 8-bit, gain = pressureGain
                        let val = data[byteIdx];
                        pressureSamples.push(val * pressureGain);
                    }
                }
            }
        } else if (numChannels === 1 && channels.length > 0) {
            // Single channel: all data is flow
            for (let i = 0; i < dataSize; i++) {
                const byteIdx = dataStart + i;
                if (byteIdx >= data.length) break;
                let val = data[byteIdx];
                if (val > 127) val -= 256;  // Signed 8-bit
                flowSamples.push(val);
            }
        }

        // Skip to next block
        pos = blockStart + blockSize;
    }

    if (flowSamples.length === 0) {
        console.warn('No flow data found in PRS1 waveform file');
        return null;
    }

    const sampleRateHz = detectedSampleRate || 5;  // Default 5 Hz per OSCAR (.005 interleave=5)
    console.log(`PRS1 parsed: ${flowSamples.length} flow samples, ${pressureSamples.length} pressure samples, ` +
        `${sampleRateHz} Hz, ${totalDuration}s duration`);

    return {
        flowSamples: flowSamples,
        pressureSamples: pressureSamples,
        sampleRateHz: sampleRateHz,
        duration: totalDuration
    };
}

/**
 * Parse PROP.TXT for machine identification
 */
function parsePhilipsProp(text) {
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
}
