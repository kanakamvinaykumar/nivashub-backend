// Maintenance payment helpers — UPI deep links, references, receipts.
//
// We deliberately avoid a payment-gateway integration. Residents pay the
// society directly over UPI (PhonePe / GPay / Paytm). The app generates a
// `upi://pay` deep link with a deterministic transaction note + reference
// so the admin can reconcile the bank statement against the uploaded
// screenshot.

import { prisma } from "./prisma.js";

const MONTH_CODES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

// Sentinel month value for the yearly AMC / water / tax due. Real months are
// 1–12 so 0 is safe to use as the discriminator on the existing unique
// `(flatId, year, month)` index.
export const AMC_MONTH_SENTINEL = 0;

export function monthCode(month: number): string {
  if (month === AMC_MONTH_SENTINEL) return "AMC";
  if (month < 1 || month > 12) throw new Error(`Invalid month ${month}`);
  return MONTH_CODES[month - 1];
}

export function monthLabel(year: number, month: number): string {
  if (month === AMC_MONTH_SENTINEL) return `AMC / Water / Tax ${year}`;
  return `${monthCode(month)} ${year}`;
}

export interface MonthSelection {
  year: number;
  month: number;
}

// Group a flat set of {year, month} selections by year so the reference can
// stay short — e.g. `GH_B102_JUN_JUL_AUG_2026` rather than mixing years.
// When selections span multiple years we emit one segment per year:
//   GH_B102_NOV_DEC_2025_JAN_2026
function buildMonthSegment(months: MonthSelection[]): string {
  if (months.length === 0) return "";
  const sorted = [...months].sort((a, b) => a.year - b.year || a.month - b.month);
  const byYear = new Map<number, number[]>();
  for (const m of sorted) {
    const arr = byYear.get(m.year) ?? [];
    arr.push(m.month);
    byYear.set(m.year, arr);
  }
  const parts: string[] = [];
  for (const [year, monthsInYear] of byYear) {
    parts.push(monthsInYear.map(monthCode).join("_"));
    parts.push(String(year));
  }
  return parts.join("_");
}

// Reference format:  <ASSOCIATION>_<FLAT>_<MONTHS>_<YEAR>
//   GH_B102_JUN_2026
//   GH_B102_JUN_JUL_AUG_2026
// Strips any non [A-Z0-9_] from the apartment code and flat number so the
// reference is safe to embed in URLs and on bank statements.
export function buildPaymentReference(args: {
  apartmentCode: string;
  flatNumber: string;
  months: MonthSelection[];
}): string {
  const apt = sanitize(args.apartmentCode);
  const flat = sanitize(args.flatNumber);
  const months = buildMonthSegment(args.months);
  return [apt, flat, months].filter(Boolean).join("_");
}

function sanitize(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .replace(/^_+|_+$/g, "");
}

