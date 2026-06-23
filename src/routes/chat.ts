import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  resolveDirectChat,
  resolveSecurityChat,
  ensureBroadcastChannel,
  createGroupChat,
  createEventGroupChat,
  getMessages,
  getUserChats,
  getUnreadCounts,
  getBlockedUsers,
  blockUser,
  unblockUser,
  updatePrivacy,
  getPrivacy,
  reportChat,
  archiveExpiredEventGroups,
  getOnlineStatus,
} from "../lib/chat.js";
import { prisma } from "../lib/prisma.js";
import { emitToUser } from "../socket-io.js";
import { notifyUserPush } from "../lib/notify-push.js";

const router = Router();

// All chat routes require auth
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────
//  Chat CRUD
// ─────────────────────────────────────────────────────────────

/** List all chats for the authenticated user */
router.get("/", async (req: Request, res: Response) => {
  try {
    const chats = await getUserChats(req.auth!.userId, req.auth!.apartmentId || undefined);
    const unread = await getUnreadCounts(req.auth!.userId);
    // Add other-participant info for direct chats
    const enriched = chats.map((chat) => {
      let otherParticipant = null;
      if (chat.type === "direct") {
        otherParticipant = chat.participants.find((p) => p.userId !== req.auth!.userId)?.user || null;
      }
      return { ...chat, otherParticipant };
    });
    res.json({ chats: enriched, unread });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get or create a 1:1 direct chat with another user */
router.post("/direct", async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    const chat = await resolveDirectChat(req.auth!.userId, userId, req.auth!.apartmentId!);
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get or create the security chat for the user's apartment */
router.post("/security", async (req: Request, res: Response) => {
  try {
    const chat = await resolveSecurityChat(req.auth!.userId, req.auth!.apartmentId!);
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get the broadcast channel */
router.get("/broadcast", async (req: Request, res: Response) => {
  try {
    const chat = await ensureBroadcastChannel(req.auth!.apartmentId!);
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Create a group chat */
router.post("/group", async (req: Request, res: Response) => {
  try {
    const { name, description, participantIds } = req.body;
    if (!name) return res.status(400).json({ error: "Group name is required" });
    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ error: "At least one participant is required" });
    }
    // Deduplicate and ensure creator is included
    const ids = [...new Set([req.auth!.userId, ...participantIds])];
    const chat = await createGroupChat({
      name,
      description,
      apartmentId: req.auth!.apartmentId!,
      createdBy: req.auth!.userId,
      participantIds: ids,
    });
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Create an event group */
router.post("/event", async (req: Request, res: Response) => {
  try {
    const { name, description, eventDate, participantIds } = req.body;
    if (!name) return res.status(400).json({ error: "Event name is required" });
    if (!eventDate) return res.status(400).json({ error: "Event date is required" });
    const ids = [...new Set([req.auth!.userId, ...(participantIds || [])])];
    const chat = await createEventGroupChat({
      name,
      description,
      apartmentId: req.auth!.apartmentId!,
      createdBy: req.auth!.userId,
      eventDate: new Date(eventDate),
      participantIds: ids,
    });
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get a single chat with participants */
router.get("/:chatId", async (req: Request, res: Response) => {
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: req.params.chatId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, role: true, flatNumber: true } },
          },
        },
        admins: { select: { userId: true } },
      },
    });
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    // Verify user is a participant
    if (!chat.participants.find((p) => p.userId === req.auth!.userId)) {
      return res.status(403).json({ error: "Not a participant in this chat" });
    }
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Update a chat (name, description, avatar) */
router.patch("/:chatId", async (req: Request, res: Response) => {
  try {
    const { name, description, avatar } = req.body;
    // Verify admin
    const isAdmin = await prisma.chatAdmin.findUnique({
      where: { chatId_userId: { chatId: req.params.chatId, userId: req.auth!.userId } },
    });
    if (!isAdmin && req.auth!.role !== "apartment_admin" && req.auth!.role !== "super_admin") {
      return res.status(403).json({ error: "Only admins can update chat settings" });
    }
    const chat = await prisma.chat.update({
      where: { id: req.params.chatId },
      data: { ...(name && { name }), ...(description !== undefined && { description }), ...(avatar && { avatar }) },
    });
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Delete a chat (admin only) */
router.delete("/:chatId", async (req: Request, res: Response) => {
  try {
    const isAdmin = await prisma.chatAdmin.findUnique({
      where: { chatId_userId: { chatId: req.params.chatId, userId: req.auth!.userId } },
    });
    if (!isAdmin && req.auth!.role !== "apartment_admin" && req.auth!.role !== "super_admin") {
      return res.status(403).json({ error: "Only admins can delete chats" });
    }
    await prisma.chat.delete({ where: { id: req.params.chatId } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Messages
// ─────────────────────────────────────────────────────────────

/** Get messages for a chat */
router.get("/:chatId/messages", async (req: Request, res: Response) => {
  try {
    const { limit, before, search } = req.query;
    const result = await getMessages(req.params.chatId, {
      limit: limit ? parseInt(limit as string) : 50,
      before: before as string,
      search: search as string,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Upload a media file and get URL (placeholder for now, will integrate with media lib) */
router.post("/media/upload", async (req: Request, res: Response) => {
  try {
    const { fileDataUrl, fileName, fileType } = req.body;
    if (!fileDataUrl) return res.status(400).json({ error: "fileDataUrl is required" });
    // TODO: use media lib to upload to cloud storage
    // For now return the dataUrl as the media URL (only works for small files)
    res.json({
      url: fileDataUrl,
      name: fileName || "file",
      type: fileType || "application/octet-stream",
      size: Math.round(fileDataUrl.length * 0.75), // approximate
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Participants
// ─────────────────────────────────────────────────────────────

/** Add participant(s) to a group chat */
router.post("/:chatId/participants", async (req: Request, res: Response) => {
  try {
    const { userIds } = req.body;
    if (!userIds || !Array.isArray(userIds)) {
      return res.status(400).json({ error: "userIds array is required" });
    }
    // Verify admin
    const isAdmin = await prisma.chatAdmin.findUnique({
      where: { chatId_userId: { chatId: req.params.chatId, userId: req.auth!.userId } },
    });
    if (!isAdmin && req.auth!.role !== "apartment_admin") {
      return res.status(403).json({ error: "Only group admins can add participants" });
    }
    const results = [];
    for (const uid of userIds) {
      try {
        const p = await prisma.chatParticipant.upsert({
          where: { chatId_userId: { chatId: req.params.chatId, userId: uid } },
          update: { leftAt: null },
          create: { chatId: req.params.chatId, userId: uid },
        });
        results.push(p);
      } catch {
        // skip duplicates
      }
    }
    res.json({ added: results.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Remove participant from group chat */
router.delete("/:chatId/participants/:userId", async (req: Request, res: Response) => {
  try {
    const isAdmin = await prisma.chatAdmin.findUnique({
      where: { chatId_userId: { chatId: req.params.chatId, userId: req.auth!.userId } },
    });
    if (!isAdmin && req.auth!.role !== "apartment_admin" && req.auth!.userId !== req.params.userId) {
      return res.status(403).json({ error: "Only admins can remove participants" });
    }
    await prisma.chatParticipant.updateMany({
      where: { chatId: req.params.chatId, userId: req.params.userId },
      data: { leftAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Leave a chat */
router.post("/:chatId/leave", async (req: Request, res: Response) => {
  try {
    await prisma.chatParticipant.updateMany({
      where: { chatId: req.params.chatId, userId: req.auth!.userId },
      data: { leftAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Admins
// ─────────────────────────────────────────────────────────────

/** Make a user an admin (only existing admin can do this) */
router.post("/:chatId/admins", async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });
    const isAdmin = await prisma.chatAdmin.findUnique({
      where: { chatId_userId: { chatId: req.params.chatId, userId: req.auth!.userId } },
    });
    if (!isAdmin && req.auth!.role !== "apartment_admin") {
      return res.status(403).json({ error: "Only group admins can promote members" });
    }
    await prisma.chatAdmin.upsert({
      where: { chatId_userId: { chatId: req.params.chatId, userId } },
      update: {},
      create: { chatId: req.params.chatId, userId },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Remove admin */
router.delete("/:chatId/admins/:userId", async (req: Request, res: Response) => {
  try {
    const isAdmin = await prisma.chatAdmin.findUnique({
      where: { chatId_userId: { chatId: req.params.chatId, userId: req.auth!.userId } },
    });
    if (!isAdmin && req.auth!.role !== "apartment_admin") {
      return res.status(403).json({ error: "Only group admins can demote members" });
    }
    await prisma.chatAdmin.deleteMany({
      where: { chatId: req.params.chatId, userId: req.params.userId },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Blocking & privacy
// ─────────────────────────────────────────────────────────────

/** Get blocked users */
router.get("/blocks", async (req: Request, res: Response) => {
  try {
    const blocked = await getBlockedUsers(req.auth!.userId);
    res.json(blocked);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Block a user */
router.post("/blocks", async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (userId === req.auth!.userId) return res.status(400).json({ error: "Cannot block yourself" });
    await blockUser(req.auth!.userId, userId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Unblock a user */
router.delete("/blocks/:userId", async (req: Request, res: Response) => {
  try {
    await unblockUser(req.auth!.userId, req.params.userId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Privacy settings
// ─────────────────────────────────────────────────────────────

router.get("/privacy", async (req: Request, res: Response) => {
  try {
    const privacy = await getPrivacy(req.auth!.userId);
    res.json(privacy || { allowAll: true, lastSeenVisible: true, onlineStatusVisible: true, readReceiptsEnabled: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/privacy", async (req: Request, res: Response) => {
  try {
    const privacy = await updatePrivacy(req.auth!.userId, req.body);
    res.json(privacy);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Reports
// ─────────────────────────────────────────────────────────────

router.post("/report", async (req: Request, res: Response) => {
  try {
    const { messageId, chatId, reason, description } = req.body;
    if (!reason) return res.status(400).json({ error: "Reason is required" });
    const report = await reportChat(req.auth!.userId, { messageId, chatId, reason, description });
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Users available to chat with (for starting new chats)
// ─────────────────────────────────────────────────────────────

router.get("/users/available", async (req: Request, res: Response) => {
  try {
    const apartmentId = req.auth!.apartmentId;
    if (!apartmentId) return res.json([]);

    // Get all users in the same apartment (excluding self)
    const users = await prisma.user.findMany({
      where: {
        apartmentId,
        id: { not: req.auth!.userId },
      },
      select: {
        id: true,
        name: true,
        role: true,
        flatNumber: true,
        flatId: true,
      },
      orderBy: { name: "asc" },
    });

    // Get online statuses
    const userIds = users.map((u) => u.id);
    const statuses = await prisma.userOnlineStatus.findMany({
      where: { userId: { in: userIds } },
    });
    const statusMap = new Map(statuses.map((s) => [s.userId, s.isOnline]));

    const enriched = users.map((u) => ({
      ...u,
      isOnline: statusMap.get(u.id) || false,
    }));

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Quiet hours & mute/unmute
// ─────────────────────────────────────────────────────────────

router.post("/:chatId/mute", async (req: Request, res: Response) => {
  try {
    await prisma.chatParticipant.updateMany({
      where: { chatId: req.params.chatId, userId: req.auth!.userId },
      data: { isMuted: true },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:chatId/unmute", async (req: Request, res: Response) => {
  try {
    await prisma.chatParticipant.updateMany({
      where: { chatId: req.params.chatId, userId: req.auth!.userId },
      data: { isMuted: false },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:chatId/pin", async (req: Request, res: Response) => {
  try {
    await prisma.chatParticipant.updateMany({
      where: { chatId: req.params.chatId, userId: req.auth!.userId },
      data: { isPinned: true },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:chatId/unpin", async (req: Request, res: Response) => {
  try {
    await prisma.chatParticipant.updateMany({
      where: { chatId: req.params.chatId, userId: req.auth!.userId },
      data: { isPinned: false },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Admin: list all groups in apartment
// ─────────────────────────────────────────────────────────────

router.get("/admin/groups", async (req: Request, res: Response) => {
  try {
    if (req.auth!.role !== "apartment_admin" && req.auth!.role !== "super_admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    const groups = await prisma.chat.findMany({
      where: {
        apartmentId: req.auth!.apartmentId,
        type: { in: ["group", "event"] },
        isArchived: false,
      },
      include: {
        _count: { select: { participants: true, messages: true } },
        participants: {
          include: {
            user: { select: { id: true, name: true, flatNumber: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
