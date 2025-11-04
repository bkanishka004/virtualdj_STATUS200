(() => {
  const fileAInput = document.getElementById('fileA');
  const fileBInput = document.getElementById('fileB');
  const fileAName = document.getElementById('fileAName');
  const fileBName = document.getElementById('fileBName');
  const createBtn = document.getElementById('createMashup');
  const downloadBtn = document.getElementById('downloadWav');
  const previewEl = document.getElementById('preview');
  const bassSlider = document.getElementById('bassGain');
  const trebleSlider = document.getElementById('trebleGain');
  const bassValue = document.getElementById('bassValue');
  const trebleValue = document.getElementById('trebleValue');
  const messagesEl = document.getElementById('messages');

  let audioContext;
  let decodedA; // AudioBuffer
  let decodedB; // AudioBuffer
  let renderedBuffer; // AudioBuffer of mashup
  let renderedWavBlob; // Blob of exported WAV

  function ensureCtx() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
  }

  function log(message, isError = false) {
    const div = document.createElement('div');
    div.className = 'msg' + (isError ? ' error' : '');
    div.textContent = message;
    messagesEl.prepend(div);
  }

  function updateButtons() {
    const ready = !!decodedA && !!decodedB;
    createBtn.disabled = !ready;
    downloadBtn.disabled = !renderedWavBlob;
  }

  function formatSeconds(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function decodeFile(file) {
    const arrayBuf = await file.arrayBuffer();
    const ctx = ensureCtx();
    return await ctx.decodeAudioData(arrayBuf.slice(0));
  }

  function validateBuffers(aBuf, bBuf) {
    if (!aBuf || !bBuf) return 'Both files must be valid audio files.';
    if (aBuf.sampleRate !== bBuf.sampleRate) {
      return 'Sample rates differ. Please choose files with the same sample rate.';
    }
    const minNeeded = 30; // needs at least 30s combined per track for A(0-15) and A(15-30)
    if (aBuf.duration < 30 || bBuf.duration < 30) {
      return 'Each track must be at least 30 seconds long.';
    }
    return null;
  }

  function createEqGraph(ctx, destination) {
    const input = ctx.createGain();
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 120; // bass
    const highShelf = ctx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 4000; // treble

    input.connect(lowShelf);
    lowShelf.connect(highShelf);
    highShelf.connect(destination);

    return { input, lowShelf, highShelf };
  }

  function copySegment(dest, destOffset, src, srcStart, length, channel) {
    const destData = dest.getChannelData(channel);
    const srcData = src.getChannelData(Math.min(channel, src.numberOfChannels - 1));
    for (let i = 0; i < length; i++) {
      destData[destOffset + i] = srcData[srcStart + i] || 0;
    }
  }

  function buildMashupBuffer(aBuf, bBuf) {
    const sr = aBuf.sampleRate;
    const segmentSec = 15;
    const segmentFrames = Math.floor(segmentSec * sr);

    const pattern = [
      { buf: aBuf, startFrames: 0 },
      { buf: bBuf, startFrames: 0 },
      { buf: aBuf, startFrames: segmentFrames }, // next 15s of A
      { buf: bBuf, startFrames: segmentFrames }, // next 15s of B
    ];

    const totalFrames = segmentFrames * pattern.length;
    const numChannels = Math.max(aBuf.numberOfChannels, bBuf.numberOfChannels);
    const ctx = ensureCtx();
    const out = ctx.createBuffer(numChannels, totalFrames, sr);

    for (let ch = 0; ch < numChannels; ch++) {
      let writeOffset = 0;
      for (const part of pattern) {
        copySegment(out, writeOffset, part.buf, part.startFrames, segmentFrames, ch);
        writeOffset += segmentFrames;
      }
    }
    return out;
  }

  function renderBufferWithEqOffline(buffer, bassGainDb, trebleGainDb) {
    const sr = buffer.sampleRate;
    const offline = new OfflineAudioContext({
      numberOfChannels: buffer.numberOfChannels,
      length: buffer.length,
      sampleRate: sr,
    });

    const src = offline.createBufferSource();
    src.buffer = buffer;
    const low = offline.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 120;
    low.gain.value = bassGainDb;
    const high = offline.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4000;
    high.gain.value = trebleGainDb;

    src.connect(low);
    low.connect(high);
    high.connect(offline.destination);
    src.start();
    return offline.startRendering();
  }

  function encodeWAV(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numChannels * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);

    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    const channels = [];
    for (let i = 0; i < numChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + audioBuffer.length * numChannels * 2, true);
    writeString(view, 8, 'WAVE');

    // fmt subchunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // audio format = PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true); // byte rate
    view.setUint16(32, numChannels * 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample

    // data subchunk
    writeString(view, 36, 'data');
    view.setUint32(40, audioBuffer.length * numChannels * 2, true);

    // interleave
    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channels[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  function refreshEqLabels() {
    bassValue.textContent = `${Number(bassSlider.value).toFixed(1)} dB`;
    trebleValue.textContent = `${Number(trebleSlider.value).toFixed(1)} dB`;
  }

  // Wire file inputs
  fileAInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    fileAName.textContent = file.name;
    try {
      decodedA = await decodeFile(file);
      log(`Loaded A: ${file.name} (${formatSeconds(decodedA.duration)})`);
    } catch (err) {
      log('Failed to decode Audio A', true);
    }
    if (decodedA && decodedB) {
      const errMsg = validateBuffers(decodedA, decodedB);
      if (errMsg) log(errMsg, true);
    }
    updateButtons();
  });

  fileBInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    fileBName.textContent = file.name;
    try {
      decodedB = await decodeFile(file);
      log(`Loaded B: ${file.name} (${formatSeconds(decodedB.duration)})`);
    } catch (err) {
      log('Failed to decode Audio B', true);
    }
    if (decodedA && decodedB) {
      const errMsg = validateBuffers(decodedA, decodedB);
      if (errMsg) log(errMsg, true);
    }
    updateButtons();
  });

  // Create Mashup
  createBtn.addEventListener('click', async () => {
    if (!decodedA || !decodedB) return;
    const validation = validateBuffers(decodedA, decodedB);
    if (validation) { log(validation, true); return; }

    try {
      log('Building mashup buffer...');
      const combined = buildMashupBuffer(decodedA, decodedB);
      renderedBuffer = await renderBufferWithEqOffline(
        combined,
        Number(bassSlider.value),
        Number(trebleSlider.value)
      );
      renderedWavBlob = encodeWAV(renderedBuffer);
      const url = URL.createObjectURL(renderedWavBlob);
      previewEl.src = url;
      downloadBtn.disabled = false;
      log('Mashup ready. Preview updated.');
    } catch (e) {
      console.error(e);
      log('Failed to create mashup.', true);
    }
  });

  // Download
  downloadBtn.addEventListener('click', () => {
    if (!renderedWavBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(renderedWavBlob);
    a.download = 'mashup.wav';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // Live EQ for preview when using decoded buffers directly in the future
  refreshEqLabels();
  bassSlider.addEventListener('input', refreshEqLabels);
  trebleSlider.addEventListener('input', refreshEqLabels);
})();


