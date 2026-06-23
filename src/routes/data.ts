import { Router, type Request } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { plans } from "../lib/plans.js";
import { getAssociation } from "../lib/association.js";
import {
  buildApartmentWelcomeMail,
  buildApartmentAdminWelcomeMail,
  generateTempPassword,
  mailer,
  sendFlatAccountStatusNotification,
  sendOwnerInvite,
  sendTenantInvite,
} from "../lib/mailer.js";
import { recordActivity, getApartmentActivity } from "../lib/activity.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireCommitteeOrRole, requireApartmentAccess } from "../lib/committee.js";
import {
  notifyVisitorPassCreated,
  notifyVisitorPassUpdated,
  notifyAnnouncementCreated,
  notifyAnnouncementUpdated,
  notifyAnnouncementDeleted,
  notifyAnnouncementCommentCreated,
} from "../socket.js";
import { notifyFlatOwners, notifyApartmentAdmins, notifyAllFlatAdmins } from "../lib/notifications.js";
import { notifyFlatOwnersPush, notifyApartmentRolePush } from "../lib/notify-push.js";
import { processAttachment } from "../lib/media.js";

const router = Router();

// All endpoints below require a valid JWT.
router.use(requireAuth);

router.get("/apartments", async (_req, res) => {
  const list = await prisma.apartment.findMany({ orderBy: { name: "asc" } });
  res.json(list);
});

router.get("/apartments/:id", async (req, res) => {
  const apt = await prisma.apartment.findUnique({ where: { id: req.params.id } });
  if (!apt) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }
  res.json(apt);
});

const ApartmentLogoSchema = z.object({
  logoUrl: z.string().min(1).optional().nullable(),
});

router.patch("/apartments/:id/logo", requireRole("apartment_admin", "super_admin"), async (req, res) => {
  const parsed = ApartmentLogoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const existing = await prisma.apartment.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }

  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  let storedLogo: string | null = null;
  if (parsed.data.logoUrl) {
    const rawLogo = parsed.data.logoUrl.trim();
    if (!rawLogo.startsWith("data:image/") && !/^https?:\/\//.test(rawLogo)) {
      res.status(400).json({ message: "Logo must be an image data URL or a valid URL." });
      return;
    }
    storedLogo = await processAttachment(rawLogo, `apartment_logo_${req.params.id}`);
  }

  const updated = await prisma.apartment.update({
    where: { id: existing.id },
    data: { logoUrl: storedLogo },
  });
  res.json({ logoUrl: updated.logoUrl });
});

router.get("/apartments/:id/flats", async (req, res) => {
  const flats = await prisma.flat.findMany({
    where: { apartmentId: req.params.id },
    orderBy: [{ block: "asc" }, { number: "asc" }],
  });
  res.json(flats);
});

router.get("/apartments/:id/summary", async (req, res) => {
  const apt = await prisma.apartment.findUnique({ where: { id: req.params.id } });
  if (!apt) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }
  const id = req.params.id;
  const [flats, annCount, listings, visitors, bookings] = await Promise.all([
    prisma.flat.findMany({ where: { apartmentId: id } }),
    prisma.announcement.count({ where: { apartmentId: id } }),
    prisma.listing.findMany({ where: { apartmentId: id, status: "active" } }),
    prisma.visitorPass.findMany({ where: { apartmentId: id, status: "active" } }),
    prisma.booking.findMany({ where: { apartmentId: id } }),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const totalResidents = flats.reduce((s, f) => s + f.residentCount, 0);
  const totalDues = flats.reduce((s, f) => s + f.pendingDuesInr, 0);
  const occupiedFlats = flats.filter((f) => f.status === "occupied" || f.status === "rented").length;
  res.json({
    apartmentId: id,
    totalFlats: flats.length,
    occupiedFlats,
    totalResidents,
    pendingApprovals: 4,
    activeAnnouncements: annCount,
    todaysBookings: bookings.filter((b) => b.date === today).length,
    activeVisitorPasses: visitors.length,
    openListings: listings.length,
    totalDuesInr: totalDues,
  });
});

router.get("/apartments/:id/activity", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  // Committee members are allowed via requireCommitteeOrRole; for apartment_admin verify scope
  const effectiveApartmentId =
    req.auth!.role === "flat_admin" && req.auth!.committeeApartmentId
      ? req.auth!.committeeApartmentId
      : req.auth!.apartmentId;
  if (effectiveApartmentId && effectiveApartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  const apartment = await prisma.apartment.findUnique({ where: { id: req.params.id } });
  if (!apartment) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }
  const activity = await getApartmentActivity(req.params.id);
  res.json(activity);
});

router.get("/apartments/:id/association", async (req, res) => {
  const a = await getAssociation(req.params.id);
  if (!a) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }
  res.json(a);
});

router.get("/apartments/:id/members", async (req, res) => {
  const flats = await prisma.flat.findMany({
    where: { apartmentId: req.params.id },
    include: { residents: true },
    orderBy: [{ block: "asc" }, { number: "asc" }],
  });
  const members = flats.flatMap((f) => {
    // If the flat has explicit residents, use them.
    if (f.residents.length > 0) {
      return f.residents.map((r) => ({
        id: r.id,
        name: r.name,
        relation: r.relation,
        phone: r.phone,
        flatNumber: f.number,
        flatId: f.id,
        block: f.block,
        ownerName: f.ownerName,
      }));
    }
    // Fallback: synthesise an "Owner" member from the flat's own fields.
    return [
      {
        id: `owner-${f.id}`,
        name: f.ownerName,
        relation: "Owner",
        phone: f.ownerMobile ?? "",
        flatNumber: f.number,
        flatId: f.id,
        block: f.block,
        ownerName: f.ownerName,
      },
    ];
  });
  res.json(members);
});

const SecurityMemberSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(6).max(100),
  phone: z.string().min(6).max(30).optional(),
  shift: z.enum(["day", "night"]).optional(),
  notes: z.string().max(500).optional(),
});

router.get("/apartments/:id/security-members", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  const effectiveApartmentId =
    req.auth!.role === "flat_admin" && req.auth!.committeeApartmentId
      ? req.auth!.committeeApartmentId
      : req.auth!.apartmentId;
  if (effectiveApartmentId && effectiveApartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  const users = await prisma.user.findMany({
    where: { apartmentId: req.params.id, role: "security" },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      apartmentId: true,
      apartmentName: true,
      phone: true,
      shift: true,
      notes: true,
    },
  });
  res.json(users);
});

router.post("/apartments/:id/security-members", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  const parsed = SecurityMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const effectiveApartmentId =
    req.auth!.role === "flat_admin" && req.auth!.committeeApartmentId
      ? req.auth!.committeeApartmentId
      : req.auth!.apartmentId;
  if (effectiveApartmentId && effectiveApartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const apartment = await prisma.apartment.findUnique({ where: { id: req.params.id } });
  if (!apartment) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (existing) {
    res.status(409).json({ message: "Email is already registered" });
    return;
  }

  const user = await prisma.user.create({
    data: {
      email: parsed.data.email.toLowerCase(),
      name: parsed.data.name,
      role: "security",
      apartmentId: apartment.id,
      apartmentName: apartment.name,
      passwordHash: await bcrypt.hash(parsed.data.password, 10),
      phone: parsed.data.phone,
      shift: parsed.data.shift,
      notes: parsed.data.notes,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      apartmentId: true,
      apartmentName: true,
      phone: true,
      shift: true,
      notes: true,
    },
  });

  try {
    await recordActivity({
      apartmentId: apartment.id,
      userId: req.auth?.userId ?? null,
      userRole: req.auth?.role ?? "apartment_admin",
      action: "created",
      entity: "security_member",
      entityId: user.id,
      details: `name=${user.name}, email=${user.email}`,
    });
  } catch (err) {
    console.error("[activity] failed to record security member creation", err);
  }

  res.status(201).json(user);
});

router.delete("/apartments/:id/security-members/:userId", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  const effectiveApartmentId =
    req.auth!.role === "flat_admin" && req.auth!.committeeApartmentId
      ? req.auth!.committeeApartmentId
      : req.auth!.apartmentId;
  if (effectiveApartmentId && effectiveApartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!user || user.role !== "security" || user.apartmentId !== req.params.id) {
    res.status(404).json({ message: "Security member not found" });
    return;
  }

  await prisma.user.delete({ where: { id: user.id } });
  try {
    await recordActivity({
      apartmentId: req.params.id,
      userId: req.auth?.userId ?? null,
      userRole: req.auth?.role ?? "apartment_admin",
      action: "deleted",
      entity: "security_member",
      entityId: user.id,
      details: `name=${user.name}, email=${user.email}`,
    });
  } catch (err) {
    console.error("[activity] failed to record security member deletion", err);
  }
  res.json({ ok: true });
});

// ---------- Committee Management ----------

