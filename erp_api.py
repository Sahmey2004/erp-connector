"""
AcmeCorp Synthetic ERP API — v1.0.0

Simulates a mid-market ERP REST API for Merge connector development and testing.
This is the "third-party platform" the connector talks to.

Run:
    python erp_api.py
    # or
    uvicorn erp_api:app --host 0.0.0.0 --port 8000 --reload

Docs: http://localhost:8000/docs

Auth keys:
    readonly_key  →  GET endpoints only
    write_key     →  GET + POST endpoints
    <anything>    →  403
"""

from __future__ import annotations

import datetime
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel

# ─────────────────────────────────────────────────────────────────────────────
# Application
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="AcmeCorp ERP API",
    version="1.0.0",
    description="Synthetic supply-chain ERP for Merge connector testing.",
    docs_url="/docs",
)

# ─────────────────────────────────────────────────────────────────────────────
# Mutable runtime config — modified by /admin/config for test isolation
# ─────────────────────────────────────────────────────────────────────────────

_config: Dict[str, Any] = {
    "rate_limit":  10,   # max requests per rolling window per key
    "rate_window": 60,   # rolling window size in seconds
    "retry_after": 30,   # value written to Retry-After header on 429
}

# ─────────────────────────────────────────────────────────────────────────────
# Auth keys  →  scope
# ─────────────────────────────────────────────────────────────────────────────

_AUTH: Dict[str, str] = {
    "readonly_key": "read",
    "write_key":    "write",
}

# ─────────────────────────────────────────────────────────────────────────────
# Rate-limit state:  api_key → list of UNIX timestamps within current window
# ─────────────────────────────────────────────────────────────────────────────

_req_log: Dict[str, List[float]] = defaultdict(list)

# ─────────────────────────────────────────────────────────────────────────────
# Edge-case test state — separate from SUPPLIERS so /admin/reset is a simple clear()
# ─────────────────────────────────────────────────────────────────────────────

# Extra supplier records injected by edge-case admin endpoints
_injected_suppliers: List[Dict[str, Any]] = []

# One-shot flag: when True, the next GET /suppliers returns HTTP 500 and resets itself
_server_error_flag: bool = False


def _check_rate(api_key: str) -> None:
    now = time.time()
    window_start = now - _config["rate_window"]
    # Evict stale timestamps
    _req_log[api_key] = [t for t in _req_log[api_key] if t > window_start]
    if len(_req_log[api_key]) >= _config["rate_limit"]:
        raise HTTPException(
            status_code=429,
            detail={
                "error":       "rate_limit_exceeded",
                "message":     (
                    f"Rate limit of {_config['rate_limit']} requests per "
                    f"{_config['rate_window']}s exceeded for this API key."
                ),
                "retry_after": _config["retry_after"],
            },
            headers={"Retry-After": str(_config["retry_after"])},
        )
    _req_log[api_key].append(now)


def _check_auth(api_key: str, *, require_write: bool = False) -> None:
    if api_key not in _AUTH:
        raise HTTPException(
            status_code=403,
            detail={
                "error":          "forbidden",
                "message":        "API key not recognised. Access denied.",
                "required_scope": "write" if require_write else "read",
                "hint": (
                    "Supply 'readonly_key' for GET requests or "
                    "'write_key' for POST requests via the X-API-Key header."
                ),
            },
        )
    if require_write and _AUTH[api_key] != "write":
        raise HTTPException(
            status_code=403,
            detail={
                "error":          "insufficient_scope",
                "message":        "This API key is read-only and cannot create resources.",
                "required_scope": "write",
                "hint":           "Replace your API key with 'write_key' to create purchase orders.",
            },
        )


# ─────────────────────────────────────────────────────────────────────────────
# Pagination helper
# ─────────────────────────────────────────────────────────────────────────────

