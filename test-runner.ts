/**
 * AcmeCorp Connector Eval Suite — v2.0
 *
 * SETUP (one-time):
 *   pip install fastapi uvicorn pydantic --break-system-packages
 *   npm install
 *
 * RUN (two terminals):
 *   Terminal 1:  python erp_api.py
 *   Terminal 2:  npx ts-node test-runner.ts
 *
 * OUTPUT FORMAT — each step shows:
 *   ┌─ Step: <what is being verified>
 *   │  Input:    <function called / data sent>
 *   │  Expected: <exact expected value>
 *   │  Actual:   <exact value returned or error>
 *   └─ ✓ PASS  |  ✗ FAIL — <root cause>
 *
 * STRUCTURE:
 *   Tests [1]–[10]  Core tests — all must pass
 *   Tests [E1]–[E4] Edge case tests — all expected to FAIL (confirm known gaps)
 *
 * EXIT CODE:
 *   0  All core tests pass AND all edge cases fail (gaps confirmed)
 *   1  Any core test fails OR any edge case unexpectedly passes
 */

import {
  AcmeCorpConnector,
  AcmePermissionError,
  AcmeValidationError,
  type MergeContact,
  type MergeTicket,
  type MergeAttachment,
} from "./connector/acmecorp";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL     = "http://localhost:8000";
const READONLY_KEY = "readonly_key";
const WRITE_KEY    = "write_key";
const INVALID_KEY  = "this-key-does-not-exist";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TestStep {
  description: string;
  input:       string;
  expected:    string;
  actual:      string;
  passed:      boolean;
  diagnosis?:  string;
}

