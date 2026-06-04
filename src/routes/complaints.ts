import { Router } from "express";
import { z } from "zod";
import type { ComplaintStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  buildComplaintCreatedAdminMail,
  buildComplaintReplyMail,
  buildComplaintStatusChangedMail,
  mailer,
} from "../lib/mailer.js";

const router = Router();
router.use(requireAuth);

const CATEGORIES = [
  "plumbing",
  "electrical",
  "lift",
  "parking",
  "security",
  "cleaning",
  "other",
] as const;
const PRIORITIES = ["low", "medium", "high", "emergency"] as const;
const STATUSES: ComplaintStatus[] = ["active", "pending", "in_progress", "declined", "closed"];

const ComplaintCreateSchema = z.object({
  flatId: z.string().min(1),
  title: z.string().min(3).max(140).transform((v) => v.trim()),
  description: z.string().min(5).max(4000).transform((v) => v.trim()),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES).default("medium"),
  contactNumber: z.string().min(4).max(40),
  preferredVisitTime: z.string().max(200).optional().nullable(),
});

const ComplaintFilterSchema = z.object({
  status: z.enum(["active", "pending", "in_progress", "declined", "closed"]).optional(),
  category: z.enum(CATEGORIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  q: z.string().max(120).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  flatId: z.string().optional(),
  apartmentId: z.string().optional(),
});

const StatusUpdateSchema = z.object({
  status: z.enum(["active", "pending", "in_progress", "declined", "closed"]),
});

const AdminPatchSchema = z.object({
  assignedTo: z.string().max(120).optional().nullable(),
  adminRemarks: z.string().max(2000).optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
});

const MessageCreateSchema = z.object({
  body: z.string().min(1).max(2000).transform((v) => v.trim()),
});

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

// ---------------------------------------------------------------------------
// POST /complaints
// flat_admin: creates a complaint for their own flat
// apartment_admin/super_admin: can create for any flat in apartment they manage
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  const parsed = ComplaintCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const flat = await prisma.flat.findUnique({ where: { id: parsed.data.flatId } });
  if (!flat) {
    res.status(404).json({ message: "Flat not found" });
    return;
  }
  const role = req.auth!.role;
  if (role === "flat_admin" && req.auth!.flatId !== flat.id) {
    res.status(403).json({ message: "You can only raise complaints for your own flat" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== flat.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const apartment = await prisma.apartment.findUnique({ where: { id: flat.apartmentId } });
  if (!apartment) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }
  const raisedBy = await prisma.user.findUnique({ where: { id: req.auth!.userId } });

  const complaint = await prisma.complaint.create({
    data: {
      apartmentId: flat.apartmentId,
      flatId: flat.id,
      flatNumber: flat.number,
      blockName: flat.block,
      raisedByUserId: req.auth!.userId,
      raisedByName: raisedBy?.name ?? flat.ownerName,
      title: parsed.data.title,
      description: parsed.data.description,
      category: parsed.data.category,
      priority: parsed.data.priority,
      contactNumber: parsed.data.contactNumber.trim(),
      preferredVisitTime: parsed.data.preferredVisitTime?.trim() || null,
    },
  });

  // Notify apartment admins.
  try {
    const admins = await findAdminEmails(flat.apartmentId);
    await Promise.all(
      admins.map((adminEmail) =>
        mailer.send(
          buildComplaintCreatedAdminMail({
            adminEmail,
            apartmentName: apartment.name,
            flatNumber: flat.number,
            raisedByName: complaint.raisedByName,
            complaintId: complaint.id,
            title: complaint.title,
            category: complaint.category,
            priority: complaint.priority,
            loginUrl: loginUrl(),
          }),
        ),
      ),
    );
  } catch (err) {
    console.error("[mail] complaint-created admin notification failed", err);
  }

  res.status(201).json(complaint);
});

// ---------------------------------------------------------------------------
// GET /complaints  — list with filters
//   flat_admin:      always restricted to their own flatId
//   apartment_admin: restricted to their apartmentId; can filter by flatId
//   super_admin:     unrestricted; can filter by apartmentId/flatId
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const parsed = ComplaintFilterSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query", errors: parsed.error.flatten() });
    return;
  }
  const where: Prisma.ComplaintWhereInput = {};
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
  if (parsed.data.category) where.category = parsed.data.category;
  if (parsed.data.priority) where.priority = parsed.data.priority;
  if (parsed.data.dateFrom || parsed.data.dateTo) {
    where.createdAt = {};
    if (parsed.data.dateFrom) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(parsed.data.dateFrom);
    if (parsed.data.dateTo) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(parsed.data.dateTo);
  }
  if (parsed.data.q) {
    const q = parsed.data.q.trim();
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { flatNumber: { contains: q, mode: "insensitive" } },
      { id: { contains: q, mode: "insensitive" } },
      { raisedByName: { contains: q, mode: "insensitive" } },
    ];
  }

  const list = await prisma.complaint.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    take: 200,
    include: {
      _count: { select: { messages: true } },
    },
  });
  res.json(
    list.map((c) => ({
      ...c,
      messagesCount: c._count.messages,
      _count: undefined,
    })),
  );
});

