import "dotenv/config";

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/orders",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  ordersQueueName: "orders",
  dlqName: "orders-dlq",
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
  // Simulated downstream (notification service) failure rate, used to exercise
  // BullMQ's retry/backoff path until the real notification-service exists.
  simulatedDownstreamFailureRate: Number(process.env.SIMULATED_DOWNSTREAM_FAILURE_RATE ?? 0.3),
};