// Ensure the reference is unique against the DB. If a clash occurs we suffix
// a short numeric counter — this happens when the same flat pays the same
// months twice (e.g. resubmits after rejection).
export async function uniquePaymentReference(base: string): Promise<string> {
  let candidate = base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await prisma.maintenancePayment.findUnique({
      where: { reference: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
    n += 1;
    candidate = `${base}_${n}`;
  }
}

// Build a `upi://pay` deep link that PhonePe/GPay/Paytm honour on Android.
//
//   upi://pay?pa=greenheights@icici
//           &pn=Green%20Heights%20Association
//           &am=6000
//           &cu=INR
//           &tn=GH_B102_JUN_JUL_AUG_2026
export function buildUpiLink(args: {
  upiId: string;
  payeeName: string;
  amountInr: number;
  transactionNote: string;
}): string {
  const params = new URLSearchParams({
    pa: args.upiId,
    pn: args.payeeName,
    am: String(args.amountInr),
    cu: "INR",
    tn: args.transactionNote,
  });
  // `URLSearchParams` uses `+` for spaces which most UPI apps accept, but
  // `%20` is the safer choice across PhonePe/GPay/Paytm.
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

// Lightweight, dependency-free QR code data URL. The frontend renders this
// directly into an <img>. We delegate to a public QR endpoint instead of
// shipping a QR library: the deep-link string is short and the endpoint is
// stable. (Apartment admins may also upload a pre-rendered QR; that takes
// precedence.)
export function buildUpiQrUrl(upiLink: string): string {
  const enc = encodeURIComponent(upiLink);
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=0&data=${enc}`;
}

// Receipts use a per-apartment sequence: RCPT-<APT>-<YYYYMM>-<NN>.
export async function nextReceiptNumber(apartmentCode: string): Promise<string> {
  const apt = sanitize(apartmentCode);
  const now = new Date();
  const period = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const prefix = `RCPT-${apt}-${period}-`;
  const last = await prisma.maintenancePayment.findFirst({
    where: { receiptNumber: { startsWith: prefix } },
    orderBy: { receiptNumber: "desc" },
    select: { receiptNumber: true },
  });
  let next = 1;
  if (last?.receiptNumber) {
    const tail = last.receiptNumber.slice(prefix.length);
    const parsed = Number.parseInt(tail, 10);
    if (Number.isFinite(parsed)) next = parsed + 1;
  }
  return `${prefix}${String(next).padStart(3, "0")}`;
}

export interface ReceiptArgs {
  receiptNumber: string;
  apartmentName: string;
  apartmentCode: string;
  flatNumber: string;
  blockName: string;
  paidByName: string;
  amountInr: number;
  reference: string;
  months: Array<{ year: number; month: number; amountInr: number }>;
  issuedAt: Date;
  upiId?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
}

// Plain-text receipt body, stored on the receipt row and emailed to the
// resident. Suitable for printing as-is; styled rendering can live in the
// frontend later.
export function renderReceiptBody(args: ReceiptArgs): string {
  const lines: string[] = [];
  lines.push("MAINTENANCE PAYMENT RECEIPT");
  lines.push("");
  lines.push(`Receipt no:    ${args.receiptNumber}`);
  lines.push(`Issued:        ${args.issuedAt.toISOString().slice(0, 10)}`);
  lines.push(`Society:       ${args.apartmentName} (${args.apartmentCode})`);
  lines.push(`Flat:          ${args.blockName ? `${args.blockName} — ` : ""}${args.flatNumber}`);
  lines.push(`Paid by:       ${args.paidByName}`);
  lines.push(`Reference:     ${args.reference}`);
  lines.push("");
  lines.push("Months covered:");
  for (const m of args.months) {
    lines.push(`  · ${monthLabel(m.year, m.month).padEnd(10)}  ₹${m.amountInr}`);
  }
  lines.push("");
  lines.push(`Total paid:    ₹${args.amountInr}`);
  if (args.upiId) lines.push(`UPI ID:        ${args.upiId}`);
  if (args.bankName) {
    lines.push(`Bank:          ${args.bankName}`);
    if (args.bankAccountNumber) lines.push(`A/C No:        ${args.bankAccountNumber}`);
    if (args.bankIfsc) lines.push(`IFSC:          ${args.bankIfsc}`);
  }
  lines.push("");
  lines.push("This is an electronically generated receipt; no signature required.");
  return lines.join("\n");
}

// Backfill maintenance dues for a flat from the apartment's billing start
// (createdAt) through the current calendar month, plus one yearly_amc due
// per calendar year covered. Idempotent — uses upserts on
// (flatId, year, month); month=0 is the AMC sentinel.
//
// Per-flat overrides win over the apartment-level monthly amount. The yearly
// AMC amount is read directly off the flat.
export async function ensureDuesForFlat(flatId: string): Promise<void> {
  const flat = await prisma.flat.findUnique({
    where: { id: flatId },
    select: {
      id: true,
      apartmentId: true,
      monthlyMaintenanceInr: true,
      yearlyAmcInr: true,
      apartment: { select: { createdAt: true, monthlyMaintenanceInr: true } },
    },
  });
  if (!flat || !flat.apartment) return;

  const monthlyAmount = flat.monthlyMaintenanceInr || flat.apartment.monthlyMaintenanceInr || 2000;
  const amcAmount = flat.yearlyAmcInr || 9000;

  const start = new Date(flat.apartment.createdAt);
  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth() + 1;
  const now = new Date();
  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth() + 1;

  interface Op { year: number; month: number; kind: "monthly" | "yearly_amc"; amountInr: number }
  const ops: Op[] = [];
  for (let y = startYear; y <= endYear; y++) {
    const mStart = y === startYear ? startMonth : 1;
    const mEnd = y === endYear ? endMonth : 12;
    for (let m = mStart; m <= mEnd; m++) {
      ops.push({ year: y, month: m, kind: "monthly", amountInr: monthlyAmount });
    }
    // One AMC due per year covered.
    ops.push({ year: y, month: AMC_MONTH_SENTINEL, kind: "yearly_amc", amountInr: amcAmount });
  }

  if (ops.length === 0) return;
  await prisma.$transaction(
    ops.map((op) =>
      prisma.maintenanceDue.upsert({
        where: { flatId_year_month: { flatId: flat.id, year: op.year, month: op.month } },
        update: {},
        create: {
          apartmentId: flat.apartmentId,
          flatId: flat.id,
          year: op.year,
          month: op.month,
          kind: op.kind,
          amountInr: op.amountInr,
          status: "pending",
        },
      }),
    ),
  );
}
