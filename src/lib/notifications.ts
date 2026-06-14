import { prisma } from "./prisma.js";
import type { NotificationType } from "@prisma/client";

interface CreateNotificationInput {
  userId: string;
  apartmentId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  link?: string | null;
}

/**
 * Create an in-app notification for a user.
 * Also pushes an FCM push notification if the user has registered devices.
 */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: input.userId,
      apartmentId: input.apartmentId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
    },
  });

  // Also fire push notification asynchronously
  try {
    const { notifyUserPush } = await import("./notify-push.js");
    await notifyUserPush(input.userId, {
      title: input.title,
      body: input.body,
      clickAction: input.link ?? "/",
      icon: "/nivashub-logo.svg",
    });
  } catch {
    // Push failure shouldn't block the notification creation
  }
}

/**
 * Create a notification for all flat_admin users who own a specific flat.
 */
export async function notifyFlatOwners(
  flatId: string,
  apartmentId: string | null | undefined,
  type: NotificationType,
  title: string,
  body: string,
  link?: string | null,
): Promise<void> {
  const owners = await prisma.flatOwner.findMany({
    where: { flatId },
    select: { userId: true },
  });

  for (const owner of owners) {
    await createNotification({
      userId: owner.userId,
      apartmentId,
      type,
      title,
      body,
      link,
    });
  }
}

/**
 * Create a notification for all apartment_admin users in a given apartment.
 */
export async function notifyApartmentAdmins(
  apartmentId: string,
  type: NotificationType,
  title: string,
  body: string,
  link?: string | null,
): Promise<void> {
  const admins = await prisma.user.findMany({
    where: {
      apartmentId,
      role: "apartment_admin",
    },
    select: { id: true },
  });

  for (const admin of admins) {
    await createNotification({
      userId: admin.id,
      apartmentId,
      type,
      title,
      body,
      link,
    });
  }
}

/**
 * Create a notification for all flat_admin users in an apartment
 * (e.g. for announcements).
 */
export async function notifyAllFlatAdmins(
  apartmentId: string,
  type: NotificationType,
  title: string,
  body: string,
  link?: string | null,
): Promise<void> {
  const flatAdmins = await prisma.user.findMany({
    where: {
      apartmentId,
      role: "flat_admin",
    },
    select: { id: true },
  });

  for (const admin of flatAdmins) {
    await createNotification({
      userId: admin.id,
      apartmentId,
      type,
      title,
      body,
      link,
    });
  }
}
