/**
 * Lightweight signaling server for the meeting app.
 * - Native Node.js `http` + `ws` (WebSocket) only.
 * - Serves the 3 static files (index.html, recorder.js, server.js is *not* exposed).
 * - Room-based signaling relay: join / leave / offer / answer / ice-candidate.
 * - Hard cap: 10 participants per room.
 *
 * Run:  node server.js
 * Env:  PORT (default 8080)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PARTICIPANTS = 10;

/* ------------------------------------------------------------------ */
/* Static file server (index.html + recorder.js only)                */
/* ------------------------------------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

const httpServer = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    // Only allow whitelisted files
    const allowed = new Set(['/index.html', '/recorder.js']);
    if (!allowed.has(urlPath)) {
        res.writeHead(404); res.end('Not found'); return;
    }

    const filePath = path.join(__dirname, urlPath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(500); res.end('Server error'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
    });
});

/* ------------------------------------------------------------------ */
/* WebSocket signaling                                               */
/* ------------------------------------------------------------------ */
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/** rooms: Map<roomId, Map<peerId, ws>> */
const rooms = new Map();

function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(roomId, obj, exceptPeerId) {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const [pid, sock] of room.entries()) {
        if (pid === exceptPeerId) continue;
        send(sock, obj);
    }
}

wss.on('connection', (ws) => {
    ws.peerId = null;
    ws.roomId = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        switch (msg.type) {
            case 'join': {
                const roomId = String(msg.roomId || '').trim();
                const name   = String(msg.name || 'Guest').slice(0, 40);
                if (!roomId) { send(ws, { type: 'error', reason: 'invalid-room' }); return; }

                if (!rooms.has(roomId)) rooms.set(roomId, new Map());
                const room = rooms.get(roomId);

                if (room.size >= MAX_PARTICIPANTS) {
                    send(ws, { type: 'error', reason: 'room-full', max: MAX_PARTICIPANTS });
                    ws.close();
                    return;
                }

                const peerId = crypto.randomBytes(6).toString('hex');
                ws.peerId = peerId;
                ws.roomId = roomId;
                ws.name   = name;
                room.set(peerId, ws);

                // Tell newcomer who is already in the room
                const peers = [];
                for (const [pid, sock] of room.entries()) {
                    if (pid !== peerId) peers.push({ peerId: pid, name: sock.name });
                }
                send(ws, { type: 'joined', peerId, roomId, peers, max: MAX_PARTICIPANTS });

                // Notify others
                broadcast(roomId, { type: 'peer-joined', peerId, name }, peerId);
                break;
            }

            case 'offer':
            case 'answer':
            case 'ice-candidate': {
                if (!ws.roomId || !msg.target) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const targetSock = room.get(msg.target);
                if (!targetSock) return;
                send(targetSock, { ...msg, from: ws.peerId });
                break;
            }

            default: break;
        }
    });

    ws.on('close', () => {
        if (!ws.roomId || !ws.peerId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        room.delete(ws.peerId);
        broadcast(ws.roomId, { type: 'peer-left', peerId: ws.peerId });
        if (room.size === 0) rooms.delete(ws.roomId);
    });
});

httpServer.listen(PORT, () => {
    console.log(`[signaling] http+ws listening on :${PORT}`);
});