def _paginate(data: List[Any], page: int, page_size: int) -> Dict[str, Any]:
    page_size = min(max(page_size, 1), 10)   # enforce server-side max of 10
    total     = len(data)
    start     = (page - 1) * page_size
    end       = start + page_size
    chunk     = data[start:end]
    next_page: Optional[int] = (page + 1) if end < total else None
    return {
        "data": chunk,
        "pagination": {
            "page":      page,
            "page_size": page_size,
            "total":     total,
            "next_page": next_page,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Seed data — deterministic, generated at import time
# ─────────────────────────────────────────────────────────────────────────────

# Supplier nulls:  contact_email null on ids 7,23,41 | on_time_rate null on 15,33
_NULL_EMAIL_IDS: set[int] = {7, 23, 41}
_NULL_RATE_IDS:  set[int] = {15, 33}
# Every 5th supplier is INACTIVE
_INACTIVE_IDS:   set[int] = set(range(5, 51, 5))

SUPPLIERS: List[Dict[str, Any]] = [
    {
        "supplier_id":   f"SUP-{i:03d}",
        "supplier_name": f"Supplier {i} Corp",
        "contact_email": None if i in _NULL_EMAIL_IDS
                         else f"contact{i}@supplier{i}.com",
        "status_code":   "I" if i in _INACTIVE_IDS else "A",
        "region":        ["NA", "EU", "APAC", "LATAM"][(i - 1) % 4],
        "on_time_rate":  None if i in _NULL_RATE_IDS
                         else round(0.70 + (i % 30) * 0.01, 2),
    }
    for i in range(1, 51)
]

# PO nulls: expected_delivery null on PO indices 3,8,14,19
_NULL_DELIVERY: set[int] = {3, 8, 14, 19}
_PO_STATUSES = ["OPEN", "PENDING_APPROVAL", "CLOSED"]

PURCHASE_ORDERS: List[Dict[str, Any]] = [
    {
        "po_number":         f"PO-{i:04d}",
        "vendor_id":         f"SUP-{((i - 1) % 50) + 1:03d}",
        "po_status":         _PO_STATUSES[(i - 1) % 3],
        "total_value":       round(5000.0 + i * 2000.0, 2),
        "currency_code":     "USD",
        "created_ts":        (
            f"2024-{((i - 1) % 12) + 1:02d}-"
            f"{((i - 1) % 28) + 1:02d}T10:00:00Z"
        ),
        "expected_delivery": None if i in _NULL_DELIVERY else (
            f"2025-{((i - 1) % 12) + 1:02d}-"
            f"{((i - 1) % 20) + 10:02d}T10:00:00Z"
        ),
    }
    for i in range(1, 21)
]

# Shipment nulls: eta null on shipment indices 4,9
_NULL_ETA:       set[int] = {4, 9}
_TRACKING = ["IN_TRANSIT", "DELIVERED", "PENDING"]

SHIPMENTS: List[Dict[str, Any]] = [
    {
        "shipment_id":    f"SHIP-{i:03d}",
        "po_ref":         f"PO-{i:04d}",
        "carrier_code":   ["UPS", "FEDEX", "DHL"][(i - 1) % 3],
        "tracking_status": _TRACKING[(i - 1) % 3],
        "eta":            None if i in _NULL_ETA else (
            f"2025-{((i - 1) % 12) + 1:02d}-"
            f"{((i - 1) % 20) + 10:02d}T12:00:00Z"
        ),
        "last_update_ts": (
            f"2025-{((i - 1) % 12) + 1:02d}-"
            f"{((i - 1) % 20) + 1:02d}T08:00:00Z"
        ),
    }
    for i in range(1, 11)
]


# ─────────────────────────────────────────────────────────────────────────────
# Read endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/suppliers", summary="List suppliers (paginated)")
def list_suppliers(
    page:      int = Query(1,  ge=1),
    page_size: int = Query(10, ge=1, le=10),
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> Dict[str, Any]:
    global _server_error_flag
    # Server-error flag fires BEFORE auth — simulates mid-infrastructure fault (E4)
    if _server_error_flag:
        _server_error_flag = False   # one-shot: clears itself after firing
        raise HTTPException(
            status_code=500,
            detail={
                "error":   "internal_server_error",
                "message": "Simulated server fault (armed by /admin/trigger-server-error).",
            },
        )
    _check_auth(x_api_key)
    _check_rate(x_api_key)
    # Baseline SUPPLIERS + any injected edge-case records
    return _paginate(SUPPLIERS + _injected_suppliers, page, page_size)


@app.get("/purchase-orders", summary="List purchase orders (paginated)")
def list_purchase_orders(
    page:      int = Query(1,  ge=1),
    page_size: int = Query(10, ge=1, le=10),
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> Dict[str, Any]:
    _check_auth(x_api_key)
    _check_rate(x_api_key)
    return _paginate(PURCHASE_ORDERS, page, page_size)


@app.get("/shipments", summary="List shipments (paginated)")
def list_shipments(
    page:      int = Query(1,  ge=1),
    page_size: int = Query(10, ge=1, le=10),
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> Dict[str, Any]:
    _check_auth(x_api_key)
    _check_rate(x_api_key)
    return _paginate(SHIPMENTS, page, page_size)


# ─────────────────────────────────────────────────────────────────────────────
# Write endpoint
# ─────────────────────────────────────────────────────────────────────────────

class CreatePOBody(BaseModel):
    po_number:         str
    vendor_id:         str
    total_value:       float
    currency_code:     Optional[str] = "USD"
    po_status:         Optional[str] = "OPEN"
    expected_delivery: Optional[str] = None


@app.post("/purchase-orders", status_code=201, summary="Create a purchase order")
def create_purchase_order(
    body:      CreatePOBody,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> Dict[str, Any]:
    _check_auth(x_api_key, require_write=True)
    _check_rate(x_api_key)

    # Field-level validation — returns structured errors, not a single message
    errors: Dict[str, str] = {}

    if not body.po_number.strip():
        errors["po_number"] = "This field is required and cannot be blank."
    if not body.vendor_id.strip():
        errors["vendor_id"] = "This field is required and cannot be blank."
    if body.total_value <= 0:
        errors["total_value"] = "Must be a positive number greater than zero."
    if any(po["po_number"] == body.po_number for po in PURCHASE_ORDERS):
        errors["po_number"] = f"PO number '{body.po_number}' already exists."

    if errors:
        raise HTTPException(status_code=400, detail={"errors": errors})

    new_po: Dict[str, Any] = {
        "po_number":         body.po_number.strip(),
        "vendor_id":         body.vendor_id.strip(),
        "po_status":         (body.po_status or "OPEN").strip(),
        "total_value":       body.total_value,
        "currency_code":     (body.currency_code or "USD").strip(),
        "created_ts":        datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expected_delivery": body.expected_delivery,
    }
    PURCHASE_ORDERS.append(new_po)
    return new_po


# ─────────────────────────────────────────────────────────────────────────────
# Admin / test-isolation endpoints (not part of the ERP contract)
# ─────────────────────────────────────────────────────────────────────────────

class ConfigBody(BaseModel):
    rate_limit:  Optional[int] = None
    rate_window: Optional[int] = None
    retry_after: Optional[int] = None


@app.post("/admin/config", summary="[test] Mutate rate-limit config")
def admin_set_config(body: ConfigBody) -> Dict[str, Any]:
    """
    Allows the test-runner to create reproducible rate-limit scenarios
    without restarting the server.
    """
    if body.rate_limit  is not None:
        _config["rate_limit"]  = body.rate_limit
    if body.rate_window is not None:
        _config["rate_window"] = body.rate_window
    if body.retry_after is not None:
        _config["retry_after"] = body.retry_after
    return {"status": "updated", "config": dict(_config)}


@app.post("/admin/reset", summary="[test] Reset state to baseline")
def admin_reset() -> Dict[str, Any]:
    """
    Clears rate-limit counters, injected edge-case records, server-error flag,
    and any POs created by test 10.  Restores default rate-limit config.
    SUPPLIERS baseline (50 records) is never mutated — injection goes into
    _injected_suppliers, so reset is a simple clear().
    """
    global _server_error_flag
    _req_log.clear()
    _injected_suppliers.clear()
    _server_error_flag = False

    # Remove any POs appended by createTicket() in test 10
    _original_po_count = 20
    while len(PURCHASE_ORDERS) > _original_po_count:
        PURCHASE_ORDERS.pop()

    # Restore default config
    _config["rate_limit"]  = 10
    _config["rate_window"] = 60
    _config["retry_after"] = 30

    return {
        "status":             "reset",
        "baseline_suppliers": len(SUPPLIERS),
        "injected_suppliers": len(_injected_suppliers),
        "pos":                len(PURCHASE_ORDERS),
        "config":             dict(_config),
    }


@app.post("/admin/inject-malformed-supplier",
          summary="[test] Inject a supplier with null supplier_id")
def admin_inject_malformed() -> Dict[str, Any]:
    """
    Appends one supplier where supplier_id is None.
    SupplierSchema.safeParse() will reject it; the connector must
    log a warning and skip the record without crashing.
    Used by core test 9.
    """
    _injected_suppliers.append({
        "supplier_id":   None,              # violates z.string() — intentional
        "supplier_name": "MALFORMED-RECORD",
        "contact_email": None,
        "status_code":   "A",
        "region":        "NA",
        "on_time_rate":  None,
    })
    return {"status": "injected", "total_suppliers": len(SUPPLIERS) + len(_injected_suppliers)}


@app.post("/admin/inject-duplicate-supplier",
          summary="[edge-case E1] Inject a duplicate copy of SUP-001")
def admin_inject_duplicate() -> Dict[str, Any]:
    """
    Appends an exact copy of SUPPLIERS[0] (SUP-001) to _injected_suppliers.
    The connector has no deduplication logic — this record passes through to
    callers, resulting in 51 contacts instead of 50.
    """
    duplicate = dict(SUPPLIERS[0])   # shallow copy — all values are primitives
    _injected_suppliers.append(duplicate)
    return {"status": "injected", "total_suppliers": len(SUPPLIERS) + len(_injected_suppliers)}


@app.post("/admin/inject-whitespace-id-supplier",
          summary="[edge-case E2] Inject a supplier with supplier_id='   '")
def admin_inject_whitespace_id() -> Dict[str, Any]:
    """
    Appends a supplier whose supplier_id is an all-whitespace string.
    Zod's z.string() accepts whitespace — connector does NOT trim or reject it,
    so the record surfaces as a MergeContact with id='   '.
    """
    _injected_suppliers.append({
        "supplier_id":   "   ",
        "supplier_name": "Whitespace ID Corp",
        "contact_email": "ws@test.com",
        "status_code":   "A",
        "region":        "NA",
        "on_time_rate":  0.95,
    })
    return {"status": "injected", "total_suppliers": len(SUPPLIERS) + len(_injected_suppliers)}


@app.post("/admin/inject-unknown-status-supplier",
          summary="[edge-case E3] Inject a supplier with status_code='Z'")
def admin_inject_unknown_status() -> Dict[str, Any]:
    """
    Appends a supplier with an unrecognised status_code 'Z'.
    The connector maps it to 'UNKNOWN' via the fallback in SUPPLIER_STATUS_MAP,
    but emits no console.warn — the mapping is silent, with no observability.
    """
    _injected_suppliers.append({
        "supplier_id":   "SUP-999",
        "supplier_name": "Unknown Status Corp",
        "contact_email": "status@test.com",
        "status_code":   "Z",
        "region":        "NA",
        "on_time_rate":  0.80,
    })
    return {"status": "injected", "total_suppliers": len(SUPPLIERS) + len(_injected_suppliers)}


@app.post("/admin/trigger-server-error",
          summary="[edge-case E4] Arm a one-shot HTTP 500 on the next GET /suppliers")
def admin_trigger_server_error() -> Dict[str, Any]:
    """
    Sets _server_error_flag = True.  The next call to GET /suppliers returns
    HTTP 500 and clears the flag automatically (one-shot semantics).
    The connector's fetchWithRetry falls through to a generic Error branch —
    it does not throw a typed AcmeServerError.
    """
    global _server_error_flag
    _server_error_flag = True
    return {"status": "armed", "next_suppliers_request": "will return HTTP 500 once"}


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="warning",   # suppress request logs during test runs
    )