// GET /apartments/:id/committee — list current committee members
router.get("/apartments/:id/committee", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  const effectiveApartmentId =
    req.auth!.role === "flat_admin" && req.auth!.committeeApartmentId
      ? req.auth!.committeeApartmentId
      : req.auth!.apartmentId;
  if (effectiveApartmentId && effectiveApartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const committee = await prisma.committeeMember.findMany({
    where: { apartmentId: req.params.id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          flatNumber: true,
          phone: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  res.json(
    committee.map((c) => ({
      id: c.id,
      userId: c.userId,
      position: c.position,
      name: c.user?.name ?? c.name,
      flatNumber: c.user?.flatNumber ?? c.flatNumber,
      email: c.user?.email ?? c.email,
      phone: c.user?.phone ?? c.phone,
    })),
  );
});

// GET /apartments/:id/eligible-residents — list flat_admin users who can be assigned committee roles
router.get("/apartments/:id/eligible-residents", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const residents = await prisma.user.findMany({
    where: {
      apartmentId: req.params.id,
      role: "flat_admin",
      flatId: { not: null },
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      flatNumber: true,
      phone: true,
      committeeMember: {
        select: { position: true },
      },
    },
  });

  res.json(
    residents.map((r) => ({
      ...r,
      currentPosition: r.committeeMember?.position ?? null,
    })),
  );
});

// POST /apartments/:id/committee — assign committee role to a resident
const CommitteeRoleSchema = z.object({
  userId: z.string().min(1),
  position: z.enum(["president", "secretary", "treasurer", "maintenance", "cultural", "security"]),
});

router.post("/apartments/:id/committee", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  const parsed = CommitteeRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!user || user.apartmentId !== req.params.id || user.role !== "flat_admin") {
    res.status(404).json({ message: "Eligible resident not found" });
    return;
  }

  // Update user with committee role and invalidate existing tokens
  const updated = await prisma.user.update({
    where: { id: parsed.data.userId },
    data: {
      committeePosition: parsed.data.position,
      committeeApartmentId: req.params.id,
      tokenVersion: { increment: 1 },
    },
  });

  // Create/update CommitteeMember record
  await prisma.committeeMember.upsert({
    where: { userId: parsed.data.userId },
    create: {
      userId: parsed.data.userId,
      apartmentId: req.params.id,
      position: parsed.data.position,
      name: user.name,
      flatNumber: user.flatNumber,
      email: user.email,
      phone: user.phone,
    },
    update: {
      position: parsed.data.position,
      name: user.name,
      flatNumber: user.flatNumber,
      email: user.email,
      phone: user.phone,
    },
  });

  try {
    await recordActivity({
      apartmentId: req.params.id,
      userId: req.auth?.userId ?? null,
      userRole: req.auth?.role ?? "apartment_admin",
      action: "assigned",
      entity: "committee_member",
      entityId: parsed.data.userId,
      details: `position=${parsed.data.position}, name=${user.name}`,
    });
  } catch (err) {
    console.error("[activity] failed to record committee assignment", err);
  }

  res.status(201).json({
    id: user.id,
    name: user.name,
    email: user.email,
    flatNumber: user.flatNumber,
    position: parsed.data.position,
  });
});

// DELETE /apartments/:id/committee/:userId — remove committee role from resident
router.delete("/apartments/:id/committee/:userId", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!user || user.apartmentId !== req.params.id || user.role !== "flat_admin") {
    res.status(404).json({ message: "Committee member not found" });
    return;
  }

  // Remove committee role from user
  await prisma.user.update({
    where: { id: req.params.userId },
    data: {
      committeePosition: null,
      committeeApartmentId: null,
    },
  });

  // Delete CommitteeMember record
  await prisma.committeeMember.delete({
    where: { userId: req.params.userId },
  });

  try {
    await recordActivity({
      apartmentId: req.params.id,
      userId: req.auth?.userId ?? null,
      userRole: req.auth?.role ?? "apartment_admin",
      action: "removed",
      entity: "committee_member",
      entityId: req.params.userId,
      details: `name=${user.name}`,
    });
  } catch (err) {
    console.error("[activity] failed to record committee removal", err);
  }

  res.json({ ok: true });
});

router.get("/flats/:id", async (req, res) => {
  const flat = await prisma.flat.findUnique({
    where: { id: req.params.id },
    include: { residents: true },
  });
  if (!flat) {
    res.status(404).json({ message: "Flat not found" });
    return;
  }
  const recentVisitors = await prisma.visitorPass.findMany({
    where: { flatId: flat.id },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  res.json({ flat, residents: flat.residents, recentVisitors });
});

router.get("/flats/:id/summary", async (req, res) => {
  const flat = await prisma.flat.findUnique({ where: { id: req.params.id } });
  if (!flat) {
    res.status(404).json({ message: "Flat not found" });
    return;
  }
  const [upcomingBookings, activeVisitors, myListings] = await Promise.all([
    prisma.booking.count({
      where: { apartmentId: flat.apartmentId, flatNumber: flat.number, status: "confirmed" },
    }),
    prisma.visitorPass.count({
      where: { flatId: flat.id, status: "active" },
    }),
    prisma.listing.count({
      where: { apartmentId: flat.apartmentId, sellerFlat: flat.number },
    }),
  ]);
  res.json({
    flatId: flat.id,
    residents: flat.residentCount,
    upcomingBookings,
    activeVisitorPasses: activeVisitors,
    unreadAnnouncements: 3,
    myListings,
    pendingDuesInr: flat.pendingDuesInr,
  });
});

router.get("/announcements", async (req, res) => {
  const apartmentId = typeof req.query.apartmentId === "string" ? req.query.apartmentId : undefined;
  const list = await prisma.announcement.findMany({
    where: apartmentId ? { apartmentId } : undefined,
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
  });
  res.json(list);
});

const AnnouncementSchema = z.object({
  apartmentId: z.string(),
  title: z.string().min(3).max(120),
  body: z.string().min(10).max(2000),
  priority: z.enum(["low", "normal", "urgent"]),
  pinned: z.boolean(),
  authorName: z.string().min(1),
  attachments: z.array(z.string()).max(5).optional(),
});

const AnnouncementCommentSchema = z.object({
  body: z.string().min(1).max(1000).transform((v) => v.trim()),
});

const AnnouncementUpdateSchema = AnnouncementSchema.omit({
  apartmentId: true,
  authorName: true,
}).partial().refine((value) => Object.keys(value).length > 0, {
  message: "At least one field is required",
});

function canManageAnnouncement(req: Request, apartmentId: string): boolean {
  if (req.auth?.role === "super_admin") return true;
  return req.auth?.role === "apartment_admin" && req.auth.apartmentId === apartmentId;
}

function serializeAnnouncement(announcement: {
  id: string;
  apartmentId: string;
  title: string;
  body: string;
  priority: "low" | "normal" | "urgent";
  pinned: boolean;
  authorName: string;
  attachments: string[];
  commentsCount: number;
  seenCount: number;
  createdAt: Date;
}) {
  return {
    id: announcement.id,
    apartmentId: announcement.apartmentId,
    title: announcement.title,
    body: announcement.body,
    priority: announcement.priority,
    pinned: announcement.pinned,
    authorName: announcement.authorName,
    attachments: announcement.attachments,
    commentsCount: announcement.commentsCount,
    seenCount: announcement.seenCount,
    createdAt: announcement.createdAt.toISOString(),
  };
}

router.post("/announcements", async (req, res) => {
  const parsed = AnnouncementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const attachments = await Promise.all(
    (parsed.data.attachments ?? []).map((attachment, index) =>
      processAttachment(attachment, `announcement_${randomUUID()}_${index}`),
    ),
  );
  const created = await prisma.announcement.create({
    data: { ...parsed.data, attachments, commentsCount: 0, seenCount: 0 },
  });
  notifyAnnouncementCreated(serializeAnnouncement(created));

  // Persist in-app notifications for all flat admins
  notifyAllFlatAdmins(
    created.apartmentId,
    "announcement_created",
    `New announcement: ${created.title}`,
    created.body.length > 200 ? created.body.slice(0, 200) + "…" : created.body,
    "/flat-admin/announcements",
  ).catch((err: unknown) => console.error("[notification] announcement notification failed", err));

  res.status(201).json(created);
});

router.patch("/announcements/:id", requireRole("apartment_admin", "super_admin"), async (req, res) => {
  const parsed = AnnouncementUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const announcement = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!announcement) {
    res.status(404).json({ message: "Announcement not found" });
    return;
  }
  if (!canManageAnnouncement(req, announcement.apartmentId)) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const attachments = parsed.data.attachments
    ? await Promise.all(
        parsed.data.attachments.map((attachment, index) =>
          processAttachment(attachment, `announcement_${randomUUID()}_${index}`),
        ),
      )
    : undefined;

  const updated = await prisma.announcement.update({
    where: { id: req.params.id },
    data: { ...parsed.data, ...(attachments ? { attachments } : {}) },
  });

  notifyAnnouncementUpdated(serializeAnnouncement(updated));

  res.json(updated);
});

router.delete("/announcements/:id", requireRole("apartment_admin", "super_admin"), async (req, res) => {
  const announcement = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!announcement) {
    res.status(404).json({ message: "Announcement not found" });
    return;
  }
  if (!canManageAnnouncement(req, announcement.apartmentId)) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  await prisma.announcement.delete({ where: { id: req.params.id } });
  notifyAnnouncementDeleted({ id: announcement.id, apartmentId: announcement.apartmentId });
  res.status(204).send();
});

router.get("/announcements/:id/comments", async (req, res) => {
  const announcement = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!announcement) {
    res.status(404).json({ message: "Announcement not found" });
    return;
  }

  const comments = await prisma.announcementComment.findMany({
    where: { announcementId: req.params.id },
    orderBy: { createdAt: "asc" },
  });
  res.json(comments);
});

router.post("/announcements/:id/comments", async (req, res) => {
  const parsed = AnnouncementCommentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const announcement = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!announcement) {
    res.status(404).json({ message: "Announcement not found" });
    return;
  }

  const user = req.auth?.userId ? await prisma.user.findUnique({ where: { id: req.auth.userId } }) : null;

  const created = await prisma.$transaction(async (tx) => {
    const comment = await tx.announcementComment.create({
      data: {
        announcementId: req.params.id,
        userId: req.auth?.userId ?? undefined,
        userName: user?.name ?? "Unknown",
        userRole: req.auth!.role,
        body: parsed.data.body,
      },
    });
    await tx.announcement.update({
      where: { id: req.params.id },
      data: { commentsCount: { increment: 1 } },
    });
    return comment;
  });

  notifyAnnouncementCommentCreated({
    id: created.id,
    announcementId: created.announcementId,
    apartmentId: announcement.apartmentId,
    userId: created.userId,
    userName: created.userName,
    userRole: created.userRole,
    body: created.body,
    createdAt: created.createdAt.toISOString(),
  });

  res.status(201).json(created);
});

router.patch("/announcements/:id/seen", async (req, res) => {
  const announcement = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!announcement) {
    res.status(404).json({ message: "Announcement not found" });
    return;
  }

  const updated = await prisma.announcement.update({
    where: { id: req.params.id },
    data: { seenCount: { increment: 1 } },
  });
  res.json({ seenCount: updated.seenCount });
});

router.get("/bookings", async (req, res) => {
  const apartmentId = typeof req.query.apartmentId === "string" ? req.query.apartmentId : undefined;
  const list = await prisma.booking.findMany({
    where: apartmentId ? { apartmentId } : undefined,
    orderBy: { date: "desc" },
  });
  res.json(list);
});

