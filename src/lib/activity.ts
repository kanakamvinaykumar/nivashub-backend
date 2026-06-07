import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { prisma } from "./prisma.js";

export interface ActivityItem {
  id: string;
  type: "signup" | "plan_upgrade" | "plan_renewal" | "suspension" | "announcement" | "booking" | "listing";
  title: string;
  subtitle: string;
  apartmentName: string;
  createdAt: string;
}

export interface ApartmentActivityLogEntry {
  id: string;
  apartmentId: string;
  userId: string | null;
  userRole: Role;
  userName: string | null;
  userEmail: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  createdAt: string;
}

export async function recordActivity(args: {
  apartmentId: string;
  userId?: string | null;
  userRole: Role;
  action: string;
  entity: string;
  entityId?: string | null;
  details?: string | null;
}): Promise<void> {
  const user = args.userId ? await prisma.user.findUnique({ where: { id: args.userId } }) : null;
  await prisma.activityLog.create({
    data: {
      apartmentId: args.apartmentId,
      userId: args.userId,
      userRole: args.userRole,
      userName: user?.name ?? null,
      userEmail: user?.email ?? null,
      action: args.action,
      entity: args.entity,
      entityId: args.entityId ?? null,
      details: args.details ?? null,
    },
  });
}

export async function getApartmentActivity(apartmentId: string): Promise<ApartmentActivityLogEntry[]> {
  const rows = await prisma.activityLog.findMany({
    where: { apartmentId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      apartmentId: true,
      userId: true,
      userRole: true,
      userName: true,
      userEmail: true,
      action: true,
      entity: true,
      entityId: true,
      details: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface RevenuePoint {
  month: string;
  revenueInr: number;
  newSubscriptions: number;
}

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString();

export async function generateActivity(): Promise<ActivityItem[]> {
  const apartments = await prisma.apartment.findMany();
  if (apartments.length === 0) return [];
  const items: ActivityItem[] = [];
  const types: ActivityItem["type"][] = [
    "signup",
    "plan_upgrade",
    "plan_renewal",
    "announcement",
    "booking",
    "listing",
    "suspension",
  ];
  for (let i = 0; i < 14; i++) {
    const apt = apartments[i % apartments.length]!;
    const t = types[i % types.length]!;
    let title = "";
    let subtitle = "";
    switch (t) {
      case "signup":
        title = "New society signed up";
        subtitle = `${apt.name} joined on the ${apt.planTier} plan`;
        break;
      case "plan_upgrade":
        title = "Plan upgraded";
        subtitle = `${apt.name} moved up to ${apt.planTier}`;
        break;
      case "plan_renewal":
        title = "Subscription renewed";
        subtitle = `${apt.name} renewed (${apt.planCycle.replace("_", " ")})`;
        break;
      case "announcement":
        title = "High-priority announcement posted";
        subtitle = `Water tank cleaning notice in ${apt.name}`;
        break;
      case "booking":
        title = "Court booked via AI agent";
        subtitle = `Badminton booking confirmed in ${apt.name}`;
        break;
      case "listing":
        title = "New marketplace listing";
        subtitle = `Listing posted in ${apt.name}`;
        break;
      case "suspension":
        title = "Subscription suspended";
        subtitle = `${apt.name} payment failed`;
        break;
    }
    items.push({
      id: randomUUID(),
      type: t,
      title,
      subtitle,
      apartmentName: apt.name,
      createdAt: isoDaysAgo(i / 3),
    });
  }
  return items;
}

export function generateRevenueTrend(): RevenuePoint[] {
  const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];
  return months.map((m, i) => ({
    month: m,
    revenueInr: 180000 + i * 24000 + ((i * 7919) % 28000),
    newSubscriptions: 4 + (i % 5) + Math.floor(i / 3),
  }));
}
