import type { RegistrationFormDefinition, RegistrationFormField } from "@/modules/forms/definition";

/**
 * The four seeded club form templates (#610, with the field-level specs from
 * #608). Each `definition` uses the registration-form definition schema and
 * field types unchanged; what the schema cannot carry lives beside it:
 *
 * - `sectionNotes`: display-only paragraphs per section id (the Pathfinder
 *   Pledge and Law, approval and waiver text, instructions);
 * - `sensitiveFieldKeys`: answers sealed at rest, shown to a club's director
 *   and deputies and to staff with VIEW_SENSITIVE_DATA, "Restricted" to Area
 *   Coordinators, and left out of CSVs;
 * - `staffOnlyFieldKeys`: office-use fields a private-link filler never sees.
 *
 * Bump `version` when a definition changes; `npm run club-forms:sync` (run by
 * `docker-entrypoint.sh` after migrations, and by hand locally) then updates
 * the stored row through `syncClubFormTemplates` and, for a field that became
 * sensitive, re-seals existing answers first. It never touches `enabled`.
 * Until it has run, saves to the behind form are refused.
 *
 * Wording that #610 summarises rather than quotes (the membership
 * application's statement, waiver and five cooperation points, and the
 * Pledge and Law) is drafted here from those summaries and the standard
 * Pathfinder texts. A human must compare it with the conference's official
 * Word forms before a system administrator enables that template.
 */

export type ClubFormTemplateSeed = {
  key: string;
  name: string;
  description: string;
  version: number;
  sortOrder: number;
  definition: RegistrationFormDefinition;
  sectionNotes: Record<string, string[]>;
  sensitiveFieldKeys: string[];
  /** Birth-date fields: sensitive, and readable only by the club's leaders and system administrators. */
  birthDateFieldKeys: string[];
  staffOnlyFieldKeys: string[];
  printLayout: "STANDARD" | "PASSENGER_LIST";
};

type FieldExtra = Partial<RegistrationFormField>;

function field(
  key: string,
  label: string,
  type: RegistrationFormField["type"],
  required = false,
  extra: FieldExtra = {},
): RegistrationFormField {
  return {
    id: `f_${key}`,
    key,
    label,
    helpText: "",
    type,
    scope: "REGISTRATION",
    required,
    options: [],
    ...extra,
  };
}

const text = (key: string, label: string, required = false, extra: FieldExtra = {}) => field(key, label, "TEXT", required, extra);
const longText = (key: string, label: string, required = false, extra: FieldExtra = {}) => field(key, label, "LONG_TEXT", required, extra);
const phone = (key: string, label: string, required = false, extra: FieldExtra = {}) => field(key, label, "PHONE", required, extra);
const date = (key: string, label: string, required = false, extra: FieldExtra = {}) => field(key, label, "DATE", required, extra);
const yesNo = (key: string, label: string, required = false, extra: FieldExtra = {}) => field(key, label, "RADIO", required, { options: ["Yes", "No"], ...extra });
const money = (key: string, label: string, extra: FieldExtra = {}) => field(key, label, "NUMBER", false, { helpText: "Dollars, entered by the club.", ...extra });
const whenYes = (fieldKey: string): FieldExtra => ({ conditional: { fieldKey, operator: "EQUALS", value: "Yes" } });

const churchField = (required: boolean) => field("church", "Church", "SELECT", required, { optionSource: "CHURCHES_DIRECTORY" });
const churchOther = () => text("church_other", "Church name", true, { conditional: { fieldKey: "church", operator: "EQUALS", value: "Not listed" } });

function section(id: string, title: string, fields: RegistrationFormField[], description = "") {
  return { id, title, description, fields };
}

// ---------------------------------------------------------------------------
// 1. Pathfinder Club Membership Application

const pledge = "The Pathfinder Pledge: By the grace of God, I will be pure and kind and true. I will keep the Pathfinder Law. I will be a servant of God and a friend to all.";
const law = "The Pathfinder Law: The Pathfinder Law is for me to keep the morning watch, do my honest part, care for my body, keep a level eye, be courteous and obedient, walk softly in the sanctuary, keep a song in my heart, and go on God's errands.";