interface TestCase {
  id:         string;
  name:       string;
  category:   string;
  steps:      TestStep[];
  passed:     boolean;
  isEdgeCase: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Results registry
// ─────────────────────────────────────────────────────────────────────────────

const results: TestCase[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function printStep(step: TestStep): void {
  console.log(`  ┌─ Step: ${step.description}`);
  console.log(`  │  Input:    ${step.input}`);
  console.log(`  │  Expected: ${step.expected}`);
  console.log(`  │  Actual:   ${step.actual}`);
  if (step.passed) {
    console.log(`  └─ ✓ PASS`);
  } else {
    console.log(`  └─ ✗ FAIL — ${step.diagnosis ?? "no diagnosis"}`);
  }
  console.log();
}

/**
 * Run a single assertion step.
 * `getActual` returns { value, passed, diagnosis? }.
 * Never re-throws — all steps in a test run independently.
 */
async function runStep(
  description: string,
  input:       string,
  expected:    string,
  getActual:   () => Promise<{ value: string; passed: boolean; diagnosis?: string }>,
): Promise<TestStep> {
  try {
    const result = await getActual();
    const step: TestStep = {
      description,
      input,
      expected,
      actual:    result.value,
      passed:    result.passed,
      diagnosis: result.passed ? undefined : result.diagnosis,
    };
    printStep(step);
    return step;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const step: TestStep = {
      description,
      input,
      expected,
      actual:    `threw unexpectedly: ${msg}`,
      passed:    false,
      diagnosis: `Unexpected throw from getActual: ${msg}`,
    };
    printStep(step);
    return step;
  }
}

/**
 * Container for one named test case.
 * Prints the test header, runs `fn`, collects steps, pushes to results[].
 */
async function runCase(
  id:         string,
  name:       string,
  category:   string,
  isEdgeCase: boolean,
  fn:         (steps: TestStep[]) => Promise<void>,
): Promise<void> {
  const badge = isEdgeCase ? `${category} ⚠` : category;
  console.log(`▶ ${id} ${name}  [${badge}]`);
  const steps: TestStep[] = [];
  try {
    await fn(steps);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const setupFailStep: TestStep = {
      description: "Test setup / teardown",
      input:       "(internal — adminPost or connector setup)",
      expected:    "No error",
      actual:      `threw: ${msg}`,
      passed:      false,
      diagnosis:   `Unexpected error outside runStep: ${msg}`,
    };
    printStep(setupFailStep);
    steps.push(setupFailStep);
  }
  const passed = steps.length > 0 && steps.every((s) => s.passed);
  results.push({ id, name, category, steps, passed, isEdgeCase });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin helpers (direct HTTP — bypass connector)
// ─────────────────────────────────────────────────────────────────────────────

async function adminPost(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`Admin ${path} returned ${res.status}: ${text}`);
  }
}

async function rawGet(path: string, apiKey: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { headers: { "X-API-Key": apiKey } });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── CORE TESTS [1]–[10] ──────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * [1] PAGINATION
 * getContacts() must follow all 5 pages (50 suppliers at 10/page) and return
 * a flat array of exactly 50 MergeContact objects.
 */
async function test1_paginationFetchesAll50(): Promise<void> {
  await runCase("[1]", "Fetch all 50 suppliers across pages", "PAGINATION", false, async (steps) => {
    await adminPost("/admin/reset", {});
    const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
    const contacts  = await connector.getContacts();

    steps.push(await runStep(
      "Total contacts returned",
      `connector.getContacts() — key: readonly_key (50 suppliers, 5 pages of 10)`,
      "50 contacts",
      async () => ({
        value:     `${contacts.length} contacts`,
        passed:    contacts.length === 50,
        diagnosis: `Expected 50, got ${contacts.length} — pagination loop may not have followed all next_page cursors`,
      }),
    ));

    steps.push(await runStep(
      "All contact IDs carry the SUP- prefix from AcmeCorp",
      "contact.id for all 50 normalised contacts",
      'All 50 start with "SUP-"',
      async () => {
        const bad = contacts.filter((c: MergeContact) => !c.id.startsWith("SUP-"));
        return {
          value:     bad.length === 0
            ? "All 50 IDs start with SUP-"
            : `${bad.length} IDs do not: ${bad.map((c: MergeContact) => c.id).slice(0, 5).join(", ")}`,
          passed:    bad.length === 0,
          diagnosis: `${bad.length} contact(s) have non-SUP ids — normalizeSupplier() mapping issue`,
        };
      },
    ));
  });
}

/**
 * [2] MISSING FIELDS — null email
 * SUP-007, SUP-023, SUP-041 have null contact_email in ERP.
 * Connector must pass null through — not default, not empty string.
 */
async function test2_nullEmailPreserved(): Promise<void> {
  await runCase("[2]", "Null email preserved, not hallucinated", "MISSING FIELDS", false, async (steps) => {
    await adminPost("/admin/reset", {});
    const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
    const contacts  = await connector.getContacts();

    const NULL_IDS = ["SUP-007", "SUP-023", "SUP-041"];

    steps.push(await runStep(
      "SUP-007, SUP-023, SUP-041 have null email_address",
      `contacts.find(c => c.id === id).email_address for ids: ${NULL_IDS.join(", ")}`,
      "null for all three (no default, no empty string)",
      async () => {
        const wrong: string[] = [];
        for (const id of NULL_IDS) {
          const c = contacts.find((x: MergeContact) => x.id === id);
          if (!c) { wrong.push(`${id} not found`); continue; }
          if (c.email_address !== null) wrong.push(`${id}="${String(c.email_address)}"`);
        }
        return {
          value:     wrong.length === 0
            ? "null on SUP-007, SUP-023, SUP-041 ✓"
            : `Non-null emails: ${wrong.join("; ")}`,
          passed:    wrong.length === 0,
          diagnosis: `normalizeSupplier() did not preserve null from contact_email — hallucinated a value`,
        };
      },
    ));

    steps.push(await runStep(
      "No other contacts have unexpected null email_address",
      "contacts where !nullIds.includes(id) && email_address === null",
      "0 unexpected nulls",
      async () => {
        const unexpected = contacts.filter(
          (c: MergeContact) => !NULL_IDS.includes(c.id) && c.email_address === null,
        );
        return {
          value:     unexpected.length === 0
            ? "0 unexpected nulls ✓"
            : `${unexpected.length} unexpected: ${unexpected.map((c: MergeContact) => c.id).join(", ")}`,
          passed:    unexpected.length === 0,
          diagnosis: `${unexpected.length} contact(s) have null email but should not`,
        };
      },
    ));
  });
}

/**
 * [3] NORMALISATION — supplier status codes
 * A→ACTIVE, I→INACTIVE, all others→UNKNOWN.
 * 10 of 50 suppliers are INACTIVE (every 5th one).
 */
async function test3_statusCodeNormalisation(): Promise<void> {
  await runCase("[3]", "All status codes normalised to Merge enum", "NORMALISATION", false, async (steps) => {
    await adminPost("/admin/reset", {});
    const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
    const contacts  = await connector.getContacts();

    steps.push(await runStep(
      "All statuses are valid Merge enum values",
      "contact.status for all 50 contacts",
      'Each is one of: "ACTIVE" | "INACTIVE" | "UNKNOWN"',
      async () => {
        const valid = new Set(["ACTIVE", "INACTIVE", "UNKNOWN"]);
        const bad   = contacts.filter((c: MergeContact) => !valid.has(c.status));
        return {
          value:     bad.length === 0
            ? "All 50 statuses are valid ✓"
            : `${bad.length} invalid: ${bad.map((c: MergeContact) => `${c.id}="${c.status}"`).join(", ")}`,
          passed:    bad.length === 0,
          diagnosis: `${bad.length} contact(s) have status outside the Merge enum`,
        };
      },
    ));

    steps.push(await runStep(
      "Exactly 10 INACTIVE contacts (every 5th supplier has status_code='I')",
      "contacts.filter(c => c.status === 'INACTIVE').length",
      "10 INACTIVE",
      async () => {
        const inactive = contacts.filter((c: MergeContact) => c.status === "INACTIVE");
        return {
          value:     `${inactive.length} INACTIVE (ids: ${inactive.map((c: MergeContact) => c.id).join(", ")})`,
          passed:    inactive.length === 10,
          diagnosis: `Expected 10 INACTIVE (every 5th supplier), got ${inactive.length}`,
        };
      },
    ));

    steps.push(await runStep(
      "remote_data is present on every contact (raw AcmeCorp record preserved)",
      "typeof contact.remote_data === 'object' for all 50",
      "All 50 have remote_data as non-null object",
      async () => {
        const missing = contacts.filter(
          (c: MergeContact) => !c.remote_data || typeof c.remote_data !== "object",
        );
        return {
          value:     missing.length === 0
            ? "All 50 have remote_data ✓"
            : `${missing.length} missing: ${missing.map((c: MergeContact) => c.id).join(", ")}`,
          passed:    missing.length === 0,
          diagnosis: `${missing.length} contact(s) missing remote_data — normalizeSupplier() must always set it`,
        };
      },
    ));
  });
}

/**
 * [4] NORMALISATION — PO status + priority derivation
 * 20 POs fetched. priority derived: >30000=HIGH, >10000=MEDIUM, else LOW.
 * PO values: 5000 + i*2000 → 7000..45000.
 */
async function test4_allPOsFetchedPriorityDerived(): Promise<void> {
  await runCase("[4]", "All 20 POs fetched and priority derived from total_value", "NORMALISATION", false, async (steps) => {
    await adminPost("/admin/reset", {});
    const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
    const tickets   = await connector.getTickets();

    steps.push(await runStep(
      "Total tickets returned",
      "connector.getTickets() — key: readonly_key (20 POs, 2 pages of 10)",
      "20 tickets",
      async () => ({
        value:     `${tickets.length} tickets`,
        passed:    tickets.length === 20,
        diagnosis: `Expected 20, got ${tickets.length}`,
      }),
    ));

    steps.push(await runStep(
      "All priorities are valid Merge enum values",
      "ticket.priority for all 20 tickets",
      'Each is one of: "HIGH" | "MEDIUM" | "LOW"',
      async () => {
        const valid = new Set(["HIGH", "MEDIUM", "LOW"]);
        const bad   = tickets.filter((t: MergeTicket) => !valid.has(t.priority));
        return {
          value:     bad.length === 0
            ? "All 20 priorities are valid ✓"
            : `${bad.length} invalid: ${bad.map((t: MergeTicket) => `${t.id}="${t.priority}"`).join(", ")}`,
          passed:    bad.length === 0,
          diagnosis: `${bad.length} ticket(s) have priority outside the Merge enum`,
        };
      },
    ));

    steps.push(await runStep(
      "Priority correctly derived: >30000→HIGH, >10000→MEDIUM, else→LOW",
      "ticket.priority vs. remote_data.total_value for all 20",
      "HIGH if total_value>30000, MEDIUM if >10000, LOW otherwise — all 20 match",
      async () => {
        const mismatches: string[] = [];
        for (const t of tickets) {
          const raw = t.remote_data as Record<string, unknown>;
          const val = raw["total_value"] as number;
          const expected: MergeTicket["priority"] =
            val > 30_000 ? "HIGH" : val > 10_000 ? "MEDIUM" : "LOW";
          if (t.priority !== expected) {
            mismatches.push(`${t.id}: val=${val} expected=${expected} got=${t.priority}`);
          }
        }
        return {
          value:     mismatches.length === 0
            ? "All 20 derive correctly ✓"
            : `${mismatches.length} mismatch(es): ${mismatches.join("; ")}`,
          passed:    mismatches.length === 0,
          diagnosis: `normalizePO() priority thresholds are wrong: ${mismatches.join("; ")}`,
        };
      },
    ));
  });
}

/**
 * [5] MISSING FIELDS — null delivery date
 * PO-0003, PO-0008, PO-0014, PO-0019 have null expected_delivery in ERP.
 * Connector must surface null due_date — not a placeholder.
 */
async function test5_nullDeliveryDatePreserved(): Promise<void> {
  await runCase("[5]", "Null delivery date preserved on POs", "MISSING FIELDS", false, async (steps) => {
    await adminPost("/admin/reset", {});
    const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
    const tickets   = await connector.getTickets();

    const NULL_DUE_IDS = ["PO-0003", "PO-0008", "PO-0014", "PO-0019"];

    steps.push(await runStep(
      "PO-0003, PO-0008, PO-0014, PO-0019 have null due_date",
      `tickets.find(t => t.id === id).due_date for ids: ${NULL_DUE_IDS.join(", ")}`,
      "null for all four",
      async () => {
        const wrong: string[] = [];
        for (const id of NULL_DUE_IDS) {
          const t = tickets.find((x: MergeTicket) => x.id === id);
          if (!t) { wrong.push(`${id} not found`); continue; }
          if (t.due_date !== null) wrong.push(`${id}="${String(t.due_date)}"`);
        }
        return {
          value:     wrong.length === 0
            ? "null on all four POs ✓"
            : `Non-null due_dates: ${wrong.join("; ")}`,
          passed:    wrong.length === 0,
          diagnosis: `normalizePO() did not preserve null from expected_delivery`,
        };
      },
    ));

    steps.push(await runStep(
      "All other 16 tickets have a non-null due_date",
      "tickets where !nullDueIds.includes(id) && due_date === null",
      "0 unexpected null due_dates",
      async () => {
        const unexpected = tickets.filter(
          (t: MergeTicket) => !NULL_DUE_IDS.includes(t.id) && t.due_date === null,
        );
        return {
          value:     unexpected.length === 0
            ? "0 unexpected nulls ✓"
            : `${unexpected.length} unexpected: ${unexpected.map((t: MergeTicket) => t.id).join(", ")}`,
          passed:    unexpected.length === 0,
          diagnosis: `${unexpected.length} ticket(s) have null due_date but should not`,
        };
      },
    ));
  });
}

/**
 * [6] NEW ENTITY — shipments
 * 10 shipments fetched and normalised to MergeAttachment.
 * SHIP-004 and SHIP-009 have null eta → remote_url must be null.
 */
async function test6_allShipmentsNormalised(): Promise<void> {
  await runCase("[6]", "All 10 shipments fetched and normalised to MergeAttachment", "NEW ENTITY", false, async (steps) => {
    await adminPost("/admin/reset", {});
    const connector   = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
    const attachments = await connector.getAttachments();

    steps.push(await runStep(
      "Total attachments returned",
      "connector.getAttachments() — key: readonly_key (10 shipments, 1 page)",
      "10 attachments",
      async () => ({
        value:     `${attachments.length} attachments`,
        passed:    attachments.length === 10,
        diagnosis: `Expected 10, got ${attachments.length}`,
      }),
    ));

    const NULL_ETA_IDS = ["SHIP-004", "SHIP-009"];

    steps.push(await runStep(
      "SHIP-004 and SHIP-009 have null remote_url (their eta is null in ERP)",
      `attachments.find(a => a.id === id).remote_url for: ${NULL_ETA_IDS.join(", ")}`,
      "null for both",
      async () => {
        const wrong: string[] = [];
        for (const id of NULL_ETA_IDS) {
          const a = attachments.find((x: MergeAttachment) => x.id === id);
          if (!a) { wrong.push(`${id} not found`); continue; }
          if (a.remote_url !== null) wrong.push(`${id}="${String(a.remote_url)}"`);
        }
        return {
          value:     wrong.length === 0
            ? "null on SHIP-004, SHIP-009 ✓"
            : `Non-null remote_urls: ${wrong.join("; ")}`,
          passed:    wrong.length === 0,
          diagnosis: `normalizeShipment() should set remote_url=null when eta is null`,
        };
      },
    ));

    steps.push(await runStep(
      "Shipments with non-null eta have a non-null remote_url",
      "attachments where !nullEtaIds.includes(id) && remote_url === null",
      "0 unexpected null remote_urls",
      async () => {
        const unexpected = attachments.filter(
          (a: MergeAttachment) => !NULL_ETA_IDS.includes(a.id) && a.remote_url === null,
        );
        return {
          value:     unexpected.length === 0
            ? "All 8 with eta have remote_url ✓"
            : `${unexpected.length} unexpected nulls: ${unexpected.map((a: MergeAttachment) => a.id).join(", ")}`,
          passed:    unexpected.length === 0,
          diagnosis: `${unexpected.length} attachment(s) should have remote_url set but don't`,
        };
      },
    ));

    steps.push(await runStep(
      "remote_data is present on every attachment",
      "typeof attachment.remote_data === 'object' for all 10",
      "All 10 have remote_data as non-null object",
      async () => {
        const missing = attachments.filter(
          (a: MergeAttachment) => !a.remote_data || typeof a.remote_data !== "object",
        );
        return {
          value:     missing.length === 0
            ? "All 10 have remote_data ✓"
            : `${missing.length} missing: ${missing.map((a: MergeAttachment) => a.id).join(", ")}`,
          passed:    missing.length === 0,
          diagnosis: `${missing.length} attachment(s) missing remote_data`,
        };
      },
    ));
  });
}

/**
 * [7] RATE LIMITS — transparent retry on 429
 * Strategy: pre-fill the rate-limit window with 2 direct requests,
 * then call connector.getAttachments() → triggers 429 → connector sleeps
 * Retry-After seconds → window expires → retry succeeds.
 * Total overhead: ~4 s.
 */
async function test7_rateLimitRetry(): Promise<void> {
  await runCase("[7]", "Rate limit triggers transparent retry and succeeds", "RATE LIMITS", false, async (steps) => {
    await adminPost("/admin/reset", {});
    // rate_limit=2, rate_window=3s, retry_after=4s
    // After a 4s sleep the 3s window expires → retry succeeds
    await adminPost("/admin/config", { rate_limit: 2, rate_window: 3, retry_after: 4 });

    // Pre-fill with 2 direct requests (window now full for READONLY_KEY)
    await rawGet("/shipments?page=1&page_size=10", READONLY_KEY);
    await rawGet("/shipments?page=1&page_size=10", READONLY_KEY);

    steps.push(await runStep(
      "Pre-fill window check: 3rd raw request should now 429",
      "rawGet('/shipments') after 2 requests (rate_limit=2, window=3s)",
      "HTTP 429 with Retry-After header",
      async () => {
        const r = await rawGet("/shipments?page=1&page_size=10", READONLY_KEY);
        const retryAfter = r.headers.get("Retry-After");
        return {
          value:     `HTTP ${r.status}${retryAfter ? `, Retry-After: ${retryAfter}` : " (no Retry-After header)"}`,
          passed:    r.status === 429 && retryAfter !== null,
          diagnosis: `ERP must return 429 with Retry-After for this test to be valid`,
        };
      },
    ));

    // Reset counters so connector gets a clean attempt (it will fill window and 429, then retry)
    await adminPost("/admin/reset", {});
    await adminPost("/admin/config", { rate_limit: 2, rate_window: 3, retry_after: 4 });
    await rawGet("/shipments?page=1&page_size=10", READONLY_KEY);
    await rawGet("/shipments?page=1&page_size=10", READONLY_KEY);

    console.log("  [connector will hit 429 and retry after ~4s — please wait...]\n");
    const connector   = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
    const attachments = await connector.getAttachments();

    steps.push(await runStep(
      "getAttachments() returns 10 after connector retried transparently",
      "connector.getAttachments() — rate limit was hit; connector slept Retry-After=4s then retried",
      "10 attachments (429 never surfaced to caller)",
      async () => ({
        value:     `${attachments.length} attachments returned after retry`,
        passed:    attachments.length === 10,
        diagnosis: `Expected 10 after retry, got ${attachments.length} — fetchWithRetry may not have retried correctly`,
      }),
    ));

    await adminPost("/admin/reset", {});
  });
}

/**
 * [8] PERMISSION ERRORS — actionable error type
 * Invalid key → AcmePermissionError with all fields populated.
 * readonly_key on POST → AcmePermissionError with requiredScope="write".
 */
async function test8_permissionErrors(): Promise<void> {
  await runCase("[8]", "Invalid key returns typed AcmePermissionError with actionable fields", "PERMISSION ERRORS", false, async (steps) => {
    await adminPost("/admin/reset", {});

    steps.push(await runStep(
      "Invalid key throws AcmePermissionError (not a plain Error)",
      `connector(key="${INVALID_KEY}").getContacts()`,
      "throws AcmePermissionError with statusCode=403, non-empty requiredScope and recommendedAction",
      async () => {
        const connector = new AcmeCorpConnector(INVALID_KEY, BASE_URL);
        let caught: unknown;
        try { await connector.getContacts(); } catch (e: unknown) { caught = e; }

        if (caught === undefined) {
          return { value: "no error thrown", passed: false, diagnosis: "Expected AcmePermissionError, nothing thrown" };
        }
        if (!(caught instanceof AcmePermissionError)) {
          const name = caught instanceof Error ? caught.constructor.name : typeof caught;
          return { value: `threw ${name}: ${String(caught)}`, passed: false, diagnosis: `Expected AcmePermissionError, got ${name}` };
        }
        const issues: string[] = [];
        if (caught.statusCode !== 403)           issues.push(`statusCode=${caught.statusCode} (want 403)`);
        if (!caught.requiredScope)               issues.push("requiredScope is empty");
        if (!caught.recommendedAction)           issues.push("recommendedAction is empty");
        if (!caught.rawDetail)                   issues.push("rawDetail is empty");
        return {
          value: issues.length === 0
            ? `AcmePermissionError — statusCode=403, scope="${caught.requiredScope}", action="${caught.recommendedAction}" ✓`
            : `AcmePermissionError has issues: ${issues.join("; ")}`,
          passed:    issues.length === 0,
          diagnosis: issues.join("; "),
        };
      },
    ));

    steps.push(await runStep(
      "readonly_key on POST throws AcmePermissionError with requiredScope='write'",
      `connector(key="readonly_key").createTicket({ name: "PO-PERM", total_value: 1000 })`,
      `AcmePermissionError with requiredScope="write"`,
      async () => {
        const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
        let caught: unknown;
        try { await connector.createTicket({ name: "PO-PERM", total_value: 1000 }); } catch (e: unknown) { caught = e; }

        if (!(caught instanceof AcmePermissionError)) {
          const name = caught instanceof Error ? caught.constructor.name : typeof caught;
          return { value: `threw ${name}`, passed: false, diagnosis: `Expected AcmePermissionError, got ${name}` };
        }
        return {
          value:     `AcmePermissionError, requiredScope="${caught.requiredScope}" ✓`,
          passed:    caught.requiredScope === "write",
          diagnosis: `requiredScope="${caught.requiredScope}", expected "write"`,
        };
      },
    ));
  });
}

/**
 * [9] MISSING FIELDS — malformed record skipped
 * ERP injected with one supplier where supplier_id=null.
 * SupplierSchema.safeParse() rejects it; connector skips+logs; 50 valid returned.
 */
async function test9_malformedRecordSkipped(): Promise<void> {
  await runCase("[9]", "Malformed record skipped; valid records succeed", "MISSING FIELDS", false, async (steps) => {
    await adminPost("/admin/reset", {});
    await adminPost("/admin/inject-malformed-supplier", {});
    // ERP now has 51 raw records: 50 valid + 1 with supplier_id=null

    const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
    let contacts: MergeContact[] = [];
    let threw = false;

    steps.push(await runStep(
      "getContacts() does not throw when a malformed record is present",
      "connector.getContacts() — 51 raw records (1 with null supplier_id)",
      "Returns array without throwing",
      async () => {
        try {
          contacts = await connector.getContacts();
        } catch (e: unknown) {
          threw = true;
          return {
            value:     `threw: ${e instanceof Error ? e.message : String(e)}`,
            passed:    false,
            diagnosis: "connector crashed on malformed record — safeParse should skip+log, not throw",
          };
        }
        return { value: `returned array of ${contacts.length} ✓`, passed: true };
      },
    ));

    if (!threw) {
      steps.push(await runStep(
        "Exactly 50 valid contacts returned (malformed 51st record excluded)",
        `${contacts.length} contacts in returned array`,
        "50 contacts (malformed null-id record skipped)",
        async () => ({
          value:     `${contacts.length} contacts`,
          passed:    contacts.length === 50,
          diagnosis: `Expected 50 after skipping malformed record, got ${contacts.length}`,
        }),
      ));

      steps.push(await runStep(
        "No contact has a null or empty id (malformed record fully excluded)",
        "contacts.filter(c => !c.id || c.id.trim() === '')",
        "0 contacts with null/empty id",
        async () => {
          const nullIds = contacts.filter((c: MergeContact) => !c.id || c.id.trim() === "");
          return {
            value:     nullIds.length === 0
              ? "0 null/empty ids ✓"
              : `${nullIds.length} invalid id(s) slipped through`,
            passed:    nullIds.length === 0,
            diagnosis: `${nullIds.length} contact(s) with null/empty id reached caller — safeParse filter broken`,
          };
        },
      ));
    }

    await adminPost("/admin/reset", {});
  });
}

/**
 * [10] WRITE SUPPORT — createTicket round-trip
 * Creates a PO via connector, verifies all normalised fields match input.
 * Also confirms AcmeValidationError is thrown when required fields are missing.
 */
async function test10_createTicket(): Promise<void> {
  await runCase("[10]", "createTicket() creates PO and maps to MergeTicket correctly", "WRITE SUPPORT", false, async (steps) => {
    await adminPost("/admin/reset", {});

    const input = {
      name:                "PO-EVAL-9999",
      assignee_contact_id: "SUP-001",
      due_date:            "2025-12-31T00:00:00Z",
      total_value:         50_000,
      currency_code:       "USD",
    };

    const connector = new AcmeCorpConnector(WRITE_KEY, BASE_URL);
    const ticket    = await connector.createTicket(input);

    steps.push(await runStep(
      "Returned ticket.id matches po_number input",
      `connector.createTicket({ name: "${input.name}", total_value: ${input.total_value} })`,
      `id = "${input.name}"`,
      async () => ({
        value:     `id = "${ticket.id}"`,
        passed:    ticket.id === input.name,
        diagnosis: `Expected id="${input.name}", got "${ticket.id}"`,
      }),
    ));

    steps.push(await runStep(
      "New PO status is OPEN (default for a fresh PO)",
      "ticket.status",
      '"OPEN"',
      async () => ({
        value:     `"${ticket.status}"`,
        passed:    ticket.status === "OPEN",
        diagnosis: `Expected "OPEN", got "${ticket.status}"`,
      }),
    ));

    steps.push(await runStep(
      "Priority is HIGH (total_value=50000 > 30000 threshold)",
      `ticket.priority derived from total_value=${input.total_value}`,
      '"HIGH" (50000 > 30000)',
      async () => ({
        value:     `"${ticket.priority}"`,
        passed:    ticket.priority === "HIGH",
        diagnosis: `Expected HIGH for value ${input.total_value}, got "${ticket.priority}"`,
      }),
    ));

    steps.push(await runStep(
      "due_date matches input due_date (expected_delivery round-trip)",
      `ticket.due_date — input was "${input.due_date}"`,
      `"${input.due_date}"`,
      async () => ({
        value:     `"${String(ticket.due_date)}"`,
        passed:    ticket.due_date === input.due_date,
        diagnosis: `Expected "${input.due_date}", got "${String(ticket.due_date)}"`,
      }),
    ));

    steps.push(await runStep(
      "remote_data is present (raw AcmeCorp PO preserved)",
      "typeof ticket.remote_data === 'object' && ticket.remote_data !== null",
      "non-null object",
      async () => ({
        value:     `${typeof ticket.remote_data} (keys: ${Object.keys(ticket.remote_data).join(", ")})`,
        passed:    !!ticket.remote_data && typeof ticket.remote_data === "object",
        diagnosis: "remote_data is missing or null — normalizePO() must always set it",
      }),
    ));

    steps.push(await runStep(
      "createTicket() with blank name throws AcmeValidationError with fieldErrors.name",
      `connector.createTicket({ name: "", total_value: 1000 })`,
      `AcmeValidationError with fieldErrors.name set`,
      async () => {
        let caught: unknown;
        try { await connector.createTicket({ name: "", total_value: 1000 }); } catch (e: unknown) { caught = e; }
        if (!(caught instanceof AcmeValidationError)) {
          const n = caught instanceof Error ? caught.constructor.name : typeof caught;
          return { value: `threw ${n}`, passed: false, diagnosis: `Expected AcmeValidationError, got ${n}` };
        }
        const hasName = "name" in caught.fieldErrors;
        return {
          value:     hasName
            ? `AcmeValidationError, fieldErrors.name="${caught.fieldErrors["name"]}" ✓`
            : `AcmeValidationError thrown but fieldErrors keys: ${Object.keys(caught.fieldErrors).join(", ")}`,
          passed:    hasName,
          diagnosis: `AcmeValidationError missing fieldErrors.name — validator not checking name field`,
        };
      },
    ));

    await adminPost("/admin/reset", {});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── EDGE CASE TESTS [E1]–[E4] ────────────────────────────────────────────────
// These tests are EXPECTED to FAIL — they confirm known gaps in the connector.
// A passing edge case means a gap was fixed and the test should be reclassified.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * [E1] EDGE CASE — KNOWN GAP: duplicate records not deduplicated
 * ERP injected with a copy of SUP-001 → 51 raw records.
 * Connector has no deduplication logic → returns 51 contacts.
 * EXPECTED FAIL: caller receives duplicate data.
 */
async function testE1_duplicateNotDeduped(): Promise<void> {
  await runCase(
    "[E1]", "Duplicate records from ERP pass through to caller",
    "EDGE CASE — KNOWN GAP", true,
    async (steps) => {
      await adminPost("/admin/reset", {});
      await adminPost("/admin/inject-duplicate-supplier", {});
      // ERP: 51 records — SUPPLIERS[0] (SUP-001) appears twice

      const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
      const contacts  = await connector.getContacts();

      const dupCount = contacts.filter((c: MergeContact) => c.id === "SUP-001").length;

      steps.push(await runStep(
        "Inject duplicate of SUP-001; getContacts() should deduplicate",
        "51 raw records (SUP-001 duplicated once), connector.getContacts()",
        "50 unique contacts (duplicate removed by connector)",
        async () => ({
          value:     `${contacts.length} contacts returned — SUP-001 appears ${dupCount}× (${dupCount > 1 ? "DUPLICATE PRESERVED — no dedup logic" : "deduplicated"})`,
          passed:    contacts.length === 50 && dupCount === 1,
          diagnosis: "fetchAllPages accumulates all raw records without deduplication; connector needs a Map<id, contact> to deduplicate",
        }),
      ));

      await adminPost("/admin/reset", {});
    },
  );
}

/**
 * [E2] EDGE CASE — KNOWN GAP: whitespace-only supplier_id passes Zod
 * Injected supplier has supplier_id="   " (three spaces).
 * z.string() does not reject whitespace; connector has no .trim()/.min(1).
 * EXPECTED FAIL: MergeContact with id="   " reaches the caller.
 */
async function testE2_whitespaceIdPassesZod(): Promise<void> {
  await runCase(
    "[E2]", "Whitespace-only supplier_id passes z.string() and reaches caller",
    "EDGE CASE — KNOWN GAP", true,
    async (steps) => {
      await adminPost("/admin/reset", {});
      await adminPost("/admin/inject-whitespace-id-supplier", {});

      const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
      const contacts  = await connector.getContacts();
      const wsContact = contacts.find((c: MergeContact) => c.id.trim() === "" && c.id !== "");

      steps.push(await runStep(
        "Supplier with supplier_id='   ' should be rejected or have id trimmed",
        "connector.getContacts() — supplier with supplier_id='   ' injected",
        "Record skipped (z.string().min(1) or .trim() rejects it) OR id normalised to empty/null",
        async () => ({
          value:     wsContact !== undefined
            ? `contact with id="${wsContact.id}" (whitespace, ${wsContact.id.length} chars) reached caller — NOT rejected`
            : `whitespace record not present in output (unexpected — schema should pass it through)`,
          passed:    wsContact === undefined,
          diagnosis: "SupplierSchema uses z.string() with no .min(1) or .trim() — whitespace ids satisfy the schema and flow to the caller unchanged",
        }),
      ));

      await adminPost("/admin/reset", {});
    },
  );
}

/**
 * [E3] EDGE CASE — KNOWN GAP: unknown status_code silently maps to UNKNOWN
 * Injected supplier has status_code="Z".
 * normalizeSupplier() maps it to "UNKNOWN" via ?? fallback — no console.warn.
 * EXPECTED FAIL: caller gets UNKNOWN but no observability that a novel code was seen.
 */
async function testE3_unknownStatusSilent(): Promise<void> {
  await runCase(
    "[E3]", "Unknown status_code 'Z' silently maps to UNKNOWN with no warning logged",
    "EDGE CASE — KNOWN GAP", true,
    async (steps) => {
      await adminPost("/admin/reset", {});
      await adminPost("/admin/inject-unknown-status-supplier", {});

      // Intercept console.warn to detect whether the connector emits a warning
      const warnMessages: string[] = [];
      const originalWarn = console.warn;
      // Must match Console["warn"]: (...data: unknown[]) => void
      console.warn = (...args: unknown[]): void => {
        warnMessages.push(args.map(String).join(" "));
        originalWarn(...args);  // still visible in console output
      };

      const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
      try {
        await connector.getContacts();
      } finally {
        console.warn = originalWarn;   // always restore
      }

      // Look for any warn that mentions the unknown code "Z"
      const expectedPattern = /unrecogni[sz]ed.*status|status.*Z|unknown.*code.*Z/i;
      const matchingWarn = warnMessages.find((m) => expectedPattern.test(m));

      steps.push(await runStep(
        "Connector emits console.warn when status_code='Z' falls back to UNKNOWN",
        `getContacts() with SUP-999 (status_code="Z") — console.warn intercepted (${warnMessages.length} total warns captured)`,
        `console.warn matching /unrecognised status.*Z/ emitted`,
        async () => ({
          value:     matchingWarn !== undefined
            ? `warn emitted: "${matchingWarn}" ✓`
            : `silent — ${warnMessages.length} warn(s) captured, none match status-code pattern`,
          passed:    matchingWarn !== undefined,
          diagnosis: "normalizeSupplier uses `SUPPLIER_STATUS_MAP[raw.status_code] ?? 'UNKNOWN'` — the ?? fallback is silent; no console.warn is emitted for unrecognised codes, meaning novel ERP values are invisible in logs",
        }),
      ));

      await adminPost("/admin/reset", {});
    },
  );
}

/**
 * [E4] EDGE CASE — KNOWN GAP: server 5xx throws untyped generic Error
 * ERP armed to return 500 on next GET /suppliers.
 * fetchWithRetry has no AcmeServerError type — falls through to plain Error branch.
 * EXPECTED FAIL: caller gets Error, not a typed error with statusCode property.
 */
async function testE4_serverErrorUntyped(): Promise<void> {
  await runCase(
    "[E4]", "Server 5xx throws untyped generic Error (not a typed error class)",
    "EDGE CASE — KNOWN GAP", true,
    async (steps) => {
      await adminPost("/admin/reset", {});
      await adminPost("/admin/trigger-server-error", {});
      // Next GET /suppliers → HTTP 500 (one-shot, auto-clears)

      const connector = new AcmeCorpConnector(READONLY_KEY, BASE_URL);
      let caughtError: unknown;
      try {
        await connector.getContacts();
      } catch (e: unknown) {
        caughtError = e;
      }

      steps.push(await runStep(
        "Server returns 500; connector throws a typed error with statusCode=500",
        "connector.getContacts() — /suppliers will return HTTP 500 on first call",
        "AcmeServerError (or similar typed class) with statusCode=500",
        async () => {
          if (caughtError === undefined) {
            return {
              value:     "no error thrown (unexpected — 500 should always throw)",
              passed:    false,
              diagnosis: "connector silently swallowed HTTP 500 — it should throw",
            };
          }

          // Is it one of the connector's typed error classes?
          const isPermErr   = caughtError instanceof AcmePermissionError;
          const isValErr    = caughtError instanceof AcmeValidationError;
          // Does it at least have a statusCode property?
          const hasStatusCode =
            caughtError instanceof Error &&
            "statusCode" in caughtError &&
            (caughtError as Record<string, unknown>)["statusCode"] === 500;

          const isTyped = isPermErr || isValErr || hasStatusCode;

          const errorName = caughtError instanceof Error
            ? caughtError.constructor.name
            : String(typeof caughtError);
          const errorMsg = caughtError instanceof Error ? caughtError.message : String(caughtError);

          return {
            value:     isTyped
              ? `${errorName} with statusCode=500 ✓`
              : `plain ${errorName}: "${errorMsg.slice(0, 120)}" — no statusCode property`,
            passed:    isTyped,
            diagnosis: "fetchWithRetry branches: 429→retry, 401/403→AcmePermissionError, 400→AcmeValidationError, else→plain Error(\"Unexpected HTTP ...\"). A 5xx hits the else branch — no AcmeServerError class exists to carry statusCode, so callers cannot programmatically distinguish a rate-limit auth error from a server fault.",
          };
        },
      ));

      await adminPost("/admin/reset", {});
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

function printSummary(): void {
  const LINE = "═".repeat(68);
  const DASH = "─".repeat(68);

  const coreTests  = results.filter((r) => !r.isEdgeCase);
  const edgeCases  = results.filter((r) =>  r.isEdgeCase);
  const corePassed = coreTests.filter((r) =>  r.passed).length;
  const edgeFailed = edgeCases.filter((r) => !r.passed).length;

  console.log(`\n${LINE}`);
  console.log("RESULTS SUMMARY");
  console.log(LINE);

  const coreLabel = corePassed === coreTests.length ? "✓ all pass" : "✗ FAILURES PRESENT";
  console.log(`\n  Core Tests  (${coreTests.length}):       ${corePassed}/${coreTests.length} passed  — ${coreLabel}`);
  console.log(`  Edge Cases  (${edgeCases.length}):       ${edgeFailed}/${edgeCases.length} gaps confirmed  — (expected — these are known connector limitations)`);

  // ── Core test failures ──────────────────────────────────────────────────
  console.log(`\n${DASH}`);
  console.log("CORE TEST FAILURES");
  const coreFailures = coreTests.filter((r) => !r.passed);
  if (coreFailures.length === 0) {
    console.log("  None");
  } else {
    for (const tc of coreFailures) {
      console.log(`\n  ${tc.id} ${tc.name}  [${tc.category}]`);
      for (const s of tc.steps.filter((st) => !st.passed)) {
        console.log(`    Step:     ${s.description}`);
        console.log(`    Expected: ${s.expected}`);
        console.log(`    Actual:   ${s.actual}`);
        console.log(`    Cause:    ${s.diagnosis ?? "unknown"}`);
      }
    }
  }

  // ── Edge case gaps ──────────────────────────────────────────────────────
  console.log(`\n${DASH}`);
  console.log("EDGE CASE GAPS CONFIRMED");
  const confirmedGaps     = edgeCases.filter((r) => !r.passed);
  const unexpectedPassing = edgeCases.filter((r) =>  r.passed);

  if (confirmedGaps.length === 0 && unexpectedPassing.length === 0) {
    console.log("  (no edge cases ran)");
  }
  for (const tc of confirmedGaps) {
    const failStep = tc.steps.find((s) => !s.passed);
    console.log(`\n  ${tc.id} ${tc.name}`);
    console.log(`    Expected: ${failStep?.expected ?? "(unknown)"}`);
    console.log(`    Actual:   ${failStep?.actual   ?? "(unknown)"}`);
    console.log(`    Gap:      ${failStep?.diagnosis ?? "no diagnosis"}`);
  }
  if (unexpectedPassing.length > 0) {
    console.log(`\n  ⚠ UNEXPECTEDLY PASSING EDGE CASES (gap was fixed — reclassify these tests):`);
    for (const tc of unexpectedPassing) {
      console.log(`    ${tc.id} ${tc.name}`);
    }
  }

  console.log(`\n${LINE}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  AcmeCorp Connector Eval Suite  v2.0                            ║");
  console.log("║  ERP must be running: python erp_api.py                         ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  // Verify ERP is reachable
  try {
    const health = await fetch(`${BASE_URL}/docs`);
    if (!health.ok) throw new Error(`Status ${health.status}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ Cannot reach ERP at ${BASE_URL}: ${msg}`);
    console.error("  Start with:  python erp_api.py\n");
    process.exit(1);
  }

  // ── Core tests (sequential — test 7 has a ~4s sleep) ──
  await test1_paginationFetchesAll50();
  await test2_nullEmailPreserved();
  await test3_statusCodeNormalisation();
  await test4_allPOsFetchedPriorityDerived();
  await test5_nullDeliveryDatePreserved();
  await test6_allShipmentsNormalised();
  await test7_rateLimitRetry();
  await test8_permissionErrors();
  await test9_malformedRecordSkipped();
  await test10_createTicket();

  // ── Edge case tests (expected to FAIL — confirm known gaps) ──
  await testE1_duplicateNotDeduped();
  await testE2_whitespaceIdPassesZod();
  await testE3_unknownStatusSilent();
  await testE4_serverErrorUntyped();

  printSummary();

  // Exit 0 only when all core tests pass AND all edge cases confirm their gaps
  const coreAllPass  = results.filter((r) => !r.isEdgeCase).every((r) =>  r.passed);
  const edgeAllFail  = results.filter((r) =>  r.isEdgeCase).every((r) => !r.passed);
  process.exit(coreAllPass && edgeAllFail ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("Fatal error in test runner:", err);
  process.exit(1);
});
