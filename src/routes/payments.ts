import express, { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  buildPaymentReference,
  buildUpiLink,
  buildUpiQrUrl,
  ensureDuesForFlat,
  monthLabel,
  nextReceiptNumber,
  renderReceiptBody,
  uniquePaymentReference,
} from "../lib/payments.js";
import {
  buildPaymentApprovedOwnerMail,
  buildPaymentRejectedOwnerMail,
  buildPaymentSubmittedAdminMail,
  buildPaymentSubmittedOwnerMail,
  mailer,
} from "../lib/mailer.js";

const router = Router();
router.use(requireAuth);

function loginUrl(): string {
  return process.env.FRONTEND_ORIGIN
    ? `${process.env.FRONTEND_ORIGIN.replace(/\/$/, "")}/login`
    : "http://localhost:5173/login";
}

async function findAdminEmails(apartmentId: string): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { apartmentId, role: "apartment_admin" },
    select: { email: true },
  });
  return admins.map((a) => a.email);
}

function monthsLabel(months: Array<{ year: number; month: number }>): string {
  return months
    .slice()
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map((m) => monthLabel(m.year, m.month))
    .join(", ");
}

// ---------------------------------------------------------------------------
// GET /payments/config  (apartment_admin / super_admin)
// Registered above /:id so the literal path wins.
// ---------------------------------------------------------------------------
router.get(
  "/config",
  requireRole("apartment_admin", "super_admin"),
  async (req, res) => {
    let apartmentId: string | null = null;
    if (req.auth!.role === "apartment_admin") {
      apartmentId = req.auth!.apartmentId;
    } else if (typeof req.query.apartmentId === "string") {
      apartmentId = req.query.apartmentId;
    }
    if (!apartmentId) {
      res.status(400).json({ message: "apartmentId is required" });
      return;
    }
    const apt = await prisma.apartment.findUnique({ where: { id: apartmentId } });
    if (!apt) {
      res.status(404).json({ message: "Apartment not found" });
      return;
    }
    res.json({
      apartmentId: apt.id,
      upiId: apt.upiId,
      upiPayeeName: apt.upiPayeeName,
      upiQrUrl: apt.upiQrUrl,
      bankName: apt.bankName,
      bankAccountNumber: apt.bankAccountNumber,
      bankIfsc: apt.bankIfsc,
      monthlyMaintenanceInr: apt.monthlyMaintenanceInr,
    });
  },
);

// ---------------------------------------------------------------------------
// PATCH /payments/config (apartment_admin / super_admin)
// ---------------------------------------------------------------------------
const ConfigSchema = z.object({
  upiId: z.string().min(3).max(100).optional().nullable(),
  upiPayeeName: z.string().min(2).max(100).optional().nullable(),
  upiQrUrl: z.string().url().optional().nullable(),
  bankName: z.string().min(2).max(100).optional().nullable(),
  bankAccountNumber: z.string().min(4).max(40).optional().nullable(),
  bankIfsc: z.string().min(4).max(20).optional().nullable(),
  monthlyMaintenanceInr: z.number().int().min(0).max(1_000_000).optional(),
  apartmentId: z.string().optional(),
});

