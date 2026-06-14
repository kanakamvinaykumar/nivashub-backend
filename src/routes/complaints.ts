import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { ComplaintStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireCommitteeOrRole, requireApartmentAccess, hasApartmentAccess } from "../lib/committee.js";
import {
  buildComplaintCreatedAdminMail,
  buildComplaintReplyMail,
  buildComplaintStatusChangedMail,
  mailer,
} from "../lib/mailer.js";
import { notifyComplaintMessage, notifyComplaintCreated } from "../socket.js";
import { createNotification, notifyFlatOwners, notifyApartmentAdmins } from "../lib/notifications.js";
import { processAttachment } from "../lib/media.js";
import { notifyFlatOwnersPush, notifyApartmentRolePush } from "../lib/notify-push.js";

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
  attachments: z.array(z.string()).max(5).optional(),
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

// Toggle complaint-related outbound emails. Default: disabled unless explicitly set to 'true'.
const COMPLAINT_EMAILS_ENABLED = process.env.COMPLAINT_EMAILS_ENABLED === "true";

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

  const attachments = await Promise.all(
    (parsed.data.attachments ?? []).map((attachment, index) =>
      processAttachment(attachment, `complaint_${flat.id}_${randomUUID()}_${index}`),
    ),
  );

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
      attachments,
    },
  });

  // Notify apartment admins via push.
  notifyApartmentRolePush(flat.apartmentId, ["apartment_admin"], {
    title: "New complaint raised",
    body: `${complaint.flatNumber}: ${complaint.title}`,
    data: { type: "complaint_created", complaintId: complaint.id },
    clickAction: `/complaints/${complaint.id}`,
  }).catch((err: unknown) => console.error("[push] complaint-created notification failed", err));

  // Notify apartment admins via WebSocket for real-time UI update.
  notifyComplaintCreated({
    complaintId: complaint.id,
    apartmentId: complaint.apartmentId,
    flatId: complaint.flatId,
    flatNumber: complaint.flatNumber,
    blockName: complaint.blockName,
    title: complaint.title,
    category: complaint.category,
    priority: complaint.priority,
    raisedByName: complaint.raisedByName,
    createdAt: complaint.createdAt.toISOString(),
  });

  // Persist in-app notification for all apartment admins
  notifyApartmentAdmins(
    flat.apartmentId,
    "complaint_created",
    `New complaint from ${complaint.flatNumber}`,
    complaint.title,
    `/complaints/${complaint.id}`,
  ).catch((err: unknown) => console.error("[notification] complaint-created notification failed", err));

  // Notify apartment admins via email.
  if (COMPLAINT_EMAILS_ENABLED) {
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
  }

  res.status(201).json(complaint);
});

