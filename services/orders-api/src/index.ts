import express from "express";
import { config } from "./config";
import { pool } from "./db/pool";
import { connection } from "./queue/queue";
import { logger, httpLogger } from "./logger";
import { ordersRouter } from "./routes/orders";

const app = express();
app.use(httpLogger);
app.use(express.json());

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await connection.ping();
    res.json({ status: "ok" });
  } catch (err) {
    req.log.error({ event: "health_check_failed", err }, "health check failed");
    res.status(503).json({ status: "unhealthy", error: (err as Error).message });
  }
});

app.use(ordersRouter);

app.listen(config.port, () => {
  logger.info({ event: "api_started", port: config.port }, `orders-api listening on :${config.port}`);
});