const BookingSchema = z.object({
  apartmentId: z.string(),
  flatNumber: z.string(),
  residentName: z.string(),
  court: z.string(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
});

router.post("/bookings", async (req, res) => {
  const parsed = BookingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const created = await prisma.booking.create({
    data: { ...parsed.data, status: "confirmed" },
  });
  res.status(201).json(created);
});

router.get("/listings", async (req, res) => {
  const apartmentId = typeof req.query.apartmentId === "string" ? req.query.apartmentId : undefined;
  const list = await prisma.listing.findMany({
    where: apartmentId ? { apartmentId } : undefined,
    orderBy: { createdAt: "desc" },
  });
  res.json(list);
});

const ListingSchema = z.object({
  apartmentId: z.string(),
  title: z.string().min(3).max(120),
  description: z.string().min(1).max(2000),
  price: z.number().min(0),
  category: z.string(),
  condition: z.string(),
  tags: z.array(z.string()),
  sellerName: z.string(),
  sellerFlat: z.string(),
});

router.post("/listings", async (req, res) => {
  const parsed = ListingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const created = await prisma.listing.create({
    data: { ...parsed.data, status: "active" },
  });

  // Push notification to all flat owners about new bazaar listing
  notifyAllFlatAdmins(
    created.apartmentId,
    "bazaar_listing_created",
    `New listing in Bazaar: ${created.title}`,
    `₹${created.price} — ${created.category} — ${created.sellerName}, ${created.sellerFlat}`,
    "/flat-admin/bazaar",
  ).catch((err: unknown) => console.error("[notification] bazaar listing notification failed", err));

  // Push notification to all apartment admins
  notifyApartmentAdmins(
    created.apartmentId,
    "bazaar_listing_created",
    `New Bazaar listing: ${created.title}`,
    `₹${created.price} — ${created.category} by ${created.sellerName} (${created.sellerFlat})`,
    "/apartment-admin/bazaar",
  ).catch((err: unknown) => console.error("[notification] bazaar listing admin notification failed", err));

  res.status(201).json(created);
});

const ListingUpdateSchema = z.object({
  title: z.string().min(3).max(120).optional(),
  description: z.string().min(1).max(2000).optional(),
  price: z.number().min(0).optional(),
  category: z.string().optional(),
  condition: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["active", "sold", "archived"]).optional(),
});

router.patch("/listings/:id", async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });
  if (!listing) {
    res.status(404).json({ message: "Listing not found" });
    return;
  }

  // Look up the current user to determine seller match
  const user = req.auth?.userId ? await prisma.user.findUnique({ where: { id: req.auth.userId } }) : null;
  const isSeller = user != null && listing.sellerFlat === user.flatNumber && listing.sellerName === user.name;
  const isApartmentAdmin = req.auth?.role === "apartment_admin" && req.auth?.apartmentId === listing.apartmentId;
  const isSuperAdmin = req.auth?.role === "super_admin";

  if (!isSeller && !isApartmentAdmin && !isSuperAdmin) {
    res.status(403).json({ message: "Forbidden — you can only edit your own listings" });
    return;
  }

  const parsed = ListingUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const updated = await prisma.listing.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(updated);
});

router.delete("/listings/:id", async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });
  if (!listing) {
    res.status(404).json({ message: "Listing not found" });
    return;
  }

  // Look up the current user to determine seller match
  const user = req.auth?.userId ? await prisma.user.findUnique({ where: { id: req.auth.userId } }) : null;
  const isSeller = user != null && listing.sellerFlat === user.flatNumber && listing.sellerName === user.name;
  const isApartmentAdmin = req.auth?.role === "apartment_admin" && req.auth?.apartmentId === listing.apartmentId;
  const isSuperAdmin = req.auth?.role === "super_admin";

  if (!isSeller && !isApartmentAdmin && !isSuperAdmin) {
    res.status(403).json({ message: "Forbidden — you can only delete your own listings" });
    return;
  }

  await prisma.listing.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

const COMMITTEE_POSITIONS = ["president", "secretary", "treasurer", "maintenance", "cultural", "security"] as const;

const CommitteeMemberSchema = z.object({
  position: z.enum(COMMITTEE_POSITIONS),
  name: z.string().min(1).max(120),
  flatNumber: z.string().max(40).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
});

const AmenitySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
});

const ApartmentSchema = z.object({
  code: z.string().min(2).max(20).transform((value) => value.toUpperCase()),
  name: z.string().min(3).max(100),
  city: z.string().min(2).max(80),
  address: z.string().min(5).max(500),
  registeredEmail: z.string().email(),
  adminName: z.string().min(2).max(120).optional(),
  totalFlats: z.number().int().min(1),
  planTier: z.enum(["Starter", "Community", "Enterprise"]),
  planCycle: z.enum(["monthly", "yearly", "five_year"]),
  planExpiresAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid date" }),
  status: z.enum(["active", "trial", "suspended"]),
  amenities: z.array(AmenitySchema).max(50).optional(),
  rules: z.array(z.string().min(1).max(1000)).max(50).optional(),
  committee: z.array(CommitteeMemberSchema).max(20).optional(),
});

const getMonthlyRevenue = (tier: "Starter" | "Community" | "Enterprise", cycle: "monthly" | "yearly" | "five_year") => {
  const plan = plans.find((plan) => plan.name === tier);
  if (!plan) return 0;
  if (cycle === "monthly") return plan.monthlyPrice;
  if (cycle === "yearly") return Math.round(plan.yearlyPrice / 12);
  return Math.round(plan.fiveYearPrice / 60);
};

router.post("/apartments", requireRole("super_admin"), async (req, res) => {
  const parsed = ApartmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const {
    code, name, city, address, registeredEmail, adminName,
    totalFlats, planTier, planCycle, planExpiresAt, status,
    amenities, rules, committee,
  } = parsed.data;

  const normalizedEmail = registeredEmail.toLowerCase();

  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existingUser) {
    res.status(409).json({ message: "A user with the registered email already exists" });
    return;
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const apartmentId = randomUUID();

  try {
    const { apt: createdApartment, committeeAccounts } = await prisma.$transaction(async (tx) => {
      const apt = await tx.apartment.create({
        data: {
          id: apartmentId,
          code,
          name,
          city,
          address,
          registeredEmail: normalizedEmail,
          totalFlats,
          occupiedFlats: 0,
          planTier,
          planCycle,
          planExpiresAt: new Date(planExpiresAt),
          monthlyRevenue: getMonthlyRevenue(planTier, planCycle),
          status,
        },
      });

      if (amenities?.length) {
        await tx.amenity.createMany({
          data: amenities.map((a) => ({
            apartmentId: apt.id,
            name: a.name,
            description: a.description ?? null,
          })),
        });
      }

      if (rules?.length) {
        await tx.societyRule.createMany({
          data: rules.map((text) => ({ apartmentId: apt.id, text })),
        });
      }

      await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          name: adminName ?? `${apt.name} Admin`,
          role: "apartment_admin",
          apartmentId: apt.id,
          apartmentName: apt.name,
          mustChangePassword: true,
        },
      });

      const committeeAccountEmails = new Map<string, { name: string; position: string }>();
      if (committee?.length) {
        for (const member of committee) {
          const email = member.email?.trim().toLowerCase();
          if (!email || email === normalizedEmail || committeeAccountEmails.has(email)) continue;
          committeeAccountEmails.set(email, { name: member.name, position: member.position });
        }
      }

      const committeeAccounts: Array<{ email: string; name: string; position: string; tempPassword: string }> = [];
      for (const [email, member] of committeeAccountEmails.entries()) {
        const memberTempPassword = generateTempPassword();
        const memberPasswordHash = await bcrypt.hash(memberTempPassword, 10);
        const existingUser = await tx.user.findUnique({ where: { email } });

        if (existingUser) {
          await tx.user.update({
            where: { id: existingUser.id },
            data: {
              name: member.name,
              passwordHash: memberPasswordHash,
              role: "apartment_admin",
              apartmentId: apt.id,
              apartmentName: apt.name,
              mustChangePassword: true,
            },
          });
        } else {
          await tx.user.create({
            data: {
              email,
              passwordHash: memberPasswordHash,
              name: member.name,
              role: "apartment_admin",
              apartmentId: apt.id,
              apartmentName: apt.name,
              mustChangePassword: true,
            },
          });
        }

        committeeAccounts.push({
          email,
          name: member.name,
          position: member.position,
          tempPassword: memberTempPassword,
        });
      }

      return { apt, committeeAccounts };
    });

    try {
      const loginUrl = process.env.FRONTEND_ORIGIN
        ? `${process.env.FRONTEND_ORIGIN.replace(/\/$/, "")}/login`
        : "http://localhost:5173/login";
      await mailer.send(buildApartmentWelcomeMail({
        apartmentName: createdApartment.name,
        apartmentCode: createdApartment.code,
        adminName: adminName ?? `${createdApartment.name} Admin`,
        email: normalizedEmail,
        tempPassword,
        loginUrl,
      }));

      await Promise.all(committeeAccounts.map(async (account) => {
        try {
          await mailer.send(buildApartmentAdminWelcomeMail({
            apartmentName: createdApartment.name,
            apartmentCode: createdApartment.code,
            adminName: account.name,
            email: account.email,
            tempPassword: account.tempPassword,
            loginUrl,
            position: account.position,
          }));
        } catch (mailErr) {
          console.error("[mail] failed to send committee invite", account.email, mailErr);
        }
      }));
    } catch (mailErr) {
      console.error("[mail] failed to send welcome email", mailErr);
    }

    try {
      await recordActivity({
        apartmentId: createdApartment.id,
        userId: req.auth?.userId ?? null,
        userRole: req.auth?.role ?? "super_admin",
        action: "created",
        entity: "apartment",
        entityId: createdApartment.id,
        details: `code=${createdApartment.code}`,
      });
    } catch (err) {
      console.error("[activity] failed to record apartment creation", err);
    }
    res.status(201).json({ apartment: createdApartment, adminEmail: normalizedEmail });
  } catch (error: unknown) {
    if (typeof error === "object" && error && "code" in error && (error as any).code === "P2002") {
      res.status(409).json({ message: "Apartment code or registered email already exists" });
      return;
    }
    console.error(error);
    res.status(500).json({ message: "Unable to create apartment" });
  }
});

