import "dotenv/config";
import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { verifyToken, type JwtPayload } from "./lib/jwt.js";
import {
  setUserOnline,
  setUserOffline,
  sendMessage,
  markChatAsRead,
  getUnreadCounts,
  addReaction,
  removeReaction,
  getUserChats,
  getOnlineStatusesForUsers,
} from "./lib/chat.js";
import { prisma } from "./lib/prisma.js";
import { notifyUserPush, notifyApartmentRolePush } from "./lib/notify-push.js";

// ─────────────────────────────────────────────────────────────
//  Socket.IO Server Setup
// ─────────────────────────────────────────────────────────────

interface AuthenticatedSocket extends Socket {
  auth?: JwtPayload;
}

const onlineUsers = new Map<string, Set<string>>(); // userId -> Set<socketId>

let io: Server | null = null;

export function getIO(): Server {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
}

export function initializeSocketIO(server: HttpServer) {
  io = new Server(server, {
    path: "/socket.io",
    cors: {
      origin: (process.env.FRONTEND_ORIGIN || "*").split(",").map((o) => o.trim()),
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }
    const payload = verifyToken(token as string);
    if (!payload) {
      return next(new Error("Invalid or expired token"));
    }
    (socket as AuthenticatedSocket).auth = payload;
    next();
  });

  const srv = io; // local ref for type narrowing
  srv.on("connection", async (socket: Socket) => {
    const authed = socket as AuthenticatedSocket;
    const auth = authed.auth!;
    const userId = auth.userId;

    console.log(`[socket.io] User connected: ${userId} (${auth.role})`);

    // Track online status
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId)!.add(socket.id);

    // Set DB online status
    await setUserOnline(userId);

    // Join user's personal room
    socket.join(`user:${userId}`);

    // Join apartment room
    if (auth.apartmentId) {
      socket.join(`apartment:${auth.apartmentId}`);
    }

    // Join role-specific room
    if (auth.role === "security") {
      socket.join(`role:security:${auth.apartmentId}`);
    }
    if (auth.role === "apartment_admin" || auth.role === "super_admin") {
      socket.join(`role:admin:${auth.apartmentId}`);
    }

    // Broadcast online status
    srv.emit("user:online", { userId, isOnline: true });

    // ─────────────────────────────────────────────────────────
    //  Event Handlers
    // ─────────────────────────────────────────────────────────

    socket.on("chat:join", async (chatId: string) => {
      // Verify user is a participant
      const participant = await prisma.chatParticipant.findUnique({
        where: { chatId_userId: { chatId, userId } },
      });
      if (participant && !participant.leftAt) {
        socket.join(`chat:${chatId}`);
        console.log(`[socket.io] User ${userId} joined chat room chat:${chatId}`);
      }
    });

    socket.on("chat:leave", (chatId: string) => {
      socket.leave(`chat:${chatId}`);
    });

    socket.on("message:send", async (data: {
      chatId: string;
      type?: string;
      body?: string;
      mediaUrl?: string;
      mediaType?: string;
      mediaName?: string;
      mediaSize?: number;
      replyToId?: string;
      mentions?: string[];
    }, callback) => {
      try {
        // Verify participant
        const participant = await prisma.chatParticipant.findUnique({
          where: { chatId_userId: { chatId: data.chatId, userId } },
          include: { chat: true },
        });
        if (!participant || participant.leftAt) {
          return callback?.({ error: "Not a participant in this chat" });
        }

        // Check broadcast - only admins can send
        if (participant.chat.type === "broadcast") {
          const isAdmin = auth.role === "apartment_admin" || auth.role === "super_admin";
          if (!isAdmin) {
            return callback?.({ error: "Only admins can send to broadcast channel" });
          }
        }

        const msg = await sendMessage({
          chatId: data.chatId,
          senderId: userId,
          senderName: auth.name || "Unknown",
          type: data.type as any || "text",
          body: data.body,
          mediaUrl: data.mediaUrl,
          mediaType: data.mediaType,
          mediaName: data.mediaName,
          mediaSize: data.mediaSize,
          replyToId: data.replyToId,
          mentions: data.mentions,
        });

        // Emit to all in the chat room (including sender)
        srv.to(`chat:${data.chatId}`).emit("message:new", msg);

        // Send push notifications to other participants
        const otherParticipants = await prisma.chatParticipant.findMany({
          where: {
            chatId: data.chatId,
            userId: { not: userId },
            leftAt: null,
          },
          select: { userId: true },
        });
        const chatName = participant.chat.name || "Chat";
        for (const p of otherParticipants) {
          await notifyUserPush(p.userId, {
            title: chatName,
            body: msg.body || `Sent a ${msg.type}`,
            data: { chatId: data.chatId, messageId: msg.id, tag: `msg-${data.chatId}` },
            clickAction: `/messages/${data.chatId}`,
          });
        }

        // Handle @mentions
        if (data.mentions && data.mentions.length > 0) {
          for (const mentionedId of data.mentions) {
            await notifyUserPush(mentionedId, {
              title: `Mentioned in ${chatName}`,
              body: `${auth.name} mentioned you: ${(msg.body || "").slice(0, 100)}`,
              data: { chatId: data.chatId, messageId: msg.id, tag: `mention-${data.chatId}` },
              clickAction: `/messages/${data.chatId}`,
            });
          }
        }

        callback?.({ ok: true, message: msg });
      } catch (err: any) {
        console.error("[socket.io] message:send error", err);
        callback?.({ error: err.message });
      }
    });

    socket.on("message:read", async (data: { chatId: string }, callback) => {
      try {
        const count = await markChatAsRead(data.chatId, userId);
        if (count > 0) {
          // Notify the chat room that user has read messages
          srv.to(`chat:${data.chatId}`).emit("message:read", {
            chatId: data.chatId,
            userId,
            readCount: count,
          });
        }
        // Get updated unread counts
        const unread = await getUnreadCounts(userId);
        socket.emit("unread:update", unread);
        callback?.({ ok: true, readCount: count, unread });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on("message:react", async (data: { chatId: string; messageId: string; emoji: string }, callback) => {
      try {
        await addReaction(data.messageId, userId, data.emoji);
        if (data.chatId) {
          srv.to(`chat:${data.chatId}`).emit("message:reaction", {
            messageId: data.messageId,
            userId,
            emoji: data.emoji,
            action: "added",
          });
        }
        callback?.({ ok: true });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on("message:unreact", async (data: { chatId: string; messageId: string; emoji: string }, callback) => {
      try {
        await removeReaction(data.messageId, userId, data.emoji);
        if (data.chatId) {
          srv.to(`chat:${data.chatId}`).emit("message:reaction", {
            messageId: data.messageId,
            userId,
            emoji: data.emoji,
            action: "removed",
          });
        }
        callback?.({ ok: true });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on("typing:start", (data: { chatId: string }) => {
      socket.to(`chat:${data.chatId}`).emit("typing:update", {
        chatId: data.chatId,
        userId,
        userName: auth.name,
        isTyping: true,
      });
    });

    socket.on("typing:stop", (data: { chatId: string }) => {
      socket.to(`chat:${data.chatId}`).emit("typing:update", {
        chatId: data.chatId,
        userId,
        userName: auth.name,
        isTyping: false,
      });
    });

    socket.on("user:online:fetch", async (data: { userIds: string[] }, callback) => {
      try {
        const statuses = await getOnlineStatusesForUsers(data.userIds);
        callback?.({ statuses });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on("chats:list", async (callback) => {
      try {
        const chats = await getUserChats(userId, auth.apartmentId || undefined);
        const unread = await getUnreadCounts(userId);
        callback?.({ chats, unread });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on("disconnect", async () => {
      console.log(`[socket.io] User disconnected: ${userId}`);

      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          await setUserOffline(userId);
          srv.emit("user:offline", { userId, lastSeen: new Date().toISOString() });
        }
      }
    });
  });

  console.log("[socket.io] Socket.IO server initialized on path /socket.io");
  return io;
}

// ─────────────────────────────────────────────────────────────
//  Server-sent events (for push from REST handlers)
// ─────────────────────────────────────────────────────────────

export function emitToUser(userId: string, event: string, data: any) {
  const srv = io;
  if (!srv) return;
  srv.to(`user:${userId}`).emit(event, data);
}

export function emitToChat(chatId: string, event: string, data: any) {
  const srv = io;
  if (!srv) return;
  srv.to(`chat:${chatId}`).emit(event, data);
}

export function emitToApartment(apartmentId: string, event: string, data: any) {
  const srv = io;
  if (!srv) return;
  srv.to(`apartment:${apartmentId}`).emit(event, data);
}

export function emitToRole(role: string, apartmentId: string | null, event: string, data: any) {
  const srv = io;
  if (!srv) return;
  if (apartmentId) {
    srv.to(`role:${role}:${apartmentId}`).emit(event, data);
  } else {
    srv.emit(event, data);
  }
}

export function isUserOnline(userId: string): boolean {
  return onlineUsers.has(userId) && onlineUsers.get(userId)!.size > 0;
}
