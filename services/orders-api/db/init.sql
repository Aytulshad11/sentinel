CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Order state machine: created -> queued -> processing -> completed | failed
CREATE TABLE IF NOT EXISTS orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created', 'queued', 'processing', 'completed', 'failed')),
    amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
    currency        TEXT NOT NULL DEFAULT 'GBP',
    customer_email  TEXT NOT NULL,
    failure_reason  TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

-- Append-only audit trail of every state transition, used to reconstruct
-- what happened to an order during chaos drills without relying on logs alone.
CREATE TABLE IF NOT EXISTS order_events (
    id         BIGSERIAL PRIMARY KEY,
    order_id   UUID NOT NULL REFERENCES orders (id),
    from_status TEXT,
    to_status   TEXT NOT NULL,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
