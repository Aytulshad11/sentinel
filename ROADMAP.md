# Cloud-Native Reliability Platform — Mentor Roadmap

A portfolio project designed to demonstrate Backend / Platform / SRE engineering depth for UK visa-sponsored roles (target tier: Monzo, Wise, Revolut, Checkout.com, GoCardless, Starling, Zopa, and similar).

---

## 0. Challenging Your Assumptions (read this before writing code)

1. **Breadth vs depth trap.** Your list has 16 technologies. UK platform/SRE interviews are won with "tell me about a time something broke and how you found out" stories, not a checklist. Three deeply explored, real failure modes beat ten shallow integrations. Build fewer moving parts, but make each one fail in an interesting, instrumented way.

2. **The EKS cost/complexity trap.** A live EKS cluster (control plane + nodes + NAT gateway) easily runs $150-300/month if left up. Recommendation: do 90% of development on a local `kind` or `k3d` cluster (free, fast iteration), and use Terraform to spin up a real AWS EKS environment only for recorded demos and interview walkthroughs, then `terraform destroy` immediately after. Document this cost discipline explicitly in your README — it's a genuinely strong signal of production maturity, not a workaround to hide.

3. **"Distributed systems" needs a real distributed failure, not a Kubernetes label.** A single monolith wrapped in K8s doesn't demonstrate distributed-systems thinking. You need at least two services talking over a queue so you can inject network partitions, duplicate delivery, poison messages, and slow consumers. Good news: you already have production experience with Redis locks and idempotent webhooks from your Razorpay integration — reuse that exact pattern here as the centerpiece failure scenario (duplicate order processing under retry storms).

4. **PostgreSQL is a deliberate, smart choice for you.** Your production stack is Mongo-heavy; most of your target UK fintechs (Monzo, Wise, GoCardless, Starling) run on Postgres for ledger/transactional correctness. Using Postgres here for an ACID-sensitive order state machine directly closes a gap in your CV.

5. **SLOs are fiction without real traffic.** You need a load generator (k6) constantly hitting the API so your SLO dashboards and burn-rate alerts reflect real numbers during chaos experiments, not static screenshots.

6. **Don't chase multi-region HA.** Scope to single-region, multi-AZ. One deliberate AZ-failure test is enough to demonstrate the thinking without infinite scope creep.

7. **Documentation is the deliverable.** Hiring managers skim code but read READMEs, ADRs, runbooks, and postmortems closely. Treat `/docs` as a first-class part of the project, not an afterthought.

8. **Tie this to what you're already doing.** Your AWS DVA-C02 study (SQS, SNS, DLQ, Kinesis) maps directly onto this project's queue/DLQ work — study and build in parallel. Your Hinglish reels content is also a "build in public" opportunity: documenting this project as a short series doubles as portfolio evidence and content output.

---

## 1. Project Roadmap (Phases)

| Phase | Focus |
|---|---|
| 0 | Foundations — repo skeleton, local dev loop |
| 1 | Core services (API, Worker, Notification) + containerization |
| 2 | Kubernetes (local, via kind/k3d) |
| 3 | Terraform + real AWS (EKS) provisioning |
| 4 | Observability stack — OTel, Prometheus, Grafana |
| 5 | SLO/SLI definitions + alerting |
| 6 | Incident management process + runbooks |
| 7 | Chaos engineering / failure injection |
| 8 | Postmortems, documentation polish, stretch goals |

---

## 2. Architecture Diagram