const membershipApplication: ClubFormTemplateSeed = {
  key: "pathfinder_membership_application",
  name: "Pathfinder Club Membership Application",
  description: "An applicant's membership application with the parent or guardian's approval, waiver and signatures.",
  version: 1,
  sortOrder: 10,
  printLayout: "STANDARD",
  sensitiveFieldKeys: ["birth_date"],
  birthDateFieldKeys: ["birth_date"],
  staffOnlyFieldKeys: [],
  sectionNotes: {
    sec_applicant: [
      "I would like to join the Pathfinder Club named below. If I am accepted, I will do my best to take part and to live by the Pathfinder Pledge and Law.",
      pledge,
      law,
    ],
    sec_approval: [
      "Parent or guardian approval. The applicant is at least in the 5th grade.",
      "Waiver of claims. We waive and release any claim against the club, its sponsoring church and the Iowa-Missouri Conference of Seventh-day Adventists, and their leaders and volunteers, for injury, illness or loss that happens during club activities, except where the law does not allow a claim to be waived.",
      "We agree to cooperate with the club in these five ways: (1) to see that the applicant attends meetings and activities on time and prepared; (2) to support the club's rules, the Pathfinder Pledge and the Pathfinder Law; (3) to keep the club leaders informed of changes in health, contact details or family circumstances; (4) to pick up the applicant promptly after activities, or to arrange safe transportation; (5) to pay the fees listed for registration, club dues and insurance.",
    ],
  },
  definition: {
    title: "Pathfinder Club Membership Application",
    description: "Membership application for one applicant. The parent or guardian approves and signs.",
    confirmationMessage: "Thank you. The membership application has been received.",
    sections: [
      section("sec_applicant", "Applicant", [
        text("club_name", "Pathfinder Club name", true),
        text("applicant_signature", "Applicant signature (type your full name)", true, { helpText: "Typing your name here is your signature." }),
        date("applicant_signature_date", "Date signed by applicant", true),
      ]),
      section("sec_fees", "Fees", [
        money("registration_fee", "Registration fee ($)"),
        money("club_dues", "Club dues ($)"),
        money("insurance_fee", "Insurance ($)"),
      ], "Amounts the club enters."),
      section("sec_details", "Applicant details", [
        text("full_name", "Applicant name", true),
        phone("phone", "Phone", true),
        field("ay_class", "AY class", "SELECT", true, { options: ["Friend", "Companion", "Explorer", "Ranger", "Voyager", "Guide"] }),
        text("street", "Street address", true),
        text("city", "City", true),
        text("state", "State", true),
        text("zip", "ZIP", true),
        text("school", "School"),
        field("grade", "Grade", "SELECT", true, { options: ["5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th"] }),
        churchField(true),
        churchOther(),
        yesNo("been_pathfinder", "I have been a Pathfinder", true),
        text("been_pathfinder_where", "Where?", false, whenYes("been_pathfinder")),
        yesNo("dad_master_guide", "Dad is a Master Guide"),
        yesNo("dad_been_pathfinder", "Dad has been a Pathfinder"),
        yesNo("mother_master_guide", "Mother is a Master Guide"),
        yesNo("mother_been_pathfinder", "Mother has been a Pathfinder"),
      ]),
      section("sec_approval", "Parent or guardian approval", [
        text("certified_name", "We hereby certify that (applicant name)", true),
        date("birth_date", "was born on", true),
        text("father_guardian_signature", "Father or guardian signature (type full name)", true, { optionalWhen: { fieldKey: "mother_guardian_signature", operator: "NOT_EMPTY", value: "" } }),
        text("father_guardian_occupation", "Father or guardian occupation"),
        text("mother_guardian_signature", "Mother or guardian signature (type full name)", true, { optionalWhen: { fieldKey: "father_guardian_signature", operator: "NOT_EMPTY", value: "" } }),
        text("mother_guardian_occupation", "Mother or guardian occupation"),
        field("approval_agreement", "We have read and agree to the approval, waiver and cooperation statements above.", "CHECKBOX", true),
        date("application_date", "Date of application", true),
      ]),
    ],
  },
};

