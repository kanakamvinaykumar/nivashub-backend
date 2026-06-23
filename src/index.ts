import "dotenv/config";
import { createServer } from "http";
import app from "./app.js";
import { registerWebSocketServer } from "./socket.js";
import { initializeSocketIO } from "./socket-io.js";
import { archiveExpiredEventGroups } from "./lib/chat.js";

const port = Number(process.env.PORT ?? 8080);
const server = createServer(app);

// Legacy WebSocket server (for visitor passes, payments, complaints notifications)
registerWebSocketServer(server);

// Socket.IO server (for chat messaging, typing, presence)
initializeSocketIO(server);

// Archive expired event groups every hour
setInterval(async () => {
  try {
    const count = await archiveExpiredEventGroups();
    if (count > 0) {
      console.log(`[chat] Archived ${count} expired event groups`);
    }
  } catch (err) {
    console.error("[chat] Failed to archive expired event groups", err);
  }
}, 60 * 60 * 1000);

server.listen(port, () => {
  console.log(`[nivashub-backend] Listening on http://localhost:${port}`);
  console.log(`[nivashub-backend] API base path: /api`);
  console.log(`[nivashub-backend] WebSocket path: /ws`);
  console.log(`[nivashub-backend] Socket.IO path: /ws/socket.io`);
});