```
                       +---------------------------+
                       |   k6 Load Generator        |
                       |  (synthetic traffic, 24/7) |
                       +-------------+---------------+
                                     v
                     +------------------------------------+
                     |  Ingress (ALB / nginx-ingress)      |
                     +------------------+-------------------+
                                        v
                          +---------------------------+
                          |   Orders API (Node/TS)     |
                          +---+-------------------+-----+
                       writes |                   | enqueue
                              v                   v
                     +-------------+     +---------------+
                     | PostgreSQL  |     | Redis/BullMQ  |
                     | (orders db) |     | (queue+cache) |
                     +-------------+     +------+---------+
                                                 | jobs
                                                 v
                                      +-----------------------+
                                      |  Orders Worker        |
                                      | (idempotent consumer, |
                                      |  retries, DLQ)        |
                                      +-----------+-----------+
                                                  | flaky downstream call
                                                  v
                                      +-----------------------+
                                      | Notification Service  |
                                      | (chaos-toggleable)     |
                                      +-----------------------+

   +--------------------------- Observability plane -----------------------------+
   | OTel SDK (all 3 services) -> OTel Collector                                 |
   |     -> Prometheus (metrics)  -> Alertmanager -> Slack/webhook               |
   |     -> Tempo/Jaeger (traces, stretch)                                       |
   |     -> Loki (logs, stretch)                                                 |
   | Grafana <- Prometheus + Tempo + Loki                                        |
   +-------------------------------------------------------------------------------+

   Infra: Terraform -> AWS VPC, EKS (or local kind), RDS/in-cluster PG, ECR
   Chaos: Toxiproxy, kubectl pod-kill scripts, k6 spike tests, tc latency injection
```

---

## 3. Repository Structure

```
cloud-native-reliability-platform/
├── README.md
├── ARCHITECTURE.md
├── docs/
│   ├── adr/                     # Architecture Decision Records
│   ├── runbooks/
│   ├── postmortems/
│   └── slo-definitions.md
├── services/
│   ├── orders-api/
│   ├── orders-worker/
│   └── notification-service/
├── load-testing/
│   └── k6/
├── infra/terraform/
│   ├── modules/{vpc,eks,rds,ecr,observability}/
│   └── envs/{local,aws}/
├── k8s/
│   ├── base/                    # kustomize base
│   └── overlays/{local,aws}/
├── observability/
│   ├── otel-collector/
│   ├── prometheus/{rules,alerts}/
│   └── grafana/dashboards/
├── chaos/
│   ├── experiments/
│   └── scripts/
└── .github/workflows/{ci.yml,deploy.yml}
```

---

## 4. Infrastructure Design

- VPC across 2 AZs, public + private subnets, single NAT gateway (cost-conscious choice — document the trade-off vs HA NAT).
- EKS cluster, managed node group on spot instances (2x t3.medium minimum, to demonstrate multi-AZ scheduling).
- Postgres: run in-cluster with a PVC for day-to-day dev (cheap); document RDS as "how I'd run this in production" with a Terraform module included but not always applied.
- ECR for container images.
- ALB Ingress Controller.
- IAM via IRSA (IAM Roles for Service Accounts) — strong, specific AWS+K8s signal.
- Terraform remote state in S3 with DynamoDB locking.

---

## 5. Kubernetes Design

- Namespaces: `app`, `observability`, `chaos`.
- Deployments with resource requests/limits, readiness + liveness probes, PodDisruptionBudgets.
- HPA on `orders-api`, scaling on a custom Prometheus metric (queue depth), not just CPU — this is a more advanced, more interview-worthy signal than default CPU-based HPA.
- NetworkPolicies restricting cross-namespace traffic.
- Secrets via Kubernetes Secrets initially; External Secrets Operator as a stretch goal.
- Kustomize overlays for `local` vs `aws` environments.

---

## 6. Terraform Design

- Modules: `vpc`, `eks`, `rds`, `ecr`, `observability` (Helm releases via the Terraform Helm provider).
- Remote state: S3 backend + DynamoDB lock table.
- Separate `envs/local` and `envs/aws` directories rather than workspaces, for clarity in a portfolio context.
- `terraform plan` on every PR via GitHub Actions; `terraform apply` gated behind manual approval.

---

## 7. Observability Implementation Plan

