(function() {
'use strict';
(function () {
    'use strict';
    /**
     * Wobble Analysis Plugin
     * Ported from Wobble Analysis Tool (React/Vite) to the Vanilla JS Plugin Architecture.
     * 
     * Provides:
     * - Flow Limitation (Flatness)
     * - Respiratory Arousal Estimation
     * - Sample Entropy (Regularity)
     * - FFT-based Periodicity (Periodic Breathing)
     */

    window.WobbleAnalyzer = {
        id: "wobble_core",
        name: "Ventilatory Stability (Wobble)",

        tableColumns: [
            { key: "wobbleFL", label: "FL Score (%)" },
            { key: "wobbleArousal", label: "Est. Arousals (/hr)" },
            { key: "wobbleRegularity", label: "Regularity Score" },
            { key: "wobblePeriodicity", label: "Periodicity Index" }
        ],

        process: function (flowData, samplingRate, settings) {

            // 1. Flow Limitation
            const breaths = [];
            let inInspiration = false;
            let inspirationStart = 0;
            let currentBreath = null;

            for (let i = 1; i < flowData.length; i++) {
                if (flowData[i] > 0 && flowData[i - 1] <= 0) {
                    inspirationStart = i;
                    inInspiration = true;
                    currentBreath = {
                        start: i,
                        end: i,
                        inspStart: inspirationStart,
                        inspEnd: i,
                        startTime: i / samplingRate
                    };
                    breaths.push(currentBreath);
                } else if (flowData[i] <= 0 && flowData[i - 1] > 0) {
                    if (inInspiration && currentBreath) {
                        currentBreath.inspEnd = i;
                        currentBreath.end = i;
                        currentBreath.endTime = i / samplingRate;
                    }
                    inInspiration = false;
                }
            }

            const flScores = [];
            const topPercent = settings.flTopPercentage || 0.5;
            const targetVar = settings.flFlatnessTarget || 0.05;

            for (const breath of breaths) {
                const inspFlow = flowData.slice(breath.inspStart, breath.inspEnd);
                if (inspFlow.length < 10) continue;

                const maxFlow = Math.max(...inspFlow);
                if (maxFlow < 0.1) continue;

                const normalizedFlow = inspFlow.map(f => f / maxFlow);

                const topHalfStart = normalizedFlow.findIndex(f => f > topPercent);
                const topHalfEnd = normalizedFlow.length - [...normalizedFlow].reverse().findIndex(f => f > topPercent);

                if (topHalfStart >= 0 && topHalfEnd > topHalfStart) {
                    const topHalf = normalizedFlow.slice(topHalfStart, topHalfEnd);
                    const topHalfMean = topHalf.reduce((a, b) => a + b) / topHalf.length;
                    const topHalfVariance = topHalf.reduce((sum, val) => {
                        const diff = val - topHalfMean;
                        return sum + diff * diff;
                    }, 0) / topHalf.length;

                    const flatness = Math.max(0, Math.min(100, (targetVar - topHalfVariance) / targetVar * 100));
                    flScores.push(flatness);
                }
            }

            let flScore = flScores.length > 0 ? flScores.reduce((a, b) => a + b) / flScores.length : 0;

            // 2. Arousal Estimation
            let arousals = 0;
            const totalDurationHours = (flowData.length / samplingRate) / 3600;

            if (breaths.length >= 10 && totalDurationHours > 0) {
                const breathMetrics = [];
                for (let i = 1; i < breaths.length; i++) {
                    const breath = breaths[i];
                    const prevBreath = breaths[i - 1];

                    const breathDuration = breath.startTime - prevBreath.startTime;
                    if (breathDuration <= 0 || breathDuration > 20) continue;

                    const respiratoryRate = 60 / breathDuration;
                    const inspFlow = flowData.slice(breath.inspStart, breath.inspEnd);
                    const tidalVolume = inspFlow.reduce((sum, f) => sum + Math.abs(f), 0) / samplingRate;

                    breathMetrics.push({
                        time: breath.startTime, rate: respiratoryRate, volume: tidalVolume, breathIndex: i
                    });
                }

                const arousalList = [];
                const baselineWindow = settings.arousalBaselineWindowSec || 120;
                const minRateInc = settings.arousalRateIncreaseMin || 0.20;
                const minVolInc = settings.arousalVolIncreaseMin || 0.30;

                for (let i = 0; i < breathMetrics.length; i++) {
                    const currentMetric = breathMetrics[i];
                    const baselineStart = Math.max(0, i - Math.floor(baselineWindow / (60 / currentMetric.rate)));
                    const baselineMetrics = breathMetrics.slice(baselineStart, i);

                    if (baselineMetrics.length < 5) continue;

                    const baselineRate = baselineMetrics.reduce((sum, m) => sum + m.rate, 0) / baselineMetrics.length;
                    const baselineVolume = baselineMetrics.reduce((sum, m) => sum + m.volume, 0) / baselineMetrics.length;

                    const rateIncrease = (currentMetric.rate - baselineRate) / baselineRate;
                    const volumeIncrease = (currentMetric.volume - baselineVolume) / baselineVolume;

                    if (rateIncrease > minRateInc || volumeIncrease > minVolInc) {
                        const recentArousal = arousalList.length > 0 &&
                            (currentMetric.time - arousalList[arousalList.length - 1].time) < 15;
                        if (!recentArousal) {
                            arousalList.push({ time: currentMetric.time });
                        }
                    }
                }
                arousals = arousalList.length / totalDurationHours;
            }

            // 3. Minute Ventilation / Entropy / FFT
            let regularityScore = 0;
            let periodicityIndex = 0;

            const windowSize = Math.floor(60 * samplingRate);
            const stepSize = Math.floor(5 * samplingRate);
            const minuteVent = [];

            for (let i = 0; i < flowData.length - windowSize; i += stepSize) {
                const window = flowData.slice(i, i + windowSize);
                let tidalVolume = 0;
                let breathCount = 0;
                let inInh = false;

                for (let j = 1; j < window.length; j++) {
                    if (window[j] > 0 && window[j - 1] <= 0) {
                        breathCount++;
                        inInh = true;
                    }
                    if (inInh && window[j] > 0) {
                        tidalVolume += Math.abs(window[j]) / samplingRate;
                    }
                    if (window[j] <= 0) {
                        inInh = false;
                    }
                }
                minuteVent.push((tidalVolume * breathCount) / 60);
            }

            if (minuteVent.length > 0) {
                const mvMean = minuteVent.reduce((a, b) => a + b) / minuteVent.length;
                const detrended = minuteVent.map(v => v - mvMean);

                // Entropy (Regularity)
                const variance = minuteVent.reduce((sum, val) => sum + Math.pow(val - mvMean, 2), 0) / minuteVent.length;
                const r = 0.2 * Math.sqrt(variance);

                const countMatches = (m) => {
                    let count = 0;
                    const N = minuteVent.length;
                    for (let i = 0; i < N - m; i++) {
                        for (let j = i + 1; j < N - m; j++) {
                            let match = true;
                            for (let k = 0; k < m; k++) {
                                if (Math.abs(minuteVent[i + k] - minuteVent[j + k]) > r) {
                                    match = false; break;
                                }
                            }
                            if (match) count++;
                        }
                    }
                    return count;
                };

                const B = countMatches(2);
                const A = countMatches(3);
                const sampleEntropy = (B === 0 || A === 0) ? 0 : -Math.log(A / B);
                regularityScore = Math.max(0, Math.min(100, 100 - (sampleEntropy / 2.5) * 100));

                // Fix 5: Iterative in-place FFT (replaces recursive version that could stack-overflow)
                const fft = (x) => {
                    const N = x.length;
                    // Bit-reversal permutation
                    for (let i = 1, j = 0; i < N; i++) {
                        let bit = N >> 1;
                        for (; j & bit; bit >>= 1) { j ^= bit; }
                        j ^= bit;
                        if (i < j) { const tmp = x[i]; x[i] = x[j]; x[j] = tmp; }
                    }
                    // Cooley-Tukey iterative
                    for (let len = 2; len <= N; len *= 2) {
                        const halfLen = len / 2;
                        const angle = -2 * Math.PI / len;
                        const wRe = Math.cos(angle), wIm = Math.sin(angle);
                        for (let i = 0; i < N; i += len) {
                            let curRe = 1, curIm = 0;
                            for (let j = 0; j < halfLen; j++) {
                                const tRe = curRe * x[i + j + halfLen].re - curIm * x[i + j + halfLen].im;
                                const tIm = curRe * x[i + j + halfLen].im + curIm * x[i + j + halfLen].re;
                                x[i + j + halfLen] = { re: x[i + j].re - tRe, im: x[i + j].im - tIm };
                                x[i + j] = { re: x[i + j].re + tRe, im: x[i + j].im + tIm };
                                const newCurRe = curRe * wRe - curIm * wIm;
                                curIm = curRe * wIm + curIm * wRe;
                                curRe = newCurRe;
                            }
                        }
                    }
                    return x;
                };

                const n = Math.pow(2, Math.ceil(Math.log2(detrended.length)));
                const paddedForFFT = [...detrended, ...new Array(n - detrended.length).fill(0)];
                const complex = paddedForFFT.map(v => ({ re: v, im: 0 }));

                try {
                    const spectrum = fft(complex);
                    const power = spectrum.slice(0, n / 2).map(c => Math.sqrt(c.re * c.re + c.im * c.im));
                    const dt = 5;
                    const freqs = power.map((_, i) => i / (n * dt));
                    const totalPower = power.reduce((a, b) => a + b, 0);
                    const pbPower = power.filter((p, i) => freqs[i] >= 0.01 && freqs[i] <= 0.03).reduce((a, b) => a + b, 0);
                    periodicityIndex = Math.min(100, (pbPower / totalPower) * 200);
                } catch (e) {
                    console.error("FFT computation failed", e);
                }
            }

            return {
                wobbleFL: flScore.toFixed(1),
                wobbleArousal: arousals.toFixed(1),
                wobbleRegularity: regularityScore.toFixed(1),
                wobblePeriodicity: periodicityIndex.toFixed(1)
            };
        }
    };

})();

})();
