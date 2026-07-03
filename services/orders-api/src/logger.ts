import pino from "pino";
import pinoHttp from "pino-http";
import { randomUUID } from "crypto";
import { config } from "./config";

// JSON structured logs are the point, not a byproduct: every log line is
// machine-parseable (service/event/order_id/request_id fields) so a future
// AI agent can query logs the same way across every service. See PRD.md §9.1.
export const logger = pino({
  level: config.logLevel,
  base: { service: "orders-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers["x-request-id"];
    const id = typeof existing === "string" ? existing : randomUUID();
    res.setHeader("X-Request-Id", id);
    return id;
  },
});