// ---------- Apartment edit / delete (super_admin only) ----------
//
// Edit: any subset of the fields we accept on creation. Status is
// the lever for "activate / deactivate" — flipping it to "suspended"
// immediately blocks every non-super-admin login for that apartment.
//
// Delete: nukes the apartment and every dependent row (flats, residents,
// users, payments, complaints, etc.) inside a single transaction. The
// existing schema cascades most of these via foreign keys; we still
// explicitly delete the non-cascading tables (payments, complaints,
// announcements, …) to keep the order predictable.

const ApartmentPatchSchema = z.object({
  code: z.string().min(2).max(20).transform((v) => v.toUpperCase()).optional(),
  name: z.string().min(3).max(100).optional(),
  city: z.string().min(2).max(80).optional(),
  address: z.string().min(5).max(500).optional(),
  registeredEmail: z.string().email().optional().nullable(),
  totalFlats: z.number().int().min(1).optional(),
  planTier: z.enum(["Starter", "Community", "Enterprise"]).optional(),
  planCycle: z.enum(["monthly", "yearly", "five_year"]).optional(),
  planExpiresAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: "Invalid date" }).optional(),
  status: z.enum(["active", "trial", "suspended"]).optional(),
});

router.patch("/apartments/:id", requireRole("super_admin"), async (req, res) => {
  const parsed = ApartmentPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.apartment.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.code !== undefined) data.code = parsed.data.code;
  if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
  if (parsed.data.city !== undefined) data.city = parsed.data.city.trim();
  if (parsed.data.address !== undefined) data.address = parsed.data.address.trim();
  if (parsed.data.registeredEmail !== undefined) {
    data.registeredEmail = parsed.data.registeredEmail
      ? parsed.data.registeredEmail.toLowerCase().trim()
      : null;
  }
  if (parsed.data.totalFlats !== undefined) data.totalFlats = parsed.data.totalFlats;
  if (parsed.data.planTier !== undefined) data.planTier = parsed.data.planTier;
  if (parsed.data.planCycle !== undefined) data.planCycle = parsed.data.planCycle;
  if (parsed.data.planExpiresAt !== undefined) data.planExpiresAt = new Date(parsed.data.planExpiresAt);
  if (parsed.data.status !== undefined) data.status = parsed.data.status;

  // Recompute MRR whenever the plan tier or cycle changes.
  const tier = (parsed.data.planTier ?? existing.planTier) as "Starter" | "Community" | "Enterprise";
  const cycle = (parsed.data.planCycle ?? existing.planCycle) as "monthly" | "yearly" | "five_year";
  if (parsed.data.planTier !== undefined || parsed.data.planCycle !== undefined) {
    data.monthlyRevenue = getMonthlyRevenue(tier, cycle);
  }

  // If the admin's denormalised apartmentName needs to follow a rename,
  // keep the cached User.apartmentName field in sync.
  if (parsed.data.name !== undefined) {
    await prisma.user.updateMany({
      where: { apartmentId: existing.id },
      data: { apartmentName: parsed.data.name.trim() },
    });
  }

  try {
    const updated = await prisma.apartment.update({ where: { id: existing.id }, data });
    try {
      await recordActivity({
        apartmentId: existing.id,
        userId: req.auth?.userId ?? null,
        userRole: req.auth?.role ?? "super_admin",
        action: "updated",
        entity: "apartment",
        entityId: existing.id,
        details: `fields=${Object.keys(data).join(",")}`,
      });
    } catch (err) {
      console.error("[activity] failed to record apartment update", err);
    }
    res.json(updated);
  } catch (error: unknown) {
    if (typeof error === "object" && error && "code" in error && (error as { code: string }).code === "P2002") {
      res.status(409).json({ message: "Apartment code already exists" });
      return;
    }
    console.error(error);
    res.status(500).json({ message: "Unable to update apartment" });
  }
});

router.post("/apartments/:id/resend-admin-invite", requireRole("super_admin"), async (req, res) => {
  const apartment = await prisma.apartment.findUnique({ where: { id: req.params.id } });
  if (!apartment) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }
  if (!apartment.registeredEmail) {
    res.status(400).json({ message: "This apartment has no registered admin email." });
    return;
  }

  const loginUrl = process.env.FRONTEND_ORIGIN
    ? `${process.env.FRONTEND_ORIGIN.replace(/\/$/, "")}/login`
    : "http://localhost:5173/login";
  const email = apartment.registeredEmail.toLowerCase().trim();
  const existingUser = await prisma.user.findUnique({ where: { email } });
  const adminName = existingUser?.name ?? `${apartment.name} Admin`;
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  if (existingUser) {
    if (existingUser.role !== "apartment_admin" || existingUser.apartmentId !== apartment.id) {
      res.status(409).json({ message: "Email is registered to a different account." });
      return;
    }
    await prisma.user.update({
      where: { id: existingUser.id },
      data: { passwordHash, mustChangePassword: true },
    });
  } else {
    await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: adminName,
        role: "apartment_admin",
        apartmentId: apartment.id,
        apartmentName: apartment.name,
        mustChangePassword: true,
      },
    });
  }

  try {
    await mailer.send(buildApartmentWelcomeMail({
      apartmentName: apartment.name,
      apartmentCode: apartment.code,
      adminName,
      email,
      tempPassword,
      loginUrl,
    }));
    res.json({ ok: true, passwordRotated: true });
  } catch (error) {
    console.error("[mail] failed to resend apartment admin login details", error);
    res.status(500).json({ message: "Unable to resend apartment admin login details." });
  }
});

router.delete("/apartments/:id", requireRole("super_admin"), async (req, res) => {
  const apartmentId = req.params.id;
  const existing = await prisma.apartment.findUnique({ where: { id: apartmentId } });
  if (!existing) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Maintenance ledger — payments cascade-delete PaymentMonth /
      // Screenshot / Receipt via schema, but the payment row itself
      // doesn't cascade with Apartment, so wipe it first.
      await tx.maintenancePayment.deleteMany({ where: { apartmentId } });
      await tx.maintenanceDue.deleteMany({ where: { apartmentId } });

      // Complaints: messages cascade with the complaint.
      await tx.complaint.deleteMany({ where: { apartmentId } });

      // Other society-scoped data.
      await tx.visitorPass.deleteMany({ where: { apartmentId } });
      await tx.listing.deleteMany({ where: { apartmentId } });
      await tx.booking.deleteMany({ where: { apartmentId } });
      await tx.announcement.deleteMany({ where: { apartmentId } });

      // Flats — residents, flat-owner joins and any flat-relation rows
      // cascade via schema. We delete flats before users so that the
      // FlatOwner join rows go cleanly.
      await tx.flat.deleteMany({ where: { apartmentId } });

      // Users (apartment_admin + flat_admins) tied to this apartment.
      await tx.user.deleteMany({ where: { apartmentId } });

      // Apartment itself — blocks, amenities, rules and committee
      // members cascade automatically.
      await tx.apartment.delete({ where: { id: apartmentId } });
    });
    try {
      await recordActivity({
        apartmentId,
        userId: req.auth?.userId ?? null,
        userRole: req.auth?.role ?? "super_admin",
        action: "deleted",
        entity: "apartment",
        entityId: apartmentId,
        details: "Apartment deleted",
      });
    } catch (err) {
      console.error("[activity] failed to record apartment deletion", err);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error("[apartment-delete] failed", error);
    res.status(500).json({ message: "Unable to delete apartment" });
  }
});

// ---------- Blocks ----------

router.get("/apartments/:id/blocks", async (req, res) => {
  const blocks = await prisma.block.findMany({
    where: { apartmentId: req.params.id },
    orderBy: { name: "asc" },
    include: { _count: { select: { flats: true } } },
  });
  res.json(blocks.map((b) => ({
    id: b.id,
    apartmentId: b.apartmentId,
    name: b.name,
    flatCount: b._count.flats,
    createdAt: b.createdAt,
  })));
});

const BlockSchema = z.object({
  name: z.string().min(1).max(40).transform((v) => v.trim()),
});

router.post("/apartments/:id/blocks", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  const parsed = BlockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  try {
    const block = await prisma.block.create({
      data: { apartmentId: req.params.id, name: parsed.data.name },
    });
    res.status(201).json({ id: block.id, apartmentId: block.apartmentId, name: block.name, flatCount: 0, createdAt: block.createdAt });
    try {
      await recordActivity({
        apartmentId: req.params.id,
        userId: req.auth?.userId ?? null,
        userRole: req.auth?.role ?? "apartment_admin",
        action: "created",
        entity: "block",
        entityId: block.id,
        details: `name=${block.name}`,
      });
    } catch (err) {
      console.error("[activity] failed to record block creation", err);
    }
  } catch (error: unknown) {
    if (typeof error === "object" && error && "code" in error && (error as any).code === "P2002") {
      res.status(409).json({ message: "A block with this name already exists in this apartment" });
      return;
    }
    console.error(error);
    res.status(500).json({ message: "Unable to create block" });
  }
});

router.patch("/apartments/:id/blocks/:blockId", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  const parsed = BlockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.block.findUnique({ where: { id: req.params.blockId } });
  if (!existing || existing.apartmentId !== req.params.id) {
    res.status(404).json({ message: "Block not found" });
    return;
  }
  try {
    const updated = await prisma.block.update({
      where: { id: existing.id },
      data: { name: parsed.data.name },
    });
    // keep denormalized Flat.block in sync
    await prisma.flat.updateMany({
      where: { blockId: updated.id },
      data: { block: updated.name },
    });
    const flatCount = await prisma.flat.count({ where: { blockId: updated.id } });
    res.json({ id: updated.id, apartmentId: updated.apartmentId, name: updated.name, flatCount, createdAt: updated.createdAt });
    try {
      await recordActivity({
        apartmentId: updated.apartmentId,
        userId: req.auth?.userId ?? null,
        userRole: req.auth?.role ?? "apartment_admin",
        action: "updated",
        entity: "block",
        entityId: updated.id,
        details: `name=${updated.name}`,
      });
    } catch (err) {
      console.error("[activity] failed to record block update", err);
    }
  } catch (error: unknown) {
    if (typeof error === "object" && error && "code" in error && (error as any).code === "P2002") {
      res.status(409).json({ message: "A block with this name already exists in this apartment" });
      return;
    }
    console.error(error);
    res.status(500).json({ message: "Unable to update block" });
  }
});

