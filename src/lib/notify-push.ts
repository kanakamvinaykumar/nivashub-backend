import { prisma } from "./prisma.js";
import { sendPushNotification, sendMulticastPushNotification, type FcmPayload } from "./fcm.js";

/**
 * Send a push notification to all devices belonging to a specific user.
 */
export async function notifyUserPush(
  userId: string,
  payload: FcmPayload,
): Promise<number> {
  const tokens = await prisma.fcmToken.findMany({
    where: { userId },
    select: { token: true },
  });

  if (tokens.length === 0) {
    console.log(`[push] notifyUserPush(userId=${userId}): no FCM tokens found, payload="${payload.title}"`);
    return 0;
  }

  const tokenStrings = tokens.map((t) => t.token);
  console.log(`[push] notifyUserPush(userId=${userId}): sending to ${tokens.length} tokens`);
  const sent = await sendMulticastPushNotification(tokenStrings, payload);
  console.log(`[push] notifyUserPush(userId=${userId}): ${sent}/${tokens.length} delivered`);
  return sent;
}

/**
 * Send a push notification to all flat_admin users who own a specific flat.
 */
export async function notifyFlatOwnersPush(
  flatId: string,
  payload: FcmPayload,
): Promise<number> {
  const owners = await prisma.flatOwner.findMany({
    where: { flatId },
    select: { userId: true },
  });

  const userIds = owners.map((o) => o.userId);
  if (userIds.length === 0) {
    console.log(`[push] notifyFlatOwnersPush(flatId=${flatId}): no flat owners found`);
    return 0;
  }

  const tokens = await prisma.fcmToken.findMany({
    where: { userId: { in: userIds } },
    select: { token: true },
  });

  if (tokens.length === 0) {
    console.log(`[push] notifyFlatOwnersPush(flatId=${flatId}): ${userIds.length} owners but 0 FCM tokens found`);
    return 0;
  }

  console.log(`[push] notifyFlatOwnersPush(flatId=${flatId}): sending to ${tokens.length} tokens`);
  const sent = await sendMulticastPushNotification(
    tokens.map((t) => t.token),
    payload,
  );
  console.log(`[push] notifyFlatOwnersPush(flatId=${flatId}): ${sent}/${tokens.length} delivered`);
  return sent;
}

/**
 * Send a push notification to all users in an apartment with a specific role.
 */
export async function notifyApartmentRolePush(
  apartmentId: string,
  role: string | string[],
  payload: FcmPayload,
): Promise<number> {
  const roles = Array.isArray(role) ? role : [role];

  const tokens = await prisma.fcmToken.findMany({
    where: {
      user: {
        apartmentId,
        role: { in: roles as any },
      },
    },
    select: { token: true },
  });

  if (tokens.length === 0) {
    console.log(`[push] notifyApartmentRolePush(apartmentId=${apartmentId}, role=${roles}): no FCM tokens found`);
    return 0;
  }

  console.log(`[push] notifyApartmentRolePush(apartmentId=${apartmentId}, role=${roles}): sending to ${tokens.length} tokens`);
  const sent = await sendMulticastPushNotification(
    tokens.map((t) => t.token),
    payload,
  );
  console.log(`[push] notifyApartmentRolePush(apartmentId=${apartmentId}, role=${roles}): ${sent}/${tokens.length} delivered`);
  return sent;
}