// ---------------------------------------------------------------------------
// 2. Pathfinder Staff/Volunteer Service Information Form

function rows<T>(count: number, build: (index: number) => T[]) {
  return Array.from({ length: count }, (_, index) => build(index + 1)).flat();
}

const childFields = rows(5, (n) => [
  text(`child_${n}_name`, `Child ${n} name`),
  date(`child_${n}_birth_date`, `Child ${n} birth date`),
]);
const experienceFields = rows(3, (n) => [
  text(`experience_${n}_position`, `${n}. Position or type of work`),
  text(`experience_${n}_organization`, `${n}. Church or organization`),
  text(`experience_${n}_dates`, `${n}. Dates of service`),
]);
const honorRoles = ["T - Teach", "A - Assist", "I - Interested in team teaching"];
const honorFields = rows(8, (n) => [
  text(`honor_${n}_name`, `${n}. Honor or craft`),
  field(`honor_${n}_role`, `${n}. T, A or I`, "SELECT", false, { options: honorRoles }),
]);
const referenceRoles = ["Pastor", "Local", "Other"];
const referenceFields = rows(3, (n) => [
  text(`reference_${n}_name`, `${n}. ${referenceRoles[n - 1]}: name`, true),
  text(`reference_${n}_address`, `${n}. ${referenceRoles[n - 1]}: address`, true),
  phone(`reference_${n}_phone`, `${n}. ${referenceRoles[n - 1]}: phone`, true),
]);