Build the three pillars progressively rather than all at once:
1. Metrics first (Prometheus + Grafana) — fastest path to visible value and to real SLO data.
2. Traces second (OpenTelemetry -> Tempo/Jaeger) — once metrics show *that* something is slow, traces show *where*.
3. Logs last (Loki, optional) — structured logging tied to trace IDs for correlation.

---

## 8. OpenTelemetry Strategy

- Node SDK auto-instrumentation for HTTP, Express, `pg`, `ioredis`, BullMQ.
- Custom spans for business logic — specifically order state transitions (`created -> queued -> processing -> completed/failed`).
- The hard, impressive part: propagate trace context across the async boundary (API -> Redis queue -> Worker), so a single trace shows the full lifecycle of an order even though it crosses a message broker. This is a genuinely differentiating skill most junior candidates can't demonstrate.
- OTel Collector with OTLP receiver, batch/resource processors, and Prometheus + OTLP exporters.

---

## 9. Prometheus Metrics Strategy

- RED metrics per service: Rate, Errors, Duration.
- USE metrics for infra: Utilization, Saturation, Errors (node/pod level).
- Custom business metrics: `orders_created_total`, `orders_failed_total`, `queue_depth`, `payment_lock_contention_total`, `dlq_messages_total`.
- Recording rules pre-computing SLO burn rates so dashboards and alerts stay fast and consistent.

---

## 10. Grafana Dashboard Strategy

- Service overview (RED) per service.
- Infra dashboard (node/pod CPU, memory, restarts).
- SLO / error-budget dashboard — the one you screen-share in interviews.
- Business dashboard (orders/min, failure rate, queue depth trend).
- A dedicated "incident view" dashboard used live during chaos drills.

---

## 11. Alerting Strategy

- Multi-window, multi-burn-rate alerts (Google SRE Workbook pattern): a fast-burn alert (5m/1h window) for acute incidents, a slow-burn alert (6h/3d window) for budget erosion.
- Alertmanager routes to Slack/webhook with severity-based routing.
- Alert only on symptoms (SLO burn), not on every underlying cause — avoids alert fatigue and is a point worth explicitly making in interviews.

---

## 12. SLO / SLI Definitions

| SLI | SLO |
|---|---|
| Proportion of order-creation requests returning non-5xx | 99.5% over rolling 28 days |
| p95 latency of order creation | < 300ms, met in 99% of 5-min windows over 28 days |
| Proportion of jobs processed without manual DLQ intervention | 99.9% over rolling 28 days |

Define an explicit **error budget policy**: when the budget is exhausted, document that you'd freeze feature work and prioritize reliability work. This single sentence, well-articulated, signals real SRE culture understanding in interviews.

---

## 13. Incident Management Process

- Severity levels SEV1-SEV3 with clear definitions (customer impact, scope, data loss risk).
- Incident roles even as a solo project: Incident Commander, Communications, Scribe — document who would hold each role and why the separation matters.
- Every alert links to a runbook (symptom -> diagnosis steps -> mitigation -> escalation).
- Postmortem template: blameless, timeline, customer impact, root cause via Five Whys, and action items with owners and due dates.

---

## 14. Chaos Engineering & Failure Injection Plan

Start manual (kubectl scripts, Toxiproxy, `tc` for latency injection); add Chaos Mesh or Litmus as a stretch goal once the manual process is solid.

Suggested experiments, each run as hypothesis -> execution -> observation -> write-up:
1. Kill the `orders-api` pod mid-traffic — verify readiness probes and HPA recovery.
2. Exhaust the Postgres connection pool — verify graceful degradation, not cascading failure.
3. Fail over Redis — verify queue durability and worker reconnect behavior.
4. Inject latency into the Notification service — verify timeout/circuit-breaker behavior prevents cascading slowness in the worker.
5. Kill the broker entirely — verify queue backlog recovery and no message loss.
6. Drain a node / simulate AZ failure — verify rescheduling across the remaining AZ.

Each experiment becomes a short, real postmortem in `/docs/postmortems` — these are your strongest interview artifacts.

