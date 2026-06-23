import { prisma } from "./prisma.js";
import type { ChatType, MessageType, Prisma } from "@prisma/client";

// ─────────────────────────────────────────────────────────────
//  Chat / Conversation helpers
// ─────────────────────────────────────────────────────────────

/** Resolve (or create) a direct (1:1) chat between two users. */
export async function resolveDirectChat(
  userIdA: string,
  userIdB: string,
  apartmentId: string,
) {
  // Look for a direct chat where both are participants
  const existing = await prisma.chat.findFirst({
    where: {
      type: "direct",
      apartmentId,
      participants: {
        every: { userId: { in: [userIdA, userIdB] } },
      },
    },
    include: {
      participants: { include: { user: { select: { id: true, name: true, role: true, flatNumber: true } } } },
    },
  });
  if (existing) return existing;

  // Create one
  return prisma.chat.create({
    data: {
      type: "direct",
      apartmentId,
      name: null, // derived from other participant
      participants: {
        createMany: {
          data: [{ userId: userIdA }, { userId: userIdB }],
        },
      },
    },
    include: {
      participants: { include: { user: { select: { id: true, name: true, role: true, flatNumber: true } } } },
    },
  });
}

/** Resolve (or create) a security chat for a flat resident. */
export async function resolveSecurityChat(
  userId: string,
  apartmentId: string,
) {
  // Find or create the apartment-wide security chat
  let chat = await prisma.chat.findFirst({
    where: {
      type: "security",
      apartmentId,
    },
    include: {
      participants: { include: { user: { select: { id: true, name: true, role: true } } } },
    },
  });

  if (!chat) {
    chat = await prisma.chat.create({
      data: {
        type: "security",
        apartmentId,
        name: "Security Desk",
        description: "Chat with security personnel about visitors, deliveries, and emergencies",
        participants: {
          create: { userId },
        },
      },
      include: {
        participants: { include: { user: { select: { id: true, name: true, role: true } } } },
      },
    });
  } else {
    // Ensure the user is a participant
    const already = await prisma.chatParticipant.findUnique({
      where: { chatId_userId: { chatId: chat.id, userId } },
    });
    if (!already) {
      await prisma.chatParticipant.create({
        data: { chatId: chat.id, userId },
      });
      chat = await prisma.chat.findUniqueOrThrow({
        where: { id: chat.id },
        include: {
          participants: { include: { user: { select: { id: true, name: true, role: true } } } },
        },
      });
    }
  }

  return chat;
}

/** Create the association broadcast channel (read-only for residents). */
export async function ensureBroadcastChannel(apartmentId: string) {
  let chat = await prisma.chat.findFirst({
    where: { type: "broadcast", apartmentId },
  });
  if (!chat) {
    chat = await prisma.chat.create({
      data: {
        type: "broadcast",
        apartmentId,
        name: "Association Announcements",
        description: "Official announcements from the Association. Residents can react but not reply.",
      },
    });
  }
  return chat;
}

/** Create a group chat */
export async function createGroupChat(data: {
  name: string;
  description?: string;
  apartmentId: string;
  createdBy: string;
  participantIds: string[];
}) {
  const chat = await prisma.chat.create({
    data: {
      type: "group",
      apartmentId: data.apartmentId,
      name: data.name,
      description: data.description || null,
      createdBy: data.createdBy,
      participants: {
        createMany: {
          data: data.participantIds.map((userId) => ({ userId })),
        },
      },
      admins: {
        create: { userId: data.createdBy },
      },
    },
    include: {
      participants: { include: { user: { select: { id: true, name: true, role: true, flatNumber: true } } } },
      admins: true,
    },
  });
  return chat;
}

/** Create an event group (auto-archived after event date). */
export async function createEventGroupChat(data: {
  name: string;
  description?: string;
  apartmentId: string;
  createdBy: string;
  eventDate: Date;
  participantIds: string[];
}) {
  const chat = await prisma.chat.create({
    data: {
      type: "event",
      apartmentId: data.apartmentId,
      name: data.name,
      description: data.description || null,
      createdBy: data.createdBy,
      eventDate: data.eventDate,
      participants: {
        createMany: {
          data: data.participantIds.map((userId) => ({ userId })),
        },
      },
      admins: {
        create: { userId: data.createdBy },
      },
    },
    include: {
      participants: { include: { user: { select: { id: true, name: true, role: true, flatNumber: true } } } },
      admins: true,
    },
  });
  return chat;
}

