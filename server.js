const { WebSocketServer } = require('ws');

const port = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: port });

let clients = [];
let globalVariables = [];
let serverVariables = {}; // Format: { "Room1": ["Score"] }

// Memory caches to save data for late-joiners
let lastGlobalData = "";
let serverDataCache = {}; // Format: { "Room1": "Latest Room Message" }

function broadcastState() {
    const globalUsers = clients.map(c => c.username);
    
    const activeServers = Array.from(new Set([
        ...clients.map(c => c.server).filter(s => s !== ""),
        ...Object.keys(serverVariables)
    ]));

    clients.forEach(client => {
        const serverUsers = clients.filter(c => c.server === client.server && client.server !== "").map(c => c.username);
        const currentServerVars = (client.server && serverVariables[client.server]) ? serverVariables[client.server] : [];
        const currentServerData = (client.server && serverDataCache[client.server]) ? serverDataCache[client.server] : "";
        
        if (client.ws.readyState === 1) { // 1 = OPEN
            client.ws.send(JSON.stringify({
                type: 'updateState',
                globalUsers: globalUsers,
                serverUsers: serverUsers,
                globalVars: globalVariables,
                serverVars: currentServerVars,
                servers: activeServers,
                globalData: lastGlobalData,      // Instantly populates on connect
                serverData: currentServerData    // Instantly populates on room switch
            }));
        }
    });
}

wss.on('connection', function connection(ws) {
    const clientState = { ws: ws, username: "Unknown", server: "" };
    clients.push(clientState);

    ws.on('message', function message(data) {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'setUsername') {
                clientState.username = msg.username;
                broadcastState();
            } 
            else if (msg.type === 'joinServer') {
                clientState.server = msg.server;
                broadcastState();
            }
            else if (msg.type === 'leaveServer') {
                clientState.server = "";
                broadcastState();
            }
            else if (msg.type === 'sendGlobal') {
                lastGlobalData = msg.data; // Save to global cache
                clients.forEach(c => {
                    if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'globalData', data: msg.data }));
                });
                broadcastState();
            }
            else if (msg.type === 'sendServer') {
                serverDataCache[msg.server] = msg.data; // Save to room cache
                clients.forEach(c => {
                    if (c.server === msg.server && c.ws.readyState === 1) {
                        c.ws.send(JSON.stringify({ type: 'serverData', data: msg.data }));
                    }
                });
                broadcastState();
            }
            else if (msg.type === 'createGlobalVar') {
                if (!globalVariables.includes(msg.name)) {
                    globalVariables.push(msg.name);
                }
                clients.forEach(c => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'globalVarCreated', name: msg.name })) });
                broadcastState();
            }
            else if (msg.type === 'destroyGlobalVar') {
                globalVariables = globalVariables.filter(v => v !== msg.name);
                broadcastState();
            }
            else if (msg.type === 'createServerVar') {
                if (!serverVariables[msg.server]) serverVariables[msg.server] = [];
                if (!serverVariables[msg.server].includes(msg.name)) {
                    serverVariables[msg.server].push(msg.name);
                }
                clients.forEach(c => {
                    if (c.server === msg.server && c.ws.readyState === 1) {
                        c.ws.send(JSON.stringify({ type: 'serverVarCreated', name: msg.name }));
                    }
                });
                broadcastState();
            }
            else if (msg.type === 'destroyServerVar') {
                if (serverVariables[msg.server]) {
                    serverVariables[msg.server] = serverVariables[msg.server].filter(v => v !== msg.name);
                    if (serverVariables[msg.server].length === 0) delete serverVariables[msg.server];
                }
                broadcastState();
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    });

    ws.on('close', () => {
        clients = clients.filter(c => c.ws !== ws);
        broadcastState();
    });
});
console.log(`Web Penguin server running on port ${port}`);