router.delete("/apartments/:id/blocks/:blockId", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== req.params.id) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  const existing = await prisma.block.findUnique({ where: { id: req.params.blockId } });
  if (!existing || existing.apartmentId !== req.params.id) {
    res.status(404).json({ message: "Block not found" });
    return;
  }
  const flatCount = await prisma.flat.count({ where: { blockId: existing.id } });
  if (flatCount > 0) {
    res.status(409).json({ message: `Block has ${flatCount} flat(s). Delete or move the flats first.` });
    return;
  }
  await prisma.block.delete({ where: { id: existing.id } });
  try {
    await recordActivity({
      apartmentId: existing.apartmentId,
      userId: req.auth?.userId ?? null,
      userRole: req.auth?.role ?? "apartment_admin",
      action: "deleted",
      entity: "block",
      entityId: existing.id,
      details: `name=${existing.name}`,
    });
  } catch (err) {
    console.error("[activity] failed to record block deletion", err);
  }
  res.json({ ok: true });
});

// ---------- Flats (creation under a block) ----------

const FlatCreateSchema = z
  .object({
    blockId: z.string().min(1),
    number: z.string().min(1).max(40).transform((v) => v.trim()),
    ownerName: z.string().min(1).max(120),
    ownerEmail: z.string().email().optional().nullable().or(z.literal("")),
    ownerMobile: z.string().max(40).optional().nullable(),
    occupantType: z.enum(["resident", "tenant"]).default("resident"),
    tenantName: z.string().max(120).optional().nullable(),
    tenantEmail: z.string().email().optional().nullable().or(z.literal("")),
    tenantMobile: z.string().max(40).optional().nullable(),
    residentCount: z.number().int().min(0).max(20).default(0),
    pendingDuesInr: z.number().int().min(0).default(0),
    monthlyMaintenanceInr: z.number().int().min(0).max(1_000_000).default(2000),
    yearlyAmcInr: z.number().int().min(0).max(10_000_000).default(9000),
  })
  .superRefine((data, ctx) => {
    if (data.occupantType === "tenant") {
      if (!data.tenantName || !data.tenantName.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tenantName"],
          message: "Tenant name is required when occupant type is tenant.",
        });
      }
      if (!data.tenantEmail || !data.tenantEmail.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tenantEmail"],
          message: "Tenant email is required when occupant type is tenant.",
        });
      }
      if (!data.tenantMobile || !data.tenantMobile.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tenantMobile"],
          message: "Tenant phone number is required when occupant type is tenant.",
        });
      }
    }
  });

/**
 * Returns the maximum number of flats allowed for the apartment based on
 * its plan tier. If the plan tier isn't found, defaults to 50 (Starter).
 */
function getPlanMaxFlats(planTier: string): number {
  const plan = plans.find((p) => p.name === planTier);
  return plan?.maxFlats ?? 50;
}

// Provision (or re-link) the flat_admin user for a flat, sending a welcome
// invite on email + WhatsApp when contact details are present. Multiple flats
// can be linked to the same User via the FlatOwner join — the user's
// `User.flatId` stays pointing at their default/active flat (the first one
// they were attached to). Returns null if no contact info was provided.
async function provisionFlatOwner(args: {
  flatId: string;
  apartmentId: string;
  apartmentName: string;
  apartmentCode: string;
  flatNumber: string;
  ownerName: string;
  ownerEmail: string | null;
  ownerMobile: string | null;
}): Promise<{ userId: string | null; created: boolean; channels: { email: boolean; whatsapp: boolean } } | null> {
  const email = args.ownerEmail ? args.ownerEmail.toLowerCase().trim() : null;
  const mobile = args.ownerMobile ? args.ownerMobile.trim() : null;
  if (!email && !mobile) return null;

  const loginUrl = process.env.FRONTEND_ORIGIN
    ? `${process.env.FRONTEND_ORIGIN.replace(/\/$/, "")}/login`
    : "http://localhost:5173/login";

  // Try to find an existing user by email. If no email, we can still send
  // a WhatsApp message even though no User account is created.
  const existing = email ? await prisma.user.findUnique({ where: { email } }) : null;

  if (existing) {
    // If the user exists in a different apartment with a non-flat_admin role, reject.
    if (existing.role !== "flat_admin" && existing.role !== "apartment_admin" && existing.role !== "super_admin") {
      throw new HttpError(409, "Email is already registered to a different account. Use a different email.");
    }
    // If it's an apartment_admin or super_admin, just link — they already have apartment-level access.
    // If it's a flat_admin from a completely different apartment, still reject unless it's the same apartment.
    if (existing.role === "flat_admin" && existing.apartmentId && existing.apartmentId !== args.apartmentId) {
      throw new HttpError(409, "Email is already registered to a different account. Use a different email.");
    }
    // Already a flat_admin (possibly in this apartment). Link via FlatOwner.
    await prisma.flatOwner.upsert({
      where: { userId_flatId: { userId: existing.id, flatId: args.flatId } },
      create: { userId: existing.id, flatId: args.flatId },
      update: {},
    });
    // If the user wasn't yet anchored to this apartment, anchor them and set
    // a default flat so login redirects sensibly.
    if (!existing.apartmentId || !existing.flatId) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          apartmentId: existing.apartmentId ?? args.apartmentId,
          apartmentName: existing.apartmentName ?? args.apartmentName,
          flatId: existing.flatId ?? args.flatId,
          flatNumber: existing.flatNumber ?? args.flatNumber,
        },
      });
    }
    const channels = await sendOwnerInvite({
      apartmentName: args.apartmentName,
      apartmentCode: args.apartmentCode,
      ownerName: args.ownerName,
      flatNumber: args.flatNumber,
      email,
      mobile,
      tempPassword: null,
      loginUrl,
    });
    return { userId: existing.id, created: false, channels };
  }

  // Brand-new owner. Need an email to create a User (login requires it).
  if (!email) {
    const channels = await sendOwnerInvite({
      apartmentName: args.apartmentName,
      apartmentCode: args.apartmentCode,
      ownerName: args.ownerName,
      flatNumber: args.flatNumber,
      email: null,
      mobile,
      tempPassword: null,
      loginUrl,
    });
    return { userId: null, created: false, channels };
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: args.ownerName,
      role: "flat_admin",
      apartmentId: args.apartmentId,
      apartmentName: args.apartmentName,
      flatId: args.flatId,
      flatNumber: args.flatNumber,
      mustChangePassword: true,
    },
  });
  await prisma.flatOwner.create({ data: { userId: user.id, flatId: args.flatId } });

  const channels = await sendOwnerInvite({
    apartmentName: args.apartmentName,
    apartmentCode: args.apartmentCode,
    ownerName: args.ownerName,
    flatNumber: args.flatNumber,
    email,
    mobile,
    tempPassword,
    loginUrl,
  });
  return { userId: user.id, created: true, channels };
}

async function provisionFlatTenant(args: {
  flatId: string;
  apartmentId: string;
  apartmentName: string;
  apartmentCode: string;
  flatNumber: string;
  tenantName: string | null;
  tenantEmail: string | null;
  tenantMobile: string | null;
  ownerEmail: string | null;
  ownerName: string;
  ownerMobile: string | null;
}): Promise<{ userId: string | null; created: boolean; channels: { email: boolean; whatsapp: boolean } } | null> {
  const email = args.tenantEmail ? args.tenantEmail.toLowerCase().trim() : null;
  const mobile = args.tenantMobile ? args.tenantMobile.trim() : null;
  if (!email && !mobile) return null;
  if (email && args.ownerEmail && email === args.ownerEmail.toLowerCase().trim()) {
    return null;
  }

  const loginUrl = process.env.FRONTEND_ORIGIN
    ? `${process.env.FRONTEND_ORIGIN.replace(/\/$/, "")}/login`
    : "http://localhost:5173/login";

  const existing = email ? await prisma.user.findUnique({ where: { email } }) : null;
  if (existing) {
    if (existing.role !== "flat_admin" || (existing.apartmentId && existing.apartmentId !== args.apartmentId)) {
      throw new HttpError(409, "Tenant email is already registered to a different account. Use a different email.");
    }
    await prisma.flatOwner.upsert({
      where: { userId_flatId: { userId: existing.id, flatId: args.flatId } },
      create: { userId: existing.id, flatId: args.flatId },
      update: {},
    });
    if (!existing.apartmentId || !existing.flatId) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          apartmentId: existing.apartmentId ?? args.apartmentId,
          apartmentName: existing.apartmentName ?? args.apartmentName,
          flatId: existing.flatId ?? args.flatId,
          flatNumber: existing.flatNumber ?? args.flatNumber,
          name: args.tenantName ?? existing.name,
        },
      });
    }

    const channels = await sendTenantInvite({
      apartmentName: args.apartmentName,
      apartmentCode: args.apartmentCode,
      flatNumber: args.flatNumber,
      tenantName: args.tenantName ?? "Tenant",
      ownerName: args.ownerName,
      ownerEmail: args.ownerEmail,
      ownerMobile: args.ownerMobile,
      email,
      mobile,
      tempPassword: null,
      loginUrl,
    });
    return { userId: existing.id, created: false, channels };
  }

  const tempPassword = email ? generateTempPassword() : null;
  const userData: any = {
    name: args.tenantName ?? "Tenant",
    role: "flat_admin",
    apartmentId: args.apartmentId,
    apartmentName: args.apartmentName,
    flatId: args.flatId,
    flatNumber: args.flatNumber,
    mustChangePassword: Boolean(tempPassword),
  };
  if (email) {
    userData.email = email;
  }
  if (tempPassword) {
    userData.passwordHash = await bcrypt.hash(tempPassword, 10);
  }

  const user = await prisma.user.create({ data: userData });
  await prisma.flatOwner.create({ data: { userId: user.id, flatId: args.flatId } });

  const channels = await sendTenantInvite({
    apartmentName: args.apartmentName,
    apartmentCode: args.apartmentCode,
    flatNumber: args.flatNumber,
    tenantName: args.tenantName ?? "Tenant",
    ownerName: args.ownerName,
    ownerEmail: args.ownerEmail,
    ownerMobile: args.ownerMobile,
    email,
    mobile,
    tempPassword,
    loginUrl,
  });
  return { userId: user.id, created: true, channels };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