const staffForm: ClubFormTemplateSeed = {
  key: "pathfinder_staff_service_information",
  name: "Pathfinder Staff/Volunteer Service Information Form",
  description: "A staff or volunteer's record, health history, experience, honors to teach, conduct disclosure and references.",
  version: 1,
  sortOrder: 20,
  printLayout: "STANDARD",
  sensitiveFieldKeys: [
    "birth_date",
    ...[1, 2, 3, 4, 5].map((n) => `child_${n}_birth_date`),
    "health_limitation",
    "health_limitation_how",
    "conduct_accused",
    "conduct_explanation",
    "conduct_date_place",
    "conduct_type",
    "conduct_verifier_name",
    "conduct_verifier_street",
    "conduct_verifier_city",
    "conduct_verifier_state",
    "conduct_verifier_zip",
    "conduct_verifier_phone",
  ],
  birthDateFieldKeys: ["birth_date", ...[1, 2, 3, 4, 5].map((n) => `child_${n}_birth_date`)],
  staffOnlyFieldKeys: ["office_date_received", "office_date_approved", "office_recommendation", "office_signature"],
  sectionNotes: {
    sec_office: ["For office use only. This form is for club files only."],
    sec_health: ["Health history. Only the club's director and deputies, and conference staff with sensitive-data access, can read these answers."],
    sec_conduct: ["Unlawful conduct. Only the club's director and deputies, and conference staff with sensitive-data access, can read these answers."],
    sec_experience: ["List experience that might qualify you for Pathfinder staff (Pathfinder or Adventurer, Scouts, Sabbath School, and so on)."],
    sec_honors: ["List honors or crafts you are interested in teaching. T = Teach, A = Assist, I = Interested in team teaching."],
    sec_references: ["List three people who know you well enough to recommend you."],
  },
  definition: {
    title: "Pathfinder Staff/Volunteer Service Information Form",
    description: "This form is for club files only.",
    confirmationMessage: "Thank you. Your service information form has been received.",
    sections: [
      section("sec_office", "Office use only", [
        date("office_date_received", "Date received"),
        date("office_date_approved", "Date approved"),
        field("office_recommendation", "Recommendation", "SELECT", false, { options: ["Recommended", "Not recommended", "Recommended with conditions noted"] }),
        text("office_signature", "Office signature (type full name)"),
      ]),
      section("sec_record", "I. Date of record", [
        text("full_name", "Name", true),
        date("birth_date", "Birth date", true),
        text("street", "Street address", true),
        text("city", "City", true),
        text("state", "State", true),
        text("zip", "ZIP", true),
        phone("phone_home", "Home phone", false, { helpText: "For use only in emergency or with permission." }),
        phone("phone_work", "Work phone", false, { helpText: "For use only in emergency or with permission." }),
        phone("phone_cell", "Cell phone", false, { helpText: "For use only in emergency or with permission." }),
        field("email", "Email", "EMAIL", true),
        churchField(true),
        churchOther(),
        field("club", "Pathfinder club", "SELECT", true, { optionSource: "CLUBS_DIRECTORY" }),
        text("club_other", "Club name", true, { conditional: { fieldKey: "club", operator: "EQUALS", value: "Not listed" } }),
        field("marital_status", "Marital status", "SELECT", false, { options: ["Married", "Single", "Divorced"] }),
        text("spouse_name", "Spouse's name"),
      ]),
      section("sec_children", "Children", childFields, "Up to five children."),
      section("sec_health", "II. Health history", [
        yesNo("health_limitation", "Do you now have or have you had injury or sickness that might limit your involvement in Pathfinder Club activities?", true),
        longText("health_limitation_how", "How would it hinder?", true, whenYes("health_limitation")),
      ]),
      section("sec_education", "III. Educational record", [
        text("highest_degree", "Highest degree or diploma"),
        field("degree_year", "Year received", "NUMBER", false, { ageBounds: { minimumAge: 1900, maximumAge: 2100 } }),
        text("degree_school", "School that granted it"),
        text("college_major", "College major"),
        text("college_minor", "College minor"),
      ]),
      section("sec_experience", "IV. Experience", experienceFields, "Up to three rows."),
      section("sec_honors", "V. Award instruction ability", honorFields, "Up to eight rows."),
      section("sec_conduct", "VI. Unlawful conduct", [
        yesNo("conduct_accused", "Have you been accused, charged, or disciplined for any unlawful sexual conduct, child abuse, and/or child sexual abuse?", true),
        longText("conduct_explanation", "Explanation", true, whenYes("conduct_accused")),
        text("conduct_date_place", "Date and place", true, whenYes("conduct_accused")),
        text("conduct_type", "Type of conduct", true, whenYes("conduct_accused")),
        text("conduct_verifier_name", "Reference or professional who can verify suitability: name", true, whenYes("conduct_accused")),
        text("conduct_verifier_street", "Verifier street address", true, whenYes("conduct_accused")),
        text("conduct_verifier_city", "Verifier city", true, whenYes("conduct_accused")),
        text("conduct_verifier_state", "Verifier state", true, whenYes("conduct_accused")),
        text("conduct_verifier_zip", "Verifier ZIP", true, whenYes("conduct_accused")),
        phone("conduct_verifier_phone", "Verifier phone", true, whenYes("conduct_accused")),
      ]),
      section("sec_references", "VII. References", referenceFields),
      section("sec_signature", "Signature", [
        text("signature", "Signature (type your full name)", true, { helpText: "Typing your name here is your signature." }),
        date("signature_date", "Date", true),
        field("signature_acknowledgment", "I confirm that the answers on this form are true and that typing my name is my signature.", "CHECKBOX", true),
      ]),
    ],
  },
};

// ---------------------------------------------------------------------------
// 3. Off-Premises Permission Slip

