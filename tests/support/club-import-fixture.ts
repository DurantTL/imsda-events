/**
 * A synthetic form 89 export for the club-import tests and verify script
 * (#541). Every name, church, and address is fake. The shape matches the real
 * Fluent Forms export: one entry, the leader and co-leader who share a
 * surname, assistants with some blank cells, and Pathfinders in the repeater
 * as [name, age, class], including sibling groups, a parent and child who
 * share a surname, and a two-letter first name.
 */

export const SYNTHETIC_CHURCH = "Fixture Hills SDA Church";

const assistants: string[][] = [
  ["Cy Faux", "1 Fake Lane", "555-0100", "cy@faux.example.test", "Yes"],
  ["Dee Faux", "", "", "", "Yes"],
  ["Eli Mockman", "2 Fake Lane", "", "", "Yes"],
  ["Fay Mockman", "", "555-0101", "fay@mockman.example.test", "Yes"],
  ["Gus Placeholder", "", "", "", ""],
  ["Hal Stubbs", "3 Fake Lane", "555-0102", "", "Yes"],
  ["Ivy Stubbs", "", "", "ivy@stubbs.example.test", "Yes"],
  ["Jo Dummy", "", "", "", "Yes"],
];

const siblingsAndSpecials: string[][] = [
  // Siblings sharing a surname with staff (Cy and Dee Faux are their parents).
  ["Kim Faux", "12", "Explorer"],
  ["Lou Faux", "10", "Companion"],
  ["Max Faux", "8", "Friend"],
  // Siblings sharing a surname with the leader and co-leader.
  ["Ned Testerson", "14", "Voyager"],
  ["Ola Testerson", "11", "Ranger"],
  // Another sibling group.
  ["Pia Samplekid", "13", "Guide"],
  ["Quin Samplekid", "9", "Friend"],
  // A two-letter first name.
  ["Bo Placeholder", "10", "Companion"],
];

export function syntheticPathfinders(count = 38) {
  const rows = [...siblingsAndSpecials];
  const classes = ["Friend", "Companion", "Explorer", "Ranger", "Voyager", "Guide"];
  const surnames = ["Fakekid", "Mockman", "Stubbs", "Dummyfamily", "Fixture"];
  for (let index = rows.length; index < count; index += 1) {
    const number = String(index + 1).padStart(2, "0");
    rows.push([`Scout${number} ${surnames[index % surnames.length]}`, String(8 + (index % 8)), classes[index % classes.length]]);
  }
  return rows;
}

export function syntheticExportEntry(overrides: Record<string, unknown> = {}, response: Record<string, unknown> = {}) {
  return {
    id: 90541,
    form_id: "89",
    status: "read",
    created_at: "2026-08-31 10:56:31",
    response: {
      multi_select: [SYNTHETIC_CHURCH],
      leader_name: "Ada Testerson",
      leader_address: "9 Fake Lane",
      leader_cell_phone: "555-0199",
      leader_email: "ada@testerson.example.test",
      leader_child_protection: "yes",
      co_leader_name: "Ben Testerson",
      co_leader_email: "ben@testerson.example.test",
      co_leader_child_protection: "yes",
      other_assistants: assistants,
      approx_pathfinders: "38",
      repeater_container: syntheticPathfinders(),
      ...response,
    },
    ...overrides,
  };
}
