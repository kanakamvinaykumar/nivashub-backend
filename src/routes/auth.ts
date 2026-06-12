import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../lib/jwt.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const LoginSchema = z.object({
  apartmentCode: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
});

const UpdateAccountSchema = z
  .object({
    name: z.string().min(1).optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(6).optional(),
  })
  .refine(
    (data) => !(data.newPassword && !data.currentPassword),
    {
      message: "Current password is required to change your password",
      path: ["currentPassword"],
    },
  );

router.post("/login", async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { apartmentCode, email, password } = parsed.data;
  const codeUpper = apartmentCode.trim().toUpperCase();

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }

  const apartment = user.apartmentId
    ? await prisma.apartment.findUnique({ where: { id: user.apartmentId }, select: { logoUrl: true } })
    : null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }

  if (user.role === "super_admin") {
    if (codeUpper !== "SUPER" && codeUpper !== "NIVASHUB") {
      res.status(401).json({ message: "Super admin must use code SUPER or NIVASHUB" });
      return;
    }
  } else {
    const apartment = await prisma.apartment.findUnique({ where: { code: codeUpper } });
    if (!apartment || apartment.id !== user.apartmentId) {
      res.status(401).json({ message: "Apartment code does not match user" });
      return;
    }
    // A super admin can suspend an apartment to lock both its admin and
    // every flat owner out of the platform immediately.
    if (apartment.status === "suspended") {
      res.status(403).json({
        message:
          "This apartment has been deactivated by NivasHub. Please contact your administrator.",
        suspended: true,
      });
      return;
    }
  }

  if (user.flatId) {
    const flat = await prisma.flat.findUnique({
      where: { id: user.flatId },
      select: { accountActive: true },
    });
    if (!flat || !flat.accountActive) {
      res.status(401).json({
        message: "Your account has been suspended. Please contact your Association for assistance.",
        suspended: true,
      });
      return;
    }
  }

  // Fetch committee role if assigned
  const committee = user.committeePosition && user.committeeApartmentId
    ? await prisma.committeeMember.findUnique({
        where: { userId: user.id },
        select: { position: true, apartmentId: true },
      })
    : null;

  const token = signToken({
    userId: user.id,
    role: user.role,
    apartmentId: user.apartmentId,
    flatId: user.flatId,
    tokenVersion: user.tokenVersion ?? 0,
    committeePosition: committee?.position ?? null,
    committeeApartmentId: committee?.apartmentId ?? null,
  });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      apartmentId: user.apartmentId,
      apartmentName: user.apartmentName,
      apartmentLogoUrl: apartment?.logoUrl ?? null,
      flatId: user.flatId,
      flatNumber: user.flatNumber,
      committeePosition: committee?.position ?? null,
      committeeApartmentId: committee?.apartmentId ?? null,
      mustChangePassword: user.mustChangePassword,
    },
  });
});

router.post("/logout", (_req, res) => {
  // JWT is stateless — client just discards token. Endpoint kept for API parity.
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const apartment = user.apartmentId
    ? await prisma.apartment.findUnique({ where: { id: user.apartmentId }, select: { logoUrl: true } })
    : null;

  // Fetch committee role if assigned
  const committee = user.committeePosition && user.committeeApartmentId
    ? await prisma.committeeMember.findUnique({
        where: { userId: user.id },
        select: { position: true, apartmentId: true },
      })
    : null;

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    apartmentId: user.apartmentId,
    apartmentName: user.apartmentName,
    apartmentLogoUrl: apartment?.logoUrl ?? null,
    flatId: user.flatId,
    flatNumber: user.flatNumber,
    committeePosition: committee?.position ?? null,
    committeeApartmentId: committee?.apartmentId ?? null,
    mustChangePassword: user.mustChangePassword,
  });
});

router.patch("/me", requireAuth, async (req, res) => {
  const parsed = UpdateAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const updateData: { name?: string; passwordHash?: string; mustChangePassword?: boolean } = {};
  if (parsed.data.name && parsed.data.name !== user.name) {
    updateData.name = parsed.data.name;
  }

  if (parsed.data.newPassword) {
    const passwordMatch = await bcrypt.compare(parsed.data.currentPassword!, user.passwordHash);
    if (!passwordMatch) {
      res.status(401).json({ message: "Current password is incorrect" });
      return;
    }
    updateData.passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
    updateData.mustChangePassword = false;
  }

  const updatedUser = updateData.name || updateData.passwordHash
    ? await prisma.user.update({ where: { id: user.id }, data: updateData })
    : user;

  res.json({
    id: updatedUser.id,
    email: updatedUser.email,
    name: updatedUser.name,
    role: updatedUser.role,
    apartmentId: updatedUser.apartmentId,
    apartmentName: updatedUser.apartmentName,
    flatId: updatedUser.flatId,
    flatNumber: updatedUser.flatNumber,
  });
});

