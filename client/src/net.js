// Thin WebSocket wrapper. One connection at a time; JSON messages with a `t` field.

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

let ws = null;

// Opens a connection, sends `join` once open. onClose(wasOpen) fires once if the socket drops
// (not when disconnect() is called by us).
export function connect(join, onMessage, onClose) {
  disconnect();
  const sock = new WebSocket(SERVER_URL);
  ws = sock;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    sock.send(JSON.stringify(join));
  };
  sock.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ws === sock) onMessage(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    onClose(opened);
  };
}

export function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function disconnect() {
  const sock = ws;
  ws = null;
  if (sock) {
    sock.onclose = null;
    sock.close();
  }
}
