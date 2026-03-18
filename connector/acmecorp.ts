/**
 * AcmeCorp Merge Connector — v1.0.0
 *
 * Abstracts AcmeCorp's ERP API into Merge common models.
 * Handles auth, pagination, rate limits, permission errors,
 * schema validation, and write support internally.
 *
 * Public interface:
 *   getContacts()             → MergeContact[]
 *   getTickets()              → MergeTicket[]
 *   getAttachments()          → MergeAttachment[]
 *   createTicket(input)       → MergeTicket
 *
 * Callers never see: 429, 401/403, cursors, AcmeCorp field names.
 *
 * Requires: Node 18+ (global fetch), zod
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Merge Common Model interfaces — the only shapes callers ever see
// ─────────────────────────────────────────────────────────────────────────────

export interface MergeContact {
  readonly id:            string;
  readonly name:          string;
  readonly email_address: string | null;
  readonly status:        "ACTIVE" | "INACTIVE" | "UNKNOWN";
  readonly remote_data:   Record<string, unknown>;
}

export interface MergeTicket {
  readonly id:                   string;
  readonly name:                 string;
  readonly status:               "OPEN" | "PENDING" | "CLOSED" | "UNKNOWN";
  readonly assignee_contact_id:  string | null;
  readonly due_date:             string | null;
  readonly priority:             "HIGH" | "MEDIUM" | "LOW";
  readonly remote_data:          Record<string, unknown>;
}

export interface MergeAttachment {
  readonly id:         string;
  readonly file_name:  string;
  readonly remote_url: string | null;
  readonly remote_data: Record<string, unknown>;
}

/** Input shape callers pass to createTicket(). */
export interface CreateTicketInput {
  readonly name:                 string;          // maps to po_number
  readonly assignee_contact_id?: string;          // maps to vendor_id
  readonly due_date?:            string;          // maps to expected_delivery
  readonly priority?:            "HIGH" | "MEDIUM" | "LOW";
  readonly total_value:          number;          // required for priority derivation
  readonly currency_code?:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas — AcmeCorp raw response shapes
// Never expose these outside the connector.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /suppliers  →  each item in data[]
 * email is validated loosely (coerce to null on empty string).
 */
const SupplierSchema = z.object({
  supplier_id:   z.string(),
  supplier_name: z.string(),
  contact_email: z.string().nullable(),
  status_code:   z.string(),
  region:        z.string().optional().nullable(),
  on_time_rate:  z.number().nullable(),
});

/**
 * GET /purchase-orders  +  POST /purchase-orders  →  each item in data[]
 */
const PurchaseOrderSchema = z.object({
  po_number:         z.string(),
  vendor_id:         z.string(),
  po_status:         z.string(),
  total_value:       z.number(),
  currency_code:     z.string().optional().nullable(),
  created_ts:        z.string().optional().nullable(),
  expected_delivery: z.string().nullable(),
});

/**
 * GET /shipments  →  each item in data[]
 */
const ShipmentSchema = z.object({
  shipment_id:     z.string(),
  po_ref:          z.string().optional().nullable(),
  carrier_code:    z.string().optional().nullable(),
  tracking_status: z.string().optional().nullable(),
  eta:             z.string().nullable(),
  last_update_ts:  z.string().optional().nullable(),
});

/** Pagination envelope returned by every list endpoint. */
const PaginationSchema = z.object({
  page:      z.number(),
  page_size: z.number(),
  total:     z.number(),
  next_page: z.number().nullable(),
});

/** Outer envelope: { data: T[], pagination: {...} } */
const PageEnvelopeSchema = z.object({
  data:       z.array(z.unknown()),
  pagination: PaginationSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Typed error classes — callers catch these, never raw HTTP errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when AcmeCorp returns 401 or 403.
 * Every field is actionable — callers know exactly what to fix.
 */
export class AcmePermissionError extends Error {
  public readonly statusCode:         number;
  public readonly rawDetail:          string;
  public readonly requiredScope:      string;
  public readonly recommendedAction:  string;

  constructor(
    statusCode:        number,
    rawDetail:         string,
    requiredScope:     string,
    recommendedAction: string,
  ) {
    super(
      `[AcmeCorp] Permission denied (HTTP ${statusCode}). ` +
      `Required scope: "${requiredScope}". ` +
      `Action: ${recommendedAction}`,
    );
    this.name               = "AcmePermissionError";
    this.statusCode         = statusCode;
    this.rawDetail          = rawDetail;
    this.requiredScope      = requiredScope;
    this.recommendedAction  = recommendedAction;
  }
}

/**
 * Thrown when required fields are missing or invalid before/during a write.
 * fieldErrors maps field name → human-readable message.
 */
export class AcmeValidationError extends Error {
  public readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(fieldErrors: Record<string, string>) {
    super(
      `[AcmeCorp] Validation failed: ${JSON.stringify(fieldErrors)}`,
    );
    this.name        = "AcmeValidationError";
    this.fieldErrors = fieldErrors;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal type helpers
// ─────────────────────────────────────────────────────────────────────────────

type AcmeSupplier      = z.infer<typeof SupplierSchema>;
type AcmePurchaseOrder = z.infer<typeof PurchaseOrderSchema>;
type AcmeShipment      = z.infer<typeof ShipmentSchema>;

// Status mappings — explicit tables, no fallthrough logic
const SUPPLIER_STATUS_MAP: Record<string, MergeContact["status"]> = {
  A: "ACTIVE",
  I: "INACTIVE",
};

const PO_STATUS_MAP: Record<string, MergeTicket["status"]> = {
  OPEN:             "OPEN",
  PENDING_APPROVAL: "PENDING",
  CLOSED:           "CLOSED",
};

// ─────────────────────────────────────────────────────────────────────────────
// AcmeCorp Connector
// ─────────────────────────────────────────────────────────────────────────────

export class AcmeCorpConnector {
  private readonly apiKey:     string;
  private readonly baseUrl:    string;
  private readonly maxRetries: number = 3;

  constructor(apiKey: string, baseUrl = "http://localhost:8000") {
    this.apiKey  = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetch all suppliers, normalised to MergeContact[].
   * Malformed records are logged and skipped; the rest are returned.
   */
  async getContacts(): Promise<MergeContact[]> {
    const raw = await this.fetchAllPages("/suppliers");
    const out: MergeContact[] = [];

    for (const item of raw) {
      const parsed = SupplierSchema.safeParse(item);
      if (!parsed.success) {
        console.warn(
          "[acmecorp] Skipping malformed supplier record:",
          JSON.stringify(item),
          "Errors:",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
        continue;
      }
      out.push(this.normalizeSupplier(parsed.data));
    }

    return out;
  }

  /**
   * Fetch all purchase orders, normalised to MergeTicket[].
   * Malformed records are logged and skipped.
   */
  async getTickets(): Promise<MergeTicket[]> {
    const raw = await this.fetchAllPages("/purchase-orders");
    const out: MergeTicket[] = [];

    for (const item of raw) {
      const parsed = PurchaseOrderSchema.safeParse(item);
      if (!parsed.success) {
        console.warn(
          "[acmecorp] Skipping malformed purchase order record:",
          JSON.stringify(item),
          "Errors:",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
        continue;
      }
      out.push(this.normalizePO(parsed.data));
    }

    return out;
  }

  /**
   * Fetch all shipments, normalised to MergeAttachment[].
   * Malformed records are logged and skipped.
   */
  async getAttachments(): Promise<MergeAttachment[]> {
    const raw = await this.fetchAllPages("/shipments");
    const out: MergeAttachment[] = [];

    for (const item of raw) {
      const parsed = ShipmentSchema.safeParse(item);
      if (!parsed.success) {
        console.warn(
          "[acmecorp] Skipping malformed shipment record:",
          JSON.stringify(item),
          "Errors:",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
        continue;
      }
      out.push(this.normalizeShipment(parsed.data));
    }

    return out;
  }

  /**
   * Create a purchase order via POST, returning it as a MergeTicket.
   * Validates required fields before sending; surfaces field-level errors
   * as AcmeValidationError — never exposes raw HTTP 400.
   */
  async createTicket(input: CreateTicketInput): Promise<MergeTicket> {
    // Pre-flight validation
    const clientErrors: Record<string, string> = {};
    if (!input.name || !input.name.trim()) {
      clientErrors["name"] = "PO name (po_number) is required and cannot be blank.";
    }
    if (typeof input.total_value !== "number" || input.total_value <= 0) {
      clientErrors["total_value"] = "total_value must be a positive number.";
    }
    if (Object.keys(clientErrors).length > 0) {
      throw new AcmeValidationError(clientErrors);
    }

    // Map Merge CreateTicketInput → AcmeCorp PO body
    const acmePayload = {
      po_number:         input.name.trim(),
      vendor_id:         input.assignee_contact_id ?? "SUP-001",
      total_value:       input.total_value,
      currency_code:     input.currency_code ?? "USD",
      po_status:         "OPEN",
      expected_delivery: input.due_date ?? null,
    };

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/purchase-orders`,
      {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key":    this.apiKey,
        },
        body: JSON.stringify(acmePayload),
      },
    );

    const body = await response.json() as unknown;
    const parsed = PurchaseOrderSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `[acmecorp] Unexpected shape in POST /purchase-orders response: ` +
        parsed.error.issues.map((i) => i.message).join("; "),
      );
    }

    return this.normalizePO(parsed.data);
  }

  // ── Internal: Pagination ───────────────────────────────────────────────────

  /**
   * Follows AcmeCorp's page+page_size cursor until next_page is null.
   * Returns the raw (untyped) items array for the caller to validate.
   * Callers MUST NOT call this method.
   */
  private async fetchAllPages(path: string): Promise<unknown[]> {
    const allItems: unknown[] = [];
    let page = 1;
    const pageSize = 10;

    while (true) {
      const url = `${this.baseUrl}${path}?page=${page}&page_size=${pageSize}`;

      const response = await this.fetchWithRetry(url, {
        method:  "GET",
        headers: { "X-API-Key": this.apiKey },
      });

      const body = await response.json() as unknown;
      const envelope = PageEnvelopeSchema.safeParse(body);

      if (!envelope.success) {
        throw new Error(
          `[acmecorp] Unexpected pagination envelope on ${path} page ${page}: ` +
          envelope.error.issues.map((i) => i.message).join("; "),
        );
      }

      allItems.push(...envelope.data.data);

      if (envelope.data.pagination.next_page === null) {
        break;
      }
      page = envelope.data.pagination.next_page;
    }

    return allItems;
  }

  // ── Internal: Fetch with retry ─────────────────────────────────────────────

  /**
   * Wraps fetch() with:
   *   - 429 → reads Retry-After, sleeps, retries (max 3× with exponential fallback)
   *   - 401/403 → throws AcmePermissionError with full actionable context
   *   - 400 → parses field errors, throws AcmeValidationError
   *   - other non-2xx → throws descriptive Error
   *
   * Callers MUST NOT call this method directly.
   */
  private async fetchWithRetry(
    url:     string,
    options: RequestInit,
    attempt: number = 0,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (networkErr: unknown) {
      const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
      throw new Error(`[acmecorp] Network error reaching ${url}: ${msg}`);
    }

    // ── 429: rate limited ──────────────────────────────────────────────────
    if (response.status === 429) {
      if (attempt >= this.maxRetries) {
        throw new Error(
          `[acmecorp] Rate limit still exceeded after ${this.maxRetries} retries on ${url}.`,
        );
      }
      const retryAfterHeader = response.headers.get("Retry-After");
      // Use Retry-After from header; fall back to exponential backoff
      const retryAfterSec = retryAfterHeader
        ? parseInt(retryAfterHeader, 10)
        : Math.pow(2, attempt + 1);   // 2s, 4s, 8s
      const waitMs = retryAfterSec * 1000;
      console.warn(
        `[acmecorp] Rate limited (attempt ${attempt + 1}/${this.maxRetries}). ` +
        `Waiting ${retryAfterSec}s before retry...`,
      );
      await this.sleep(waitMs);
      return this.fetchWithRetry(url, options, attempt + 1);
    }

    // ── 401/403: permission error ──────────────────────────────────────────
    if (response.status === 401 || response.status === 403) {
      let detail: Record<string, unknown> = {};
      try {
        detail = await response.json() as Record<string, unknown>;
      } catch {
        // Body is not JSON — use empty detail
      }
      const rawMessage = typeof detail["message"] === "string"
        ? detail["message"]
        : `HTTP ${response.status} from AcmeCorp`;
      const requiredScope = typeof detail["required_scope"] === "string"
        ? detail["required_scope"]
        : response.status === 403 ? "write" : "read";
      const hint = typeof detail["hint"] === "string"
        ? detail["hint"]
        : "Verify your X-API-Key header has the required scope.";
      throw new AcmePermissionError(
        response.status,
        rawMessage,
        requiredScope,
        hint,
      );
    }

    // ── 400: validation / bad request ─────────────────────────────────────
    if (response.status === 400) {
      let detail: Record<string, unknown> = {};
      try {
        detail = await response.json() as Record<string, unknown>;
      } catch {
        throw new Error(`[acmecorp] Bad request (400) with non-JSON body from ${url}`);
      }
      if (
        detail["errors"] !== null &&
        detail["errors"] !== undefined &&
        typeof detail["errors"] === "object" &&
        !Array.isArray(detail["errors"])
      ) {
        throw new AcmeValidationError(detail["errors"] as Record<string, string>);
      }
      throw new Error(`[acmecorp] Bad request (400): ${JSON.stringify(detail)}`);
    }

    // ── other non-2xx ─────────────────────────────────────────────────────
    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new Error(
        `[acmecorp] Unexpected HTTP ${response.status} from ${url}: ${text}`,
      );
    }

    return response;
  }

  // ── Internal: sleep ────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Internal: Normalisation ────────────────────────────────────────────────

  /**
   * AcmeCorp supplier → MergeContact
   * raw response is preserved in remote_data — never mutated.
   */
  private normalizeSupplier(raw: AcmeSupplier): MergeContact {
    return {
      id:            raw.supplier_id,
      name:          raw.supplier_name,
      email_address: raw.contact_email ?? null,
      status:        SUPPLIER_STATUS_MAP[raw.status_code] ?? "UNKNOWN",
      remote_data:   raw as unknown as Record<string, unknown>,
    };
  }

  /**
   * AcmeCorp purchase order → MergeTicket
   * Priority is derived from total_value (>30000=HIGH, >10000=MEDIUM, else LOW).
   */
  private normalizePO(raw: AcmePurchaseOrder): MergeTicket {
    const priority: MergeTicket["priority"] =
      raw.total_value > 30_000 ? "HIGH" :
      raw.total_value > 10_000 ? "MEDIUM" :
      "LOW";

    return {
      id:                   raw.po_number,
      name:                 `PO ${raw.po_number}`,
      status:               PO_STATUS_MAP[raw.po_status] ?? "UNKNOWN",
      assignee_contact_id:  raw.vendor_id ?? null,
      due_date:             raw.expected_delivery ?? null,
      priority,
      remote_data:          raw as unknown as Record<string, unknown>,
    };
  }

  /**
   * AcmeCorp shipment → MergeAttachment
   * file_name encodes shipment identity; remote_url is null when eta is absent.
   */
  private normalizeShipment(raw: AcmeShipment): MergeAttachment {
    const carrier = raw.carrier_code    ?? "UNKNOWN-CARRIER";
    const status  = raw.tracking_status ?? "UNKNOWN-STATUS";
    return {
      id:          raw.shipment_id,
      file_name:   `${raw.shipment_id}_${carrier}_${status}`,
      remote_url:  raw.eta
        ? `https://track.acmecorp.io/shipments/${raw.shipment_id}`
        : null,
      remote_data: raw as unknown as Record<string, unknown>,
    };
  }
}
