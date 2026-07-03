import pino from "pino";
import { config } from "./config";

// See PRD.md §9.1 — JSON structured logs, one shared field schema across
// services, so log consumers (including a future AI agent) don't need
// per-service parsing.
export const logger = pino({
  level: config.logLevel,
  base: { service: "orders-worker" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
