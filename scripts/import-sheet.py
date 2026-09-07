#!/usr/bin/env python3
"""One-time backfill: add shipments present in the live 'OMP - TRACKER' sheet
but missing from data/shipments.json (seeded once on 2026-07-31, never resynced).

Only ADDS new shipmentIds. Never touches the 130 that already exist -- those
carry richer financial fields (material/qty/GST/margin/etc.) that this sheet
tab does not have, and this script must not overwrite real CRM history.

Usage: python3 scripts/import-sheet.py path/to/sheet_export.csv
"""
import csv
import json
import sys
from datetime import datetime

SHIPMENTS_FILE = "data/shipments.json"

STAGE_MAP = {
    "reached": "reached",
    "dispatched/transit": "intransit",
    "completed": "completed",
    "delivered": "qc",
    "cancelled": "rejected",
}

MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]


def to_iso(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw  # keep raw text (e.g. "NA") rather than fabricate a date


def doc_flag(raw):
    v = (raw or "").strip().lower()
    if not v:
        return "no"
    if v in ("na", "n.a", "n.a.", "not applicable"):
        return "na"
    if v in ("no",):
        return "no"
    return "yes"  # "Yes", or any free text (a filename/description) means present


def build_docs(row, h):
    def col(name):
        return row[h[name]] if h.get(name) is not None and h[name] < len(row) else ""
    invewb = doc_flag(col("Invoice / EWB"))
    return {
        "vehImages": doc_flag(col("Vehicle Images")),
        "weighslip": doc_flag(col("Weighments")),
        "invoice": invewb,
        "ewaybill": invewb,
        "tracking": doc_flag(col("Tracking")),
        "pod": doc_flag(col("POD")),
        "podDoc": doc_flag(col("POD Doc")),
        "dn": doc_flag(col("DN")),
    }


def main():
    if len(sys.argv) != 2:
        print("usage: import-sheet.py <csv_path>")
        sys.exit(1)
    csv_path = sys.argv[1]

    with open(SHIPMENTS_FILE, encoding="utf-8-sig") as f:
        store = json.load(f)
    existing = store.get("shipments", [])
    existing_ids = {s["shipmentId"] for s in existing}

    with open(csv_path, encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    header = rows[1]
    h = {name.strip(): i for i, name in enumerate(header)}
    data_rows = rows[2:]

    added = []
    skipped_no_id = 0
    skipped_existing = 0
    skipped_unknown_stage = []

    for r in data_rows:
        def col(name):
            i = h.get(name)
            return r[i].strip() if i is not None and i < len(r) else ""

        shipment_id = col("Shipment ID")
        if not shipment_id:
            skipped_no_id += 1
            continue
        if shipment_id in existing_ids:
            skipped_existing += 1
            continue

        stage_raw = col("Shipment Status")
        funnel = STAGE_MAP.get(stage_raw.strip().lower())
        if not funnel:
            skipped_unknown_stage.append((shipment_id, stage_raw))
            continue

        mm_date = col("MM Date")
        month = ""
        for fmt in ("%d-%m-%Y", "%d/%m/%Y"):
            try:
                month = MONTHS[datetime.strptime(mm_date, fmt).month - 1]
                break
            except ValueError:
                continue

        remarks_parts = [col("Remarks"), col("Actual Dispatch status Remarks")]
        remarks = " | ".join(p for p in remarks_parts if p)

        shipment = {
            "shipmentId": shipment_id,
            "orderId": col("SO Number"),
            "vertical": col("Vertcal Name"),
            "material": "",
            "seller": col("Seller Name"),
            "srPoc": col("SR POC"),
            "buyer": col("Buyer Name"),
            "brPoc": col("BR POC"),
            "controlPoc": col("Control - POC"),
            "month": month,
            "invoiceNo": col("Invoice Number"),
            "invoiceDate": to_iso(col("Inv Date")),
            "dispatchDate": to_iso(col("Dispatch Date")),
            "dueDate": to_iso(col("Due Date")),
            "paymentTerms": col("Payment Terms"),
            "distance": col("Distance"),
            "stageRaw": stage_raw,
            "funnel": funnel,
            "qtyKg": "",
            "materialValue": "",
            "gst": "",
            "total": "",
            "debitNote": "",
            "netPayable": "",
            "paidAmount": "",
            "balance": "",
            "paymentStatus": col("Payment Status"),
            "docs": build_docs(r, h),
            "remarks": remarks,
        }
        added.append(shipment)
        existing_ids.add(shipment_id)

    store["shipments"] = existing + added
    store["count"] = len(store["shipments"])
    store["generatedAt"] = datetime.now().strftime("%Y-%m-%d")

    with open(SHIPMENTS_FILE, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"existing before: {len(existing)}")
    print(f"added: {len(added)}")
    print(f"total after: {len(store['shipments'])}")
    print(f"skipped (no Shipment ID / pre-shipment SO): {skipped_no_id}")
    print(f"skipped (already present): {skipped_existing}")
    if skipped_unknown_stage:
        print(f"skipped (unrecognized stage, needs mapping): {skipped_unknown_stage}")


if __name__ == "__main__":
    main()
