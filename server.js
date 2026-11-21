const http = require('http');
const { WebSocketServer } = require('ws');

const port = process.env.PORT || 8080;

// 1. HIDDEN ENVIRONMENT SECRET (Set this in Render Dashboard -> Environment)
// Never type your actual secret password directly in this file!
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || "CHANGE_ME_IN_RENDER_ENV";

// 2. ALLOWED ORIGINS (Only allow official PenguinMod domains)
const ALLOWED_ORIGINS = [
    "https://penguinmod.com",
    "https://studio.penguinmod.com",
    "https://projects.penguinmod.com"
];

// 3. SERVER-AUTHORITATIVE VARIABLES (Clients cannot create/destroy these)
let globalVariables = ["GlobalAnnouncement", "SeasonStatus"];
let serverVariables = {
    "Room1": ["RoomTimer", "MatchState"],
    "Lobby": ["WelcomeText"]
};

let clients = [];
let lastGlobalData = "";
let serverDataCache = {};

// Create HTTP server to inspect Origin BEFORE upgrading to WebSocket
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Web Penguin Secure Server is Online.');
});

// Enforce maxPayload (16KB) to block memory-exhaustion attacks
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;

    // Reject connections from unauthorized websites
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        console.log(`Blocked unauthorized origin: ${origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

function broadcastState() {
    const globalUsers = clients.map(c => c.username);
    const activeServers = Array.from(new Set([
        ...clients.map(c => c.server).filter(s => s !== ""),
        ...Object.keys(serverVariables)
    ]));

    clients.forEach(client => {
        const serverUsers = clients
            .filter(c => c.server === client.server && client.server !== "")
            .map(c => c.username);
        const currentServerVars = (client.server && serverVariables[client.server]) 
            ? serverVariables[client.server] : [];
        const currentServerData = (client.server && serverDataCache[client.server]) 
            ? serverDataCache[client.server] : "";

        if (client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({
                type: 'updateState',
                globalUsers: globalUsers,
                serverUsers: serverUsers,
                globalVars: globalVariables,
                serverVars: currentServerVars,
                servers: activeServers,
                globalData: lastGlobalData,
                serverData: currentServerData
            }));
        }
    });
}

wss.on('connection', (ws) => {
    const clientState = {
        ws: ws,
        username: "Player" + Math.floor(Math.random() * 1000),
        server: "",
        lastMessageTime: 0,
        violations: 0
    };
    clients.push(clientState);

    ws.on('message', (rawData) => {
        try {
            const msg = JSON.parse(rawData.toString());
            const now = Date.now();

            // Basic type check
            if (!msg || typeof msg.type !== 'string') return;

            // 4. RATE LIMITING (500ms cooldown between messages)
            if (now - clientState.lastMessageTime < 500) {
                clientState.violations++;
                if (clientState.violations > 10) {
                    ws.close(1008, "Spamming detected"); // Kick spammers
                }
                return;
            }
            clientState.lastMessageTime = now;

            // --- ACTION HANDLERS ---
            if (msg.type === 'setUsername' && typeof msg.username === 'string') {
                // Sanitize username length
                clientState.username = msg.username.trim().substring(0, 20) || "Guest";
                broadcastState();
            } 
            else if (msg.type === 'joinServer' && typeof msg.server === 'string') {
                clientState.server = msg.server.trim().substring(0, 25);
                broadcastState();
            } 
            else if (msg.type === 'leaveServer') {
                clientState.server = "";
                broadcastState();
            } 
            else if (msg.type === 'sendGlobal' && typeof msg.data === 'string') {
                const cleanData = msg.data.substring(0, 150);
                lastGlobalData = cleanData;
                clients.forEach(c => {
                    if (c.ws.readyState === 1) {
                        c.ws.send(JSON.stringify({ type: 'globalData', data: cleanData }));
                    }
                });
                broadcastState();
            } 
            else if (msg.type === 'sendServer' && typeof msg.data === 'string') {
                if (!clientState.server) return;
                const cleanData = msg.data.substring(0, 150);
                serverDataCache[clientState.server] = cleanData;
                clients.forEach(c => {
                    if (c.server === clientState.server && c.ws.readyState === 1) {
                        c.ws.send(JSON.stringify({ type: 'serverData', data: cleanData }));
                    }
                });
                broadcastState();
            }
            // 5. ADMIN-ONLY VARIABLE MANAGEMENT (Requires popflat + Secret Key)
            else if (msg.type === 'adminManageVar') {
                const isPopflat = clientState.username.toLowerCase() === 'popflat';
                const hasValidKey = msg.secretKey === ADMIN_SECRET_KEY;

                if (!isPopflat || !hasValidKey) {
                    console.log(`Blocked unauthorized admin attempt by ${clientState.username}`);
                    ws.send(JSON.stringify({ type: 'securityError', error: 'Server rejected admin credentials.' }));
                    return;
                }

                const varName = String(msg.name || "").trim().substring(0, 25);
                if (!varName) return;

                if (msg.scope === 'global') {
                    if (msg.action === 'Create' && !globalVariables.includes(varName)) {
                        globalVariables.push(varName);
                        clients.forEach(c => {
                            if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'globalVarCreated', name: varName }));
                        });
                    } else if (msg.action === 'Destroy') {
                        globalVariables = globalVariables.filter(v => v !== varName);
                    }
                } else if (msg.scope === 'server' && clientState.server) {
                    if (!serverVariables[clientState.server]) serverVariables[clientState.server] = [];
                    if (msg.action === 'Create' && !serverVariables[clientState.server].includes(varName)) {
                        serverVariables[clientState.server].push(varName);
                        clients.forEach(c => {
                            if (c.server === clientState.server && c.ws.readyState === 1) {
                                c.ws.send(JSON.stringify({ type: 'serverVarCreated', name: varName }));
                            }
                        });
                    } else if (msg.action === 'Destroy') {
                        serverVariables[clientState.server] = serverVariables[clientState.server].filter(v => v !== varName);
                    }
                }
                broadcastState();
            }
        } catch (err) {
            console.error("Malformed packet ignored.");
        }
    });

    ws.on('close', () => {
        clients = clients.filter(c => c !== clientState);
        broadcastState();
    });
});

server.listen(port, () => {
    console.log(`Secure Web Penguin server listening on port ${port}`);
});
