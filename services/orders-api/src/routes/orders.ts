import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { ordersQueue } from "../queue/queue";

export const ordersRouter = Router();

const createOrderSchema = z.object({
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default("GBP"),
  customerEmail: z.string().email(),
});

// Idempotency mirrors the Redis-lock pattern used for the Razorpay webhook
// integration: the DB unique constraint on idempotency_key is the source of
// truth, and BullMQ's jobId dedupe gives a second, independent guard against
// double-processing if the same request is retried after the DB write lands
// but before the caller sees a response.
ordersRouter.post("/orders", async (req, res) => {
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey) {
    return res.status(400).json({ error: "Idempotency-Key header is required" });
  }

  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { amountCents, currency, customerEmail } = parsed.data;

  const existing = await pool.query("SELECT * FROM orders WHERE idempotency_key = $1", [idempotencyKey]);
  if (existing.rows.length > 0) {
    return res.status(200).json(existing.rows[0]);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertResult = await client.query(
      `INSERT INTO orders (idempotency_key, amount_cents, currency, customer_email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [idempotencyKey, amountCents, currency, customerEmail]
    );

    if (insertResult.rows.length === 0) {
      // Lost the race to a concurrent request with the same key.
      await client.query("ROLLBACK");
      const raced = await pool.query("SELECT * FROM orders WHERE idempotency_key = $1", [idempotencyKey]);
      return res.status(200).json(raced.rows[0]);
    }

    const order = insertResult.rows[0];

    await client.query(
      `UPDATE orders SET status = 'queued', updated_at = now() WHERE id = $1`,
      [order.id]
    );
    await client.query(
      `INSERT INTO order_events (order_id, from_status, to_status, note) VALUES ($1, 'created', 'queued', 'enqueued to orders queue')`,
      [order.id]
    );

    await client.query("COMMIT");

    // jobId = idempotency_key so a duplicate enqueue for the same key is a
    // no-op at the queue layer too, even if this handler is ever retried.
    await ordersQueue.add(
      "process-order",
      { orderId: order.id },
      {
        jobId: idempotencyKey,
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      }
    );

    return res.status(201).json({ ...order, status: "queued" });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

ordersRouter.get("/orders/:id", async (req, res) => {
  const result = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "order not found" });
  }
  return res.json(result.rows[0]);
});