// ─────────────────────────────────────────────────────────────
//  Messaging
// ─────────────────────────────────────────────────────────────

export async function sendMessage(data: {
  chatId: string;
  senderId: string;
  senderName: string;
  type?: MessageType;
  body?: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaName?: string;
  mediaSize?: number;
  replyToId?: string;
  mentions?: string[];
}) {
  const msg = await prisma.message.create({
    data: {
      chatId: data.chatId,
      senderId: data.senderId,
      senderName: data.senderName,
      type: (data.type as MessageType) || "text",
      body: data.body || null,
      mediaUrl: data.mediaUrl || null,
      mediaType: data.mediaType || null,
      mediaName: data.mediaName || null,
      mediaSize: data.mediaSize || null,
      replyToId: data.replyToId || null,
      mentions: data.mentions || [],
    },
    include: {
      sender: { select: { id: true, name: true } },
      reactions: { include: { user: { select: { id: true, name: true } } } },
      readBy: { include: { user: { select: { id: true, name: true } } } },
      replyTo: { include: { sender: { select: { id: true, name: true } } } },
    },
  });

  // Update chat updatedAt
  await prisma.chat.update({
    where: { id: data.chatId },
    data: { updatedAt: new Date() },
  });

  return msg;
}

/** Get messages for a chat (paginated, newest first). */
export async function getMessages(
  chatId: string,
  opts: { limit?: number; before?: string; search?: string } = {},
) {
  const limit = opts.limit || 50;
  const where: Prisma.MessageWhereInput = { chatId };

  if (opts.before) {
    const cursor = await prisma.message.findUnique({ where: { id: opts.before } });
    if (cursor) {
      where.createdAt = { lt: cursor.createdAt };
    }
  }

  if (opts.search) {
    where.body = { contains: opts.search, mode: "insensitive" };
  }

  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    include: {
      sender: { select: { id: true, name: true } },
      reactions: { include: { user: { select: { id: true, name: true } } } },
      readBy: { include: { user: { select: { id: true, name: true } } } },
      replyTo: { include: { sender: { select: { id: true, name: true } } } },
    },
  });

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  return { messages, hasMore };
}

/** Mark messages as read for a user in a chat. Returns count of newly marked. */
export async function markChatAsRead(chatId: string, userId: string) {
  // Update participant's lastReadAt
  await prisma.chatParticipant.updateMany({
    where: { chatId, userId },
    data: { lastReadAt: new Date() },
  });

  // Create read receipts for all unread messages
  const unreadMessages = await prisma.message.findMany({
    where: {
      chatId,
      senderId: { not: userId },
      readBy: { none: { userId } },
    },
    select: { id: true },
  });

  if (unreadMessages.length === 0) return 0;

  await prisma.messageReadReceipt.createMany({
    data: unreadMessages.map((m) => ({ messageId: m.id, userId })),
    skipDuplicates: true,
  });

  return unreadMessages.length;
}

/** Get unread count per chat for a user. */
export async function getUnreadCounts(userId: string) {
  // All chats the user is in
  const participants = await prisma.chatParticipant.findMany({
    where: { userId, leftAt: null },
    select: {
      chatId: true,
      lastReadAt: true,
    },
  });

  const counts: Record<string, number> = {};

  for (const p of participants) {
    const count = await prisma.message.count({
      where: {
        chatId: p.chatId,
        senderId: { not: userId },
        createdAt: { gt: p.lastReadAt || new Date(0) },
        readBy: { none: { userId } },
      },
    });
    if (count > 0) counts[p.chatId] = count;
  }

  return counts;
}