router.post("/apartments/:id/flats", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  const apartmentId = req.params.id;
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  const parsed = FlatCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const block = await prisma.block.findUnique({ where: { id: parsed.data.blockId } });
  if (!block || block.apartmentId !== apartmentId) {
    res.status(400).json({ message: "Block not found in this apartment. Add a block first before adding flats." });
    return;
  }

  const apartment = await prisma.apartment.findUnique({ where: { id: apartmentId } });
  if (!apartment) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }

  // Enforce plan max flats limit
  const existingFlatCount = await prisma.flat.count({ where: { apartmentId } });
  const maxFlats = getPlanMaxFlats(apartment.planTier);
  if (existingFlatCount >= maxFlats) {
    res.status(409).json({
      message: `Cannot add more flats. Your current plan (${apartment.planTier}) allows a maximum of ${maxFlats} flats. Please upgrade your plan to add more.`,
    });
    return;
  }

  try {
    const ownerEmail = parsed.data.ownerEmail ? parsed.data.ownerEmail.toLowerCase().trim() : null;
    const ownerMobile = parsed.data.ownerMobile?.trim() || null;

    const tenantEmail = parsed.data.tenantEmail ? parsed.data.tenantEmail.toLowerCase().trim() : null;
    const tenantMobile = parsed.data.tenantMobile?.trim() || null;
    const tenantName = parsed.data.occupantType === "tenant" ? (parsed.data.tenantName ?? null) : null;

    const flat = await prisma.flat.create({
      data: {
        id: randomUUID(),
        apartmentId,
        blockId: block.id,
        block: block.name,
        number: parsed.data.number,
        ownerName: parsed.data.ownerName,
        ownerEmail,
        ownerMobile,
        occupantType: parsed.data.occupantType,
        tenantName,
        tenantEmail,
        tenantMobile,
        residentCount: parsed.data.residentCount,
        status: parsed.data.occupantType === "tenant" ? "rented" : (parsed.data.residentCount > 0 ? "occupied" : "vacant"),
        pendingDuesInr: parsed.data.pendingDuesInr,
        monthlyMaintenanceInr: parsed.data.monthlyMaintenanceInr,
        yearlyAmcInr: parsed.data.yearlyAmcInr,
      },
    });

    let ownerInvite: Awaited<ReturnType<typeof provisionFlatOwner>> = null;
    let tenantInvite: Awaited<ReturnType<typeof provisionFlatTenant>> = null;
    try {
      ownerInvite = await provisionFlatOwner({
        flatId: flat.id,
        apartmentId,
        apartmentName: apartment.name,
        apartmentCode: apartment.code,
        flatNumber: flat.number,
        ownerName: flat.ownerName,
        ownerEmail,
        ownerMobile,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ message: err.message, flat });
        return;
      }
      console.error("[flat] provisionFlatOwner failed", err);
    }

    if (parsed.data.occupantType === "tenant") {
      try {
        tenantInvite = await provisionFlatTenant({
          flatId: flat.id,
          apartmentId,
          apartmentName: apartment.name,
          apartmentCode: apartment.code,
          flatNumber: flat.number,
          tenantName,
          tenantEmail,
          tenantMobile,
          ownerEmail,
          ownerName: flat.ownerName,
          ownerMobile,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ message: err.message, flat });
          return;
        }
        console.error("[flat] provisionFlatTenant failed", err);
      }
    }

    try {
      await recordActivity({
        apartmentId,
        userId: req.auth?.userId ?? null,
        userRole: req.auth?.role ?? "apartment_admin",
        action: "created",
        entity: "flat",
        entityId: flat.id,
        details: `block=${block.name},number=${flat.number},owner=${flat.ownerName}`,
      });
    } catch (err) {
      console.error("[activity] failed to record flat creation", err);
    }
    res.status(201).json({ flat, ownerInvite, tenantInvite });
  } catch (error: unknown) {
    console.error(error);
    res.status(500).json({ message: "Unable to create flat" });
  }
});

// ---------- Bulk flat upload / export ----------
// Bulk-upload flats from a CSV. The frontend parses the CSV and sends rows
// as JSON; the backend validates each row, auto-creates missing blocks, and
// inserts flats. Invite emails are NOT sent in bulk — admins can use the
// per-flat "Resend invite" button.
//
// Optional `blockId` constrains the upload to a single block (any row whose
// `block` column differs is rejected). Otherwise the row's `block` column
// decides the block; unknown blocks are auto-created.

const BulkRowSchema = z.object({
  block: z.string().min(1).max(40).transform((v) => v.trim()),
  number: z.string().min(1).max(40).transform((v) => v.trim()),
  ownerName: z.string().min(1).max(120).transform((v) => v.trim()),
  ownerEmail: z.string().email().optional().nullable().or(z.literal("")),
  ownerMobile: z.string().max(40).optional().nullable(),
  occupantType: z.enum(["resident", "tenant"]).optional(),
  tenantName: z.string().max(120).optional().nullable(),
  tenantEmail: z.string().email().optional().nullable().or(z.literal("")),
  tenantMobile: z.string().max(40).optional().nullable(),
  residentCount: z.number().int().min(0).max(20).optional(),
  pendingDuesInr: z.number().int().min(0).optional(),
  monthlyMaintenanceInr: z.number().int().min(0).max(1_000_000).optional(),
  yearlyAmcInr: z.number().int().min(0).max(10_000_000).optional(),
});

const BulkUploadSchema = z.object({
  blockId: z.string().min(1).optional(),
  rows: z.array(z.record(z.unknown())).min(1).max(2000),
});

interface BulkRowError {
  row: number;
  message: string;
}

router.post(
  "/apartments/:id/flats/bulk-csv",
  requireCommitteeOrRole("id", "apartment_admin"),
  async (req, res) => {
    const apartmentId = req.params.id;
    if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== apartmentId) {
      res.status(403).json({ message: "Forbidden — wrong apartment" });
      return;
    }
    const parsedBody = BulkUploadSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsedBody.error.flatten() });
      return;
    }
    const apartment = await prisma.apartment.findUnique({ where: { id: apartmentId } });
    if (!apartment) {
      res.status(404).json({ message: "Apartment not found" });
      return;
    }

  const restrictBlock = parsedBody.data.blockId
      ? await prisma.block.findUnique({ where: { id: parsedBody.data.blockId } })
      : null;
  if (parsedBody.data.blockId && (!restrictBlock || restrictBlock.apartmentId !== apartmentId)) {
    res.status(400).json({ message: "Block not found in this apartment" });
    return;
  }

  // Enforce plan max flats limit
  const existingFlatCount = await prisma.flat.count({ where: { apartmentId } });
  const maxFlats = getPlanMaxFlats(apartment.planTier);
  const newRows = parsedBody.data.rows.length;
  const wouldExceedLimit = existingFlatCount + newRows > maxFlats;
  if (existingFlatCount >= maxFlats) {
    res.status(409).json({
      message: `Cannot upload flats. Your current plan (${apartment.planTier}) allows a maximum of ${maxFlats} flats. You already have ${existingFlatCount} flats. Please upgrade your plan to add more.`,
    });
    return;
  }
  if (wouldExceedLimit) {
    const availableSlots = maxFlats - existingFlatCount;
    res.status(409).json({
      message: `Cannot upload ${newRows} flats — only ${availableSlots} slot(s) remaining under your current plan (${apartment.planTier}, max ${maxFlats} flats). Please upgrade your plan or reduce the upload to ${availableSlots} flats.`,
      existingCount: existingFlatCount,
      maxFlats,
      attemptedRows: newRows,
      availableSlots,
    });
    return;
  }

  const existingBlocks = await prisma.block.findMany({ where: { apartmentId } });
  const blockByName = new Map(existingBlocks.map((b) => [b.name.toLowerCase(), b]));

  const errors: BulkRowError[] = [];
  let created = 0;
  let skipped = 0;
  let blocksCreated = 0;

  for (let i = 0; i < parsedBody.data.rows.length; i++) {
      const rowNum = i + 2; // header is row 1
      const raw = parsedBody.data.rows[i];
      const parsed = BulkRowSchema.safeParse({
        block: raw.block,
        number: raw.number,
        ownerName: raw.ownerName,
        ownerEmail: raw.ownerEmail === "" ? null : raw.ownerEmail,
        ownerMobile: raw.ownerMobile === "" ? null : raw.ownerMobile,
        occupantType: raw.occupantType || undefined,
        tenantName: raw.tenantName === "" ? null : raw.tenantName,
        tenantEmail: raw.tenantEmail === "" ? null : raw.tenantEmail,
        tenantMobile: raw.tenantMobile === "" ? null : raw.tenantMobile,
        residentCount:
          raw.residentCount === undefined || raw.residentCount === null || raw.residentCount === ""
            ? undefined
            : Number(raw.residentCount),
        pendingDuesInr:
          raw.pendingDuesInr === undefined || raw.pendingDuesInr === null || raw.pendingDuesInr === ""
            ? undefined
            : Number(raw.pendingDuesInr),
        monthlyMaintenanceInr:
          raw.monthlyMaintenanceInr === undefined || raw.monthlyMaintenanceInr === null || raw.monthlyMaintenanceInr === ""
            ? undefined
            : Number(raw.monthlyMaintenanceInr),
        yearlyAmcInr:
          raw.yearlyAmcInr === undefined || raw.yearlyAmcInr === null || raw.yearlyAmcInr === ""
            ? undefined
            : Number(raw.yearlyAmcInr),
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        errors.push({ row: rowNum, message: `${issue.path.join(".") || "row"}: ${issue.message}` });
        continue;
      }

      if (restrictBlock && parsed.data.block.toLowerCase() !== restrictBlock.name.toLowerCase()) {
        errors.push({
          row: rowNum,
          message: `block "${parsed.data.block}" doesn't match the target block "${restrictBlock.name}"`,
        });
        continue;
      }

      // Resolve or create block.
      const key = parsed.data.block.toLowerCase();
      let block = blockByName.get(key);
      if (!block) {
        try {
          block = await prisma.block.create({
            data: { apartmentId, name: parsed.data.block },
          });
          blockByName.set(key, block);
          blocksCreated++;
        } catch (err) {
          errors.push({ row: rowNum, message: `unable to create block "${parsed.data.block}"` });
          continue;
        }
      }

      // Skip if a flat with the same number already exists in this block.
      const dup = await prisma.flat.findFirst({
        where: { apartmentId, blockId: block.id, number: parsed.data.number },
        select: { id: true },
      });
      if (dup) {
        skipped++;
        continue;
      }

      const occupantType = parsed.data.occupantType ?? "resident";
      const residentCount = parsed.data.residentCount ?? 0;
      const ownerEmail = parsed.data.ownerEmail ? parsed.data.ownerEmail.toLowerCase().trim() : null;
      const ownerMobile = parsed.data.ownerMobile?.trim() || null;
      try {
        await prisma.flat.create({
          data: {
            id: randomUUID(),
            apartmentId,
            blockId: block.id,
            block: block.name,
            number: parsed.data.number,
            ownerName: parsed.data.ownerName,
            ownerEmail,
            ownerMobile,
            occupantType,
            tenantName: occupantType === "tenant" ? (parsed.data.tenantName ?? null) : null,
            residentCount,
            status: occupantType === "tenant" ? "rented" : residentCount > 0 ? "occupied" : "vacant",
            pendingDuesInr: parsed.data.pendingDuesInr ?? 0,
            monthlyMaintenanceInr: parsed.data.monthlyMaintenanceInr ?? 2000,
            yearlyAmcInr: parsed.data.yearlyAmcInr ?? 9000,
          },
        });
        created++;
      } catch (err) {
        errors.push({ row: rowNum, message: "unable to create flat (database error)" });
      }
    }

    res.json({ created, skipped, blocksCreated, errors });
  },
);