---

## 15. Weekly Milestones (14 weeks, adjustable)

| Week | Deliverable |
|---|---|
| 1 | Repo scaffold, docker-compose stack, basic API + Worker + Postgres |
| 2 | Redis/BullMQ queue, idempotency logic, order state machine |
| 3 | Multi-stage Docker builds, local k8s deploy via kind |
| 4 | K8s manifests: probes, resource limits, HPA on queue depth |
| 5 | Terraform VPC + EKS module, first real AWS deploy |
| 6 | RDS/ECR/IAM via Terraform, CI/CD pipeline (build -> push -> deploy) |
| 7 | OTel instrumentation across all 3 services |
| 8 | Prometheus + OTel Collector + base Grafana dashboards |
| 9 | SLO/SLI definitions, recording rules, burn-rate alerts |
| 10 | Incident process docs, runbooks, on-call simulation |
| 11 | Chaos experiments 1-2 + postmortems |
| 12 | Chaos experiments 3-4 + postmortems |
| 13 | Docs polish: ADRs, README, architecture diagrams, demo video |
| 14 | Stretch goals + interview-prep pass, recorded walkthrough |

---

## 16. Interview Talking Points (by phase)

Frame each as STAR (Situation/Task/Action/Result):
- **Kubernetes**: "I designed HPA scaling on queue depth rather than CPU, which kept p95 latency under 300ms during a simulated traffic spike that would have caused a 4-minute scale-up lag under CPU-based scaling."
- **Terraform**: "I modularized infra into reusable VPC/EKS/RDS modules with remote state, cutting full environment recreation from a manual multi-hour process to a single `terraform apply`."
- **Observability**: "I propagated trace context across an async queue boundary, so a single distributed trace shows an order's full lifecycle from API request to worker completion — this cut a simulated debugging scenario from grep-ing three services' logs to one trace view."
- **SLOs**: "I implemented multi-window burn-rate alerting per the Google SRE Workbook, which fired only on real budget-threatening regressions and produced zero false pages during three chaos drills."
- **Chaos engineering**: "I ran a Redis failover drill and discovered our retry logic created duplicate order processing; I fixed it using the same Redis-lock idempotency pattern I'd shipped in production for a Razorpay integration."
- **Incident process**: "I wrote a blameless postmortem template and used it across N real, self-induced incidents, each producing concrete action items I then implemented."

---

## 17. Common Mistakes to Avoid

- Building a "tech zoo" — tools with no integration story between them.
- Skipping load testing, so SLO numbers are fictional.
- No teardown discipline, leading to AWS bill surprises (or, in interviews, an inability to explain real cost trade-offs).
- Dashboards with no alerts behind them.
- Postmortems written for show rather than from genuinely triggered incidents.
- Treating Kubernetes as the headline rather than the reliability outcomes it enables.
- Secrets in plain ConfigMaps, or IAM roles broader than necessary.
- Not documenting *why* — trade-offs (self-hosted vs RDS, NAT gateway vs NAT instance) matter more in interviews than the choice itself.

---

## 18. Stretch Goals (mid-level Platform Engineer parity)

- GitOps via ArgoCD or Flux instead of direct `kubectl apply`/CI deploy.
- Progressive delivery — canary releases via Argo Rollouts or Flagger.
- Service mesh (Linkerd, lighter than Istio) for mTLS and traffic shifting.
- Scheduled chaos experiments in CI via Chaos Mesh.
- Cost visibility via Kubecost or tagged AWS Cost Explorer reports.
- Policy as code (Kyverno or OPA Gatekeeper).
- Security scanning in CI (Trivy for images, tfsec/Checkov for Terraform).
- Multi-AZ RDS failover drill.
- SLO-as-code (Sloth or Pyrra) generating Prometheus rules from YAML definitions.

---

*This roadmap is meant to be revisited and adjusted weekly — treat the milestones as a living plan, not a fixed contract.*
