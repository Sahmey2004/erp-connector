# AcmeCorp Merge-Style Connector 



---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Information Architecture](#2-information-architecture)
3. [User Journey Mapping](#3-user-journey-mapping)
4. [Data Architecture](#4-data-architecture)
5. [API Surface Definition](#5-api-surface-definition)
6. [Technology Stack](#6-technology-stack)
7. [Performance Benchmarks](#7-performance-benchmarks)
8. [Verification Guide](#8-verification-guide)

---

## 1. Project Overview

AcmeCorp represents any mid-market ERP with a REST API (SAP Business One, Acumatica, Epicor, or a custom internal system). This connector abstracts all AcmeCorp-specific quirks so that downstream B2B SaaS callers never need to know which ERP they are talking to.

### Core Responsibilities

| # | Responsibility | What the connector does |
|---|---|---|
| 1 | **Auth abstraction** | Accepts a single API key; handles all AcmeCorp-specific header formats internally |
| 2 | **Schema normalisation** | Translates AcmeCorp field names → Merge common models (MergeContact, MergeTicket, MergeAttachment) |
| 3 | **Pagination handling** | Follows `page + page_size` cursor internally; callers receive a flat array |
| 4 | **Rate limit handling** | Reads `Retry-After` on 429, sleeps, retries up to 3× with exponential backoff |
| 5 | **Permission error handling** | Translates 401/403 into `AcmePermissionError` with `requiredScope` + `recommendedAction` |
| 6 | **Missing field handling** | Zod `safeParse` on every record; nulls typed, malformed records logged and skipped |
| 7 | **Write support** | `createTicket()` validates, maps Merge input → AcmeCorp PO, surfaces field errors |
| 8 | **Eval coverage** | 10 hero queries — happy path AND failure cases |

---

## 2. Information Architecture

### File Tree

```
erp-connector/
├── erp_api.py              ← Synthetic AcmeCorp ERP (FastAPI, port 8000)
│                             50 suppliers · 20 POs · 10 shipments
│                             Rate limiting · Auth · Pagination · Admin endpoints
│
├── connector/
│   └── acmecorp.ts         ← Merge connector (TypeScript strict)
│                             Public: getContacts() getTickets() getAttachments() createTicket()
│                             Internal: fetchAllPages() fetchWithRetry() normalize*()
│
├── test-runner.ts          ← Eval suite — 10 hero queries with assertions
│
├── package.json            ← Node deps: zod, ts-node, @types/node, typescript
├── tsconfig.json           ← ES2022, CommonJS, strict mode, noImplicitAny
└── requirements.txt        ← fastapi, uvicorn[standard], pydantic
```

### Domain Hierarchy

```
AcmeCorp ERP  (erp_api.py)
├── Read endpoints
│   ├── GET /suppliers            50 records, paginated (10/page max)
│   ├── GET /purchase-orders      20 records, paginated
│   └── GET /shipments            10 records, paginated
├── Write endpoints
│   └── POST /purchase-orders     Field-level 400 on invalid input
└── Admin endpoints  (test isolation only)
    ├── POST /admin/config        Mutate rate_limit / rate_window / retry_after
    ├── POST /admin/reset         Clear counters + injected data
    └── POST /admin/inject-malformed-supplier

Merge Connector  (connector/acmecorp.ts)
├── Public API  (the ONLY surface callers touch)
│   ├── getContacts()             → MergeContact[]
│   ├── getTickets()              → MergeTicket[]
│   ├── getAttachments()          → MergeAttachment[]
│   └── createTicket(input)       → MergeTicket
└── Internal  (private, never called externally)
    ├── fetchAllPages()           pagination loop
    ├── fetchWithRetry()          429 / 4xx handler
    ├── normalizeSupplier()       AcmeCorp → MergeContact
    ├── normalizePO()             AcmeCorp → MergeTicket
    └── normalizeShipment()       AcmeCorp → MergeAttachment
```

---

## 3. User Journey Mapping

### Path 1 — Read: B2B SaaS fetches normalised supplier list

```
Caller                    Connector                     AcmeCorp ERP
  │                           │                              │
  ├─ getContacts() ──────────►│                              │
  │                           ├─ fetchAllPages("/suppliers") ►│
  │                           │◄─ {data[10], next_page:2} ───┤
  │                           ├─ page 2 ─────────────────────►│
  │                           │◄─ {data[10], next_page:3} ───┤
  │                           │  ... 5 pages total            │
  │                           ├─ SupplierSchema.safeParse()   │
  │                           │  (malformed records skipped)  │
  │                           ├─ normalizeSupplier() ×50      │
  │◄─ MergeContact[50] ───────┤                              │
```

**Caller never sees:** pagination cursors, AcmeCorp field names, raw HTTP responses.

---

### Path 2 — Transparent rate-limit retry

```
Connector                     AcmeCorp ERP
  │                              │
  ├─ fetchWithRetry(url) ────────►│
  │◄─ HTTP 429                   │
  │   Retry-After: 30            │
  │                              │
  ├─ sleep(30 000 ms)            │
  │                              │
  ├─ retry attempt 1 ────────────►│
  │◄─ HTTP 200 OK ────────────────┤
  │
  (caller receives data; 429 never surfaced)
```

**On exhaustion (>3 retries):** throws `Error("[acmecorp] Rate limit still exceeded after 3 retries")`.

---

### Path 3 — Write: create purchase order

```
Caller                    Connector                     AcmeCorp ERP
  │                           │                              │
  ├─ createTicket(input) ────►│                              │
  │                           ├─ validate required fields    │
  │                           │  (throws AcmeValidationError │
  │                           │   if name/total_value bad)   │
  │                           ├─ map MergeTicket → AcmePO   │
  │                           ├─ POST /purchase-orders ──────►│
  │                           │◄─ 201 {po_number, ...} ──────┤
  │                           ├─ PurchaseOrderSchema.safeParse│
  │                           ├─ normalizePO()               │
  │◄─ MergeTicket ────────────┤                              │

  Error paths:
  ├─ ERP 400 (field errors) → AcmeValidationError { fieldErrors }
  ├─ ERP 403 (wrong key)    → AcmePermissionError { requiredScope, recommendedAction }
  └─ Network failure        → Error "[acmecorp] Network error reaching ..."
```

---

## 4. Data Architecture

### Entity Relationships

```
SUPPLIER (1) ──────────── (N) PURCHASE_ORDER
    SUP-001                       PO-0001
    SUP-002                       PO-0002
    ...                           ... (vendor_id → supplier_id)
                                       │
                                       │ po_ref
                                       ▼
                                  SHIPMENT (N)
                                      SHIP-001
                                      SHIP-002
                                      ...
```

### AcmeCorp Raw Schemas

#### Supplier

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `supplier_id` | `string` | No | Primary key, format `SUP-NNN` |
| `supplier_name` | `string` | No | |
| `contact_email` | `string` | **Yes** | Null on SUP-007, SUP-023, SUP-041 |
| `status_code` | `string` | No | `"A"` or `"I"` |
| `region` | `string` | Yes | `NA`, `EU`, `APAC`, `LATAM` |
| `on_time_rate` | `number` | **Yes** | Null on SUP-015, SUP-033 |

#### Purchase Order

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `po_number` | `string` | No | Primary key, format `PO-NNNN` |
| `vendor_id` | `string` | No | FK → supplier_id |
| `po_status` | `string` | No | `OPEN`, `PENDING_APPROVAL`, `CLOSED` |
| `total_value` | `number` | No | Used to derive priority |
| `currency_code` | `string` | Yes | Defaults to `USD` |
| `created_ts` | `string` | Yes | ISO 8601 |
| `expected_delivery` | `string` | **Yes** | Null on PO-0003, PO-0008, PO-0014, PO-0019 |

#### Shipment

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `shipment_id` | `string` | No | Primary key, format `SHIP-NNN` |
| `po_ref` | `string` | Yes | FK → po_number |
| `carrier_code` | `string` | Yes | `UPS`, `FEDEX`, `DHL` |
| `tracking_status` | `string` | Yes | `IN_TRANSIT`, `DELIVERED`, `PENDING` |
| `eta` | `string` | **Yes** | Null on SHIP-004, SHIP-009 |
| `last_update_ts` | `string` | Yes | ISO 8601 |

### Merge Normalised Models

```typescript
interface MergeContact {
  id:            string;                            // ← supplier_id
  name:          string;                            // ← supplier_name
  email_address: string | null;                     // ← contact_email (null preserved)
  status:        "ACTIVE" | "INACTIVE" | "UNKNOWN"; // ← status_code mapped
  remote_data:   Record<string, unknown>;           // ← full raw record
}

interface MergeTicket {
  id:                   string;                          // ← po_number
  name:                 string;                          // ← "PO {po_number}"
  status:               "OPEN" | "PENDING" | "CLOSED" | "UNKNOWN"; // ← po_status mapped
  assignee_contact_id:  string | null;                   // ← vendor_id
  due_date:             string | null;                   // ← expected_delivery (null preserved)
  priority:             "HIGH" | "MEDIUM" | "LOW";       // ← derived from total_value
  remote_data:          Record<string, unknown>;
}

interface MergeAttachment {
  id:          string;                // ← shipment_id
  file_name:   string;               // ← "{shipment_id}_{carrier}_{status}"
  remote_url:  string | null;        // ← null when eta is null
  remote_data: Record<string, unknown>;
}
```

### Mapping Tables

```
AcmeCorp status_code → MergeContact.status
  "A"  → "ACTIVE"
  "I"  → "INACTIVE"
  else → "UNKNOWN"

AcmeCorp po_status → MergeTicket.status
  "OPEN"             → "OPEN"
  "PENDING_APPROVAL" → "PENDING"
  "CLOSED"           → "CLOSED"
  else               → "UNKNOWN"

total_value → MergeTicket.priority
  > 30 000  → "HIGH"
  > 10 000  → "MEDIUM"
  else      → "LOW"
```

---

## 5. API Surface Definition

### AcmeCorp ERP Endpoints

| Method | Path | Auth required | Description |
|---|---|---|---|
| `GET` | `/suppliers` | `readonly_key` or `write_key` | Paginated supplier list |
| `GET` | `/purchase-orders` | `readonly_key` or `write_key` | Paginated PO list |
| `GET` | `/shipments` | `readonly_key` or `write_key` | Paginated shipment list |
| `POST` | `/purchase-orders` | `write_key` only | Create a PO; 400 on field errors |
| `POST` | `/admin/config` | none (test-only) | Mutate `rate_limit`, `rate_window`, `retry_after` |
| `POST` | `/admin/reset` | none (test-only) | Clear rate counters + injected test data |
| `POST` | `/admin/inject-malformed-supplier` | none (test-only) | Inject a null-id supplier record |

### Authentication Model

```
Header: X-API-Key: <key>

readonly_key   →  GET  endpoints: 200 OK
readonly_key   →  POST endpoints: 403 { required_scope: "write", hint: "..." }
write_key      →  GET + POST:     200/201 OK
<unknown key>  →  any endpoint:   403 { required_scope: "read"|"write", hint: "..." }
```

### Pagination Contract

**Request:**
```
GET /suppliers?page=1&page_size=10
```

**Response:**
```json
{
  "data": [ ...10 items... ],
  "pagination": {
    "page":      1,
    "page_size": 10,
    "total":     50,
    "next_page": 2
  }
}
```

`next_page` is `null` on the final page. The connector loops until `null`.

### Rate Limit Contract

```
Default: 10 requests / 60 s per API key

On breach:
  HTTP 429
  Retry-After: 30
  Body: { "error": "rate_limit_exceeded", "retry_after": 30 }

Connector behaviour:
  1. Read Retry-After header
  2. sleep(retryAfterSeconds * 1000)
  3. Retry (up to maxRetries = 3)
  4. Exponential fallback if header absent: 2s, 4s, 8s
  5. After 3 failed retries: throw Error (never a 429 to caller)
```

### Error Shapes

**Permission error (403):**
```json
{
  "error":          "insufficient_scope",
  "message":        "This API key is read-only and cannot create resources.",
  "required_scope": "write",
  "hint":           "Replace your API key with 'write_key' to create purchase orders."
}
```

**Validation error (400):**
```json
{
  "errors": {
    "po_number":   "This field is required and cannot be blank.",
    "total_value": "Must be a positive number greater than zero."
  }
}
```

### Connector Public Interface (TypeScript)

```typescript
class AcmeCorpConnector {
  constructor(apiKey: string, baseUrl?: string)

  // Read — callers use these; pagination/auth/retries are invisible
  getContacts():    Promise<MergeContact[]>
  getTickets():     Promise<MergeTicket[]>
  getAttachments(): Promise<MergeAttachment[]>

  // Write — validates before sending; maps Merge input → AcmeCorp PO
  createTicket(input: CreateTicketInput): Promise<MergeTicket>
}

interface CreateTicketInput {
  name:                  string;   // required — becomes po_number
  total_value:           number;   // required — drives priority
  assignee_contact_id?:  string;   // becomes vendor_id
  due_date?:             string;   // becomes expected_delivery
  currency_code?:        string;
}
```

### Error Types (TypeScript)

```typescript
class AcmePermissionError extends Error {
  statusCode:        number;   // 401 or 403
  rawDetail:         string;   // AcmeCorp's raw message
  requiredScope:     string;   // "read" or "write"
  recommendedAction: string;   // exact human-readable fix
}

class AcmeValidationError extends Error {
  fieldErrors: Record<string, string>;   // field name → message
}
```

---

## 6. Technology Stack

| Layer | Technology | Version | Rationale |
|---|---|---|---|
| Synthetic ERP | FastAPI | ≥ 0.104 | Async-ready, auto OpenAPI docs, Pydantic-native |
| ERP server | Uvicorn | ≥ 0.24 | Production ASGI server, low overhead |
| ERP validation | Pydantic v2 | ≥ 2.5 | Fast, native to FastAPI |
| Connector language | TypeScript | ≥ 5.3 | Strict types, Zod integration, Merge convention |
| Schema validation | Zod | ≥ 3.22 | `safeParse` — never throws on bad data |
| Test runner | ts-node | ≥ 10.9 | Runs TypeScript directly, zero build step |
| HTTP client | Node.js global `fetch` | Node ≥ 18 | No extra dependency |
| **Production hosting (ERP)** | Railway / Render | — | Zero-ops, environment variable injection |
| **Production DB (metadata)** | Postgres + Prisma | — | Audit logs, sync cursors, multi-tenant keys |
| **Production packaging** | NPM package | — | Connector ships as `@yourorg/acmecorp-connector` |

### Dependency Graph

```
test-runner.ts
  └── connector/acmecorp.ts
        └── zod (runtime schema validation)
        └── fetch (Node 18 global — no extra dep)

erp_api.py
  └── fastapi
  └── uvicorn
  └── pydantic
```

---

## 7. Performance Benchmarks

| Metric | Target | Measured condition |
|---|---|---|
| Full 50-supplier fetch (no rate limit hit) | **< 500 ms** | 5 sequential HTTP calls × ~10 ms each + Zod parse |
| Full 20-PO fetch | **< 250 ms** | 2 pages |
| Full 10-shipment fetch | **< 150 ms** | 1 page |
| Zod parse for 50 records | **< 5 ms** | In-process, compiled schema |
| `createTicket()` round-trip | **< 200 ms** | 1 POST + 1 safeParse |
| Rate-limit retry overhead | **= Retry-After header value** | Deterministic — no polling |
| Test suite (tests 1–6, 8–10) | **< 3 s** | Sequential, in-memory ERP data |
| Test suite full (including test 7 sleep) | **< 12 s** | One ~4 s sleep in rate-limit test |
| ERP cold start | **< 1 s** | FastAPI + Uvicorn + in-memory seed data |

### Scalability Notes

- `fetchAllPages` is O(n/pageSize) requests — scales linearly with data volume
- Connector is stateless; multiple instances can run concurrently without shared state
- ERP seed data is generated at import time — deterministic, no DB required for testing
- Rate-limit window is configurable at runtime via `/admin/config` — no restart needed

---

## 8. Verification Guide

### Prerequisites

```bash
# Check versions
python3 --version    # must be ≥ 3.10
node --version       # must be ≥ 18.0.0
npm --version        # must be ≥ 9.0.0
```

### Step 1 — Install dependencies

```bash
cd /Users/sahmey/Erp-connector

# Python (ERP server)
pip install -r requirements.txt --break-system-packages

# Node (connector + tests)
npm install
```

### Step 2 — Start the ERP server

Open **Terminal 1** and run:

```bash
python erp_api.py
```

Expected output:
```
INFO:     Started server process [XXXXX]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
```

### Step 3 — Verify the ERP manually (optional sanity check)

Open **Terminal 2** and run these curl commands:

```bash
# Should return 50 suppliers, page 1 of 5
curl -s -H "X-API-Key: readonly_key" \
  "http://localhost:8000/suppliers?page=1&page_size=10" | python3 -m json.tool

# Should return 20 POs, page 1 of 2
curl -s -H "X-API-Key: readonly_key" \
  "http://localhost:8000/purchase-orders?page=1&page_size=10" | python3 -m json.tool

# Should return 10 shipments, page 1 of 1
curl -s -H "X-API-Key: readonly_key" \
  "http://localhost:8000/shipments?page=1&page_size=10" | python3 -m json.tool

# Should return 403 (invalid key)
curl -s -H "X-API-Key: bad-key" \
  "http://localhost:8000/suppliers" | python3 -m json.tool

# Should create a PO (201)
curl -s -X POST \
  -H "X-API-Key: write_key" \
  -H "Content-Type: application/json" \
  -d '{"po_number":"PO-MANUAL","vendor_id":"SUP-001","total_value":15000}' \
  "http://localhost:8000/purchase-orders" | python3 -m json.tool

# Should fail with field errors (400)
curl -s -X POST \
  -H "X-API-Key: write_key" \
  -H "Content-Type: application/json" \
  -d '{"po_number":"","vendor_id":"","total_value":-1}' \
  "http://localhost:8000/purchase-orders" | python3 -m json.tool
```

### Step 4 — Run the full eval suite

In **Terminal 2**:

```bash
npm test
```

### Step 5 — Expected output

```
╔══════════════════════════════════════════════════════════════╗
║  AcmeCorp Connector Eval Suite                               ║
║  ERP must be running: python erp_api.py                      ║
╚══════════════════════════════════════════════════════════════╝

▶ [1] Fetch all 50 suppliers across pages  [pagination]
    ✓ 50 contacts returned by getContacts()
    ✓ Every contact has a SUP-prefixed id

▶ [2] Null email preserved, not hallucinated  [missing fields]
    ✓ SUP-007, SUP-023, SUP-041 have null email_address
    ✓ No unexpected null emails (only 3 are intentional)

▶ [3] All status codes normalised to Merge enum  [normalisation]
    ✓ All statuses are ACTIVE, INACTIVE, or UNKNOWN
    ✓ Exactly 10 INACTIVE contacts (every 5th supplier)
    ✓ remote_data present on every contact

▶ [4] All 20 POs fetched and priority derived from value  [normalisation]
    ✓ Exactly 20 tickets returned
    ✓ All priorities are HIGH, MEDIUM, or LOW
    ✓ Priority derives correctly from total_value

▶ [5] Null delivery date preserved on POs  [missing fields]
    ✓ PO-0003, PO-0008, PO-0014, PO-0019 have null due_date
    ✓ All other tickets have a non-null due_date

▶ [6] All 10 shipments fetched and normalised  [new entity]
    ✓ Exactly 10 attachments returned
    ✓ SHIP-004 and SHIP-009 have null remote_url (null eta)
    ✓ Attachments with eta have a non-null remote_url
    ✓ remote_data preserved on every attachment

▶ [7] Rate limit triggers transparent retry  [rate limits]
    [rate limit filled — connector will hit 429 and retry in ~4s]
    ✓ getAttachments() succeeds after rate-limit retry (returns 10)

▶ [8] Invalid key returns actionable error  [permission errors]
    ✓ getContacts() throws AcmePermissionError on invalid key
    ✓ readonly_key throws AcmePermissionError on POST

▶ [9] Malformed record skipped, valid records succeed  [missing fields]
    ✓ getContacts() does not throw despite malformed record
    ✓ 50 valid contacts returned (malformed 51st skipped)
    ✓ No contact has a null id (malformed record fully excluded)

▶ [10] Create PO succeeds and maps to MergeTicket  [write support]
    ✓ Returned ticket id matches po_number input
    ✓ Status is OPEN
    ✓ Priority is HIGH (total_value=50000 > 30000)
    ✓ due_date matches input
    ✓ remote_data is present and is an object
    ✓ createTicket() throws AcmeValidationError when name is missing

────────────────────────────────────────────────────────────────
Results:      10/10 passed
Success rate: 100%
Failures:     None
────────────────────────────────────────────────────────────────
```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot reach ERP at http://localhost:8000` | ERP not running | Run `python erp_api.py` in Terminal 1 |
| `ModuleNotFoundError: No module named 'fastapi'` | Python deps not installed | `pip install -r requirements.txt --break-system-packages` |
| `Cannot find module 'zod'` | Node deps not installed | `npm install` |
| `SyntaxError` in ts-node | Node < 18 | `node --version` — upgrade if needed |
| Test 7 never finishes | `rate_window` too long | Check `/admin/config` — reset with `POST /admin/reset` |
| `Error: AcmePermissionError` on getContacts | Wrong API key string | Use `"readonly_key"` exactly |
| Duplicate PO error on test 10 re-run | Previous run left data | `curl -X POST localhost:8000/admin/reset` then re-run |

### Interactive API Docs

With the ERP running, open in a browser:

```
http://localhost:8000/docs
```

This shows the full Swagger UI for all ERP endpoints — useful for manual exploration.

---

*Generated by AcmeCorp Connector — Technical Blueprint v1.0.0*
