import type { IncomingMessage, Server as HttpServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyToken, type JwtPayload } from "./lib/jwt.js";
import { prisma } from "./lib/prisma.js";

type SocketWithAuth = WebSocket & { auth?: JwtPayload };

const clients = new Set<SocketWithAuth>();

function send(client: SocketWithAuth, payload: unknown) {
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify(payload));
  }
}

function broadcast(predicate: (auth: JwtPayload) => boolean, payload: unknown) {
  for (const client of clients) {
    if (!client.auth) continue;
    if (predicate(client.auth)) {
      send(client, payload);
    }
  }
}

export interface VisitorPassNotificationData {
  id: string;
  apartmentId: string;
  flatId: string;
  flatNumber: string;
  guestName: string;
  type: "guest" | "contractor" | "delivery";
  status: "active" | "used" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
}

export type VisitorPassNotification =
  | { event: "visitor_pass.created"; data: VisitorPassNotificationData }
  | { event: "visitor_pass.updated"; data: VisitorPassNotificationData };

export interface PaymentNotificationData {
  id: string;
  reference: string;
  apartmentId: string;
  flatId: string;
  flatNumber: string;
  blockName: string;
  paidByName: string;
  amountInr: number;
  status: "pending_verification" | "approved" | "rejected";
  submittedAt: string;
}

export type PaymentNotification =
  | { event: "payment.submitted"; data: PaymentNotificationData }
  | { event: "payment.approved"; data: PaymentNotificationData }
  | { event: "payment.rejected"; data: PaymentNotificationData };

export interface AnnouncementNotificationData {
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
  createdAt: string;
}

export type AnnouncementNotification =
  | { event: "announcement.created"; data: AnnouncementNotificationData }
  | { event: "announcement.updated"; data: AnnouncementNotificationData }
  | { event: "announcement.deleted"; data: { id: string; apartmentId: string } };

export interface AnnouncementCommentNotificationData {
  id: string;
  announcementId: string;
  apartmentId: string;
  userId: string | null;
  userName: string;
  userRole: "flat_admin" | "apartment_admin" | "super_admin" | "security";
  body: string;
  createdAt: string;
}

export type AnnouncementCommentNotification =
  | { event: "announcement.comment.created"; data: AnnouncementCommentNotificationData };

export interface ComplaintMessageNotificationData {
  complaintId: string;
  apartmentId: string;
  flatId: string;
  title: string;
  senderName: string;
  senderRole: "flat_admin" | "apartment_admin" | "super_admin";
  preview: string;
  createdAt: string;
}

export type ComplaintMessageNotification =
  | { event: "complaint.message"; data: ComplaintMessageNotificationData };

export interface ComplaintCreatedNotificationData {
  complaintId: string;
  apartmentId: string;
  flatId: string;
  flatNumber: string;
  blockName: string;
  title: string;
  category: string;
  priority: string;
  raisedByName: string;
  createdAt: string;
}

export type ComplaintCreatedNotification =
  | { event: "complaint.created"; data: ComplaintCreatedNotificationData };

export type PaymentNotificationEvent =
  | { event: "payment.submitted"; data: PaymentNotificationData }
  | { event: "payment.approved"; data: PaymentNotificationData }
  | { event: "payment.rejected"; data: PaymentNotificationData };

export type NotificationEvent =
  | VisitorPassNotification
  | PaymentNotification
  | AnnouncementNotification
  | AnnouncementCommentNotification
  | ComplaintMessageNotification
  | ComplaintCreatedNotification;

export function registerWebSocketServer(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");
    const payload = token ? verifyToken(token) : null;

    if (!payload) {
      socket.close(1008, "Invalid or missing token");
      return;
    }

    if (payload.role !== "super_admin" && payload.apartmentId) {
      const apartment = await prisma.apartment.findUnique({
        where: { id: payload.apartmentId },
        select: { status: true },
      });
      if (!apartment || apartment.status === "suspended") {
        socket.close(1008, "Apartment is suspended");
        return;
      }
    }

    const client = socket as SocketWithAuth;
    client.auth = payload;
    clients.add(client);
    console.log("WebSocket connected", {
      userId: payload.userId,
      role: payload.role,
      apartmentId: payload.apartmentId,
      flatId: payload.flatId,
    });
    socket.once("close", () => {
      clients.delete(client);
      console.log("WebSocket disconnected", payload.userId);
    });
    socket.on("error", (error: Error) => {
      console.warn("WebSocket error", error);
    });
  });
}

export function notifyVisitorPassCreated(pass: VisitorPassNotificationData) {
  broadcast(
    (auth) => auth.role === "security" && auth.apartmentId === pass.apartmentId,
    { event: "visitor_pass.created", data: pass },
  );
}

export function notifyVisitorPassUpdated(pass: VisitorPassNotificationData) {
  broadcast(
    (auth) =>
      (auth.role === "security" && auth.apartmentId === pass.apartmentId) ||
      (auth.role === "flat_admin" && auth.flatId === pass.flatId),
    { event: "visitor_pass.updated", data: pass },
  );
}

export function notifyPaymentSubmitted(payment: PaymentNotificationData) {
  broadcast(
    (auth) => auth.role === "apartment_admin" && auth.apartmentId === payment.apartmentId,
    { event: "payment.submitted", data: payment },
  );
}

export function notifyPaymentApproved(payment: PaymentNotificationData) {
  broadcast(
    (auth) => auth.role === "flat_admin" && auth.flatId === payment.flatId,
    { event: "payment.approved", data: payment },
  );
}

export function notifyPaymentRejected(payment: PaymentNotificationData) {
  broadcast(
    (auth) => auth.role === "flat_admin" && auth.flatId === payment.flatId,
    { event: "payment.rejected", data: payment },
  );
}

export function notifyAnnouncementCreated(announcement: AnnouncementNotificationData) {
  broadcast(
    (auth) =>
      (auth.role === "flat_admin" || auth.role === "apartment_admin") &&
      auth.apartmentId === announcement.apartmentId,
    { event: "announcement.created", data: announcement },
  );
}

export function notifyAnnouncementUpdated(announcement: AnnouncementNotificationData) {
  broadcast(
    (auth) =>
      (auth.role === "flat_admin" || auth.role === "apartment_admin") &&
      auth.apartmentId === announcement.apartmentId,
    { event: "announcement.updated", data: announcement },
  );
}

export function notifyAnnouncementDeleted(announcement: { id: string; apartmentId: string }) {
  broadcast(
    (auth) =>
      (auth.role === "flat_admin" || auth.role === "apartment_admin") &&
      auth.apartmentId === announcement.apartmentId,
    { event: "announcement.deleted", data: announcement },
  );
}

export function notifyAnnouncementCommentCreated(comment: AnnouncementCommentNotificationData) {
  broadcast(
    (auth) =>
      (auth.role === "flat_admin" || auth.role === "apartment_admin") &&
      auth.apartmentId === comment.apartmentId,
    { event: "announcement.comment.created", data: comment },
  );
}

export function notifyComplaintMessage(message: ComplaintMessageNotificationData) {
  broadcast((auth) => {
    if (message.senderRole === "flat_admin") {
      return auth.role === "apartment_admin" && auth.apartmentId === message.apartmentId;
    }
    return auth.role === "flat_admin" && auth.flatId === message.flatId;
  }, { event: "complaint.message", data: message });
}

export function notifyComplaintCreated(complaint: ComplaintCreatedNotificationData) {
  broadcast(
    (auth) => auth.role === "apartment_admin" && auth.apartmentId === complaint.apartmentId,
    { event: "complaint.created", data: complaint },
  );
}