// ---------- Multi-flat support ----------

/**
 * GET /auth/my-flats — returns all flats the current user owns via FlatOwner,
 * plus their current active context (which flat they're "in", and committee info).
 * Used by the dashboard-selection page to show all available dashboards.
 */
router.get("/my-flats", requireAuth, async (req, res) => {
  const userId = req.auth!.userId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      apartmentId: true,
      apartmentName: true,
      flatId: true,
      flatNumber: true,
      committeePosition: true,
      committeeApartmentId: true,
    },
  });

  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  // Fetch all flats linked via FlatOwner
  const ownedFlats = await prisma.flatOwner.findMany({
    where: { userId },
    include: {
      flat: {
        select: {
          id: true,
          block: true,
          number: true,
          ownerName: true,
          status: true,
          apartmentId: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const flats = ownedFlats.map((fo) => ({
    id: fo.flat.id,
    block: fo.flat.block,
    number: fo.flat.number,
    ownerName: fo.flat.ownerName,
    status: fo.flat.status,
    apartmentId: fo.flat.apartmentId,
    isActive: fo.flat.id === user.flatId,
  }));

  // Also include the committee context if user is a committee member
  const committeeContext =
    user.committeePosition && user.committeeApartmentId
      ? {
          position: user.committeePosition,
          apartmentId: user.committeeApartmentId,
        }
      : null;

  res.json({
    flats,
    committeeContext,
    activeContext: {
      flatId: user.flatId,
      flatNumber: user.flatNumber,
      apartmentId: user.apartmentId,
      apartmentName: user.apartmentName,
    },
  });
});

/**
 * POST /auth/switch-flat — switches the user's active flat context.
 * Updates User.flatId / User.flatNumber and reissues a JWT.
 * Body: { flatId: string }
 */
const SwitchFlatSchema = z.object({
  flatId: z.string().min(1),
});

router.post("/switch-flat", requireAuth, async (req, res) => {
  const parsed = SwitchFlatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const userId = req.auth!.userId;
  const { flatId } = parsed.data;

  // Verify user owns this flat
  const ownership = await prisma.flatOwner.findUnique({
    where: { userId_flatId: { userId, flatId } },
    include: {
      flat: {
        select: { id: true, number: true, apartmentId: true, apartment: { select: { name: true, logoUrl: true } } },
      },
    },
  });

  if (!ownership) {
    res.status(403).json({ message: "You do not own this flat" });
    return;
  }

  const flat = ownership.flat;

  // Update user's active flat context
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      flatId: flat.id,
      flatNumber: flat.number,
      apartmentId: flat.apartmentId,
      apartmentName: flat.apartment.name,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      apartmentId: true,
      apartmentName: true,
      flatId: true,
      flatNumber: true,
      committeePosition: true,
      committeeApartmentId: true,
      tokenVersion: true,
    },
  });

  const committee = updatedUser.committeePosition && updatedUser.committeeApartmentId
    ? await prisma.committeeMember.findUnique({
        where: { userId: updatedUser.id },
        select: { position: true, apartmentId: true },
      })
    : null;

  const token = signToken({
    userId: updatedUser.id,
    role: updatedUser.role,
    apartmentId: updatedUser.apartmentId,
    flatId: updatedUser.flatId,
    tokenVersion: updatedUser.tokenVersion,
    committeePosition: committee?.position ?? null,
    committeeApartmentId: committee?.apartmentId ?? null,
  });

  const apartment = updatedUser.apartmentId
    ? await prisma.apartment.findUnique({
        where: { id: updatedUser.apartmentId },
        select: { logoUrl: true },
      })
    : null;

  res.json({
    token,
    user: {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      role: updatedUser.role,
      apartmentId: updatedUser.apartmentId,
      apartmentName: updatedUser.apartmentName,
      apartmentLogoUrl: apartment?.logoUrl ?? null,
      flatId: updatedUser.flatId,
      flatNumber: updatedUser.flatNumber,
      committeePosition: committee?.position ?? null,
      committeeApartmentId: committee?.apartmentId ?? null,
      mustChangePassword: false,
    },
  });
});

export default router;
