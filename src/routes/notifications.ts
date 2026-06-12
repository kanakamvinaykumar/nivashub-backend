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

export default router;
