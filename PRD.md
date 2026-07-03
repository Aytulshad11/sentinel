# PRD — Cloud-Native Reliability Platform

**Status:** Living document. This is the single source of truth for *what* we're
building, *why*, and the decisions behind it. Decisions here can and will change as
the project progresses — see [§12 Decision Log](#12-decision-log) for how changes are
tracked, not hidden.

**Document relationship:**
- **`PRD.md` (this file)** — what we're building, why, requirements, and the decision
  history. Source of truth for *scope and rationale*.
- **`ROADMAP.md`** — the mentor-authored phasing and 14-week milestone plan. Source of
  truth for *sequencing (when)*. Not rewritten here; referenced.
- **`README.md`** — how to run the thing today. Source of truth for *operating the
  current state of the repo*.
- **`docs/adr/`** — one-off architecture decision records for deep technical choices
  that need more than a Decision Log row (e.g. "why BullMQ over SQS locally").

---

## 1. Purpose

A portfolio project that demonstrates Backend/Platform/SRE engineering depth for UK
visa-sponsored roles (Monzo, Wise, Revolut, Checkout.com, GoCardless, Starling, Zopa,
and similar). It is a small order-processing system deliberately built to fail in
instrumented, observable ways, then hardened through Kubernetes, Terraform/AWS,
observability, SLOs, and chaos engineering.

## 2. Goals

- Demonstrate real distributed-systems failure handling (duplicate delivery, retries,
  poison messages, network partition) — not just a Kubernetes label on a monolith.
- Produce interview-grade artifacts: ADRs, runbooks, postmortems, dashboards, a
  recorded chaos drill.
- Every subsystem's telemetry (logs, metrics, traces, alerts) is **machine-consumable
  by design**, not just human-readable — see [§9](#9-observability--ai-agent-readiness).
  This is a first-class requirement, not an afterthought bolted on during the
  observability phase.
- Keep real AWS spend near zero via local-first development (`docker-compose` /
  `kind`), with Terraform-provisioned AWS used only for recorded demos, then destroyed.

## 3. Non-Goals

- Multi-region high availability (single-region, multi-AZ is the deliberate ceiling).
- A production-grade payments system — `orders` is a vehicle for reliability patterns,
  not a real ledger.
- Building a full agent platform. §9.6 scopes a *future* agent-facing interface; it is
  not implemented yet and won't be until the telemetry foundation (§9.2–9.5) is solid.
- Chasing every tool in the original 16-technology wishlist — see ROADMAP.md §0.1.

## 4. Audience / Personas

| Persona | What they need from this system |
|---|---|
| Hiring reviewer / interviewer | Clear README, real dashboards, honest postmortems from self-induced incidents |
| The builder (operating this project) | A system that's easy to reason about locally, cheap to run, safe to break on purpose |
| **A future AI agent** (SRE copilot, auto-triage bot, incident assistant) | Structured, schema-consistent logs/metrics/traces/alerts it can query and reason over *without* bespoke parsing per service. This is a real, planned consumer of this system's telemetry — not a hypothetical. See §9. |

## 5. System Overview

See `ROADMAP.md` §2 for the full architecture diagram. Current implemented slice:

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

## 6. Functional Requirements

### 6.1 orders-api
- `POST /orders` — creates an order. Requires `Idempotency-Key` header. Returns the
  existing order (200) on key replay instead of creating a duplicate.
- `GET /orders/:id` — fetch current order state.
- `GET /health` — liveness/readiness signal, checks Postgres + Redis connectivity.

### 6.2 orders-worker
- Consumes the `orders` BullMQ queue.
- Enforces the order state machine: `created → queued → processing → completed | failed`.
- Every transition is written to `order_events` (audit trail, also the raw material
  for a future agent reconstructing "what happened to order X").
- Retries with exponential backoff (5 attempts); on exhaustion, routes the order to
  `orders-dlq` and marks it `failed` with a `failure_reason`.
- Redis lock (`SET NX EX 30`) guards against two workers concurrently handling a
  redelivered message for the same order.

### 6.3 notification-service — **not yet built**
Currently simulated in-process by the worker (configurable random failure rate) to
exercise the retry/backoff/DLQ path. Building it as a real, separately deployable
service (with its own chaos-toggleable latency/failure injection) is scoped for a
later phase per ROADMAP.md.

### 6.4 Data model
- `orders`: `id`, `idempotency_key` (unique), `status`, `amount_cents`, `currency`,
  `customer_email`, `failure_reason`, `attempts`, `created_at`, `updated_at`.
- `order_events`: append-only, `order_id`, `from_status`, `to_status`, `note`,
  `created_at`.

## 7. Non-Functional Requirements

### 7.1 Idempotency (defense in depth)
Three independent layers, matching a pattern proven in a prior production Razorpay
webhook integration:
1. DB unique constraint on `idempotency_key` (source of truth).
2. BullMQ `jobId` = idempotency key (dedupes at the queue layer).
3. Redis lock in the worker (guards concurrent redelivery).

### 7.2 SLOs
Canonical numbers live here; ROADMAP.md §12 has the same table for narrative context.

| SLI | SLO |
|---|---|
| Proportion of order-creation requests returning non-5xx | 99.5% over rolling 28 days |
| p95 latency of order creation | < 300ms, met in 99% of 5-minute windows over 28 days |
| Proportion of jobs processed without manual DLQ intervention | 99.9% over rolling 28 days |

**Error budget policy:** when a budget is exhausted, feature work freezes and
reliability work is prioritized until the budget recovers. Enforcement is currently
manual/self-reported (no automated freeze mechanism) — that is itself a candidate for
future agent involvement (§9.6).

### 7.3 Security
- Secrets via `.env` locally (gitignored), Kubernetes Secrets in-cluster, never
  committed. External Secrets Operator is a stretch goal.
- No production-real customer data anywhere in this project.

### 7.4 Cost discipline
Local development costs $0 (Docker only). Real AWS infra is provisioned via Terraform
strictly for recorded demos/interviews and torn down (`terraform destroy`) immediately
after. See ROADMAP.md §0.2.

## 8. API Contracts (current)

```
POST /orders
Headers: Idempotency-Key: <string, required>
Body:    { amountCents: number>0, currency?: string(3), customerEmail: string }
201 ->   { id, idempotency_key, status: "queued", amount_cents, currency, customer_email, ... }
200 ->   (idempotent replay) existing order, unchanged

GET /orders/:id
200 ->   { id, idempotency_key, status, amount_cents, currency, customer_email, failure_reason, attempts, ... }
404 ->   { error: "order not found" }

GET /health
200 ->   { status: "ok" }
503 ->   { status: "unhealthy", error: string }
```

## 9. Observability & AI-Agent-Readiness

**Design principle:** every signal this system emits — logs, metrics, traces, alerts,
runbooks — is structured and schema-consistent from day one, so that a future AI agent
(SRE copilot, auto-triage bot) can query and reason over it without bespoke,
per-service parsing. This is not deferred to the observability phase (ROADMAP.md
Phase 4); it governs how instrumentation is written starting now.

### 9.1 Structured logging (implemented now, retrofitted into services this session)

All services log JSON (via `pino`), one shared field schema:

| Field | Meaning |
|---|---|
| `time` | ISO8601 timestamp |
| `level` | pino numeric level (30=info, 40=warn, 50=error, ...) |
| `service` | `orders-api` \| `orders-worker` \| `notification-service` |
| `event` | machine-readable snake_case event name, e.g. `order_created`, `job_failed`, `order_dlq_routed` |
| `msg` | human-readable message (for the human reading logs directly) |
| `request_id` | present on all API-request-originated logs (via `pino-http`), returned to the caller as `X-Request-Id` for cross-system correlation |
| `order_id`, `idempotency_key`, `job_id` | present when applicable |
| `trace_id`, `span_id` | **not yet populated** — added once OTel instrumentation lands (ROADMAP.md Phase 4/Week 7). Field names reserved now so log consumers (including agents) can code against them ahead of time. |
| `err` | structured error (`message`, `stack`, `type`) when applicable |

Every log line is an `event`, not free text — an agent can filter on `event ==
"order_dlq_routed"` instead of regexing a message string.

### 9.2 Metrics conventions
Per ROADMAP.md §9 (RED/USE + business metrics: `orders_created_total`,
`orders_failed_total`, `queue_depth`, `payment_lock_contention_total`,
`dlq_messages_total`). Requirement on top of that list: every custom metric carries a
`service` label and, where relevant, a `status`/`reason` label, so an agent can slice
by outcome without needing service-specific knowledge encoded elsewhere.

### 9.3 Tracing conventions (Phase 4, not yet implemented)
- Standard OTel resource attributes: `service.name`, `service.version`,
  `deployment.environment`.
- Custom span attributes: `order.id`, `order.status`, `order.idempotency_key`.
- Span names: `order.create`, `order.enqueue`, `order.process`, `order.notify`.
- Trace context (W3C `traceparent`) is injected into the BullMQ job payload at
  enqueue time and extracted by the worker, so one trace covers the full
  API → queue → worker lifecycle of an order despite the async broker hop. This is
  called out explicitly because it's the hardest and most differentiating part of the
  observability work (ROADMAP.md §8).

### 9.4 Structured alerts & machine-readable runbooks (Phase 5-6, not yet implemented)
- Alertmanager payloads carry structured labels beyond the defaults: `runbook_url`,
  `slo`, `severity`, `service`, and a `dlq: true/false` flag — so a webhook consumer
  (human or agent) doesn't need to parse alert prose to decide what to do.
- Every runbook (`docs/runbooks/*.md`) has YAML frontmatter — `id`, `symptom`,
  `service`, `severity`, `diagnosis_steps`, `mitigation_steps`, `escalation`,
  `related_slo`, `related_alert` — with human narrative prose below it. An agent reads
  the frontmatter; a human reads the prose. Same file, two audiences.

### 9.5 Data access layer for agents
No new services are stood up for this. Prometheus (metrics), Tempo (traces), and Loki
(logs) each already expose a queryable HTTP API — that API surface *is* the
agent-readiness layer. The discipline in §9.1-9.4 exists so those APIs return
consistent, well-labeled data rather than requiring an agent to know per-service quirks.

### 9.6 Future: agent-facing interface (explicit stretch goal, Phase 8+)
Scoped, not built. A small **read-only MCP server** sitting in front of the
Prometheus/Loki/Tempo APIs and the runbook frontmatter, exposing narrow tools such as:
- `get_slo_status(service)` — current error budget burn.
- `get_recent_incidents(service?, since?)` — derived from Alertmanager history.
- `get_runbook(alert_name)` — returns parsed frontmatter + prose for a given alert.
- `query_metric(promql)` — passthrough to Prometheus for ad hoc queries.

This is intentionally **read-only** and scoped after chaos engineering (Phase 7) is
stable — an agent reasoning over telemetry is only useful once the telemetry itself is
trustworthy. Building this earlier would be building on sand.

## 10. Relationship to Roadmap & Milestones

Sequencing and weekly deliverables are owned by `ROADMAP.md` §15, not duplicated here.
This PRD updates when *scope or rationale* changes; ROADMAP.md updates when *timing*
changes.

## 11. Open Questions / Risks

- `notification-service` is still simulated in-process — real separation (own
  container, own chaos toggles) is required before Phase 7 chaos experiment #4
  (latency injection) is meaningful.
- Trace context propagation across the Redis/BullMQ boundary (§9.3) is unproven in
  this codebase; flag as a risk to de-risk early in Phase 4 rather than late.
- No automated error-budget-freeze mechanism exists yet (§7.2) — currently a documented
  policy, not enforced tooling.

## 12. Decision Log

Append-only. When a decision changes, add a new row and mark the old one
`Superseded → see row N`; don't edit history.

| Date | Decision | Rationale | Status |
|---|---|---|---|
| 2026-07-02 | Node.js + TypeScript + Express for `orders-api`/`orders-worker` | Matches ROADMAP.md's OTel/BullMQ/pg examples directly; fastest given existing Node background | Active |
| 2026-07-02 | PostgreSQL for the orders DB | Day job is Mongo-heavy; target fintechs (Monzo, Wise, GoCardless, Starling) run Postgres for ledger correctness — closes a CV gap | Active |
| 2026-07-02 | Redis + BullMQ for the queue | Reuses the Redis-lock idempotent-webhook pattern from a prior production Razorpay integration; BullMQ's `jobId` dedupe is a second free idempotency layer | Active |
| 2026-07-02 | Triple-layered idempotency (DB unique constraint + BullMQ `jobId` + Redis lock) | Defense in depth against duplicate order processing under retry storms — the roadmap's centerpiece distributed-systems failure scenario | Active |
| 2026-07-03 | `PRD.md` established as the single source of truth for requirements/decisions | Requested explicitly; `ROADMAP.md` stays as-is for phasing/milestones | Active |
| 2026-07-03 | All telemetry (logs now; metrics/traces/alerts/runbooks later) designed as structured/schema-consistent from day one, for future AI-agent consumption | Requested explicitly — treat "AI-agent-readiness" as a standing non-functional requirement, not a Phase 4 add-on | Active |
| 2026-07-03 | Structured JSON logging (`pino` + `pino-http`) retrofitted into `orders-api`/`orders-worker` immediately, rather than deferred to the observability phase | Makes §9.1 live now instead of aspirational; cheap to do before more services exist | Active |
| 2026-07-03 | Future agent-facing interface scoped as a read-only MCP server (§9.6), explicitly gated until after chaos engineering (Phase 7) is stable | Telemetry must be trustworthy before an agent reasons over it; avoids building an integration on unproven data | Planned |
