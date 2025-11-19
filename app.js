        const fileInput = document.getElementById('fileInput');
        const tracksListEl = document.getElementById('tracksList');
        const trackCountEl = document.getElementById('trackCount');
        const renderBtn = document.getElementById('renderBtn');
        const statusMessage = document.getElementById('statusMessage');
        const infoText = document.getElementById('infoText');
        const durationInput = document.getElementById('duration');
        const bassSlider = document.getElementById('bassBoost');
        const bassValue = document.getElementById('bassBoostValue');
        const echoSlider = document.getElementById('echoAmount');
        const echoValue = document.getElementById('echoValue');
        const flangerBtn = document.getElementById('flangerBtn');
        const reverbBtn = document.getElementById('reverbBtn');
        const uploadLabel = document.getElementById('uploadLabel');
        const playerSection = document.getElementById('playerSection');
        const previewAudioEl = document.getElementById('preview');

        let flangerOn = false;
        let reverbOn = false;
        let tracks = [];
        let decodeCtx = null;

        function getDecodeCtx() {
            if (!decodeCtx) decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
            return decodeCtx;
        }

        function showStatus(text, type = 'info', autoHide = true) {
            statusMessage.textContent = text;
            statusMessage.className = `status-message ${type}`;
            statusMessage.style.display = 'block';
            if (autoHide) setTimeout(() => { statusMessage.style.display = 'none'; }, 3000);
        }

        function updateUI() {
            trackCountEl.textContent = tracks.length;
            renderBtn.disabled = tracks.length < 2;
            
            if (tracks.length >= 5) {
                uploadLabel.classList.add('disabled');
                fileInput.disabled = true;
            } else {
                uploadLabel.classList.remove('disabled');
                fileInput.disabled = false;
            }

            if (tracks.length === 0) {
                infoText.textContent = 'Add 2-5 tracks to get started';
            } else if (tracks.length === 1) {
                infoText.textContent = 'Add at least 1 more track';
            } else {
                infoText.textContent = `Ready to create mashup with ${tracks.length} tracks`;
            }
        }

        function renderTrackList() {
            tracksListEl.innerHTML = '';
            tracks.forEach((t, i) => {
                const div = document.createElement('div');
                div.className = 'track-item';
                const dur = t.buffer ? `${t.buffer.duration.toFixed(1)}s` : 'loading...';
                div.innerHTML = `
                    <div class="track-info">
                        <div class="track-name">${i + 1}. ${escapeHtml(t.name)}</div>
                        <div class="track-details">${dur}</div>
                    </div>
                    <button class="remove-btn" data-index="${i}">Remove</button>
                `;
                tracksListEl.appendChild(div);
            });
            
            document.querySelectorAll('.remove-btn').forEach(b => {
                b.onclick = () => removeTrack(Number(b.dataset.index));
            });
            
            updateUI();
        }

        function escapeHtml(s = '') {
            return s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
        }

        fileInput.addEventListener('change', async (ev) => {
            const f = ev.target.files && ev.target.files[0];
            if (!f) return;
            
            if (tracks.length >= 5) {
                showStatus('Maximum 5 tracks allowed', 'error');
                fileInput.value = '';
                return;
            }

            const id = Date.now() + Math.floor(Math.random() * 1000);
            const t = { id, name: f.name, file: f, url: URL.createObjectURL(f) };
            tracks.push(t);
            renderTrackList();
            showStatus(`Loading ${f.name}...`, 'info');

            try {
                await decodeFileToBuffer(t);
                showStatus(`Loaded ${f.name} (${t.buffer.duration.toFixed(1)}s)`, 'success');
            } catch (err) {
                console.error(err);
                showStatus('Failed to decode file', 'error');
                tracks = tracks.filter(x => x.id !== id);
            } finally {
                renderTrackList();
                fileInput.value = '';
            }
        });

        function removeTrack(i) {
            const t = tracks[i];
            if (t && t.url) URL.revokeObjectURL(t.url);
            tracks.splice(i, 1);
            renderTrackList();
        }

        async function decodeFileToBuffer(track) {
            if (!track.arrayBuffer) track.arrayBuffer = await track.file.arrayBuffer();
            const ctx = getDecodeCtx();
            return new Promise((resolve, reject) => {
                ctx.decodeAudioData(track.arrayBuffer.slice(0), buf => { track.buffer = buf; resolve(buf); }, err => reject(err));
            });
        }

        async function prepareSegmentBuffers(buffers, perTrackLengthSec, targetSampleRate) {
            const sr = targetSampleRate;
            const segmentFrames = Math.floor(perTrackLengthSec * sr);
            const segmentBuffers = [];

            for (let i = 0; i < buffers.length; i++) {
                let src = buffers[i];
                if (src.sampleRate !== sr) src = await resampleAudioBuffer(src, sr);
                const numCh = src.numberOfChannels;
                const out = new OfflineAudioContext(numCh, segmentFrames, sr).createBuffer(numCh, segmentFrames, sr);
                
                // Analyze audio to find energetic sections
                const energy = analyzeEnergy(src, sr);
                const startFrame = selectBestSegment(energy, segmentFrames, src.length);
                
                for (let ch = 0; ch < numCh; ch++) {
                    const outData = out.getChannelData(ch);
                    const srcData = src.getChannelData(ch);
                    for (let k = 0; k < segmentFrames; k++) {
                        const sIdx = startFrame + k;
                        outData[k] = (sIdx < srcData.length) ? srcData[sIdx] : 0;
                    }
                }
                segmentBuffers.push(out);
            }
            return segmentBuffers;
        }

        function analyzeEnergy(buffer, sampleRate) {
            const windowSize = Math.floor(sampleRate * 0.5); // 500ms windows
            const data = buffer.getChannelData(0);
            const energyMap = [];
            
            for (let i = 0; i < data.length; i += windowSize) {
                let sum = 0;
                const end = Math.min(i + windowSize, data.length);
                
                for (let j = i; j < end; j++) {
                    sum += Math.abs(data[j]);
                }
                energyMap.push({
                    startFrame: i,
                    energy: sum / (end - i)
                });
            }
            return energyMap;
        }

        function selectBestSegment(energyMap, neededFrames, totalFrames) {
            // Skip intro (first 15%) and outro (last 15%)
            const skipStart = Math.floor(totalFrames * 0.15);
            const skipEnd = Math.floor(totalFrames * 0.85);
            
            if (skipEnd - skipStart < neededFrames) {
                // Song too short, use middle
                return Math.max(0, Math.floor((totalFrames - neededFrames) / 2));
            }
            
            // Find highest energy segment that fits
            let maxEnergy = -1;
            let bestStartFrame = skipStart;
            
            for (let i = 0; i < energyMap.length; i++) {
                const startFrame = energyMap[i].startFrame;
                const endFrame = startFrame + neededFrames;
                
                // Check if segment fits in usable range
                if (startFrame >= skipStart && endFrame <= skipEnd && endFrame <= totalFrames) {
                    // Calculate average energy for this segment
                    let totalEnergy = 0;
                    let count = 0;
                    
                    for (let j = i; j < energyMap.length; j++) {
                        if (energyMap[j].startFrame < endFrame) {
                            totalEnergy += energyMap[j].energy;
                            count++;
                        } else {
                            break;
                        }
                    }
                    
                    const avgEnergy = count > 0 ? totalEnergy / count : 0;
                    
                    if (avgEnergy > maxEnergy) {
                        maxEnergy = avgEnergy;
                        bestStartFrame = startFrame;
                    }
                }
            }
            
            return bestStartFrame;
        }

        async function resampleAudioBuffer(srcBuffer, targetSampleRate) {
            if (srcBuffer.sampleRate === targetSampleRate) return srcBuffer;
            const numChannels = srcBuffer.numberOfChannels;
            const duration = srcBuffer.duration;
            const offline = new OfflineAudioContext(numChannels, Math.ceil(duration * targetSampleRate), targetSampleRate);
            const src = offline.createBufferSource();
            src.buffer = srcBuffer;
            src.connect(offline.destination);
            src.start(0);
            return await offline.startRendering();
        }

        async function renderSegmentsWithEffects(segmentBuffers, totalDurationSec, crossfadeSec) {
            const sr = segmentBuffers[0].sampleRate;
            const totalFrames = Math.floor(totalDurationSec * sr);
            const numChannels = Math.max(...segmentBuffers.map(b => b.numberOfChannels));
            const offline = new OfflineAudioContext(numChannels, totalFrames, sr);

            const bass = offline.createBiquadFilter();
            bass.type = 'lowshelf';
            bass.frequency.value = 120;
            bass.gain.value = Number(bassSlider.value) || 0;

            let echoNode = null;
            const echoAmount = Number(echoSlider.value);
            if (echoAmount > 0) {
                const delay = offline.createDelay();
                delay.delayTime.value = 0.3;
                const feedback = offline.createGain();
                feedback.gain.value = echoAmount / 200;
                const mix = offline.createGain();
                mix.gain.value = echoAmount / 100;
                delay.connect(feedback).connect(delay);
                delay.connect(mix);
                echoNode = { input: delay, output: mix };
            }

            let flangerNode = null;
            if (flangerOn) {
                const delay = offline.createDelay();
                delay.delayTime.value = 0.005;
                const lfo = offline.createOscillator();
                lfo.frequency.value = 0.5;
                const lfoGain = offline.createGain();
                lfoGain.gain.value = 0.002;
                lfo.connect(lfoGain).connect(delay.delayTime);
                lfo.start(0);
                flangerNode = delay;
            }

            let reverbNode = null;
            if (reverbOn) {
                reverbNode = offline.createConvolver();
                const ir = offline.createBuffer(2, sr * 2, sr);
                for (let ch = 0; ch < 2; ch++) {
                    const data = ir.getChannelData(ch);
                    for (let i = 0; i < data.length; i++) {
                        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
                    }
                }
                reverbNode.buffer = ir;
            }

            const connectChain = (src) => {
                let node = src;
                node.connect(bass);
                node = bass;
                if (echoNode) {
                    node.connect(echoNode.input);
                    echoNode.output.connect(offline.destination);
                }
                if (flangerNode) {
                    node.connect(flangerNode);
                    node = flangerNode;
                }
                if (reverbNode) {
                    node.connect(reverbNode);
                    node = reverbNode;
                }
                node.connect(offline.destination);
            };

            const N = segmentBuffers.length;
            const step = (totalDurationSec + (N - 1) * crossfadeSec) / N - crossfadeSec;
            const startTimes = Array.from({ length: N }, (_, i) => i * step);

            for (let i = 0; i < N; i++) {
                const srcBuf = segmentBuffers[i];
                const src = offline.createBufferSource();
                src.buffer = srcBuf;
                const gain = offline.createGain();
                src.connect(gain);
                connectChain(gain);

                const segDur = srcBuf.duration;
                const cross = Math.min(crossfadeSec, segDur / 2);
                const steps = 128;
                const fadeIn = new Float32Array(steps).map((_, k) => Math.sin((k / (steps - 1)) * Math.PI / 2));
                const fadeOut = new Float32Array(steps).map((_, k) => Math.cos((k / (steps - 1)) * Math.PI / 2));
                
                gain.gain.setValueAtTime(0, startTimes[i]);
                gain.gain.setValueCurveAtTime(fadeIn, startTimes[i], cross);
                const foStart = startTimes[i] + segDur - cross;
                if (foStart > startTimes[i]) gain.gain.setValueCurveAtTime(fadeOut, foStart, cross);

                src.start(startTimes[i]);
            }

            return await offline.startRendering();
        }

        function encodeWAV(audioBuffer) {
            const numChannels = audioBuffer.numberOfChannels;
            const sampleRate = audioBuffer.sampleRate;
            const length = audioBuffer.length * numChannels * 2 + 44;
            const buffer = new ArrayBuffer(length);
            const view = new DataView(buffer);
            
            function writeString(offset, str) {
                for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
            }
            
            writeString(0, 'RIFF');
            view.setUint32(4, 36 + audioBuffer.length * numChannels * 2, true);
            writeString(8, 'WAVE');
            writeString(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, numChannels, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * numChannels * 2, true);
            view.setUint16(32, numChannels * 2, true);
            view.setUint16(34, 16, true);
            writeString(36, 'data');
            view.setUint32(40, audioBuffer.length * numChannels * 2, true);
            
            let offset = 44;
            for (let i = 0; i < audioBuffer.length; i++) {
                for (let ch = 0; ch < numChannels; ch++) {
                    let sample = audioBuffer.getChannelData(ch)[i];
                    sample = Math.max(-1, Math.min(1, sample));
                    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
                    offset += 2;
                }
            }
            return new Blob([view], { type: 'audio/wav' });
        }

        renderBtn.addEventListener('click', async () => {
            try {
                if (tracks.length < 2) throw new Error('Add at least 2 tracks');
                
                const totalDuration = Number(durationInput.value) || 30;
                const buffers = tracks.map(t => t.buffer);
                
                showStatus('Preparing tracks...', 'info', false);
                const segmentBuffers = await prepareSegmentBuffers(buffers, totalDuration / buffers.length, buffers[0].sampleRate);
                
                showStatus('Applying effects...', 'info', false);
                const rendered = await renderSegmentsWithEffects(segmentBuffers, totalDuration, 1.5);
                
                showStatus('Encoding audio...', 'info', false);
                const wavBlob = encodeWAV(rendered);
                
                const url = URL.createObjectURL(wavBlob);
                previewAudioEl.src = url;
                playerSection.style.display = 'block';
                previewAudioEl.play().catch(() => {});
                
                const a = document.createElement('a');
                a.href = url;
                a.download = `mashup-${Date.now()}.wav`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                
                showStatus('✨ Mashup ready!', 'success');
            } catch (err) {
                console.error(err);
                showStatus('Error: ' + err.message, 'error');
            }
        });

        bassSlider.addEventListener('input', () => {
            bassValue.textContent = bassSlider.value + ' dB';
        });

        echoSlider.addEventListener('input', () => {
            echoValue.textContent = echoSlider.value + '%';
        });

        flangerBtn.addEventListener('click', () => {
            flangerOn = !flangerOn;
            flangerBtn.textContent = flangerOn ? 'ON' : 'OFF';
            flangerBtn.classList.toggle('active');
        });

        reverbBtn.addEventListener('click', () => {
            reverbOn = !reverbOn;
            reverbBtn.textContent = reverbOn ? 'ON' : 'OFF';
            reverbBtn.classList.toggle('active');
        });

        updateUI();