router.patch(
  "/config",
  requireRole("apartment_admin", "super_admin"),
  async (req, res) => {
    const parsed = ConfigSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      return;
    }
    let apartmentId: string | null = null;
    if (req.auth!.role === "apartment_admin") {
      apartmentId = req.auth!.apartmentId;
    } else {
      apartmentId = parsed.data.apartmentId ?? null;
    }
    if (!apartmentId) {
      res.status(400).json({ message: "apartmentId is required" });
      return;
    }
    const data: Prisma.ApartmentUpdateInput = {};
    if (parsed.data.upiId !== undefined) data.upiId = parsed.data.upiId?.trim() || null;
    if (parsed.data.upiPayeeName !== undefined) data.upiPayeeName = parsed.data.upiPayeeName?.trim() || null;
    if (parsed.data.upiQrUrl !== undefined) data.upiQrUrl = parsed.data.upiQrUrl?.trim() || null;
    if (parsed.data.bankName !== undefined) data.bankName = parsed.data.bankName?.trim() || null;
    if (parsed.data.bankAccountNumber !== undefined) data.bankAccountNumber = parsed.data.bankAccountNumber?.trim() || null;
    if (parsed.data.bankIfsc !== undefined) data.bankIfsc = parsed.data.bankIfsc?.trim() || null;
    if (parsed.data.monthlyMaintenanceInr !== undefined) data.monthlyMaintenanceInr = parsed.data.monthlyMaintenanceInr;
    const updated = await prisma.apartment.update({ where: { id: apartmentId }, data });
    res.json({
      apartmentId: updated.id,
      upiId: updated.upiId,
      upiPayeeName: updated.upiPayeeName,
      upiQrUrl: updated.upiQrUrl,
      bankName: updated.bankName,
      bankAccountNumber: updated.bankAccountNumber,
      bankIfsc: updated.bankIfsc,
      monthlyMaintenanceInr: updated.monthlyMaintenanceInr,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /payments/pending-dues?flatId=
//   flat_admin:      restricted to own flat
//   apartment_admin: any flat in their apartment
//   super_admin:     any flat
// Returns the flat's pending + pending-verification dues with the
// apartment's UPI / QR / bank details so the client can render the screen.
// ---------------------------------------------------------------------------
router.get("/pending-dues", async (req, res) => {
  const flatId = typeof req.query.flatId === "string" ? req.query.flatId : undefined;
  const role = req.auth!.role;
  const targetFlatId =
    role === "flat_admin" ? req.auth!.flatId ?? undefined : flatId;
  if (!targetFlatId) {
    res.status(400).json({ message: "flatId is required" });
    return;
  }
  const flat = await prisma.flat.findUnique({
    where: { id: targetFlatId },
    include: { apartment: true },
  });
  if (!flat) {
    res.status(404).json({ message: "Flat not found" });
    return;
  }
  if (role === "flat_admin" && req.auth!.flatId !== flat.id) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== flat.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  // Backfill dues lazily so a freshly-created flat shows the right list.
  await ensureDuesForFlat(flat.id);

  const dues = await prisma.maintenanceDue.findMany({
    where: {
      flatId: flat.id,
      status: { in: ["pending", "pending_verification"] },
    },
    orderBy: [{ year: "asc" }, { month: "asc" }],
  });

  const apt = flat.apartment;
  res.json({
    flat: {
      id: flat.id,
      apartmentId: flat.apartmentId,
      number: flat.number,
      block: flat.block,
      ownerName: flat.ownerName,
      ownerEmail: flat.ownerEmail,
    },
    apartment: {
      id: apt.id,
      code: apt.code,
      name: apt.name,
      monthlyMaintenanceInr: apt.monthlyMaintenanceInr,
      upiId: apt.upiId,
      upiPayeeName: apt.upiPayeeName ?? apt.name,
      upiQrUrl: apt.upiQrUrl,
      bankName: apt.bankName,
      bankAccountNumber: apt.bankAccountNumber,
      bankIfsc: apt.bankIfsc,
    },
    dues: dues.map((d) => ({
      id: d.id,
      year: d.year,
      month: d.month,
      kind: d.kind,
      label: monthLabel(d.year, d.month),
      amountInr: d.amountInr,
      status: d.status,
    })),
    totals: {
      pendingMonths: dues.filter((d) => d.status === "pending" && d.kind === "monthly").length,
      pendingAmcYears: dues.filter((d) => d.status === "pending" && d.kind === "yearly_amc").length,
      pendingAmountInr: dues
        .filter((d) => d.status === "pending")
        .reduce((s, d) => s + d.amountInr, 0),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /payments
// Body: { flatId, dueIds: string[] }
// Reserves the selected dues by flipping them to `pending_verification`
// and returns a payment row + UPI link the client can render as QR.
// The actual screenshot is uploaded in a subsequent call.
// ---------------------------------------------------------------------------
const CreatePaymentSchema = z.object({
  flatId: z.string().min(1),
  dueIds: z.array(z.string().min(1)).min(1).max(60),
});

router.post("/", async (req, res) => {
  const parsed = CreatePaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const flat = await prisma.flat.findUnique({
    where: { id: parsed.data.flatId },
    include: { apartment: true },
  });
  if (!flat) {
    res.status(404).json({ message: "Flat not found" });
    return;
  }
  const role = req.auth!.role;
  if (role === "flat_admin" && req.auth!.flatId !== flat.id) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== flat.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const apt = flat.apartment;
  if (!apt.upiId) {
    res.status(409).json({
      message:
        "This society hasn't configured a UPI ID yet. Ask the apartment admin to add it under Association > Maintenance.",
    });
    return;
  }

  const dues = await prisma.maintenanceDue.findMany({
    where: { id: { in: parsed.data.dueIds }, flatId: flat.id },
    orderBy: [{ year: "asc" }, { month: "asc" }],
  });
  if (dues.length !== parsed.data.dueIds.length) {
    res.status(400).json({ message: "Some selected dues don't belong to this flat" });
    return;
  }
  const blocked = dues.find((d) => d.status !== "pending");
  if (blocked) {
    res.status(409).json({
      message: `Month ${monthLabel(blocked.year, blocked.month)} is already ${blocked.status.replace("_", " ")}`,
    });
    return;
  }

  const amount = dues.reduce((s, d) => s + d.amountInr, 0);
  const base = buildPaymentReference({
    apartmentCode: apt.code,
    flatNumber: flat.number,
    months: dues.map((d) => ({ year: d.year, month: d.month })),
  });
  const reference = await uniquePaymentReference(base);
  const upiLink = buildUpiLink({
    upiId: apt.upiId,
    payeeName: apt.upiPayeeName || apt.name,
    amountInr: amount,
    transactionNote: reference,
  });
  const payer = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  const paidByName = payer?.name ?? flat.ownerName;

  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.maintenancePayment.create({
      data: {
        reference,
        apartmentId: flat.apartmentId,
        flatId: flat.id,
        flatNumber: flat.number,
        blockName: flat.block,
        paidByUserId: req.auth!.userId,
        paidByName,
        amountInr: amount,
        upiLink,
        transactionNote: reference,
        status: "pending_verification",
      },
    });
    await tx.paymentMonth.createMany({
      data: dues.map((d) => ({
        paymentId: created.id,
        dueId: d.id,
        year: d.year,
        month: d.month,
        amountInr: d.amountInr,
      })),
    });
    await tx.maintenanceDue.updateMany({
      where: { id: { in: dues.map((d) => d.id) } },
      data: { status: "pending_verification", paymentId: created.id },
    });
    return created;
  });

  res.status(201).json({
    payment: {
      id: payment.id,
      reference: payment.reference,
      amountInr: payment.amountInr,
      status: payment.status,
      submittedAt: payment.submittedAt,
      transactionNote: payment.transactionNote,
    },
    upi: {
      link: upiLink,
      qrUrl: apt.upiQrUrl || buildUpiQrUrl(upiLink),
      upiId: apt.upiId,
      payeeName: apt.upiPayeeName || apt.name,
    },
    months: dues.map((d) => ({
      year: d.year,
      month: d.month,
      kind: d.kind,
      label: monthLabel(d.year, d.month),
      amountInr: d.amountInr,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /payments/:id/screenshot
// Body: { dataUrl: "data:image/png;base64,..." }
// Accepts a single base64-encoded image up to ~6 MB. The image is stored
// inline (data URL) so this module is self-contained — production
// deployments can swap this for an S3 / GCS uploader by replacing the
// `url` value below without changing the schema or frontend.
// ---------------------------------------------------------------------------
const ScreenshotSchema = z.object({
  dataUrl: z
    .string()
    .startsWith("data:image/")
    .refine((s) => s.length <= 8_400_000, "Screenshot is too large (max ~6 MB)"),
});

// 9 MB body limit on this endpoint only.
router.post(
  "/:id/screenshot",
  express.json({ limit: "9mb" }),
  async (req, res) => {
    const parsed = ScreenshotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    const payment = await prisma.maintenancePayment.findUnique({
      where: { id: req.params.id },
      include: { apartment: true, flat: true, months: true },
    });
    if (!payment) {
      res.status(404).json({ message: "Payment not found" });
      return;
    }
    const role = req.auth!.role;
    if (role === "flat_admin" && req.auth!.flatId !== payment.flatId) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    if (role === "apartment_admin" && req.auth!.apartmentId !== payment.apartmentId) {
      res.status(403).json({ message: "Forbidden — wrong apartment" });
      return;
    }
    if (payment.status === "approved") {
      res.status(409).json({ message: "Payment is already approved" });
      return;
    }

    // Extract MIME type + raw payload size for the screenshot row.
    const mimeMatch = parsed.data.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!mimeMatch) {
      res.status(400).json({ message: "Screenshot must be a base64-encoded image data URL" });
      return;
    }
    const mimeType = mimeMatch[1];
    const base64Body = mimeMatch[2];
    const sizeBytes = Math.floor((base64Body.length * 3) / 4);

    const screenshot = await prisma.paymentScreenshot.create({
      data: {
        paymentId: payment.id,
        url: parsed.data.dataUrl,
        mimeType,
        sizeBytes,
      },
    });

    // If a previously-rejected payment is being resubmitted, flip it back
    // to pending_verification so admins see it on the queue again.
    if (payment.status === "rejected") {
      await prisma.maintenancePayment.update({
        where: { id: payment.id },
        data: { status: "pending_verification", rejectedAt: null, adminRemarks: null },
      });
      await prisma.maintenanceDue.updateMany({
        where: { paymentId: payment.id },
        data: { status: "pending_verification" },
      });
    }

    // Notify owner + admins. Best-effort — do not fail the request.
    try {
      const months = monthsLabel(payment.months);
      const owner = payment.flat.ownerEmail;
      if (owner) {
        await mailer.send(
          buildPaymentSubmittedOwnerMail({
            to: owner,
            ownerName: payment.paidByName,
            apartmentName: payment.apartment.name,
            flatNumber: payment.flatNumber,
            reference: payment.reference,
            amountInr: payment.amountInr,
            months,
            loginUrl: loginUrl(),
          }),
        );
      }
      const admins = await findAdminEmails(payment.apartmentId);
      await Promise.all(
        admins.map((adminEmail) =>
          mailer.send(
            buildPaymentSubmittedAdminMail({
              adminEmail,
              apartmentName: payment.apartment.name,
              flatNumber: payment.flatNumber,
              paidByName: payment.paidByName,
              reference: payment.reference,
              amountInr: payment.amountInr,
              months,
              loginUrl: loginUrl(),
            }),
          ),
        ),
      );
    } catch (err) {
      console.error("[mail] payment-submitted notification failed", err);
    }

    res.status(201).json({
      id: screenshot.id,
      url: screenshot.url,
      mimeType: screenshot.mimeType,
      sizeBytes: screenshot.sizeBytes,
      uploadedAt: screenshot.uploadedAt,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /payments
// History — scoped by role. Filters: status, flatId, apartmentId.
// ---------------------------------------------------------------------------
const ListFilterSchema = z.object({
  status: z.enum(["pending_verification", "approved", "rejected"]).optional(),
  flatId: z.string().optional(),
  apartmentId: z.string().optional(),
  q: z.string().max(120).optional(),
});

router.get("/", async (req, res) => {
  const parsed = ListFilterSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query", errors: parsed.error.flatten() });
    return;
  }
  const where: Prisma.MaintenancePaymentWhereInput = {};
  const role = req.auth!.role;
  if (role === "flat_admin") {
    if (!req.auth!.flatId) {
      res.json([]);
      return;
    }
    where.flatId = req.auth!.flatId;
  } else if (role === "apartment_admin") {
    if (!req.auth!.apartmentId) {
      res.json([]);
      return;
    }
    where.apartmentId = req.auth!.apartmentId;
    if (parsed.data.flatId) where.flatId = parsed.data.flatId;
  } else {
    if (parsed.data.apartmentId) where.apartmentId = parsed.data.apartmentId;
    if (parsed.data.flatId) where.flatId = parsed.data.flatId;
  }
  if (parsed.data.status) where.status = parsed.data.status;
  if (parsed.data.q) {
    const q = parsed.data.q.trim();
    where.OR = [
      { reference: { contains: q, mode: "insensitive" } },
      { flatNumber: { contains: q, mode: "insensitive" } },
      { paidByName: { contains: q, mode: "insensitive" } },
    ];
  }

  const list = await prisma.maintenancePayment.findMany({
    where,
    orderBy: [{ submittedAt: "desc" }],
    take: 200,
    include: {
      months: true,
      screenshots: { orderBy: { uploadedAt: "desc" }, take: 1 },
    },
  });
  res.json(
    list.map((p) => ({
      id: p.id,
      reference: p.reference,
      apartmentId: p.apartmentId,
      flatId: p.flatId,
      flatNumber: p.flatNumber,
      blockName: p.blockName,
      paidByName: p.paidByName,
      amountInr: p.amountInr,
      status: p.status,
      submittedAt: p.submittedAt,
      verifiedAt: p.verifiedAt,
      rejectedAt: p.rejectedAt,
      adminRemarks: p.adminRemarks,
      receiptNumber: p.receiptNumber,
      months: p.months
        .map((m) => ({ year: m.year, month: m.month, label: monthLabel(m.year, m.month), amountInr: m.amountInr }))
        .sort((a, b) => a.year - b.year || a.month - b.month),
      screenshotUrl: p.screenshots[0]?.url ?? null,
      screenshotUploadedAt: p.screenshots[0]?.uploadedAt ?? null,
    })),
  );
});

// ---------------------------------------------------------------------------
// GET /payments/:id  — full detail
// ---------------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  const payment = await prisma.maintenancePayment.findUnique({
    where: { id: req.params.id },
    include: {
      months: { orderBy: [{ year: "asc" }, { month: "asc" }] },
      screenshots: { orderBy: { uploadedAt: "desc" } },
      receipt: true,
    },
  });
  if (!payment) {
    res.status(404).json({ message: "Payment not found" });
    return;
  }
  const role = req.auth!.role;
  if (role === "flat_admin" && req.auth!.flatId !== payment.flatId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== payment.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  res.json(payment);
});

// ---------------------------------------------------------------------------
// POST /payments/:id/verify  (apartment_admin / super_admin)
// Body: { remarks?: string }
// Marks the payment approved, flips its dues to `paid`, generates a
// receipt, and notifies the resident.
// ---------------------------------------------------------------------------
const VerifySchema = z.object({
  remarks: z.string().max(2000).optional().nullable(),
});

router.post(
  "/:id/verify",
  requireRole("apartment_admin", "super_admin"),
  async (req, res) => {
    const parsed = VerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      return;
    }
    const payment = await prisma.maintenancePayment.findUnique({
      where: { id: req.params.id },
      include: {
        apartment: true,
        flat: true,
        months: { orderBy: [{ year: "asc" }, { month: "asc" }] },
        receipt: true,
      },
    });
    if (!payment) {
      res.status(404).json({ message: "Payment not found" });
      return;
    }
    if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== payment.apartmentId) {
      res.status(403).json({ message: "Forbidden — wrong apartment" });
      return;
    }
    if (payment.status === "approved") {
      res.json({ message: "Already approved", payment });
      return;
    }
    const verifier = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    const verifierName = verifier?.name ?? "Apartment admin";
    const receiptNumber = await nextReceiptNumber(payment.apartment.code);
    const issuedAt = new Date();
    const body = renderReceiptBody({
      receiptNumber,
      apartmentName: payment.apartment.name,
      apartmentCode: payment.apartment.code,
      flatNumber: payment.flatNumber,
      blockName: payment.blockName,
      paidByName: payment.paidByName,
      amountInr: payment.amountInr,
      reference: payment.reference,
      months: payment.months.map((m) => ({ year: m.year, month: m.month, amountInr: m.amountInr })),
      issuedAt,
      upiId: payment.apartment.upiId,
      bankName: payment.apartment.bankName,
      bankAccountNumber: payment.apartment.bankAccountNumber,
      bankIfsc: payment.apartment.bankIfsc,
    });

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.maintenancePayment.update({
        where: { id: payment.id },
        data: {
          status: "approved",
          verifiedAt: issuedAt,
          verifiedByUserId: req.auth!.userId,
          verifiedByName: verifierName,
          adminRemarks: parsed.data.remarks?.trim() || null,
          receiptNumber,
          receiptIssuedAt: issuedAt,
        },
      });
      await tx.maintenanceDue.updateMany({
        where: { paymentId: payment.id },
        data: { status: "paid", paidAt: issuedAt },
      });
      await tx.paymentReceipt.upsert({
        where: { paymentId: payment.id },
        update: { receiptNumber, amountInr: payment.amountInr, issuedAt, body },
        create: {
          paymentId: payment.id,
          receiptNumber,
          amountInr: payment.amountInr,
          issuedAt,
          body,
        },
      });
      // Refresh the flat's cached `pendingDuesInr` so dashboards stay correct.
      const remaining = await tx.maintenanceDue.aggregate({
        where: { flatId: payment.flatId, status: { in: ["pending", "pending_verification"] } },
        _sum: { amountInr: true },
      });
      await tx.flat.update({
        where: { id: payment.flatId },
        data: { pendingDuesInr: remaining._sum.amountInr ?? 0 },
      });
      return p;
    });

    try {
      if (payment.flat.ownerEmail) {
        await mailer.send(
          buildPaymentApprovedOwnerMail({
            to: payment.flat.ownerEmail,
            ownerName: payment.paidByName,
            apartmentName: payment.apartment.name,
            flatNumber: payment.flatNumber,
            reference: payment.reference,
            amountInr: payment.amountInr,
            months: monthsLabel(payment.months),
            receiptNumber,
            loginUrl: loginUrl(),
          }),
        );
      }
    } catch (err) {
      console.error("[mail] payment-approved notification failed", err);
    }

    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// POST /payments/:id/reject  (apartment_admin / super_admin)
// Body: { remarks: string }
// Flips dues back to `pending` so the resident can re-submit.
// ---------------------------------------------------------------------------
const RejectSchema = z.object({
  remarks: z.string().min(3).max(2000),
});

router.post(
  "/:id/reject",
  requireRole("apartment_admin", "super_admin"),
  async (req, res) => {
    const parsed = RejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      return;
    }
    const payment = await prisma.maintenancePayment.findUnique({
      where: { id: req.params.id },
      include: { apartment: true, flat: true, months: true },
    });
    if (!payment) {
      res.status(404).json({ message: "Payment not found" });
      return;
    }
    if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== payment.apartmentId) {
      res.status(403).json({ message: "Forbidden — wrong apartment" });
      return;
    }
    if (payment.status === "approved") {
      res.status(409).json({ message: "Cannot reject an already-approved payment" });
      return;
    }

    const verifier = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    const verifierName = verifier?.name ?? "Apartment admin";
    const rejectedAt = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.maintenancePayment.update({
        where: { id: payment.id },
        data: {
          status: "rejected",
          rejectedAt,
          rejectedByUserId: req.auth!.userId,
          rejectedByName: verifierName,
          adminRemarks: parsed.data.remarks.trim(),
        },
      });
      // Free the dues so the owner can retry.
      await tx.maintenanceDue.updateMany({
        where: { paymentId: payment.id },
        data: { status: "pending", paymentId: null },
      });
      return p;
    });

    try {
      if (payment.flat.ownerEmail) {
        await mailer.send(
          buildPaymentRejectedOwnerMail({
            to: payment.flat.ownerEmail,
            ownerName: payment.paidByName,
            apartmentName: payment.apartment.name,
            flatNumber: payment.flatNumber,
            reference: payment.reference,
            amountInr: payment.amountInr,
            months: monthsLabel(payment.months),
            remarks: parsed.data.remarks.trim(),
            loginUrl: loginUrl(),
          }),
        );
      }
    } catch (err) {
      console.error("[mail] payment-rejected notification failed", err);
    }

    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// GET /payments/:id/receipt  — printable receipt text
// ---------------------------------------------------------------------------
router.get("/:id/receipt", async (req, res) => {
  const payment = await prisma.maintenancePayment.findUnique({
    where: { id: req.params.id },
    include: { apartment: true, receipt: true, months: { orderBy: [{ year: "asc" }, { month: "asc" }] } },
  });
  if (!payment) {
    res.status(404).json({ message: "Payment not found" });
    return;
  }
  const role = req.auth!.role;
  if (role === "flat_admin" && req.auth!.flatId !== payment.flatId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== payment.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  if (payment.status !== "approved" || !payment.receipt) {
    res.status(409).json({ message: "Receipt is available only for approved payments" });
    return;
  }
  res.json({
    receiptNumber: payment.receipt.receiptNumber,
    amountInr: payment.receipt.amountInr,
    issuedAt: payment.receipt.issuedAt,
    body: payment.receipt.body,
    reference: payment.reference,
    flatNumber: payment.flatNumber,
    apartmentName: payment.apartment.name,
    months: payment.months.map((m) => ({
      year: m.year,
      month: m.month,
      label: monthLabel(m.year, m.month),
      amountInr: m.amountInr,
    })),
  });
});

export default router;
