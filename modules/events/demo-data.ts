export const demoEvent = {
  id: "evt_wr26",
  slug: "womens-retreat-2026",
  name: "Women’s Retreat 2026",
  dates: "October 9–11, 2026",
  location: "Des Moines, Iowa",
  status: "Registration open",
  capacity: 350,
} as const;

export const demoMetrics = [
  { label: "Registrations", value: "128", detail: "121 confirmed", tone: "navy" },
  { label: "Expected people", value: "176", detail: "Including 18 workers", tone: "purple" },
  { label: "Pending payment", value: "9", detail: "$1,275 outstanding", tone: "gold" },
  { label: "Checked in", value: "0", detail: "Arrival opens Oct. 9", tone: "green" },
] as const;

export const demoPeople = [
  { initials: "AS", name: "Alicia Smith", detail: "Des Moines SDA · Individual", status: "Paid", tone: "green" },
  { initials: "JM", name: "Jennifer Miller", detail: "Ankeny SDA · Party of 3", status: "Balance due", tone: "gold" },
  { initials: "TW", name: "Taylor Worker", detail: "Conference · Event worker", status: "No charge", tone: "purple" },
] as const;

export const demoAnnouncements = [
  {
    title: "Friday arrival information",
    body: "Use the south entrance for event check-in. Parking volunteers will direct you.",
    status: "Published",
    audience: "All attendees",
  },
  {
    title: "Weather plan reminder",
    body: "Draft copy for the team to review before publishing to the event feed.",
    status: "Draft",
    audience: "All attendees",
  },
] as const;