/** Get all chats for a user (for the chat list). */
export async function getUserChats(userId: string, apartmentId?: string) {
  const participantRows = await prisma.chatParticipant.findMany({
    where: { userId, leftAt: null },
    include: {
      chat: {
        include: {
          participants: {
            include: {
              user: {
                select: { id: true, name: true, role: true, flatNumber: true },
              },
            },
          },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              sender: { select: { id: true, name: true } },
            },
          },
          admins: { select: { userId: true } },
        },
      },
    },
    orderBy: { chat: { updatedAt: "desc" } },
  });

  const chats = participantRows
    .filter((p) => !p.chat.isArchived)
    .map((p) => ({
      ...p.chat,
      isPinned: p.isPinned,
      isMuted: p.isMuted,
      lastReadAt: p.lastReadAt,
      lastMessage: p.chat.messages[0] || null,
      adminIds: p.chat.admins.map((a) => a.userId),
    }));

  return chats;
}

/** Add reaction to a message */
export async function addReaction(messageId: string, userId: string, emoji: string) {
  return prisma.messageReaction.upsert({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
    update: {},
    create: { messageId, userId, emoji },
    include: { user: { select: { id: true, name: true } } },
  });
}

/** Remove reaction */
export async function removeReaction(messageId: string, userId: string, emoji: string) {
  return prisma.messageReaction.deleteMany({
    where: { messageId, userId, emoji },
  });
}

// ─────────────────────────────────────────────────────────────
//  Privacy & security
// ─────────────────────────────────────────────────────────────

export async function blockUser(blockerId: string, blockedId: string) {
  return prisma.userBlock.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    update: {},
    create: { blockerId, blockedId },
  });
}

export async function unblockUser(blockerId: string, blockedId: string) {
  return prisma.userBlock.deleteMany({
    where: { blockerId, blockedId },
  });
}

export async function getBlockedUsers(userId: string) {
  const blocks = await prisma.userBlock.findMany({
    where: { blockerId: userId },
    include: {
      blocked: { select: { id: true, name: true, role: true, flatNumber: true } },
    },
  });
  return blocks.map((b) => b.blocked);
}

export async function reportChat(
  reporterId: string,
  data: { messageId?: string; chatId?: string; reason: string; description?: string },
) {
  return prisma.chatReport.create({
    data: {
      reporterId,
      messageId: data.messageId || null,
      chatId: data.chatId || null,
      reason: data.reason,
      description: data.description || null,
    },
  });
}

/** Update user privacy settings */
export async function updatePrivacy(userId: string, data: {
  allowAll?: boolean;
  allowResidentsOnly?: boolean;
  allowCommitteeOnly?: boolean;
  lastSeenVisible?: boolean;
  onlineStatusVisible?: boolean;
  readReceiptsEnabled?: boolean;
}) {
  return prisma.userPrivacy.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

export async function getPrivacy(userId: string) {
  return prisma.userPrivacy.findUnique({ where: { userId } });
}

// ─────────────────────────────────────────────────────────────
//  Online / Offline status
// ─────────────────────────────────────────────────────────────

export async function setUserOnline(userId: string) {
  return prisma.userOnlineStatus.upsert({
    where: { userId },
    update: { isOnline: true, updatedAt: new Date() },
    create: { userId, isOnline: true },
  });
}

export async function setUserOffline(userId: string) {
  return prisma.userOnlineStatus.upsert({
    where: { userId },
    update: { isOnline: false, lastSeen: new Date(), updatedAt: new Date() },
    create: { userId, isOnline: false },
  });
}

export async function getOnlineStatus(userId: string) {
  return prisma.userOnlineStatus.findUnique({ where: { userId } });
}

export async function getOnlineStatusesForUsers(userIds: string[]) {
  const statuses = await prisma.userOnlineStatus.findMany({
    where: { userId: { in: userIds } },
  });
  return statuses;
}

/** Get the number of participants in a chat who can receive messages */
export async function getChatParticipantCount(chatId: string) {
  return prisma.chatParticipant.count({
    where: { chatId, leftAt: null },
  });
}

/** Archive expired event groups */
export async function archiveExpiredEventGroups() {
  const now = new Date();
  const expired = await prisma.chat.findMany({
    where: {
      type: "event",
      isArchived: false,
      eventDate: { lt: now },
    },
    select: { id: true },
  });

  if (expired.length === 0) return 0;

  await prisma.chat.updateMany({
    where: { id: { in: expired.map((e) => e.id) } },
    data: { isArchived: true, archivedAt: now },
  });

  return expired.length;
}
