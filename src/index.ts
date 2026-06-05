import "dotenv/config";
import { createServer } from "http";
import app from "./app.js";
import { registerWebSocketServer } from "./socket.js";

const port = Number(process.env.PORT ?? 8080);
const server = createServer(app);

registerWebSocketServer(server);

server.listen(port, () => {
  console.log(`[nivashub-backend] Listening on http://localhost:${port}`);
  console.log(`[nivashub-backend] API base path: /api`);
  console.log(`[nivashub-backend] WebSocket path: /ws`);
});