const permissionSlip: ClubFormTemplateSeed = {
  key: "off_premises_permission_slip",
  name: "Off-Premises Permission Slip",
  description: "A parent or guardian's permission for a child to take part in one off-premises club activity, with medical and emergency details.",
  version: 1,
  sortOrder: 30,
  printLayout: "STANDARD",
  sensitiveFieldKeys: ["physician_name", "physician_phone", "clinic_name", "clinic_phone", "emergency_contact_phone"],
  birthDateFieldKeys: [],
  staffOnlyFieldKeys: [],
  sectionNotes: {
    sec_permission: [
      "I hereby give my permission for my child to participate in the pre-planned activity named below, on the date given.",
    ],
    sec_medical: ["Medical and emergency information. Only the club's director and deputies, and conference staff with sensitive-data access, can read these answers."],
  },
  definition: {
    title: "Iowa-Missouri Conference, Pathfinder/Adventurer Club, Permission Slip for Off-Premises Activities",
    description: "Permission Slip for Off-Premises Activities.",
    confirmationMessage: "Thank you. The permission slip has been received.",
    sections: [
      section("sec_child", "Child and family", [
        text("child_name", "Child's name", true),
        text("street", "Address", true),
        text("city", "City", true),
        text("state", "State", true),
        text("zip", "ZIP", true),
        phone("phone", "Phone", true),
      ]),
      section("sec_permission", "Permission to participate in off-premises club activities", [
        text("activity", "I hereby give my permission for my child to participate in the pre-planned activity of", true),
        date("activity_date", "On the date of", true),
        text("ride_with", "I give my child permission to ride with", true),
      ]),
      section("sec_parent", "Parent or guardian", [
        text("parent_signature", "Signed name (type your full name)", true, { helpText: "Typing your name here is your signature." }),
        date("parent_signature_date", "Date", true),
        text("relationship", "Relationship to the Pathfinder or Adventurer", true),
        longText("parent_address_if_different", "Address, if different from above"),
      ]),
      section("sec_medical", "Medical and emergency", [
        text("physician_name", "Physician's name"),
        phone("physician_phone", "Physician's phone"),
        text("clinic_name", "Clinic"),
        phone("clinic_phone", "Clinic phone"),
        phone("emergency_contact_phone", "Emergency contact phone number", true),
      ]),
    ],
  },
};

// ---------------------------------------------------------------------------
// 4. Transportation Passenger List

const passengerSections = [
  [1, 6], [7, 12], [13, 18], [19, 20],
].map(([first, last]) => section(
  `sec_passengers_${first}_${last}`,
  `Passengers ${first} to ${last}`,
  rows(last - first + 1, (offset) => {
    const n = first + offset - 1;
    return [
      text(`passenger_${n}_name`, `Passenger ${n} name`, n === 1),
      phone(`passenger_${n}_phone`, `Passenger ${n} phone`),
      text(`passenger_${n}_emergency_contact`, `Passenger ${n} emergency contact (name and phone)`),
    ];
  }),
));

const passengerList: ClubFormTemplateSeed = {
  key: "transportation_passenger_list",
  name: "Transportation Passenger List",
  description: "A roll-call sheet for one trip: contacts, up to 20 passengers with emergency contacts, and printable roll-call columns 1 to 5.",
  version: 1,
  sortOrder: 40,
  printLayout: "PASSENGER_LIST",
  sensitiveFieldKeys: Array.from({ length: 20 }, (_, index) => `passenger_${index + 1}_emergency_contact`),
  birthDateFieldKeys: [],
  staffOnlyFieldKeys: [],
  sectionNotes: {
    sec_contacts: [
      "Enter the name and emergency contact of each passenger. The club director needs a copy and the driver needs a copy. At each stop before driving away, take roll call.",
    ],
  },
  definition: {
    title: "Transportation Passenger List",
    description: "Enter the name and emergency contact of each passenger.",
    confirmationMessage: "Thank you. The passenger list has been received.",
    sections: [
      section("sec_contacts", "Contacts", [
        text("contact_name", "Club director's or central contact's name", true),
        phone("contact_cell", "Contact's cell phone", true),
        text("driver_name", "Driver's name", true),
        phone("driver_cell", "Driver's cell phone", true),
      ]),
      ...passengerSections,
    ],
  },
};

export const clubFormTemplateSeeds: readonly ClubFormTemplateSeed[] = [
  membershipApplication,
  staffForm,
  permissionSlip,
  passengerList,
];