// ---------------------------------------------------------------------------
// GET /complaints  — list with filters
//   flat_admin (no committee):  restricted to their own flatId
//   committee member:           sees all complaints for their apartment
//   apartment_admin:            restricted to their apartmentId; can filter by flatId
//   super_admin:                unrestricted; can filter by apartmentId/flatId
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const parsed = ComplaintFilterSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query", errors: parsed.error.flatten() });
    return;
  }
  const where: Prisma.ComplaintWhereInput = {};
  const role = req.auth!.role;

  // Committee members (flat_admin with committeePosition) get apartment-wide view
  const isCommitteeMember =
    role === "flat_admin" &&
    req.auth!.committeePosition &&
    req.auth!.committeeApartmentId;

  if (role === "flat_admin" && !isCommitteeMember) {
    if (!req.auth!.flatId) {
      res.json([]);
      return;
    }
    where.flatId = req.auth!.flatId;
  } else if (role === "apartment_admin" || isCommitteeMember) {
    const apartmentId = isCommitteeMember
      ? req.auth!.committeeApartmentId
      : req.auth!.apartmentId;
    if (!apartmentId) {
      res.json([]);
      return;
    }
    where.apartmentId = apartmentId;
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
router.get("/summary", requireApartmentAccess("apartment_admin"), async (req, res) => {
  const role = req.auth!.role;
  let apartmentId: string | undefined;
  if (role === "apartment_admin") {
    apartmentId = req.auth!.apartmentId ?? undefined;
  } else if (role === "flat_admin" && req.auth!.committeePosition && req.auth!.committeeApartmentId) {
    apartmentId = req.auth!.committeeApartmentId!;
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
  const isCommitteeMember =
    role === "flat_admin" &&
    req.auth!.committeePosition &&
    req.auth!.committeeApartmentId;

  if (role === "flat_admin" && !isCommitteeMember && req.auth!.flatId !== complaint.flatId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== complaint.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  // Committee members can view any complaint in their apartment
  if (isCommitteeMember && req.auth!.committeeApartmentId !== complaint.apartmentId) {
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
  requireApartmentAccess("apartment_admin"),
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
    // Determine the user's effective apartment ID (supports committee members)
    const effectiveApartmentId = req.auth!.role === "flat_admin" && req.auth!.committeeApartmentId
      ? req.auth!.committeeApartmentId
      : req.auth!.apartmentId;
    if (effectiveApartmentId && effectiveApartmentId !== complaint.apartmentId) {
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

    // Notify the flat owner via push that status changed.
    notifyFlatOwnersPush(complaint.flatId, {
      title: `Complaint status updated: ${parsed.data.status}`,
      body: `${complaint.title} — changed from ${complaint.status} to ${parsed.data.status}`,
      data: { type: "complaint_status", complaintId: complaint.id },
      clickAction: `/complaints/${complaint.id}`,
    }).catch((err: unknown) => console.error("[push] complaint status notification failed", err));

    if (COMPLAINT_EMAILS_ENABLED && apartment && flat?.ownerEmail) {
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
router.patch("/:id", requireApartmentAccess("apartment_admin"), async (req, res) => {
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
  // Determine the user's effective apartment ID (supports committee members)
  const effectiveApartmentId = req.auth!.role === "flat_admin" && req.auth!.committeeApartmentId
    ? req.auth!.committeeApartmentId
    : req.auth!.apartmentId;
  if (effectiveApartmentId && effectiveApartmentId !== complaint.apartmentId) {
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
  const isCommitteeMember =
    role === "flat_admin" &&
    req.auth!.committeePosition &&
    req.auth!.committeeApartmentId;

  if (role === "flat_admin" && !isCommitteeMember && req.auth!.flatId !== complaint.flatId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (role === "apartment_admin" && req.auth!.apartmentId !== complaint.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  // Committee members can reply on any complaint in their apartment
  if (isCommitteeMember && req.auth!.committeeApartmentId !== complaint.apartmentId) {
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

  notifyComplaintMessage({
    complaintId: complaint.id,
    apartmentId: complaint.apartmentId,
    flatId: complaint.flatId,
    title: complaint.title,
    senderName,
    senderRole: role as "flat_admin" | "apartment_admin" | "super_admin",
    preview: parsed.data.body.length > 240 ? parsed.data.body.slice(0, 240) + "…" : parsed.data.body,
    createdAt: message.createdAt.toISOString(),
  });

   // Notify the other side via push.
   if (role === "flat_admin") {
     notifyApartmentRolePush(complaint.apartmentId, ["apartment_admin"], {
       title: `New message on complaint: ${complaint.title}`,
       body: `${senderName}: ${parsed.data.body.length > 120 ? parsed.data.body.slice(0, 120) + "…" : parsed.data.body}`,
       data: { type: "complaint_message", complaintId: complaint.id },
       clickAction: `/complaints/${complaint.id}`,
     }).catch((err: unknown) => console.error("[push] complaint message notification failed", err));
   } else {
     notifyFlatOwnersPush(complaint.flatId, {
       title: `New message on complaint: ${complaint.title}`,
       body: `${senderName}: ${parsed.data.body.length > 120 ? parsed.data.body.slice(0, 120) + "…" : parsed.data.body}`,
       data: { type: "complaint_message", complaintId: complaint.id },
       clickAction: `/complaints/${complaint.id}`,
     }).catch((err: unknown) => console.error("[push] complaint message notification failed", err));
   }

   // Notify the other side via email (disabled unless COMPLAINT_EMAILS_ENABLED=true).
   if (COMPLAINT_EMAILS_ENABLED) {
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
   }

   // Persist in-app notifications for the other party (admin↔flat)
   if (role === "flat_admin") {
     // Flat user sent a message → notify apartment admins
     notifyApartmentAdmins(
       complaint.apartmentId,
       "complaint_message",
       `New message: ${complaint.title}`,
       `${senderName}: ${parsed.data.body.length > 120 ? parsed.data.body.slice(0, 120) + "…" : parsed.data.body}`,
       `/complaints/${complaint.id}`,
     ).catch((err: unknown) => console.error("[notification] complaint message admin notification failed", err));
   } else {
     // Admin sent a message → notify flat owner(s)
     notifyFlatOwners(
       complaint.flatId,
       complaint.apartmentId,
       "complaint_message",
       `New message on: ${complaint.title}`,
       `${senderName}: ${parsed.data.body.length > 120 ? parsed.data.body.slice(0, 120) + "…" : parsed.data.body}`,
       `/complaints/${complaint.id}`,
     ).catch((err: unknown) => console.error("[notification] complaint message flat notification failed", err));
   }

  res.status(201).json(message);
});

export default router;
