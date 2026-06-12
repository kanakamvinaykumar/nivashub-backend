import { prisma } from "./prisma.js";

export interface CommitteeMember {
  id: string;
  name: string;
  role: string;
  flatNumber: string;
  phone: string;
  email: string;
}

export interface Association {
  apartmentId: string;
  registeredName: string;
  registrationNumber: string;
  foundedYear: number;
  description: string;
  managementType: string;
  contactEmail: string;
  contactPhone: string;
  officeHours: string;
  emergencyPhone: string;
  bankName: string;
  bankAccount: string;
  gstNumber: string;
  committee: CommitteeMember[];
  amenities: string[];
  rules: string[];
}

const COMMON_AMENITIES = [
  "Swimming Pool",
  "Gymnasium",
  "Clubhouse",
  "Indoor Games Room",
  "Children's Play Area",
  "Badminton Court",
  "Tennis Court",
  "Yoga / Aerobics Studio",
  "Multi-purpose Hall",
  "Landscaped Gardens",
  "Jogging Track",
  "24x7 Security with CCTV",
  "Visitor Parking",
  "Power Backup",
  "Rainwater Harvesting",
];

const COMMON_RULES = [
  "Quiet hours: 10:00 PM to 7:00 AM. No loud music or parties beyond this window.",
  "Visitors must register at the gate and obtain a visitor pass before entering.",
  "Pet owners must keep pets on a leash in common areas and clean up after them.",
  "No deliveries or contractors are allowed on the premises after 8:00 PM without prior notice.",
  "All construction, renovation or interior work must be approved by the association office in advance.",
  "Use of clubhouse and amenities requires advance booking through the NivasHub app.",
  "Maintenance dues must be paid by the 10th of every month to avoid late fees.",
  "Garbage segregation (wet, dry, hazardous) is mandatory for every flat.",
  "Two-wheelers and four-wheelers may park only in the slot allotted to the flat.",
  "Smoking is prohibited in lifts, lobbies, staircases and all common indoor areas.",
];

const baseAssociations: Record<string, Partial<Association>> = {
  "apt-001": {
    registeredName: "Green Valley Heights",
    description:
      "Green Valley Heights is a 248-flat residential community on Sarjapur Road, Bengaluru, established in 2014. The Owners Welfare Association is a registered society under the Karnataka Societies Registration Act, run by elected resident volunteers. Our mission is to keep Green Valley a calm, well-maintained, child-friendly community where families across cultures and languages feel at home.",
    managementType: "Resident-managed (Owners Welfare Association)",
  },
  "apt-002": {
    registeredName: "Skyline Towers Residents Association",
    description:
      "Skyline Towers in Gachibowli, Hyderabad is a 412-flat gated community across 6 towers. The association is a registered body under the Telangana Societies Registration Act. Our focus is on world-class amenities, security, and community programmes that bring residents together.",
    managementType: "Hybrid (Resident Association + Facility Manager)",
  },
  "apt-003": {
    registeredName: "Lotus Residency Association",
    description:
      "Lotus Residency is a boutique 96-flat community in Baner, Pune. We are a small, tight-knit society that prides itself on personal warmth and shared responsibility.",
    managementType: "Resident-managed",
  },
};

const COMMITTEE_TEMPLATES: Array<Pick<CommitteeMember, "role" | "name" | "flatNumber" | "phone" | "email">> = [
  { role: "President", name: "Suresh Kumar", flatNumber: "A-201", phone: "+91 98450 11111", email: "president@society.in" },
  { role: "Secretary", name: "Priya Sharma", flatNumber: "B-104", phone: "+91 98450 22222", email: "secretary@society.in" },
  { role: "Treasurer", name: "Arjun Reddy", flatNumber: "C-307", phone: "+91 98450 33333", email: "treasurer@society.in" },
  { role: "Maintenance Lead", name: "Vikram Iyer", flatNumber: "A-405", phone: "+91 98450 44444", email: "maintenance@society.in" },
  { role: "Cultural Secretary", name: "Anjali Menon", flatNumber: "D-201", phone: "+91 98450 55555", email: "cultural@society.in" },
  { role: "Sports Secretary", name: "Rohit Patel", flatNumber: "B-302", phone: "+91 98450 66666", email: "sports@society.in" },
  { role: "Security Coordinator", name: "Lakshmi Rao", flatNumber: "C-101", phone: "+91 98450 77777", email: "security@society.in" },
];

const POSITION_LABELS: Record<string, string> = {
  president: "President",
  secretary: "Secretary",
  treasurer: "Treasurer",
  maintenance: "Maintenance Lead",
  cultural: "Cultural Secretary",
  security: "Security Coordinator",
};

export async function getAssociation(apartmentId: string): Promise<Association | null> {
  const apt = await prisma.apartment.findUnique({
    where: { id: apartmentId },
    include: { amenities: true, rules: true, committee: true },
  });
  if (!apt) return null;
  const base = baseAssociations[apartmentId] ?? {};

  const dbAmenities = apt.amenities.map((a) => a.name);
  const dbRules = apt.rules.map((r) => r.text);
  const dbCommittee: CommitteeMember[] = apt.committee.map((m) => ({
    id: m.id,
    name: m.name,
    role: POSITION_LABELS[m.position] ?? m.position,
    flatNumber: m.flatNumber ?? "",
    phone: m.phone ?? "",
    email: m.email ?? "",
  }));

  return {
    apartmentId,
    registeredName: base.registeredName ?? `${apt.name}`,
    registrationNumber: `REG/${apt.city.slice(0, 3).toUpperCase()}/${2010 + (apt.name.length % 14)}/${(apt.id.length * 89) % 9999}`,
    foundedYear: 2010 + (apt.name.length % 14),
    description:
      base.description ??
      `${apt.name} is a ${apt.totalFlats}-flat residential community in ${apt.city}. The association is a registered body of resident volunteers focused on maintenance, safety, and community life.`,
    managementType: base.managementType ?? "Resident-managed",
    contactEmail: apt.registeredEmail ?? `office@${apt.code.toLowerCase().replace(/[^a-z0-9]/g, "")}.in`,
    contactPhone: "+91 80 4000 1234",
    officeHours: "Mon–Sat, 9:00 AM – 6:00 PM",
    emergencyPhone: "+91 80 4000 9999",
    bankName: "HDFC Bank",
    bankAccount: `XXXX XXXX ${(apt.id.length * 71) % 10000}`,
    gstNumber: `29AABCS${(apt.id.length * 1234) % 10000}1Z${(apt.totalFlats % 9) + 1}`,
    committee: dbCommittee.length
      ? dbCommittee
      : COMMITTEE_TEMPLATES.map((t, i) => ({ ...t, id: `${apartmentId}-cm-${i + 1}` })),
    amenities: dbAmenities.length ? dbAmenities : COMMON_AMENITIES.slice(0, 8 + (apt.totalFlats > 200 ? 4 : 0)),
    rules: dbRules.length ? dbRules : COMMON_RULES,
  };
}
