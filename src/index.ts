import "dotenv/config";
import app from "./app.js";

const port = Number(process.env.PORT ?? 8080);

app.listen(port, () => {
  console.log(`[nivashub-backend] Listening on http://localhost:${port}`);
  console.log(`[nivashub-backend] API base path: /api`);
});
