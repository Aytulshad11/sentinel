import express from "express";
import { config } from "./config";
import { pool } from "./db/pool";
import { connection } from "./queue/queue";
import { ordersRouter } from "./routes/orders";

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    await connection.ping();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: (err as Error).message });
  }
});

app.use(ordersRouter);

app.listen(config.port, () => {
  console.log(`orders-api listening on :${config.port}`);
});
