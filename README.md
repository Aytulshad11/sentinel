# Cloud-Native Reliability Platform

A portfolio project demonstrating Backend / Platform / SRE engineering depth: a small
order-processing system built to fail in interesting, instrumented ways, then hardened
through Kubernetes, Terraform/AWS, observability, SLOs, and chaos engineering.

See [ROADMAP.md](./ROADMAP.md) for the full phased plan, weekly milestones, and the
reasoning behind each design decision.

## Status

**Phase 0 / Week 1 — done.** Repo scaffold + a working `orders-api` and `orders-worker`
behind Postgres and Redis/BullMQ, runnable locally via `docker-compose`.

- [x] Repo skeleton for all planned phases (`services/`, `infra/`, `k8s/`, `observability/`, `chaos/`, `docs/`)
- [x] `orders-api`: `POST /orders` (idempotent, via `Idempotency-Key` header), `GET /orders/:id`, `/health`
- [x] `orders-worker`: BullMQ consumer with Redis-lock idempotency, order state machine, retry/backoff, DLQ routing on exhausted retries
- [x] Postgres schema: `orders` (state machine) + `order_events` (audit trail)
- [ ] `notification-service` (currently simulated in-process by the worker, with a configurable random failure rate to exercise retries)
- [ ] Kubernetes, Terraform, observability, SLOs, chaos experiments — see roadmap phases 2-8

## Architecture (current)

```
client --> orders-api --> Postgres (orders, order_events)
              |
              +--> Redis/BullMQ (orders queue)
                        |
                        v
                  orders-worker --> (simulated) notification call
                        |
                        +--> orders-dlq (on exhausted retries)
```

## Order state machine

`created -> queued -> processing -> completed | failed`

Every transition is written to `order_events` for audit/debugging during chaos drills.

## Idempotency design

Mirrors the Redis-lock pattern used in a prior production Razorpay webhook integration,
layered three ways so a retried request can't double-process an order:

1. **DB unique constraint** on `orders.idempotency_key` — the source of truth.
2. **BullMQ `jobId` dedupe** — job `jobId` is set to the idempotency key, so re-enqueueing
   the same key is a no-op at the queue layer.
3. **Redis lock in the worker** (`SET NX EX 30`) — guards against two worker processes
   concurrently handling a redelivered/duplicated message for the same order.

## Quickstart

Requires Docker Desktop.

```bash
cp .env.example .env
docker compose up --build
```

This starts Postgres, Redis, `orders-api` (port 3000), and `orders-worker`.

Create an order:

```bash
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-order-1" \
  -d '{"amountCents": 1999, "customerEmail": "test@example.com"}'
```

Re-sending the exact same request (same `Idempotency-Key`) returns the existing order
instead of creating a duplicate — try it twice and compare the response.

Fetch the order (replace `<id>` with the `id` from the response above) and watch its
`status` move from `queued` -> `processing` -> `completed` (or `failed`, since the worker
randomly fails ~30% of "downstream notification" calls by design, to exercise retries):

```bash
curl -s http://localhost:3000/orders/<id>
```

Watch it live:

```bash
docker compose logs -f orders-worker
```

Health check:

```bash
curl -s http://localhost:3000/health
```

## Local development (without Docker for the app code)

```bash
docker compose up postgres redis
cd services/orders-api && npm install && npm run dev
cd services/orders-worker && npm install && npm run dev
```

## Cost discipline

Everything above runs entirely locally (Docker) at zero cloud cost. Real AWS
infrastructure (EKS, RDS, NAT gateway) is provisioned via Terraform only for
recorded demos/interview walkthroughs and torn down immediately after — see
[ROADMAP.md](./ROADMAP.md) section 0.2 for the reasoning.

## Repository structure

See [ROADMAP.md, section 3](./ROADMAP.md#3-repository-structure).
