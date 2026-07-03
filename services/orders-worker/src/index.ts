import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";
import { pool } from "./db/pool";
import { logger } from "./logger";

const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const dlq = new Queue(config.dlqName, { connection });

async function transition(orderId: string, from: string, to: string, note?: string) {
  await pool.query("UPDATE orders SET status = $2, updated_at = now(), attempts = attempts + 1 WHERE id = $1", [
    orderId,
    to,
  ]);
  await pool.query(
    "INSERT INTO order_events (order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)",
    [orderId, from, to, note ?? null]
  );
}

// Simulates the flaky call to the notification-service. Randomized so BullMQ's
// exponential backoff and eventual DLQ routing have something real to exercise.
async function callDownstreamNotification(orderId: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
  if (Math.random() < config.simulatedDownstreamFailureRate) {
    throw new Error(`downstream notification call failed for order ${orderId}`);
  }
}

async function processOrder(job: Job<{ orderId: string }>) {
  const { orderId } = job.data;

  // Redis lock guards against two worker processes concurrently picking up a
  // redelivered/duplicated message for the same order — the same pattern used
  // for idempotent webhook handling in the Razorpay integration.
  const lockKey = `lock:order:${orderId}`;
  const acquired = await connection.set(lockKey, job.id ?? "1", "EX", 30, "NX");
  if (!acquired) {
    logger.warn(
      { event: "duplicate_delivery_skipped", order_id: orderId, job_id: job.id },
      "order already locked by another worker, skipping duplicate delivery"
    );
    return;
  }

  try {
    const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    const order = rows[0];
    if (!order) throw new Error(`order ${orderId} not found`);

    if (order.status === "completed") {
      logger.info(
        { event: "order_already_completed", order_id: orderId, job_id: job.id },
        "order already completed, skipping (idempotent replay)"
      );
      return;
    }

    await transition(orderId, order.status, "processing", `attempt ${job.attemptsMade + 1}`);

    await callDownstreamNotification(orderId);

    await transition(orderId, "processing", "completed");
    logger.info({ event: "order_completed", order_id: orderId, job_id: job.id }, "order completed");
  } finally {
    await connection.del(lockKey);
  }
}

const worker = new Worker(config.ordersQueueName, processOrder, {
  connection,
  concurrency: config.concurrency,
});

worker.on("completed", (job) => {
  logger.info({ event: "job_completed", job_id: job.id }, "job completed");
});

worker.on("failed", async (job, err) => {
  if (!job) return;
  const attemptsMax = job.opts.attempts ?? 1;
  logger.error(
    { event: "job_failed", job_id: job.id, attempts_made: job.attemptsMade, attempts_max: attemptsMax, err },
    `job failed (attempt ${job.attemptsMade}/${attemptsMax}): ${err.message}`
  );

  if (job.attemptsMade >= attemptsMax) {
    // Retries exhausted: park the order as failed and route to the DLQ for
    // manual/automated inspection instead of silently dropping it.
    const { orderId } = job.data as { orderId: string };
    await transition(orderId, "processing", "failed", err.message).catch((e) =>
      logger.error({ event: "order_failure_record_error", order_id: orderId, err: e }, "failed to record final failure")
    );
    await dlq.add("dead-order", { orderId, reason: err.message, originalJobId: job.id });
    logger.error(
      { event: "order_dlq_routed", order_id: orderId, reason: err.message, original_job_id: job.id },
      "order moved to DLQ after exhausting retries"
    );
  }
});

logger.info({ event: "worker_started" }, "orders-worker started, waiting for jobs...");
