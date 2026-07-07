/* =====================================================================
 * recorder.js — Audio-only recording via MediaRecorder + AudioContext.
 *
 * Two strict modes:
 * • mode:'mixed'    → single .webm file containing all participants mixed.
 * • mode:'separate' → one .webm file per participant, all started at the
 * same performance.now() epoch, and filenames include
 * an ISO timestamp + start-offset (ms) for
 * timestamp-synced post-processing.
 *
 * Exposed as window.Recorder = { start, stop, onPeerLeft }.
 *
 * NOTE: In 'separate' mode, if a new peer joins *after* the recording has
 * started, a new per-peer recorder is created and its filename encodes the
 * offset from t0, so files remain synchronizable on a common timeline.
 * =================================================================== */

(function () {
    const state = {
        active: false,
        mode: null,               // 'mixed' | 'separate'
        t0: 0,                    // performance.now() at Recorder.start()
        startedISO: null,         // ISO string of wall-clock start
        audioCtx: null,
        // mixed-mode
        mixedRecorder: null,
        mixedChunks: [],
        mixedDest: null,
        mixedSources: [],         // AudioNode refs to disconnect on stop
        // separate-mode
        perPeer: new Map(),       // key -> { recorder, chunks, name, offsetMs }
        // callback for late joiners in separate mode
        peersRef: null,
        localRef: null,
    };

    const MIME = pickMime();

    function pickMime() {
        const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4',
        ];
        for (const m of candidates) {
            if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
        }
        return '';
    }

    function extFromMime(m) {
        if (!m) return 'webm';
        if (m.includes('webm')) return 'webm';
        if (m.includes('ogg'))  return 'ogg';
        if (m.includes('mp4'))  return 'm4a';
        return 'webm';
    }

    function safeName(s) {
        return String(s || 'guest').replace(/[^\p{L}\p{N}_\-]+/gu, '_').slice(0, 40);
    }

    function download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    }

    /* ---------------- START ---------------- */
    function start({ mode, localName, localStream, peers }) {
        if (state.active) return;
        state.active = true;
        state.mode   = mode;
        state.t0     = performance.now();
        state.startedISO = new Date().toISOString().replace(/[:.]/g, '-');
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        state.peersRef = peers;
        state.localRef = { name: localName, stream: localStream };

        if (mode === 'mixed') startMixed(localName, localStream, peers);
        else                  startSeparate(localName, localStream, peers);
    }

    /* ---- Mixed mode: one destination, one recorder ---- */
    function startMixed(localName, localStream, peers) {
        state.mixedDest = state.audioCtx.createMediaStreamDestination();

        // Local mic
        const localAudio = localStream.getAudioTracks()[0];
        if (localAudio) {
            const src = state.audioCtx.createMediaStreamSource(new MediaStream([localAudio]));
            src.connect(state.mixedDest);
            state.mixedSources.push(src);
        }

        // Each remote peer
        for (const [peerId, entry] of peers.entries()) {
            const track = entry.audioTrackForRec || entry.stream.getAudioTracks()[0];
            if (!track) continue;
            const src = state.audioCtx.createMediaStreamSource(new MediaStream([track]));
            src.connect(state.mixedDest);
            state.mixedSources.push(src);
        }

        const rec = new MediaRecorder(state.mixedDest.stream, MIME ? { mimeType: MIME } : undefined);
        state.mixedRecorder = rec;
        state.mixedChunks   = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) state.mixedChunks.push(e.data); };
        rec.onstop = () => {
            const blob = new Blob(state.mixedChunks, { type: MIME || 'audio/webm' });
            download(blob, `meeting_${state.startedISO}_mixed.${extFromMime(MIME)}`);
        };
        rec.start(1000); // 1s timeslice
    }

    /* ---- Separate mode: one recorder per participant ---- */
    function startSeparate(localName, localStream, peers) {
        // Local
        const localAudio = localStream.getAudioTracks()[0];
        if (localAudio) addPerPeerRecorder('local', localName, new MediaStream([localAudio]));

        // Remotes
        for (const [peerId, entry] of peers.entries()) {
            const track = entry.audioTrackForRec || entry.stream.getAudioTracks()[0];
            if (!track) continue;
            addPerPeerRecorder(peerId, entry.name, new MediaStream([track]));
        }
    }

    function addPerPeerRecorder(key, name, stream) {
        if (state.perPeer.has(key)) return;
        const offsetMs = Math.round(performance.now() - state.t0);
        const rec = new MediaRecorder(stream, MIME ? { mimeType: MIME } : undefined);
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
            const blob = new Blob(chunks, { type: MIME || 'audio/webm' });
            const fname = `meeting_${state.startedISO}__${safeName(name)}__offset${offsetMs}ms.${extFromMime(MIME)}`;
            download(blob, fname);
        };
        rec.start(1000);
        state.perPeer.set(key, { recorder: rec, chunks, name, offsetMs });
    }

    /* ---- Called by main script when a peer leaves during recording ---- */
    function onPeerLeft(peerId) {
        if (!state.active || state.mode !== 'separate') return;
        const p = state.perPeer.get(peerId);
        if (p && p.recorder.state !== 'inactive') {
            try { p.recorder.stop(); } catch {}
        }
    }

    /* ---------------- STOP ---------------- */
    function stop() {
        if (!state.active) return;
        state.active = false;

        if (state.mode === 'mixed') {
            try { state.mixedRecorder && state.mixedRecorder.state !== 'inactive' && state.mixedRecorder.stop(); } catch {}
            state.mixedSources.forEach(s => { try { s.disconnect(); } catch {} });
            state.mixedSources = [];
        } else if (state.mode === 'separate') {
            for (const { recorder } of state.perPeer.values()) {
                try { recorder.state !== 'inactive' && recorder.stop(); } catch {}
            }
            state.perPeer.clear();
        }

        try { state.audioCtx && state.audioCtx.close(); } catch {}
        state.audioCtx = null;
        state.mode = null;
    }

    window.Recorder = { start, stop, onPeerLeft };
})();
