export interface Plan {
  id: string;
  name: string;
  tagline: string;
  monthlyPrice: number;
  yearlyPrice: number;
  fiveYearPrice: number;
  currency: string;
  maxFlats: number;
  features: string[];
  recommended: boolean;
}

export const plans: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    tagline: "For small societies just getting started",
    monthlyPrice: 1499,
    yearlyPrice: 14990,
    fiveYearPrice: 59990,
    currency: "INR",
    maxFlats: 50,
    features: [
      "Up to 50 flats",
      "Announcements with priority pinning",
      "Visitor passes with QR codes",
      "Bazaar marketplace",
      "Email support",
      "English + Hindi support",
    ],
    recommended: false,
  },
  {
    id: "community",
    name: "Community",
    tagline: "For most apartment societies in India",
    monthlyPrice: 3499,
    yearlyPrice: 34990,
    fiveYearPrice: 139990,
    currency: "INR",
    maxFlats: 200,
    features: [
      "Up to 200 flats",
      "Everything in Starter",
      "Multi-channel real-time chat",
      "Sports / amenity booking with fairness rules",
      "AI announcement composer",
      "Chat-to-listing AI agent",
      "Audit logs",
      "Priority chat support",
    ],
    recommended: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "For large gated communities and townships",
    monthlyPrice: 7999,
    yearlyPrice: 79990,
    fiveYearPrice: 319990,
    currency: "INR",
    maxFlats: 500,
    features: [
      "Up to 500 flats",
      "Everything in Community",
      "Dedicated onboarding manager",
      "AI court booking agent",
      "MCP translation server",
      "Custom domain & branding",
      "SLA & 24x7 support",
      "Telugu, Hindi & English",
    ],
    recommended: false,
  },
];
