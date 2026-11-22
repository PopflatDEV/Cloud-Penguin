const http = require('http');
const { WebSocketServer } = require('ws');

const port = process.env.PORT || 8080;

// --- RENDER ENVIRONMENT CONTROLS ---
// Set these in Render Dashboard -> Environment
const ALLOWED_PROJECT_URL = process.env.ALLOWED_PROJECT_URL || "https://projects.penguinmod.com";
const ALLOW_EDITOR_UPDATES = process.env.ALLOW_EDITOR_UPDATES === "true";

let globalVariables = [];
let serverVariables = {};
let clients = [];
let lastGlobalData = "";
let serverDataCache = {};

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Web Penguin Server Active');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin || "";
    const referer = request.headers.referer || "";
    const fullSource = referer || origin;

    // 1. Check if it came from your exact published project URL
    const isFromProject = fullSource.startsWith(ALLOWED_PROJECT_URL);
    
    // 2. Check if it came from the editor (only allowed if enabled in Render)
    const isFromEditor = ALLOW_EDITOR_UPDATES && (
        origin.includes("studio.penguinmod.com") || 
        fullSource.includes("editor.html")
    );

    if (!isFromProject && !isFromEditor) {
        console.log(`Blocked connection. Origin: ${origin} | Referer: ${referer}`);
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

            if (!msg || typeof msg.type !== 'string') return;

            // Rate limit (500ms)
            if (now - clientState.lastMessageTime < 500) {
                clientState.violations++;
                if (clientState.violations > 10) ws.close(1008, "Rate limit exceeded");
                return;
            }
            clientState.lastMessageTime = now;

            if (msg.type === 'setUsername' && typeof msg.username === 'string') {
                clientState.username = msg.username.trim().substring(0, 20) || "Guest";
                broadcastState();
            } else if (msg.type === 'joinServer' && typeof msg.server === 'string') {
                clientState.server = msg.server.trim().substring(0, 25);
                broadcastState();
            } else if (msg.type === 'leaveServer') {
                clientState.server = "";
                broadcastState();
            } else if (msg.type === 'sendGlobal' && typeof msg.data === 'string') {
                const cleanData = msg.data.substring(0, 150);
                lastGlobalData = cleanData;
                clients.forEach(c => {
                    if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'globalData', data: cleanData }));
                });
                broadcastState();
            } else if (msg.type === 'sendServer' && typeof msg.data === 'string') {
                if (!clientState.server) return;
                const cleanData = msg.data.substring(0, 150);
                serverDataCache[clientState.server] = cleanData;
                clients.forEach(c => {
                    if (c.server === clientState.server && c.ws.readyState === 1) {
                        c.ws.send(JSON.stringify({ type: 'serverData', data: cleanData }));
                    }
                });
                broadcastState();
            } else if (msg.type === 'adminManageVar') {
                // Only popflat can manage variables (no keys required)
                if (clientState.username.toLowerCase() !== 'popflat') {
                    ws.send(JSON.stringify({ type: 'securityError', error: 'Must be popflat to manage variables.' }));
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
            // Ignore malformed packets
        }
    });

    ws.on('close', () => {
        clients = clients.filter(c => c !== clientState);
        broadcastState();
    });
});

server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