// CSV export — returns text/csv with block + flat details + payment dues.
// Optional ?blockId= filter exports a single block.
router.get("/apartments/:id/flats/export.csv", async (req, res) => {
  const apartmentId = req.params.id;
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  if (req.auth!.role === "flat_admin") {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const blockId = typeof req.query.blockId === "string" ? req.query.blockId : undefined;
  const flats = await prisma.flat.findMany({
    where: { apartmentId, ...(blockId ? { blockId } : {}) },
    orderBy: [{ block: "asc" }, { number: "asc" }],
  });

  const headers = [
    "block",
    "number",
    "ownerName",
    "ownerEmail",
    "ownerMobile",
    "occupantType",
    "tenantName",
    "tenantEmail",
    "tenantMobile",
    "residentCount",
    "status",
    "pendingDuesInr",
    "monthlyMaintenanceInr",
    "yearlyAmcInr",
  ];

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(",")];
  for (const f of flats) {
    lines.push(
      [
        f.block,
        f.number,
        f.ownerName,
        f.ownerEmail ?? "",
        f.ownerMobile ?? "",
        f.occupantType,
        f.tenantName ?? "",
        f.tenantEmail ?? "",
        f.tenantMobile ?? "",
        f.residentCount,
        f.status,
        f.pendingDuesInr,
        f.monthlyMaintenanceInr,
        f.yearlyAmcInr,
      ]
        .map(escape)
        .join(","),
    );
  }

  const filename = blockId ? `flats-block-${blockId}.csv` : `flats-${apartmentId}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // BOM so Excel opens UTF-8 correctly.
  res.send("﻿" + lines.join("\r\n") + "\r\n");
});

// ---------- Flat update / delete ----------
// PATCH /flats/:id
//   - apartment_admin (own apartment) / super_admin: may update any field
//   - flat_admin (own flat only): may update ownerName, ownerMobile, residentCount

const FlatAdminPatchSchema = z.object({
  ownerName: z.string().min(1).max(120).optional(),
  ownerMobile: z.string().max(40).optional().nullable(),
  residentCount: z.number().int().min(0).max(20).optional(),
});

const FlatFullPatchSchema = FlatAdminPatchSchema.extend({
  number: z.string().min(1).max(40).optional(),
  ownerEmail: z.string().email().optional().nullable().or(z.literal("")),
  ownerMobile: z.string().max(40).optional().nullable(),
  occupantType: z.enum(["resident", "tenant"]).optional(),
  tenantName: z.string().max(120).optional().nullable(),
  tenantEmail: z.string().email().optional().nullable().or(z.literal("")),
  tenantMobile: z.string().max(40).optional().nullable(),
  status: z.enum(["occupied", "vacant", "rented"]).optional(),
  accountActive: z.boolean().optional(),
  pendingDuesInr: z.number().int().min(0).optional(),
  monthlyMaintenanceInr: z.number().int().min(0).max(1_000_000).optional(),
  yearlyAmcInr: z.number().int().min(0).max(10_000_000).optional(),
});

router.patch("/flats/:id", async (req, res) => {
  const flat = await prisma.flat.findUnique({ where: { id: req.params.id } });
  if (!flat) {
    res.status(404).json({ message: "Flat not found" });
    return;
  }

  const role = req.auth!.role;
  let data: Record<string, unknown>;

  if (role === "flat_admin") {
    if (req.auth!.flatId !== flat.id) {
      res.status(403).json({ message: "Forbidden — you can only update your own flat" });
      return;
    }
    const parsed = FlatAdminPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    data = {};
    if (parsed.data.ownerName !== undefined) data.ownerName = parsed.data.ownerName.trim();
    if (parsed.data.ownerMobile !== undefined) {
      data.ownerMobile = parsed.data.ownerMobile ? parsed.data.ownerMobile.trim() : null;
    }
    if (parsed.data.residentCount !== undefined) data.residentCount = parsed.data.residentCount;
  } else if (role === "apartment_admin" || role === "super_admin") {
    if (role === "apartment_admin" && req.auth!.apartmentId !== flat.apartmentId) {
      res.status(403).json({ message: "Forbidden — wrong apartment" });
      return;
    }
    const parsed = FlatFullPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    data = {};
    if (parsed.data.ownerName !== undefined) data.ownerName = parsed.data.ownerName.trim();
    if (parsed.data.ownerMobile !== undefined) {
      data.ownerMobile = parsed.data.ownerMobile ? parsed.data.ownerMobile.trim() : null;
    }
    if (parsed.data.ownerEmail !== undefined) {
      data.ownerEmail = parsed.data.ownerEmail ? parsed.data.ownerEmail.toLowerCase().trim() : null;
    }
    if (parsed.data.ownerMobile !== undefined) {
      data.ownerMobile = parsed.data.ownerMobile ? parsed.data.ownerMobile.trim() : null;
    }
    if (parsed.data.residentCount !== undefined) data.residentCount = parsed.data.residentCount;
    if (parsed.data.number !== undefined) data.number = parsed.data.number.trim();
    if (parsed.data.occupantType !== undefined) data.occupantType = parsed.data.occupantType;
    if (parsed.data.tenantName !== undefined) {
      data.tenantName = parsed.data.tenantName ? parsed.data.tenantName.trim() : null;
    }
    if (parsed.data.tenantEmail !== undefined) {
      data.tenantEmail = parsed.data.tenantEmail ? parsed.data.tenantEmail.toLowerCase().trim() : null;
    }
    if (parsed.data.tenantMobile !== undefined) {
      data.tenantMobile = parsed.data.tenantMobile ? parsed.data.tenantMobile.trim() : null;
    }
    if (parsed.data.status !== undefined) data.status = parsed.data.status;
    if (parsed.data.accountActive !== undefined) data.accountActive = parsed.data.accountActive;
    if (parsed.data.pendingDuesInr !== undefined) data.pendingDuesInr = parsed.data.pendingDuesInr;
    if (parsed.data.monthlyMaintenanceInr !== undefined) data.monthlyMaintenanceInr = parsed.data.monthlyMaintenanceInr;
    if (parsed.data.yearlyAmcInr !== undefined) data.yearlyAmcInr = parsed.data.yearlyAmcInr;
    // if occupantType flipped to resident, clear tenant contact details
    if (parsed.data.occupantType === "resident") {
      if (parsed.data.tenantName === undefined) data.tenantName = null;
      if (parsed.data.tenantEmail === undefined) data.tenantEmail = null;
      if (parsed.data.tenantMobile === undefined) data.tenantMobile = null;
    }
  } else {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  if (Object.keys(data).length === 0) {
    res.json({ flat, invite: null });
    return;
  }

  try {
    const updated = await prisma.flat.update({ where: { id: flat.id }, data });

    let invite: Awaited<ReturnType<typeof provisionFlatOwner>> = null;
    if (
      (role === "apartment_admin" || role === "super_admin") &&
      ((data.ownerEmail !== undefined && data.ownerEmail !== flat.ownerEmail) ||
        (data.ownerMobile !== undefined && data.ownerMobile !== flat.ownerMobile))
    ) {
      const apartment = await prisma.apartment.findUnique({ where: { id: updated.apartmentId } });
      if (apartment) {
        try {
          invite = await provisionFlatOwner({
            flatId: updated.id,
            apartmentId: updated.apartmentId,
            apartmentName: apartment.name,
            apartmentCode: apartment.code,
            flatNumber: updated.number,
            ownerName: updated.ownerName,
            ownerEmail: updated.ownerEmail,
            ownerMobile: updated.ownerMobile,
          });
        } catch (err) {
          if (err instanceof HttpError) {
            res.status(err.status).json({ message: err.message, flat: updated });
            return;
          }
          console.error("[flat] provisionFlatOwner failed", err);
        }
      }
    }

    const becameInactive = data.accountActive === false && flat.accountActive === true;
    const becameActive = data.accountActive === true && flat.accountActive === false;
    if ((becameInactive || becameActive) && (role === "apartment_admin" || role === "super_admin")) {
      const apartment = await prisma.apartment.findUnique({
        where: { id: updated.apartmentId },
        select: { name: true, code: true },
      });
      if (apartment) {
        try {
          if (becameInactive) {
            await prisma.user.updateMany({
              where: { flatId: updated.id },
              data: { tokenVersion: { increment: 1 } },
            });
          }

          const loginUrl = process.env.FRONTEND_ORIGIN
            ? `${process.env.FRONTEND_ORIGIN.replace(/\/$/, "")}/login`
            : "http://localhost:5173/login";

          await Promise.all([
            sendFlatAccountStatusNotification({
              apartmentName: apartment.name,
              apartmentCode: apartment.code,
              flatNumber: updated.number,
              recipientName: updated.ownerName,
              email: updated.ownerEmail,
              mobile: updated.ownerMobile,
              active: becameActive,
              loginUrl,
            }),
            updated.occupantType === "tenant" && updated.tenantEmail
              ? sendFlatAccountStatusNotification({
                  apartmentName: apartment.name,
                  apartmentCode: apartment.code,
                  flatNumber: updated.number,
                  recipientName: updated.tenantName ?? "Tenant",
                  email: updated.tenantEmail,
                  mobile: updated.tenantMobile,
                  active: becameActive,
                  loginUrl,
                })
              : Promise.resolve({ email: false, whatsapp: false }),
          ]);
        } catch (err) {
          console.error("[flat] account status notification failed", err);
        }
      }
    }

    try {
      await recordActivity({
        apartmentId: updated.apartmentId,
        userId: req.auth?.userId ?? null,
        userRole: req.auth?.role ?? "apartment_admin",
        action: "updated",
        entity: "flat",
        entityId: updated.id,
        details: `fields=${Object.keys(data).join(",")}`,
      });
    } catch (err) {
      console.error("[activity] failed to record flat update", err);
    }
    res.json({ flat: updated, invite });
  } catch (error: unknown) {
    console.error(error);
    res.status(500).json({ message: "Unable to update flat" });
  }
});

// POST /flats/:id/resend-invite — apartment_admin can regenerate a temp
// password (or just re-send the link) for the flat owner. Returns
// `{ channels: { email, whatsapp } }` indicating which deliveries were
// attempted.
router.post("/flats/:id/resend-invite", requireCommitteeOrRole("id", "apartment_admin"), async (req, res) => {
  const flat = await prisma.flat.findUnique({ where: { id: req.params.id } });
  if (!flat) {
    res.status(404).json({ message: "Flat not found" });
    return;
  }
  if (req.auth!.role === "apartment_admin" && req.auth!.apartmentId !== flat.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }
  if (!flat.ownerEmail && !flat.ownerMobile) {
    res.status(400).json({ message: "Add the owner's email or mobile number first." });
    return;
  }
  const apartment = await prisma.apartment.findUnique({ where: { id: flat.apartmentId } });
  if (!apartment) {
    res.status(404).json({ message: "Apartment not found" });
    return;
  }

  const loginUrl = process.env.FRONTEND_ORIGIN
    ? `${process.env.FRONTEND_ORIGIN.replace(/\/$/, "")}/login`
    : "http://localhost:5173/login";

  // If a user already exists for the owner email, regenerate their password
  // and re-link. Otherwise fall through to provisionFlatOwner which will
  // create the user (and the FlatOwner link) and send the invite.
  if (flat.ownerEmail) {
    const existing = await prisma.user.findUnique({ where: { email: flat.ownerEmail } });
    if (existing) {
      if (existing.role !== "flat_admin" || (existing.apartmentId && existing.apartmentId !== flat.apartmentId)) {
        res.status(409).json({ message: "Email is registered to a different account." });
        return;
      }
      const tempPassword = generateTempPassword();
      await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash: await bcrypt.hash(tempPassword, 10), mustChangePassword: true },
      });
      await prisma.flatOwner.upsert({
        where: { userId_flatId: { userId: existing.id, flatId: flat.id } },
        create: { userId: existing.id, flatId: flat.id },
        update: {},
      });
      const channels = await sendOwnerInvite({
        apartmentName: apartment.name,
        apartmentCode: apartment.code,
        ownerName: flat.ownerName,
        flatNumber: flat.number,
        email: flat.ownerEmail,
        mobile: flat.ownerMobile,
        tempPassword,
        loginUrl,
      });
      res.json({ ok: true, channels, passwordRotated: true });
      return;
    }
  }

  try {
    const invite = await provisionFlatOwner({
      flatId: flat.id,
      apartmentId: flat.apartmentId,
      apartmentName: apartment.name,
      apartmentCode: apartment.code,
      flatNumber: flat.number,
      ownerName: flat.ownerName,
      ownerEmail: flat.ownerEmail,
      ownerMobile: flat.ownerMobile,
    });
    res.json({ ok: true, channels: invite?.channels ?? { email: false, whatsapp: false }, passwordRotated: invite?.created ?? false });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ message: "Unable to resend invite" });
  }
});

router.delete("/flats/:id", async (req, res) => {
  const flat = await prisma.flat.findUnique({ where: { id: req.params.id } });
  if (!flat) {
    res.status(404).json({ message: "Flat not found" });
    return;
  }

  // Check authorization: super_admin, apartment_admin (own apartment), or committee member (same apartment)
  const role = req.auth!.role;
  const isCommitteeMember =
    role === "flat_admin" &&
    req.auth!.committeePosition &&
    req.auth!.committeeApartmentId === flat.apartmentId;
  const isApartmentAdmin = role === "apartment_admin" && req.auth!.apartmentId === flat.apartmentId;
  const isSuperAdmin = role === "super_admin";

  if (!isSuperAdmin && !isApartmentAdmin && !isCommitteeMember) {
    res.status(403).json({ message: "Forbidden — insufficient role" });
    return;
  }
  try {
    await prisma.$transaction([
      prisma.user.updateMany({ where: { flatId: flat.id }, data: { flatId: null, flatNumber: null } }),
      prisma.visitorPass.deleteMany({ where: { flatId: flat.id } }),
      prisma.resident.deleteMany({ where: { flatId: flat.id } }),
      prisma.flat.delete({ where: { id: flat.id } }),
    ]);
    try {
      await recordActivity({
        apartmentId: flat.apartmentId,
        userId: req.auth?.userId ?? null,
        userRole: req.auth?.role ?? "apartment_admin",
        action: "deleted",
        entity: "flat",
        entityId: flat.id,
        details: `block=${flat.block},number=${flat.number}`,
      });
    } catch (err) {
      console.error("[activity] failed to record flat deletion", err);
    }
    res.json({ ok: true });
  } catch (error: unknown) {
    console.error(error);
    res.status(500).json({ message: "Unable to delete flat" });
  }
});

router.get("/visitor-passes", async (req, res) => {
  const apartmentId = typeof req.query.apartmentId === "string" ? req.query.apartmentId : undefined;
  const flatId = typeof req.query.flatId === "string" ? req.query.flatId : undefined;
  const list = await prisma.visitorPass.findMany({
    where: {
      ...(apartmentId ? { apartmentId } : {}),
      ...(flatId ? { flatId } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      flat: {
        select: {
          ownerName: true,
          ownerMobile: true,
        },
      },
    },
  });
  res.json(list);
});

const VisitorPassUpdateSchema = z.object({
  status: z.enum(["active", "used", "cancelled"]),
});

router.patch("/visitor-passes/:id", requireRole("security", "apartment_admin", "super_admin"), async (req, res) => {
  const parsed = VisitorPassUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const visitorPass = await prisma.visitorPass.findUnique({ where: { id: req.params.id } });
  if (!visitorPass) {
    res.status(404).json({ message: "Visitor pass not found" });
    return;
  }
  if (req.auth!.role !== "super_admin" && req.auth!.apartmentId !== visitorPass.apartmentId) {
    res.status(403).json({ message: "Forbidden — wrong apartment" });
    return;
  }

  const updated = await prisma.visitorPass.update({
    where: { id: req.params.id },
    data: { status: parsed.data.status },
  });
  notifyVisitorPassUpdated({
    id: updated.id,
    apartmentId: updated.apartmentId,
    flatId: updated.flatId,
    flatNumber: updated.flatNumber,
    guestName: updated.guestName,
    type: updated.type,
    status: updated.status,
    createdAt: updated.createdAt.toISOString(),
    expiresAt: updated.expiresAt.toISOString(),
  });
  res.json(updated);
});

const VisitorPassSchema = z.object({
  apartmentId: z.string(),
  flatId: z.string(),
  flatNumber: z.string(),
  guestName: z.string().min(1),
  type: z.enum(["guest", "contractor", "delivery"]),
  validForHours: z.number().min(1).max(168),
});

router.post("/visitor-passes", async (req, res) => {
  const parsed = VisitorPassSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { validForHours, ...rest } = parsed.data;
  const created = await prisma.visitorPass.create({
    data: {
      ...rest,
      code: String(Math.floor(100000 + Math.random() * 899999)),
      status: "active",
      expiresAt: new Date(Date.now() + validForHours * 3600 * 1000),
    },
  });
  notifyVisitorPassCreated({
    id: created.id,
    apartmentId: created.apartmentId,
    flatId: created.flatId,
    flatNumber: created.flatNumber,
    guestName: created.guestName,
    type: created.type,
    status: created.status,
    createdAt: created.createdAt.toISOString(),
    expiresAt: created.expiresAt.toISOString(),
  });

  // Persist in-app notification for flat owners
  notifyFlatOwners(
    created.flatId,
    created.apartmentId,
    "visitor_pass_created",
    `Visitor pass created for ${created.guestName}`,
    `${created.guestName} (${created.type}) — valid until ${created.expiresAt.toLocaleDateString()}`,
    "/flat-admin/visitors",
  ).catch((err: unknown) => console.error("[notification] visitor pass notification failed", err));

  // Push notification to security staff
  notifyApartmentRolePush(created.apartmentId, ["security"], {
    title: `Visitor: ${created.guestName}`,
    body: `${created.guestName} requested entry to ${created.flatNumber} (${created.type})`,
    data: { type: "visitor_pass_created", visitorPassId: created.id },
    clickAction: "/visitors",
  }).catch((err: unknown) => console.error("[push] visitor pass security notification failed", err));

  res.status(201).json(created);
});

export default router;