// ---------------------------------------------------------------------------
// GET /complaints/summary — admin dashboard counts
//   apartment_admin: scoped to their apartment
//   super_admin:     scoped via ?apartmentId= (optional)
// ---------------------------------------------------------------------------
router.get("/summary", requireRole("apartment_admin", "super_admin"), async (req, res) => {
  const role = req.auth!.role;
  let apartmentId: string | undefined;
  if (role === "apartment_admin") {
    apartmentId = req.auth!.apartmentId ?? undefined;
  } else if (typeof req.query.apartmentId === "string") {
    apartmentId = req.query.apartmentId;
  }
  const where: Prisma.ComplaintWhereInput = apartmentId ? { apartmentId } : {};

  const [byStatusRaw, byPriorityRaw, byCategoryRaw, total, openCount, last30] = await Promise.all([
    prisma.complaint.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.complaint.groupBy({ by: ["priority"], where, _count: { _all: true } }),
    prisma.complaint.groupBy({ by: ["category"], where, _count: { _all: true } }),
    prisma.complaint.count({ where }),
    prisma.complaint.count({ where: { ...where, status: { in: ["active", "pending", "in_progress"] } } }),
    prisma.complaint.count({
      where: { ...where, createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const s of STATUSES) statusCounts[s] = 0;
  for (const row of byStatusRaw) statusCounts[row.status] = row._count._all;

  const priorityCounts: Record<string, number> = {};
  for (const p of PRIORITIES) priorityCounts[p] = 0;
  for (const row of byPriorityRaw) priorityCounts[row.priority] = row._count._all;

  const categoryCounts: Record<string, number> = {};
  for (const c of CATEGORIES) categoryCounts[c] = 0;
  for (const row of byCategoryRaw) categoryCounts[row.category] = row._count._all;

  res.json({
    total,
    openCount,
    last30Days: last30,
    byStatus: statusCounts,
    byPriority: priorityCounts,
    byCategory: categoryCounts,
  });
});

// ---------------------------------------------------------------------------
// GET /complaints/:id — full detail with messages (chat thread)
// ---------------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  const complaint = await prisma.complaint.findUnique({
    where: { id: req.params.id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!complaint) {
    res.status(404).json({ message: "Complaint not found" });
    return;
  }
  const role = req.auth!.role;
  if (role === "flat_admin" && req.auth!.flatId !== complaint.flatId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== complaint.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  res.json(complaint);
});

// ---------------------------------------------------------------------------
// PATCH /complaints/:id/status — admin status update
// Closes the complaint when status becomes "closed".
// Adds a system message recording the transition.
// ---------------------------------------------------------------------------
router.patch(
  "/:id/status",
  requireRole("apartment_admin", "super_admin"),
  async (req, res) => {
    const parsed = StatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      return;
    }
    const complaint = await prisma.complaint.findUnique({ where: { id: req.params.id } });
    if (!complaint) {
      res.status(404).json({ message: "Complaint not found" });
      return;
    }
    if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== complaint.apartmentId) {
      res.status(403).json({ message: "Forbidden — wrong apartment" });
      return;
    }
    if (complaint.status === parsed.data.status) {
      res.json(complaint);
      return;
    }
    const apartment = await prisma.apartment.findUnique({ where: { id: complaint.apartmentId } });
    const flat = await prisma.flat.findUnique({ where: { id: complaint.flatId } });
    const sender = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    const senderName = sender?.name ?? "Apartment admin";

    const updated = await prisma.$transaction(async (tx) => {
      const c = await tx.complaint.update({
        where: { id: complaint.id },
        data: {
          status: parsed.data.status,
          closedAt: parsed.data.status === "closed" ? new Date() : null,
        },
      });
      await tx.complaintMessage.create({
        data: {
          complaintId: c.id,
          senderUserId: req.auth!.userId,
          senderName,
          senderRole: req.auth!.role as Role,
          type: "status_change",
          body: `Status changed: ${complaint.status} → ${parsed.data.status}`,
        },
      });
      return c;
    });

    if (apartment && flat?.ownerEmail) {
      try {
        await mailer.send(
          buildComplaintStatusChangedMail({
            to: flat.ownerEmail,
            ownerName: complaint.raisedByName,
            apartmentName: apartment.name,
            flatNumber: complaint.flatNumber,
            complaintId: complaint.id,
            title: complaint.title,
            category: complaint.category,
            priority: complaint.priority,
            fromStatus: complaint.status,
            toStatus: parsed.data.status,
            loginUrl: loginUrl(),
          }),
        );
      } catch (err) {
        console.error("[mail] complaint status email failed", err);
      }
    }

    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// PATCH /complaints/:id — admin updates assignedTo / remarks / priority
// ---------------------------------------------------------------------------
router.patch("/:id", requireRole("apartment_admin", "super_admin"), async (req, res) => {
  const parsed = AdminPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
    return;
  }
  const complaint = await prisma.complaint.findUnique({ where: { id: req.params.id } });
  if (!complaint) {
    res.status(404).json({ message: "Complaint not found" });
    return;
  }
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== complaint.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  const data: Prisma.ComplaintUpdateInput = {};
  if (parsed.data.assignedTo !== undefined) data.assignedTo = parsed.data.assignedTo?.trim() || null;
  if (parsed.data.adminRemarks !== undefined) data.adminRemarks = parsed.data.adminRemarks?.trim() || null;
  if (parsed.data.priority !== undefined) data.priority = parsed.data.priority;
  if (Object.keys(data).length === 0) {
    res.json(complaint);
    return;
  }
  const updated = await prisma.complaint.update({ where: { id: complaint.id }, data });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// POST /complaints/:id/messages — chat reply
// flat_admin: can reply on their own flat's complaint
// apartment_admin / super_admin: can reply on any complaint in their scope
// ---------------------------------------------------------------------------
router.post("/:id/messages", async (req, res) => {
  const parsed = MessageCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
    return;
  }
  const complaint = await prisma.complaint.findUnique({ where: { id: req.params.id } });
  if (!complaint) {
    res.status(404).json({ message: "Complaint not found" });
    return;
  }
  const role = req.auth!.role;
  if (role === "flat_admin" && req.auth!.flatId !== complaint.flatId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== complaint.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  const sender = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  const senderName = sender?.name ?? (role === "flat_admin" ? complaint.raisedByName : "Apartment admin");

  const message = await prisma.complaintMessage.create({
    data: {
      complaintId: complaint.id,
      senderUserId: req.auth!.userId,
      senderName,
      senderRole: role as Role,
      type: "message",
      body: parsed.data.body,
    },
  });

  // bump updatedAt
  await prisma.complaint.update({ where: { id: complaint.id }, data: { updatedAt: new Date() } });

  // Notify the other side via email.
  try {
    const apartment = await prisma.apartment.findUnique({ where: { id: complaint.apartmentId } });
    const preview = parsed.data.body.length > 240 ? parsed.data.body.slice(0, 240) + "…" : parsed.data.body;
    if (role === "flat_admin") {
      // admin gets notified
      const admins = await findAdminEmails(complaint.apartmentId);
      await Promise.all(
        admins.map((adminEmail) =>
          mailer.send(
            buildComplaintReplyMail({
              to: adminEmail,
              ownerName: "team",
              replierName: senderName,
              apartmentName: apartment?.name ?? "your society",
              flatNumber: complaint.flatNumber,
              complaintId: complaint.id,
              title: complaint.title,
              category: complaint.category,
              priority: complaint.priority,
              preview,
              loginUrl: loginUrl(),
            }),
          ),
        ),
      );
    } else {
      // resident gets notified
      const flat = await prisma.flat.findUnique({ where: { id: complaint.flatId } });
      if (flat?.ownerEmail) {
        await mailer.send(
          buildComplaintReplyMail({
            to: flat.ownerEmail,
            ownerName: complaint.raisedByName,
            replierName: senderName,
            apartmentName: apartment?.name ?? "your society",
            flatNumber: complaint.flatNumber,
            complaintId: complaint.id,
            title: complaint.title,
            category: complaint.category,
            priority: complaint.priority,
            preview,
            loginUrl: loginUrl(),
          }),
        );
      }
    }
  } catch (err) {
    console.error("[mail] complaint reply notification failed", err);
  }

  res.status(201).json(message);
});

export default router;
