import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const RegisterTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["web", "android", "ios"]).optional().default("web"),
});

const UnregisterTokenSchema = z.object({
  token: z.string().min(1),
});

/**
 * POST /notifications/register — Register an FCM push token for the current user.
 * If the token already exists for this user, it's a no-op. If the token exists
 * for a different user, it's re-assigned (user logged out on device, another logged in).
 */
router.post("/register", requireAuth, async (req, res) => {
  const parsed = RegisterTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const { token, platform } = parsed.data;
  const userId = req.auth!.userId;

  // Check if this token already belongs to this user
  const existing = await prisma.fcmToken.findUnique({ where: { token } });

  if (existing) {
    if (existing.userId === userId) {
      // Token already registered — update platform if needed
      if (existing.platform !== platform) {
        await prisma.fcmToken.update({
          where: { id: existing.id },
          data: { platform },
        });
      }
      res.json({ ok: true, alreadyRegistered: true });
      return;
    }

    // Token belongs to a different user — reassign
    await prisma.fcmToken.update({
      where: { id: existing.id },
      data: { userId, platform },
    });
    res.json({ ok: true, reassigned: true });
    return;
  }

  // Create new token
  await prisma.fcmToken.create({
    data: { userId, token, platform },
  });

  res.json({ ok: true });
});

/**
 * POST /notifications/unregister — Remove an FCM push token.
 */
router.post("/unregister", requireAuth, async (req, res) => {
  const parsed = UnregisterTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const { token } = parsed.data;

  try {
    await prisma.fcmToken.delete({ where: { token } });
  } catch {
    // Token may not exist — that's fine
  }

  res.json({ ok: true });
});

/**
 * GET /notifications/tokens — List all registered tokens for the current user.
 */
router.get("/tokens", requireAuth, async (req, res) => {
  const tokens = await prisma.fcmToken.findMany({
    where: { userId: req.auth!.userId },
    select: { id: true, platform: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  res.json(tokens);
});

/**
 * POST /notifications/test-welcome — Send a test welcome push to the current user.
 * Used to verify FCM push notifications are working end-to-end.
 */
router.post("/test-welcome", requireAuth, async (req, res) => {
  const { sendPushNotification } = await import("../lib/fcm.js");

  const tokens = await prisma.fcmToken.findMany({
    where: { userId: req.auth!.userId },
    select: { token: true },
  });

  if (tokens.length === 0) {
    res.status(400).json({ message: "No FCM tokens registered for this user." });
    return;
  }

  const results = await Promise.allSettled(
    tokens.map((t) =>
      sendPushNotification(t.token, {
        title: "Welcome to NivasHub 🎉",
        body: "Your push notifications are working! You'll now receive real-time updates.",
        icon: "/nivashub-logo.svg",
        clickAction: "/",
        data: { tag: "welcome-test" },
      }),
    ),
  );

  const sent = results.filter((r) => r.status === "fulfilled" && r.value).length;
  const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value)).length;

  console.log(`[test-welcome] userId=${req.auth!.userId}: ${sent} sent, ${failed} failed`);

  res.json({ ok: true, sent, failed, total: tokens.length });
});

// ---------------------------------------------------------------------------
// In-app notification endpoints
// ---------------------------------------------------------------------------

/**
 * GET /notifications/list — List all notifications for the current user.
 * Supports ?limit=50&offset=0&unreadOnly=true
 */
router.get("/list", requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  const unreadOnly = req.query.unreadOnly === "true";

  const where: any = { userId };
  if (unreadOnly) {
    where.isRead = false;
  }

  const [notifications, totalCount, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  res.json({
    notifications,
    totalCount,
    unreadCount,
  });
});

/**
 * PATCH /notifications/:id/read — Mark a single notification as read.
 */
router.patch("/:id/read", requireAuth, async (req, res) => {
  const userId = req.auth!.userId;

  const notification = await prisma.notification.findUnique({
    where: { id: req.params.id },
    select: { userId: true },
  });

  if (!notification) {
    res.status(404).json({ message: "Notification not found" });
    return;
  }

  if (notification.userId !== userId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  await prisma.notification.update({
    where: { id: req.params.id },
    data: { isRead: true },
  });

  res.json({ ok: true });
});

/**
 * POST /notifications/read-all — Mark all notifications as read for the current user.
 */
router.post("/read-all", requireAuth, async (req, res) => {
  const userId = req.auth!.userId;

  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });

  res.json({ ok: true, updated: result.count });
});

/**
 * GET /notifications/unread-count — Get the unread notification count for the current user.
 */
router.get("/unread-count", requireAuth, async (req, res) => {
  const count = await prisma.notification.count({
    where: { userId: req.auth!.userId, isRead: false },
  });

  res.json({ count });
});

export default router;
