import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/orders",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  ordersQueueName: "orders",
  logLevel: process.env.LOG_LEVEL ?? "info",
};
