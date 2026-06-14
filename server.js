const { WebSocketServer } = require('ws');

const port = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: port });

let clients = [];

function broadcastUserLists() {
    const globalUsers = clients.map(c => c.username);
    clients.forEach(client => {
        const serverUsers = clients.filter(c => c.server === client.server && client.server !== "").map(c => c.username);
        if (client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({
                type: 'updateUsers',
                global: globalUsers,
                server: serverUsers
            }));
        }
    });
}

wss.on('connection', function connection(ws) {
    const clientState = { ws: ws, username: "Unknown", server: "" };
    clients.push(clientState);

    ws.on('message', function message(data) {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'setUsername') {
                clientState.username = msg.username;
                broadcastUserLists();
            } 
            else if (msg.type === 'joinServer') {
                clientState.server = msg.server;
                broadcastUserLists();
            }
            else if (msg.type === 'leaveServer') {
                clientState.server = "";
                broadcastUserLists();
            }
            else if (msg.type === 'sendGlobal') {
                clients.forEach(c => {
                    if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'globalData', data: msg.data }));
                });
            }
            else if (msg.type === 'sendServer') {
                clients.forEach(c => {
                    if (c.server === msg.server && c.ws.readyState === 1) {
                        c.ws.send(JSON.stringify({ type: 'serverData', data: msg.data }));
                    }
                });
            }
            else if (msg.type === 'createGlobalVar') {
                clients.forEach(c => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'globalVarCreated', name: msg.name })) });
            }
            else if (msg.type === 'createServerVar') {
                clients.forEach(c => {
                    if (c.server === msg.server && c.ws.readyState === 1) {
                        c.ws.send(JSON.stringify({ type: 'serverVarCreated', name: msg.name }));
                    }
                });
            }
        } catch (e) {
            console.error("Invalid JSON message received");
        }
    });

    ws.on('close', () => {
        clients = clients.filter(c => c.ws !== ws);
        broadcastUserLists();
    });
});

console.log(`Web Penguin server running on port ${port}`);