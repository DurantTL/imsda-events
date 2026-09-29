"use client";

import { PUBLIC_DRAFT_STAFF_HELP } from "@/modules/forms/public-draft";
import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Copy,
  CopyPlus,
  Eye,
  ExternalLink,
  FileClock,
  GripVertical,
  Layers3,
  Plus,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { AddressFieldGroup } from "@/components/address-field-group";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormSlugDialog } from "@/components/form-slug-dialog";
import { SearchableSelect } from "@/components/searchable-select";
import type { AddressValue } from "@/modules/forms/address";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";
import { calculateFormTotal, calculateRosterTotal, conditionOperators, formFieldScopes, formFieldTypes, getAttendeeRosterConfig, getAvailabilityMode, isChoiceFieldType, isDirectoryOptionSource, isFieldVisible, isAgeFieldKey, isLatePricingActive, localCalendarDate, templatesForPicker, numberFieldBounds, type ChoiceUsage, type RegistrationFormDefinition, type RegistrationFormField } from "@/modules/forms/definition";
import {
  builderFieldModules,
  moduleAlreadyPresentNotice,
  moduleAttendeeRoster,
  moduleInsertNotice,
  planModuleInsert,
  type BuilderModuleDefinition,
} from "@/modules/forms/builder-modules";
import { defaultTypeForNewChoiceField, singleChoiceTypeHint } from "@/modules/forms/choice-defaults";
import { creditPatchForKindChange, creditSummary, hasCredit, removeCreditPatch } from "@/modules/forms/credit-fields";
import { getPublicRegistrationStepPlan, isPublicReviewSection, type PublicRegistrationStepId } from "@/modules/forms/public-registration-steps";
import { batchFieldKeys, removalAnswerNote } from "@/modules/forms/field-answer-counts";
import { slugMatchesTitle } from "@/modules/forms/slug";
import { recordTemplateCleanupCreated } from "@/components/template-cleanup-checklist";
import { TemplateCleanupChecklistPanel } from "@/components/template-cleanup-checklist-panel";

type PreviewValue = string | boolean | string[] | AddressValue;
type TestSubmissionView = { id: string; isValid: boolean; submittedBy: string; createdAt: string; validation: Record<string, unknown>; responses: Record<string, unknown> };
type FormVersionView = {
  id: string;
  versionNumber: number;
  status: string;
  definition: RegistrationFormDefinition;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  testSubmissionCount: number;
  choiceUsage: ChoiceUsage;
  testSubmissions: TestSubmissionView[];
};
type FormView = {
  id: string;
  eventId: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  activeVersion: FormVersionView;
  versions: FormVersionView[];
};
type TemplateView = { key: string; name: string; description: string; audience: string; collectsPayment?: boolean; sectionCount: number; fieldCount: number };
type DragState =
  | { kind: "section"; sectionIndex: number }
  | { kind: "field"; sectionIndex: number; fieldIndex: number }
  | null;

const fieldTypeLabels: Record<RegistrationFormField["type"], string> = {
  TEXT: "Short text",
  LONG_TEXT: "Long answer",
  EMAIL: "Email",
  PHONE: "Phone",
  SELECT: "Dropdown",
  RADIO: "Single choice",
  MULTISELECT: "Multiple choice",
  RANKED_CHOICE: "Ranked choice",
  CHECKBOX: "Acknowledgment",
  DATE: "Date",
  NUMBER: "Number",
  CALCULATED: "Automatic fee",
  ADDRESS: "Address",
};

const choicePresets = [
  { name: "Yes / No", options: ["No", "Yes"] },
  { name: "Adult / Teen", options: ["Adult", "Teen"] },
  { name: "Meal preference", options: ["Regular", "Vegetarian", "Vegan", "Gluten-free"] },
  { name: "Payment method", options: ["Pay Later", "Pay Now"] },
];

const moduleCategories = ["All", "Common", "People", "Housing", "Group event"] as const;

function fieldKey(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50) || "new_field";
}

function localId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function defaultField(index: number): RegistrationFormField {
  return { id: localId("field"), key: `new_field_${index}`, label: "New field", helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] };
}

type PreviewAttendee = {
  clientId: string;
  responses: Record<string, PreviewValue>;
};

function blankPreviewAttendees(definition: RegistrationFormDefinition | null): PreviewAttendee[] {
  if (!definition) return [];
  const roster = getAttendeeRosterConfig(definition);
  if (!roster.enabled) return [];
  return Array.from({ length: roster.minAttendees }, (_, index) => ({
    clientId: `preview_initial_attendee_${index + 1}`,
    responses: {},
  }));
}

function statusLabel(status: string) {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function firstPreviewStepId(definition: RegistrationFormDefinition) {
  return getPublicRegistrationStepPlan(definition)[0]?.id ?? "review";
}

const conditionLabels = {
  EQUALS: "Equals",
  NOT_EQUALS: "Does not equal",
  INCLUDES: "Includes",
  NOT_EMPTY: "Has any answer",
} as const;

export function RegistrationBuilderWorkspace({ eventId, eventSlug, eventName, eventAudience, eventBillingMode, initialForms, templates }: { eventId: string; eventSlug: string; eventName: string; eventAudience?: string; eventBillingMode?: string; initialForms: FormView[]; templates: TemplateView[] }) {
  const [forms, setForms] = useState(initialForms);
  const [selectedFormId, setSelectedFormId] = useState(initialForms[0]?.id ?? "");
  const selectedForm = forms.find((form) => form.id === selectedFormId) ?? null;
  const [selectedVersionId, setSelectedVersionId] = useState(selectedForm?.activeVersion.id ?? "");
  const selectedVersion = selectedForm?.versions.find((version) => version.id === selectedVersionId) ?? selectedForm?.activeVersion ?? null;
  const [definition, setDefinition] = useState<RegistrationFormDefinition | null>(selectedVersion?.definition ?? null);
  const [responses, setResponses] = useState<Record<string, PreviewValue>>({});
  const [previewAttendees, setPreviewAttendees] = useState<PreviewAttendee[]>(() => blankPreviewAttendees(selectedVersion?.definition ?? null));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"create" | "save" | "test" | "publish" | "unpublish" | "slug" | null>(null);
  const [notice, setNotice] = useState("");
  // Fields the builder just turned into a choice field that defaulted to radio cards (FB-9).
  const [autoRadioFieldIds, setAutoRadioFieldIds] = useState<ReadonlySet<string>>(() => new Set());
  // Field ids whose choice-size hint the builder dismissed this session. The
  // hint is only a suggestion, so dismissing it just hides it.
  const [dismissedChoiceHintIds, setDismissedChoiceHintIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");
  const [testIssues, setTestIssues] = useState<Array<{ fieldId: string | null; key: string; message: string; attendeeIndex?: number | null; path?: string }>>([]);
  const [showTemplates, setShowTemplates] = useState(initialForms.length === 0);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);
  // The address the server offers when a renamed, never-published form's
  // slug no longer matches its title; null while no prompt is open.
  const [slugPrompt, setSlugPrompt] = useState<{ offeredSlug: string } | null>(null);
  const [slugError, setSlugError] = useState("");
  const publishDialogRef = useAccessibleDialog<HTMLElement>(
    confirmingPublish,
    () => {
      if (!busy) setConfirmingPublish(false);
    },
  );
  // Review before removing a section or field (#471): the shared confirm
  // dialog names what disappears and, when there's already something to
  // lose, the real count of already-submitted answers that stay on those
  // registrations regardless — removing a field or section only ever edits
  // this draft version.
  const [removeFieldTarget, setRemoveFieldTarget] = useState<{ sectionIndex: number; fieldIndex: number; field: RegistrationFormField } | null>(null);
  const [removeSectionTarget, setRemoveSectionTarget] = useState<{ sectionIndex: number; section: RegistrationFormDefinition["sections"][number] } | null>(null);
  const [removalAnswerCounts, setRemovalAnswerCounts] = useState<Record<string, number> | null>(null);
  const [removalAnswerCountsLoading, setRemovalAnswerCountsLoading] = useState(false);
  // Each count lookup gets an id; a response for anything but the latest
  // lookup (the dialog was closed or reopened for another field) is ignored.
  const removalAnswerRequestId = useRef(0);
  const [dragging, setDragging] = useState<DragState>(null);
  const [expandedFieldId, setExpandedFieldId] = useState<string | null>(null);
  const [openModuleSection, setOpenModuleSection] = useState<number | null>(null);
  const [moduleQuery, setModuleQuery] = useState("");
  const [moduleCategory, setModuleCategory] = useState<typeof moduleCategories[number]>("All");
  const [pricingPreviewDate, setPricingPreviewDate] = useState(localCalendarDate());
  const [previewStepId, setPreviewStepId] = useState<PublicRegistrationStepId>(
    () => selectedVersion?.definition
      ? firstPreviewStepId(selectedVersion.definition)
      : "__review",
  );
  const previewRef = useRef<HTMLElement>(null);
  useUnsavedChangesGuard(
    dirty,
    "This registration form has unsaved changes. Leave and discard the draft edits?",
  );

  const totalFields = useMemo(() => definition?.sections.reduce((count, section) => count + section.fields.length, 0) ?? 0, [definition]);
  const allFields = useMemo(() => definition?.sections.flatMap((section) => section.fields) ?? [], [definition]);
  const visibleFieldModules = useMemo(() => {
    const query = moduleQuery.trim().toLocaleLowerCase();
    return builderFieldModules.filter((module) => (
      (moduleCategory === "All" || module.category === moduleCategory)
      && (
        !query
        || `${module.name} ${module.description} ${module.category}`
          .toLocaleLowerCase()
          .includes(query)
      )
    ));
  }, [moduleCategory, moduleQuery]);
  const attendeeFields = allFields.filter((field) => field.scope === "ATTENDEE");
  const hasAttendeeNameFields = (
    attendeeFields.some((field) => field.key === "first_name")
    && attendeeFields.some((field) => field.key === "last_name")
  ) || attendeeFields.some((field) => ["full_name", "name", "attendee_name", "guest_name"].includes(field.key));
  const roster = useMemo(() => definition ? getAttendeeRosterConfig(definition) : null, [definition]);
  const calculation = useMemo(() => {
    if (!definition) return null;
    return roster?.enabled
      ? calculateRosterTotal(definition, responses, previewAttendees.map((attendee) => attendee.responses), pricingPreviewDate)
      : calculateFormTotal(definition, responses, pricingPreviewDate);
  }, [definition, pricingPreviewDate, previewAttendees, responses, roster?.enabled]);
  const previewVisibleFieldKeys = useMemo(() => {
    const visible = new Set<string>();
    if (!definition) return visible;
    for (const field of allFields) {
      if (!roster?.enabled) {
        if (isFieldVisible(field, responses)) visible.add(field.key);
        continue;
      }
      if (field.scope === "REGISTRATION" && isFieldVisible(field, responses)) {
        visible.add(field.key);
      }
      if (
        field.scope === "ATTENDEE"
        && previewAttendees.some((attendee) => (
          isFieldVisible(field, { ...responses, ...attendee.responses })
        ))
      ) {
        visible.add(field.key);
      }
    }
    return visible;
  }, [allFields, definition, previewAttendees, responses, roster?.enabled]);
  const previewSteps = useMemo(
    () => definition
      ? getPublicRegistrationStepPlan(definition, previewVisibleFieldKeys)
      : [],
    [definition, previewVisibleFieldKeys],
  );
  const previewStepIndex = Math.max(
    previewSteps.findIndex((step) => step.id === previewStepId),
    0,
  );
  const previewStep = previewSteps[previewStepIndex] ?? null;
  const paymentMethodFields = allFields.filter((field) => field.scope === "REGISTRATION" && isChoiceFieldType(field.type));
  const scheduledPriceFields = allFields.filter((field) => field.latePricing);
  const publishedVersion = selectedForm?.versions.find((version) => version.status === "PUBLISHED") ?? null;
  const isHistorical = Boolean(selectedVersion && selectedForm && selectedVersion.id !== selectedForm.activeVersion.id);
  // The current version is always editable. When it is live or withdrawn, the
  // first save creates a new draft version (#564); the live version is never
  // changed in place. Only superseded historical versions are read-only.
  const canEdit = Boolean(selectedVersion && !isHistorical);
  const editsCreateDraft = Boolean(selectedVersion && selectedVersion.status !== "DRAFT");
  const hasValidTest = Boolean(selectedVersion?.testSubmissions.some((submission) => submission.isValid));
  // Publishing requires a valid test submission against the selected version
  // itself, every time (#564). Earlier publications do not count.
  const hasEverPublished = Boolean(selectedForm?.versions.some((version) => version.publishedAt));
  const publishBlockedReason = dirty
    ? "Save your changes as a draft before publishing."
    : !hasValidTest
      ? "Run a test submission first: open the last step of the preview and choose Run test submission."
      : "";
  // A form copied from a template can keep the template's web address after
  // its title changes. Before a form's first publish only, offer to sync the
  // slug to the current title — after that, shared links depend on the slug
  // never changing on its own (#476).
  // A `title-N` slug that creation added counts as matching. The server
  // makes the final call and picks a free address to offer.
  const slugMayNeedSync = Boolean(
    selectedForm && definition && !hasEverPublished && definition.title.trim() && !slugMatchesTitle(selectedForm.slug, definition.title),
  );

  function replaceDefinition(next: RegistrationFormDefinition) {
    setDefinition(next); setDirty(true); setNotice(""); setError(""); setTestIssues([]);
  }

  function syncForm(form: FormView, message?: string, preserveTestResponses = false) {
    setForms((current) => [form, ...current.filter((item) => item.id !== form.id)]);
    setSelectedFormId(form.id);
    setSelectedVersionId(form.activeVersion.id);
    const nextDefinition = structuredClone(form.activeVersion.definition);
    setDefinition(nextDefinition);
    setDirty(false);
    if (!preserveTestResponses) {
      setResponses({});
      setPreviewAttendees(blankPreviewAttendees(nextDefinition));
      setPreviewStepId(firstPreviewStepId(nextDefinition));
      setTestIssues([]);
      setExpandedFieldId(null);
      closeModuleLibrary();
    }
    if (message) setNotice(message);
  }

  async function createFromTemplate(templateKey: string) {
    setBusy("create"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/forms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateKey }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to create this form.");
      syncForm(result.form, "Draft created from the selected template.");
      recordTemplateCleanupCreated(result.form.id, result.form.activeVersion.definition);
      setShowTemplates(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to create this form."); }
    finally { setBusy(null); }
  }

  async function saveDraft() {
    if (!selectedForm || !selectedVersion || !definition) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/forms/${selectedForm.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition, expectedUpdatedAt: selectedVersion.updatedAt }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to save this draft.");
      syncForm(result.form, editsCreateDraft ? `Version ${result.form.activeVersion.versionNumber} was saved as a new draft. The ${selectedVersion.status === "PUBLISHED" ? "published version stays live" : "withdrawn version stays withdrawn"} until you test and publish this draft.` : "Draft saved locally.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save this draft."); }
    finally { setBusy(null); }
  }

  async function runTest() {
    if (!selectedForm || !selectedVersion) return;
    if (dirty) { setError("Save the draft before running a test submission."); return; }
    setBusy("test"); setError(""); setNotice(""); setTestIssues([]);
    try {
      const response = await fetch(`/api/events/${eventId}/forms/${selectedForm.id}/test-submissions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: selectedVersion.id,
          responses,
          ...(roster?.enabled ? { attendees: previewAttendees } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to run this test submission.");
      const issues = result.submission.validation.issues ?? [];
      const refreshed = await fetch(`/api/events/${eventId}/forms/${selectedForm.id}`);
      if (refreshed.ok) syncForm((await refreshed.json()).form, undefined, true);
      setTestIssues(issues);
      if (issues.length > 0) {
        const issueStep = previewSteps.find((step) => (
          step.fieldKeys.includes(issues[0].key)
          || (issues[0].key === "attendees" && step.managesAttendees)
        ));
        if (issueStep) setPreviewStepId(issueStep.id);
      }
      setNotice(result.submission.isValid ? "Valid test submission saved. This draft is eligible to publish." : "Test saved with validation issues. Correct the highlighted responses and try again.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to run this test submission."); }
    finally { setBusy(null); }
  }

  async function beginPublish() {
    if (!selectedForm || !slugMayNeedSync) { setConfirmingPublish(true); return; }
    setBusy("slug"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/forms/${selectedForm.id}/slug`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to check the web address.");
      if (result.suggestion.needsSync) { setSlugError(""); setSlugPrompt({ offeredSlug: result.suggestion.offeredSlug }); }
      else setConfirmingPublish(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to check the web address."); }
    finally { setBusy(null); }
  }

  function keepSlug() {
    setSlugPrompt(null); setSlugError(""); setConfirmingPublish(true);
  }

  async function updateSlug() {
    if (!selectedForm || !slugPrompt) return;
    setBusy("slug"); setSlugError("");
    try {
      const response = await fetch(`/api/events/${eventId}/forms/${selectedForm.id}/slug`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slugPrompt.offeredSlug }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to update the web address.");
      syncForm(result.form, `The web address is now /register/${eventSlug}/${result.form.slug}.`, true);
      setSlugPrompt(null);
      setConfirmingPublish(true);
    } catch (caught) { setSlugError(caught instanceof Error ? caught.message : "Unable to update the web address."); }
    finally { setBusy(null); }
  }

  async function publish() {
    if (!selectedForm) return;
    setBusy("publish"); setError(""); setNotice(""); setConfirmingPublish(false);
    try {
      const response = await fetch(`/api/events/${eventId}/forms/${selectedForm.id}/publish`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to publish this form.");
      syncForm(result.form, `Version ${result.form.activeVersion.versionNumber} is published. The public registration link is now available; future edits create a new draft version.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to publish this form."); }
    finally { setBusy(null); }
  }

  async function unpublish() {
    if (!selectedForm) return;
    setBusy("unpublish"); setError(""); setNotice(""); setConfirmingUnpublish(false);
    try {
      const response = await fetch(`/api/events/${eventId}/forms/${selectedForm.id}/unpublish`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to withdraw this form.");
      syncForm(result.form, "This form is withdrawn: it is no longer offered on the public event page and registration is closed. Registrations already taken keep the exact questions and prices they were submitted under. To offer it again, save a new draft, run a fresh test submission against it, then publish.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to withdraw this form."); }
    finally { setBusy(null); }
  }

  function chooseForm(form: FormView) {
    if (dirty && !window.confirm("Discard the unsaved draft changes and open another form?")) return;
    const nextDefinition = structuredClone(form.activeVersion.definition);
    setSelectedFormId(form.id); setSelectedVersionId(form.activeVersion.id); setDefinition(nextDefinition); setDirty(false); setResponses({}); setPreviewAttendees(blankPreviewAttendees(nextDefinition)); setPreviewStepId(firstPreviewStepId(nextDefinition)); setTestIssues([]); setExpandedFieldId(null); closeModuleLibrary(); setNotice(""); setError("");
  }

  function chooseVersion(version: FormVersionView) {
    if (dirty && !window.confirm("Discard the unsaved draft changes and view another version?")) return;
    const nextDefinition = structuredClone(version.definition);
    setSelectedVersionId(version.id); setDefinition(nextDefinition); setDirty(false); setResponses({}); setPreviewAttendees(blankPreviewAttendees(nextDefinition)); setPreviewStepId(firstPreviewStepId(nextDefinition)); setExpandedFieldId(null); closeModuleLibrary(); setNotice(""); setError(""); setTestIssues([]);
  }

  function updateSection(index: number, patch: Partial<RegistrationFormDefinition["sections"][number]>) {
    if (!definition) return;
    const sections = definition.sections.map((section, sectionIndex) => sectionIndex === index ? { ...section, ...patch } : section);
    replaceDefinition({ ...definition, sections });
  }

  function updateField(sectionIndex: number, fieldIndex: number, patch: Partial<RegistrationFormField>) {
    if (!definition) return;
    const sections = definition.sections.map((section, currentSection) => currentSection === sectionIndex ? {
      ...section, fields: section.fields.map((field, currentField) => currentField === fieldIndex ? { ...field, ...patch } : field),
    } : section);
    replaceDefinition({ ...definition, sections });
  }

  function updateNumberBounds(sectionIndex: number, fieldIndex: number, field: RegistrationFormField, edge: "minimumAge" | "maximumAge", raw: string) {
    const parsed = raw.trim() === "" ? null : Math.min(isAgeFieldKey(field.key) ? 130 : 100000, Math.max(0, Math.floor(Number(raw))));
    const value = parsed === null || Number.isNaN(parsed) ? null : parsed;
    const next = { minimumAge: field.ageBounds?.minimumAge ?? null, maximumAge: field.ageBounds?.maximumAge ?? null, [edge]: value };
    updateField(sectionIndex, fieldIndex, { ageBounds: next.minimumAge === null && next.maximumAge === null ? undefined : next });
  }

  function moveField(sectionIndex: number, fieldIndex: number, direction: -1 | 1) {
    if (!definition) return;
    const nextIndex = fieldIndex + direction;
    const section = definition.sections[sectionIndex];
    if (nextIndex < 0 || nextIndex >= section.fields.length) return;
    const fields = [...section.fields];
    [fields[fieldIndex], fields[nextIndex]] = [fields[nextIndex], fields[fieldIndex]];
    updateSection(sectionIndex, { fields });
  }

  function moveSection(sectionIndex: number, direction: -1 | 1) {
    if (!definition) return;
    const nextIndex = sectionIndex + direction;
    if (nextIndex < 0 || nextIndex >= definition.sections.length) return;
    const reviewSectionIndex = definition.sections.findIndex((section) => (
      isPublicReviewSection(definition, section)
    ));
    if (
      sectionIndex === reviewSectionIndex
      || (direction === 1 && nextIndex === reviewSectionIndex)
    ) return;
    const sections = [...definition.sections];
    [sections[sectionIndex], sections[nextIndex]] = [sections[nextIndex], sections[sectionIndex]];
    replaceDefinition({ ...definition, sections });
  }

  function dropSection(targetIndex: number) {
    if (!definition || dragging?.kind !== "section") return;
    const source = definition.sections[dragging.sectionIndex];
    if (isPublicReviewSection(definition, source)) {
      setDragging(null);
      return;
    }
    const sections = [...definition.sections];
    const [section] = sections.splice(dragging.sectionIndex, 1);
    const reviewIndex = sections.findIndex((candidate) => (
      isPublicReviewSection({ ...definition, sections }, candidate)
    ));
    const adjustedTarget = dragging.sectionIndex < targetIndex
      ? targetIndex - 1
      : targetIndex;
    sections.splice(
      reviewIndex >= 0 ? Math.min(adjustedTarget, reviewIndex) : adjustedTarget,
      0,
      section,
    );
    setDragging(null);
    replaceDefinition({ ...definition, sections });
  }

  function dropField(targetSectionIndex: number, targetFieldIndex: number) {
    if (!definition || dragging?.kind !== "field") return;
    const { sectionIndex: sourceSectionIndex, fieldIndex: sourceFieldIndex } = dragging;
    if (sourceSectionIndex !== targetSectionIndex && definition.sections[sourceSectionIndex].fields.length === 1) {
      setDragging(null);
      setError("Each section must keep at least one field. Add another field before moving this one.");
      return;
    }
    const sections = structuredClone(definition.sections);
    const [field] = sections[sourceSectionIndex].fields.splice(sourceFieldIndex, 1);
    sections[targetSectionIndex].fields.splice(targetFieldIndex, 0, field);
    setDragging(null);
    replaceDefinition({ ...definition, sections });
  }

  function showPreview() {
    previewRef.current?.focus({ preventScroll: true });
    previewRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
  }

  function removeField(sectionIndex: number, fieldIndex: number) {
    if (!definition) return;
    const section = definition.sections[sectionIndex];
    if (section.fields.length === 1) { setError("Each section must keep at least one field."); return; }
    updateSection(sectionIndex, { fields: section.fields.filter((_, index) => index !== fieldIndex) });
  }

  function resetRemovalAnswerCounts() {
    removalAnswerRequestId.current += 1;
    setRemovalAnswerCounts(null);
    setRemovalAnswerCountsLoading(false);
  }

  /**
   * Best-effort real counts for the removal dialog (#471), in batches the
   * route accepts. Any failure (HTTP error, network error, bad body) leaves
   * the counts null, which the dialog words neutrally rather than as "no
   * answers"; a stale response never overwrites a newer lookup.
   */
  async function loadRemovalAnswerCounts(fieldKeys: string[]) {
    const requestId = removalAnswerRequestId.current + 1;
    removalAnswerRequestId.current = requestId;
    setRemovalAnswerCounts(null);
    if (!selectedForm) { setRemovalAnswerCountsLoading(false); return; }
    setRemovalAnswerCountsLoading(true);
    let merged: Record<string, number> | null = {};
    try {
      for (const batch of batchFieldKeys(fieldKeys)) {
        const response = await fetch(
          `/api/events/${selectedForm.eventId}/forms/${selectedForm.id}/field-answer-counts`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fieldKeys: batch }),
          },
        );
        const result = await response.json().catch(() => ({})) as { counts?: Record<string, number> };
        if (!response.ok || !result.counts) { merged = null; break; }
        merged = { ...merged, ...result.counts };
      }
    } catch {
      merged = null;
    }
    if (removalAnswerRequestId.current !== requestId) return;
    setRemovalAnswerCounts(merged);
    setRemovalAnswerCountsLoading(false);
  }

  function openRemoveField(sectionIndex: number, fieldIndex: number) {
    if (!definition) return;
    const section = definition.sections[sectionIndex];
    if (section.fields.length === 1) { setError("Each section must keep at least one field."); return; }
    const field = section.fields[fieldIndex];
    setRemoveFieldTarget({ sectionIndex, fieldIndex, field });
    void loadRemovalAnswerCounts([field.key]);
  }

  function confirmRemoveField() {
    if (!removeFieldTarget) return;
    removeField(removeFieldTarget.sectionIndex, removeFieldTarget.fieldIndex);
    setRemoveFieldTarget(null);
    resetRemovalAnswerCounts();
  }

  function duplicateField(sectionIndex: number, fieldIndex: number) {
    if (!definition) return;
    const source = definition.sections[sectionIndex].fields[fieldIndex];
    if (definition.sections[sectionIndex].fields.length >= 20) {
      setError("A section can contain up to 20 fields. Add another section before copying this field.");
      return;
    }
    const usedKeys = new Set(allFields.map((field) => field.key));
    const baseKey = `${source.key.slice(0, 55)}_copy`;
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${baseKey.slice(0, 57)}_${suffix}`;
      suffix += 1;
    }
    const duplicate = {
      ...structuredClone(source),
      id: localId("field"),
      key,
      label: `${source.label} copy`.slice(0, 120),
    };
    const fields = [...definition.sections[sectionIndex].fields];
    fields.splice(fieldIndex + 1, 0, duplicate);
    updateSection(sectionIndex, { fields });
    setExpandedFieldId(duplicate.id);
  }

  function closeModuleLibrary() {
    setOpenModuleSection(null);
    setModuleQuery("");
    setModuleCategory("All");
  }

  function addModule(sectionIndex: number, module: BuilderModuleDefinition) {
    if (!definition) return;
    const existingFields = definition.sections.flatMap((section) => section.fields);
    const plan = planModuleInsert(module, existingFields, () => localId("field"));
    if (plan.kind === "already-present") {
      const existing = existingFields.find((field) => plan.existingKeys.includes(field.key));
      setExpandedFieldId(existing?.id ?? null);
      closeModuleLibrary();
      setNotice(moduleAlreadyPresentNotice(module, plan));
      return;
    }
    const { fields } = plan;
    if (definition.sections[sectionIndex].fields.length + fields.length > 20) {
      setError(
        `${module.name} does not fit in this section. Add another section and place the module there.`,
      );
      return;
    }
    const section = definition.sections[sectionIndex];
    const sections = definition.sections.map((candidate, index) => index === sectionIndex
      ? { ...candidate, fields: [...section.fields, ...fields] }
      : candidate);
    const attendeeRoster = moduleAttendeeRoster(definition.attendeeRoster, module);
    const nextDefinition = { ...definition, sections, attendeeRoster };
    replaceDefinition(nextDefinition);
    if (module.enablesAttendeeRoster && !definition.attendeeRoster?.enabled) {
      setPreviewAttendees(blankPreviewAttendees(nextDefinition));
    }
    setExpandedFieldId(fields[0]?.id ?? null);
    closeModuleLibrary();
    const insertNotice = moduleInsertNotice(plan);
    if (insertNotice) setNotice(insertNotice);
  }

  function addSection() {
    if (!definition) return;
    const sections = [...definition.sections];
    const reviewIndex = sections.findIndex((section) => (
      isPublicReviewSection(definition, section)
    ));
    sections.splice(
      reviewIndex >= 0 ? reviewIndex : sections.length,
      0,
      {
        id: localId("section"),
        title: "New section",
        description: "",
        fields: [defaultField(totalFields + 1)],
      },
    );
    replaceDefinition({ ...definition, sections });
  }

  function removeSection(sectionIndex: number) {
    if (!definition) return;
    if (definition.sections.length === 1) { setError("A form must keep at least one section."); return; }
    replaceDefinition({ ...definition, sections: definition.sections.filter((_, index) => index !== sectionIndex) });
  }

  function openRemoveSection(sectionIndex: number) {
    if (!definition) return;
    if (definition.sections.length === 1) { setError("A form must keep at least one section."); return; }
    const section = definition.sections[sectionIndex];
    setRemoveSectionTarget({ sectionIndex, section });
    void loadRemovalAnswerCounts(section.fields.map((field) => field.key));
  }

  function confirmRemoveSection() {
    if (!removeSectionTarget) return;
    removeSection(removeSectionTarget.sectionIndex);
    setRemoveSectionTarget(null);
    resetRemovalAnswerCounts();
  }

  function setReviewSection(sectionIndex: number, enabled: boolean) {
    if (!definition) return;
    const sections = definition.sections.map((section, index) => ({
      ...section,
      isReviewStep: enabled ? index === sectionIndex : index === sectionIndex
        ? false
        : section.isReviewStep ?? false,
    }));
    if (enabled) {
      const [reviewSection] = sections.splice(sectionIndex, 1);
      sections.push(reviewSection);
    }
    closeModuleLibrary();
    replaceDefinition({ ...definition, sections });
  }

  function renderPreviewField(
    field: RegistrationFormField,
    options: {
      valueResponses?: Record<string, PreviewValue>;
      idPrefix?: string;
      attendeeIndex?: number | null;
      onChange?: (key: string, value: PreviewValue) => void;
    } = {},
  ) {
    const valueResponses = options.valueResponses ?? responses;
    const attendeeIndex = options.attendeeIndex ?? null;
    const issue = testIssues.find((item) => item.key === field.key && (item.attendeeIndex ?? null) === attendeeIndex);
    const className = issue ? "preview-field invalid" : "preview-field";
    const inputId = `preview_${options.idPrefix ?? "registration"}_${field.id}`;
    const selectedValues = Array.isArray(valueResponses[field.key]) ? valueResponses[field.key] as string[] : [];
    const maximum = field.maxSelections ?? (field.type === "RANKED_CHOICE" ? 2 : field.options.length);
    const setValue = (value: PreviewValue) => {
      if (options.onChange) options.onChange(field.key, value);
      else setResponses((current) => ({ ...current, [field.key]: value }));
    };
    const toggleChoice = (option: string) => {
      if (selectedValues.includes(option)) setValue(selectedValues.filter((value) => value !== option));
      else if (selectedValues.length < maximum) setValue([...selectedValues, option]);
    };
    const fieldHeading = <span>{field.label}{field.required && <b> *</b>}</span>;
    const supportingText = <>{field.helpText && <small>{field.helpText}</small>}{issue && <small className="field-error">{issue.message}</small>}</>;
    const choiceStatus = (option: string) => {
      const stats = selectedVersion?.choiceUsage?.[field.key]?.[option] ?? { total: 0, first: 0, second: 0 };
      const limit = field.choiceLimits?.[option];
      return { stats, limit, full: Boolean(limit && stats.total >= limit) };
    };
    const choiceCount = (option: string, ranked = false) => {
      const { stats, limit, full } = choiceStatus(option);
      const tracksAvailability = getAvailabilityMode(field) !== "NONE";
      const price = isLatePricingActive(field, pricingPreviewDate) ? field.latePricing?.choicePricesCents?.[option] ?? field.choicePricesCents?.[option] : field.choicePricesCents?.[option];
      if (price === undefined && !tracksAvailability) return null;
      return <small className={full ? "choice-availability full" : "choice-availability"}>{price !== undefined && <>{money(price)}{tracksAvailability ? " · " : ""}</>}{tracksAvailability && <>{ranked && <>{stats.first} first · {stats.second} second · </>}{stats.total} interested{limit ? ` · limit ${limit}` : " · unlimited"}</>}</small>;
    };
    const choiceDescription = (option: string) => {
      const description = field.optionDescriptions?.[option]?.trim();
      return description
        ? <small className="choice-description">{description}</small>
        : null;
    };
    const optionLabel = (option: string) => field.optionLabels?.[option] ?? option;

    if (field.type === "RADIO") return <fieldset className={className} key={field.id}><legend>{fieldHeading}</legend><div className="preview-choice-list">{field.options.map((option) => { const { full } = choiceStatus(option); return <label className={full ? "preview-option full" : "preview-option"} key={option}><input name={inputId} type="radio" checked={valueResponses[field.key] === option} disabled={full && valueResponses[field.key] !== option} onChange={() => setValue(option)} /> <span><strong>{optionLabel(option)}</strong>{choiceDescription(option)}{choiceCount(option)}</span></label>; })}</div>{supportingText}</fieldset>;
    if (field.type === "MULTISELECT") return <fieldset className={className} key={field.id}><legend>{fieldHeading}</legend><small>Choose {field.minSelections ? `at least ${field.minSelections} and ` : ""}up to {maximum}</small><div className="preview-choice-list">{field.options.map((option) => { const { full } = choiceStatus(option); return <label className={full ? "preview-option full" : "preview-option"} key={option}><input type="checkbox" checked={selectedValues.includes(option)} disabled={!selectedValues.includes(option) && (selectedValues.length >= maximum || full)} onChange={() => toggleChoice(option)} /> <span><strong>{option}</strong>{choiceDescription(option)}{choiceCount(option)}</span></label>; })}</div>{supportingText}</fieldset>;
    if (field.type === "RANKED_CHOICE") return <fieldset className={className} key={field.id}><legend>{fieldHeading}</legend><small>Choose {field.minSelections ?? (field.required ? Math.min(2, maximum) : 1)} and rank up to {maximum}. The first selected is first choice; the second is second choice.</small><div className="preview-ranking-list">{field.options.map((option) => { const rank = selectedValues.indexOf(option); const { full } = choiceStatus(option); return <button aria-pressed={rank >= 0} className={`${rank >= 0 ? "selected" : ""}${full ? " full" : ""}`.trim()} type="button" key={option} disabled={rank < 0 && (selectedValues.length >= maximum || full)} onClick={() => toggleChoice(option)}><span><strong>{option}</strong>{choiceDescription(option)}{choiceCount(option, true)}</span><b>{rank >= 0 ? (rank === 0 ? "1st choice" : rank === 1 ? "2nd choice" : `#${rank + 1}`) : full ? "Full" : "Choose"}</b></button>; })}</div>{supportingText}</fieldset>;
    if (field.type === "CHECKBOX") return <fieldset className={className} key={field.id}><legend>{fieldHeading}</legend><label className="preview-check"><input id={inputId} type="checkbox" checked={valueResponses[field.key] === true} onChange={(event) => setValue(event.target.checked)} /> <span>{field.placeholder || "Yes, I agree"}</span></label>{supportingText}</fieldset>;
    if (field.type === "CALCULATED") return <div className="preview-field preview-calculated-field" key={field.id}><span>{field.label}</span><small>Automatically included in the order total.{field.latePricing ? ` ${field.latePricing.label} begins ${new Date(`${field.latePricing.startsOn}T12:00:00`).toLocaleDateString()}.` : ""}</small></div>;
    if (field.type === "ADDRESS") return <AddressFieldGroup key={field.id} className={className} legend={fieldHeading} idPrefix={inputId} required={field.required} invalid={Boolean(issue)} value={(valueResponses[field.key] as AddressValue | undefined) ?? {}} onChange={(next) => setValue(next)} helpText={field.helpText} supporting={issue && <small className="field-error">{issue.message}</small>} />;
    if (field.type === "SELECT") return <div className={className} key={field.id}><label htmlFor={inputId}>{fieldHeading}</label><SearchableSelect id={inputId} value={typeof valueResponses[field.key] === "string" ? valueResponses[field.key] as string : ""} required={field.required} invalid={Boolean(issue)} placeholder={`Search ${field.label.toLocaleLowerCase()}…`} options={field.options.map((option) => ({ value: option, label: optionLabel(option), disabled: choiceStatus(option).full && valueResponses[field.key] !== option }))} onChange={(value) => setValue(value)} />{supportingText}</div>;

    const common = { id: inputId, value: typeof valueResponses[field.key] === "string" ? valueResponses[field.key] as string : "", placeholder: field.placeholder ?? "", onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setValue(event.target.value) };
    return <label className={className} key={field.id}>{fieldHeading}{field.type === "LONG_TEXT" ? <textarea {...common} rows={4} /> : <input {...common} type={field.type === "EMAIL" ? "email" : field.type === "PHONE" ? "tel" : field.type === "DATE" ? "date" : field.type === "NUMBER" ? "number" : "text"} />}{supportingText}</label>;
  }

  function setPreviewAttendeeValue(clientId: string, key: string, value: PreviewValue) {
    setPreviewAttendees((current) => current.map((attendee) => attendee.clientId === clientId
      ? { ...attendee, responses: { ...attendee.responses, [key]: value } }
      : attendee));
  }

  function movePreviewAttendee(index: number, direction: -1 | 1) {
    setPreviewAttendees((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function renderPreviewSections(allowedFieldKeys: ReadonlySet<string>) {
    if (!definition || !previewStep?.sectionId) return null;
    const section = definition.sections.find((candidate) => (
      candidate.id === previewStep.sectionId
    ));
    if (!section) return null;
    const visibleFields = section.fields.filter((field) => (
      allowedFieldKeys.has(field.key)
      && (!roster?.enabled || field.scope === "REGISTRATION")
      && isFieldVisible(field, responses)
    ));
    return visibleFields.length > 0 && (
      <section className="preview-linked-section" aria-label={section.title}>
        {visibleFields.map((field) => renderPreviewField(field))}
      </section>
    );
  }

  function renderPreviewRoster(allowedFieldKeys: ReadonlySet<string>) {
    if (!definition || !roster?.enabled || !previewStep?.sectionId) return null;
    const stepSection = definition.sections.find((section) => (
      section.id === previewStep.sectionId
    ));
    const hasAllowedAttendeeFields = stepSection?.fields.some((field) => (
        field.scope === "ATTENDEE" && allowedFieldKeys.has(field.key)
    ));
    if (!hasAllowedAttendeeFields) return null;

    return <section className="preview-roster">
      <div className="preview-roster-heading">
        <span>
          <h4>{previewStep.managesAttendees ? "Who is attending?" : "Choices for each attendee"}</h4>
          <small>{previewAttendees.length} of {roster.maxAttendees} {roster.attendeeLabel.toLowerCase()}{roster.maxAttendees === 1 ? "" : "s"}</small>
        </span>
      </div>
      {previewAttendees.map((attendee, attendeeIndex) => {
        const merged = { ...responses, ...attendee.responses };
        const enteredName = `${String(attendee.responses.first_name ?? "")} ${String(attendee.responses.last_name ?? "")}`.trim()
          || String(attendee.responses.attendee_name ?? attendee.responses.guest_name ?? "");
        return <article className="preview-attendee-card" key={attendee.clientId}>
          <header>
            <span><strong>{roster.attendeeLabel} {attendeeIndex + 1}</strong>{enteredName && <small>{enteredName}</small>}</span>
            <div>
              <button type="button" aria-label={`Move ${roster.attendeeLabel} ${attendeeIndex + 1} up`} disabled={attendeeIndex === 0} onClick={() => movePreviewAttendee(attendeeIndex, -1)}><ArrowUp size={13} /></button>
              <button type="button" aria-label={`Move ${roster.attendeeLabel} ${attendeeIndex + 1} down`} disabled={attendeeIndex === previewAttendees.length - 1} onClick={() => movePreviewAttendee(attendeeIndex, 1)}><ArrowDown size={13} /></button>
              <button type="button" aria-label={`Remove ${roster.attendeeLabel} ${attendeeIndex + 1}`} disabled={previewAttendees.length <= roster.minAttendees} onClick={() => setPreviewAttendees((current) => current.filter((candidate) => candidate.clientId !== attendee.clientId))}><Trash2 size={13} /></button>
            </div>
          </header>
          {definition.sections.map((section) => {
            const fields = section.fields.filter((field) => (
              field.scope === "ATTENDEE"
              && allowedFieldKeys.has(field.key)
              && isFieldVisible(field, merged)
            ));
            return fields.length > 0 && (
              <div className="preview-attendee-fields" key={`${attendee.clientId}_${section.id}`}>
                {fields.map((field) => renderPreviewField(field, {
                  valueResponses: attendee.responses,
                  idPrefix: attendee.clientId,
                  attendeeIndex,
                  onChange: (key, value) => setPreviewAttendeeValue(attendee.clientId, key, value),
                }))}
              </div>
            );
          })}
        </article>;
      })}
      {previewStep.managesAttendees && (
        <button className="preview-add-attendee" type="button" disabled={previewAttendees.length >= roster.maxAttendees} onClick={() => setPreviewAttendees((current) => [...current, { clientId: localId("preview_attendee"), responses: {} }])}>
          <Plus size={14} /> {roster.addButtonLabel}
        </button>
      )}
    </section>;
  }

  const previewAllowedFieldKeys = new Set(previewStep?.fieldKeys ?? []);

  return <section className="page-stack builder-workspace">
    <div className="page-intro"><div><p className="eyebrow">Public registration setup</p><h2>Registration builder</h2><p>Create, arrange, preview, test, and publish versioned registration forms for {eventName} without code.</p></div><div className="intro-actions"><span className="count-badge"><ShieldCheck size={16} /> Safe draft editing</span>{definition && <button className="secondary-button" type="button" onClick={showPreview}><Eye size={16} /> Preview &amp; test</button>}<button className="primary-button" type="button" onClick={() => setShowTemplates((value) => !value)}><CopyPlus size={16} /> New from template</button></div></div>

    {showTemplates && <section className="panel builder-template-panel"><div className="section-heading"><div><p className="eyebrow">Start with a safe foundation</p><h2>Choose a template</h2></div><button className="icon-button" aria-label="Close templates" type="button" onClick={() => setShowTemplates(false)}><X size={18} /></button></div><div className="template-card-grid">{templatesForPicker(templates, eventAudience, eventBillingMode).map((template) => <article className="template-card" key={template.key}><span><Layers3 size={20} /></span><small>{template.audience}</small><h3>{template.name}</h3><p>{template.description}</p><div>{template.sectionCount} sections · {template.fieldCount} fields</div><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => createFromTemplate(template.key)}>Use template <ChevronRight size={15} /></button></article>)}</div></section>}

    {error && <div className="inline-notice error" role="alert">{error}</div>}
    {notice && <div className="inline-notice" role="status">{notice}</div>}

    {forms.length === 0 ? <section className="panel builder-empty"><CopyPlus size={32} /><h2>Create the first registration form</h2><p>Choose “Blank form” or a tested local template to begin. Nothing will be published publicly or sent to an external service.</p></section> : <div className="builder-layout">
      <aside className="panel builder-form-list"><div className="section-heading"><div><p className="eyebrow">Event forms</p><h2>{forms.length} form{forms.length === 1 ? "" : "s"}</h2></div></div><div className="builder-form-buttons">{forms.map((form) => <button aria-pressed={form.id === selectedFormId} className={form.id === selectedFormId ? "selected" : ""} type="button" key={form.id} onClick={() => chooseForm(form)}><span><strong>{form.name}</strong><small>Version {form.activeVersion.versionNumber} · {statusLabel(form.activeVersion.status)}</small></span><ChevronRight size={16} /></button>)}</div>{selectedForm && <div className="version-history"><p className="eyebrow">Version history</p>{selectedForm.versions.map((version) => <button aria-pressed={version.id === selectedVersion?.id} className={version.id === selectedVersion?.id ? "selected" : ""} type="button" key={version.id} onClick={() => chooseVersion(version)}><FileClock size={15} /><span><strong>Version {version.versionNumber}</strong><small>{statusLabel(version.status)} · {version.testSubmissionCount} tests</small></span></button>)}</div>}</aside>

	      {selectedForm && selectedVersion && definition && <>
	        <div className="builder-canvas"><section className="panel builder-editor-head"><div className="builder-status-row"><span className={`status-chip ${selectedVersion.status === "PUBLISHED" ? "green" : selectedVersion.status === "DRAFT" ? "gold" : "purple"}`}>{statusLabel(selectedVersion.status)}</span><span>Version {selectedVersion.versionNumber}</span>{dirty && <span className="unsaved-dot">Unsaved changes</span>}</div><label>Form title<input disabled={!canEdit} value={definition.title} maxLength={120} onChange={(event) => replaceDefinition({ ...definition, title: event.target.value })} /></label><label>Description<textarea disabled={!canEdit} value={definition.description} maxLength={500} rows={2} onChange={(event) => replaceDefinition({ ...definition, description: event.target.value })} /></label><div className="builder-actions"><button className="secondary-button" type="button" disabled={!canEdit || (!dirty && !editsCreateDraft) || busy !== null} aria-describedby="builder-action-hints" onClick={saveDraft}><Save size={15} /> {busy === "save" ? "Saving…" : editsCreateDraft ? (dirty ? "Save as new draft" : "Create new version") : "Save draft"}</button>{publishedVersion ? <a className="secondary-button" href={`/register/${eventSlug}/${selectedForm.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open public form</a> : <button className="secondary-button" type="button" disabled title="Publish this form to create its public link"><ExternalLink size={15} /> Open public form</button>}{selectedVersion.status === "DRAFT" && <button className="primary-button" type="button" disabled={Boolean(publishBlockedReason) || busy !== null} aria-describedby="builder-action-hints" title={publishBlockedReason || undefined} onClick={beginPublish}><Send size={15} /> Publish version</button>}{publishedVersion && <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => setConfirmingUnpublish(true)}><FileClock size={15} /> Withdraw from public page</button>}</div><div id="builder-action-hints">{editsCreateDraft && !isHistorical && <p className="builder-gate"><FileClock size={15} /> {selectedVersion.status === "PUBLISHED" ? `Version ${selectedVersion.versionNumber} is live and is never changed in place.` : `Version ${selectedVersion.versionNumber} is withdrawn from the public page.`} {dirty ? "Choose Save as new draft to keep your edits; until then they are not saved." : "Make your edits, or choose Create new version to start a draft from it."} Existing registrations keep the version they were submitted under.</p>}{selectedVersion.status === "DRAFT" && dirty && <p className="builder-gate"><AlertTriangle size={15} /> Save this draft to enable Publish version.</p>}{selectedVersion.status === "DRAFT" && !dirty && !hasValidTest && <p className="builder-gate"><AlertTriangle size={15} /> Run a test submission first. Publishing needs a valid test against this version (version {selectedVersion.versionNumber}), and saving edits clears earlier tests. <a href="#live-form-preview" onClick={() => { const last = previewSteps[previewSteps.length - 1]; if (last) setPreviewStepId(last.id); }}>Go to the test panel</a></p>}</div>{isHistorical && <p className="builder-gate"><FileClock size={15} /> Historical versions are immutable and shown read-only.</p>}</section>

        {canEdit && <TemplateCleanupChecklistPanel key={selectedForm.id} formId={selectedForm.id} definition={definition} />}

        <section className="panel roster-builder-settings">
          <div className="section-heading">
            <div><p className="eyebrow">Registration mode</p><h2>Who can this form register?</h2></div>
            {roster?.enabled && <span className="count-badge">{attendeeFields.length} repeating field{attendeeFields.length === 1 ? "" : "s"}</span>}
          </div>
          <div className="roster-mode-options" role="group" aria-label="Registration mode">
            <button aria-pressed={!roster?.enabled} className={!roster?.enabled ? "selected" : ""} type="button" disabled={!canEdit} onClick={() => {
              if (!roster?.enabled) return;
              replaceDefinition({ ...definition, attendeeRoster: undefined });
              setPreviewAttendees([]);
            }}><strong>One attendee</strong><small>Attendee fields are completed once.</small></button>
            <button aria-pressed={Boolean(roster?.enabled)} className={roster?.enabled ? "selected" : ""} type="button" disabled={!canEdit || attendeeFields.length === 0} onClick={() => {
              if (roster?.enabled) return;
              const next = { enabled: true, minAttendees: 1, maxAttendees: 8, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" };
              replaceDefinition({ ...definition, attendeeRoster: next });
              setPreviewAttendees(blankPreviewAttendees({ ...definition, attendeeRoster: next }));
            }}><strong>Household or group</strong><small>Attendee fields repeat for every person.</small></button>
          </div>
          {attendeeFields.length === 0 && <p className="builder-gate"><AlertTriangle size={15} /> Change at least one field’s “Applies to” setting to Each attendee before enabling a roster.</p>}
          {roster?.enabled && <>
            {!hasAttendeeNameFields && <p className="builder-gate"><AlertTriangle size={15} /> Add attendee first/last name fields or a supported full-name field before saving.</p>}
            <div className="roster-settings-grid">
              <label>Minimum attendees<input disabled={!canEdit} type="number" min={1} max={roster.maxAttendees} value={roster.minAttendees} onChange={(event) => {
                const minAttendees = Math.max(1, Math.min(roster.maxAttendees, Number(event.target.value) || 1));
                replaceDefinition({ ...definition, attendeeRoster: { ...roster, minAttendees } });
                setPreviewAttendees((current) => current.length >= minAttendees ? current : [...current, ...Array.from({ length: minAttendees - current.length }, () => ({ clientId: localId("preview_attendee"), responses: {} }))]);
              }} /></label>
              <label>Maximum attendees<input disabled={!canEdit} type="number" min={roster.minAttendees} max={50} value={roster.maxAttendees} onChange={(event) => {
                const maxAttendees = Math.max(roster.minAttendees, Math.min(50, Number(event.target.value) || roster.minAttendees));
                replaceDefinition({ ...definition, attendeeRoster: { ...roster, maxAttendees } });
                setPreviewAttendees((current) => current.slice(0, maxAttendees));
              }} /></label>
              <label>Person label<input disabled={!canEdit} value={roster.attendeeLabel} maxLength={40} onChange={(event) => replaceDefinition({ ...definition, attendeeRoster: { ...roster, attendeeLabel: event.target.value } })} /></label>
              <label>Add-button text<input disabled={!canEdit} value={roster.addButtonLabel} maxLength={80} onChange={(event) => replaceDefinition({ ...definition, attendeeRoster: { ...roster, addButtonLabel: event.target.value } })} /></label>
            </div>
          </>}
        </section>

        <p className="builder-draft-note"><small>{PUBLIC_DRAFT_STAFF_HELP}</small></p>

        {definition.sections.map((section, sectionIndex) => <section
          className={dragging?.kind === "section" && dragging.sectionIndex === sectionIndex ? "panel builder-section dragging" : "panel builder-section"}
          data-testid={`builder-section-${sectionIndex}`}
          key={section.id}
          onDragOver={(event) => { if (dragging) event.preventDefault(); }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging?.kind === "section") dropSection(sectionIndex);
            if (dragging?.kind === "field") dropField(sectionIndex, section.fields.length);
          }}
        >
          <div className="builder-section-head">
            <span className="section-number">{sectionIndex + 1}</span>
            <div className="builder-section-copy">
              <span className="builder-step-link">Public step {sectionIndex + 1}{isPublicReviewSection(definition, section) ? " · Final review" : ""}</span>
              <input aria-label={`Section ${sectionIndex + 1} title`} disabled={!canEdit} value={section.title} maxLength={120} onChange={(event) => updateSection(sectionIndex, { title: event.target.value })} />
              <input aria-label={`Section ${sectionIndex + 1} description`} className="section-description-input" disabled={!canEdit} value={section.description} maxLength={300} placeholder="Optional section description" onChange={(event) => updateSection(sectionIndex, { description: event.target.value })} />
              <div className="builder-step-settings">
                <label>Progress label<input aria-label={`Step ${sectionIndex + 1} progress label`} disabled={!canEdit} value={section.stepLabel ?? section.title.slice(0, 40)} maxLength={40} onChange={(event) => updateSection(sectionIndex, { stepLabel: event.target.value })} /></label>
                <label className="builder-review-toggle"><input disabled={!canEdit} type="checkbox" checked={isPublicReviewSection(definition, section)} onChange={(event) => setReviewSection(sectionIndex, event.target.checked)} /> Final review and payment step</label>
              </div>
            </div>
            {canEdit && <div className="section-actions">
              <button className="drag-handle" type="button" draggable={!isPublicReviewSection(definition, section)} disabled={isPublicReviewSection(definition, section)} aria-label={`Drag section ${section.title}`} title={isPublicReviewSection(definition, section) ? "The final review step stays last" : "Drag section"} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragging({ kind: "section", sectionIndex }); }} onDragEnd={() => setDragging(null)}><GripVertical size={15} /><span>Drag</span></button>
              <button type="button" aria-label={`Move section ${section.title} up`} disabled={sectionIndex === 0 || isPublicReviewSection(definition, section)} onClick={() => moveSection(sectionIndex, -1)}><ArrowUp size={14} /><span>Up</span></button>
              <button type="button" aria-label={`Move section ${section.title} down`} disabled={sectionIndex === definition.sections.length - 1 || isPublicReviewSection(definition, definition.sections[sectionIndex + 1]!)} onClick={() => moveSection(sectionIndex, 1)}><ArrowDown size={14} /><span>Down</span></button>
              <button className="danger" type="button" aria-label={`Remove ${section.title}`} onClick={() => openRemoveSection(sectionIndex)}><Trash2 size={14} /><span>Remove</span></button>
            </div>}
          </div>
          <div className="builder-fields">{section.fields.map((field, fieldIndex) => <article
            className={dragging?.kind === "field" && dragging.sectionIndex === sectionIndex && dragging.fieldIndex === fieldIndex ? "builder-field-card dragging" : "builder-field-card"}
             data-testid={`builder-field-${sectionIndex}-${fieldIndex}`}
             data-option-source={field.optionSource}
            key={field.id}
            onDragOver={(event) => { if (dragging?.kind === "field") event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dropField(sectionIndex, fieldIndex); }}
          >
            <div className="field-module-row">
              {canEdit ? <button className="drag-handle field-drag-handle" type="button" draggable aria-label={`Drag field ${field.label}`} title="Drag field" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragging({ kind: "field", sectionIndex, fieldIndex }); }} onDragEnd={() => setDragging(null)}><GripVertical size={16} /></button> : <GripVertical className="field-grip" size={17} />}
              <button className="field-module-summary" type="button" aria-expanded={expandedFieldId === field.id} aria-label={`${expandedFieldId === field.id ? "Close settings for" : "Edit"} ${field.label}`} onClick={() => setExpandedFieldId((current) => current === field.id ? null : field.id)}><span className="field-type-mark">{fieldTypeLabels[field.type].slice(0, 1)}</span><span><strong>{field.label}</strong><small>{fieldTypeLabels[field.type]} · {field.scope === "ATTENDEE" ? "Each attendee" : "Registration"}{field.required ? " · Required" : ""}</small></span><ChevronRight className={expandedFieldId === field.id ? "expanded" : ""} size={16} /></button>
              {canEdit && <div className="field-actions"><button type="button" aria-label={`Duplicate ${field.label}`} onClick={() => duplicateField(sectionIndex, fieldIndex)}><Copy size={14} /><span>Copy</span></button><button type="button" aria-label={`Move ${field.label} up`} disabled={fieldIndex === 0} onClick={() => moveField(sectionIndex, fieldIndex, -1)}><ArrowUp size={14} /><span>Up</span></button><button type="button" aria-label={`Move ${field.label} down`} disabled={fieldIndex === section.fields.length - 1} onClick={() => moveField(sectionIndex, fieldIndex, 1)}><ArrowDown size={14} /><span>Down</span></button><button className="danger" type="button" aria-label={`Remove ${field.label}`} onClick={() => openRemoveField(sectionIndex, fieldIndex)}><Trash2 size={14} /><span>Remove</span></button></div>}
            </div>
            {expandedFieldId === field.id && <div className="field-editor-body">
              <div className="field-settings field-basic-settings">
                <label>Label<input disabled={!canEdit} value={field.label} maxLength={120} onChange={(event) => updateField(sectionIndex, fieldIndex, { label: event.target.value, key: field.key.startsWith("new_field_") ? fieldKey(event.target.value) : field.key })} /></label>
                <label>Field type<select disabled={!canEdit} value={field.type} onChange={(event) => { const requestedType = event.target.value as RegistrationFormField["type"]; const type = defaultTypeForNewChoiceField(field.type, requestedType, field.options.length < 2 ? 2 : field.options.length); if (type !== requestedType) setAutoRadioFieldIds((current) => new Set(current).add(field.id)); const choiceType = isChoiceFieldType(type); const changedPricingKind = choiceType !== isChoiceFieldType(field.type); const nextOptions = choiceType ? (field.options.length < 2 ? ["Option one", "Option two"] : field.options) : []; updateField(sectionIndex, fieldIndex, { type, required: type === "CALCULATED" ? false : field.required, options: nextOptions, optionDescriptions: choiceType && field.options.length >= 2 ? field.optionDescriptions : undefined, minSelections: type === "RANKED_CHOICE" ? field.minSelections ?? 2 : type === "MULTISELECT" ? field.minSelections ?? 1 : undefined, maxSelections: type === "MULTISELECT" || type === "RANKED_CHOICE" ? field.maxSelections ?? 2 : undefined, availabilityMode: choiceType ? field.availabilityMode : undefined, choiceLimits: choiceType ? field.choiceLimits : undefined, choicePricesCents: choiceType ? field.choicePricesCents : undefined, latePricing: changedPricingKind ? undefined : field.latePricing, ...creditPatchForKindChange(field, { type }) }); }}>{formFieldTypes.map((type) => <option key={type} value={type}>{fieldTypeLabels[type]}</option>)}</select></label>
                <label>Applies to<select disabled={!canEdit} value={field.scope} onChange={(event) => {
                  const scope = event.target.value as RegistrationFormField["scope"];
                  const controller = field.conditional ? allFields.find((candidate) => candidate.key === field.conditional?.fieldKey) : null;
                  updateField(sectionIndex, fieldIndex, {
                    scope,
                    ...creditPatchForKindChange(field, { scope }),
                    conditional: scope === "REGISTRATION" && controller?.scope === "ATTENDEE" ? undefined : field.conditional,
                    optionalWhen: scope === "REGISTRATION" && allFields.find((candidate) => candidate.key === field.optionalWhen?.fieldKey)?.scope === "ATTENDEE" ? undefined : field.optionalWhen,
                    // Directory sources apply only to the whole registration (#482).
                    ...(scope === "ATTENDEE" && isDirectoryOptionSource(field.optionSource) ? { optionSource: undefined, options: [] } : {}),
                  });
                }}>{formFieldScopes.map((scope) => <option key={scope} value={scope}>{scope === "ATTENDEE" ? "Each attendee" : "Registration"}</option>)}</select></label>
                <label className="required-toggle"><input disabled={!canEdit || field.type === "CALCULATED" || field.optionSource === "ATTENDEE_TYPES"} type="checkbox" checked={field.optionSource === "ATTENDEE_TYPES" ? true : field.required} onChange={(event) => updateField(sectionIndex, fieldIndex, { required: event.target.checked, optionalWhen: event.target.checked ? field.optionalWhen : undefined })} /> Required{field.optionSource === "ATTENDEE_TYPES" && <small> — the attendee-type selector is always required</small>}</label>
                {(field.type === "SELECT" || field.type === "RADIO") && field.scope === "ATTENDEE" && <label className="required-toggle"><input disabled={!canEdit || (!field.optionSource && allFields.some((candidate) => candidate.optionSource === "ATTENDEE_TYPES"))} type="checkbox" checked={field.optionSource === "ATTENDEE_TYPES"} onChange={(event) => updateField(sectionIndex, fieldIndex, { optionSource: event.target.checked ? "ATTENDEE_TYPES" : undefined, optionLabels: event.target.checked ? field.optionLabels : undefined, required: event.target.checked ? true : field.required, availabilityMode: event.target.checked ? "NONE" : field.availabilityMode, choiceLimits: event.target.checked ? undefined : field.choiceLimits, choicePricesCents: event.target.checked ? undefined : field.choicePricesCents, latePricing: event.target.checked ? undefined : field.latePricing })} /> Source attendee types from event configuration</label>}
                {(field.type === "SELECT" || field.type === "RADIO") && field.scope === "REGISTRATION" && (["CLUBS_DIRECTORY", "CHURCHES_DIRECTORY"] as const).map((source) => (
                  <label className="required-toggle" key={source}>
                    <input
                      disabled={!canEdit || (field.optionSource !== source && Boolean(field.optionSource))}
                      type="checkbox"
                      checked={field.optionSource === source}
                      onChange={(event) => updateField(sectionIndex, fieldIndex, {
                        optionSource: event.target.checked ? source : undefined,
                        optionLabels: undefined,
                        optionDescriptions: event.target.checked ? undefined : field.optionDescriptions,
                        availabilityMode: event.target.checked ? "NONE" : field.availabilityMode,
                        choiceLimits: event.target.checked ? undefined : field.choiceLimits,
                        choicePricesCents: event.target.checked ? undefined : field.choicePricesCents,
                        latePricing: event.target.checked ? undefined : field.latePricing,
                      })}
                    /> Source from the {source === "CLUBS_DIRECTORY" ? "clubs" : "churches"} directory
                  </label>
                ))}
              </div>
              {canEdit && field.type === "RADIO" && autoRadioFieldIds.has(field.id) && !field.optionSource && <div className="field-full inline-notice choice-type-hint" data-testid={`new-choice-default-${field.key}`}><span>New short-list choice fields start as radio cards.</span><button className="text-button" type="button" onClick={() => { setAutoRadioFieldIds((current) => { const next = new Set(current); next.delete(field.id); return next; }); setDismissedChoiceHintIds((current) => new Set(current).add(field.id)); updateField(sectionIndex, fieldIndex, { type: "SELECT", ...creditPatchForKindChange(field, { type: "SELECT" }) }); }}>Keep dropdown</button></div>}
              {canEdit && !dismissedChoiceHintIds.has(field.id) && (() => {
                const hint = singleChoiceTypeHint(field);
                if (!hint) return null;
                return <div className="field-full inline-notice choice-type-hint" data-testid={`choice-type-hint-${field.key}`}><span>{hint.message}</span><button className="text-button" type="button" onClick={() => updateField(sectionIndex, fieldIndex, { type: hint.suggestedType, ...creditPatchForKindChange(field, { type: hint.suggestedType }) })}>{hint.actionLabel}</button><button className="text-button" type="button" aria-label={`Dismiss the choice control suggestion for ${field.label}`} onClick={() => setDismissedChoiceHintIds((current) => new Set(current).add(field.id))}>Keep {fieldTypeLabels[field.type].toLowerCase()}</button></div>;
              })()}
              {isChoiceFieldType(field.type) && <section className="choice-settings"><div><p className="eyebrow">Choices, descriptions, pricing &amp; capacity</p><span>Add optional descriptions when people need more information before choosing.</span></div><div className="field-settings">
                <label>Quick choices<select aria-label={`Quick choices for ${field.label}`} disabled={!canEdit || Boolean(field.optionSource)} value="" onChange={(event) => { const preset = choicePresets.find((item) => item.name === event.target.value); if (preset) updateField(sectionIndex, fieldIndex, { options: preset.options, optionLabels: undefined, optionDescriptions: undefined, choiceLimits: getAvailabilityMode(field) === "NONE" ? undefined : {}, choicePricesCents: {}, latePricing: field.latePricing ? { ...field.latePricing, choicePricesCents: {} } : undefined }); }}><option value="">Choose a preset…</option>{choicePresets.map((preset) => <option key={preset.name}>{preset.name}</option>)}</select></label>
                {!field.optionSource && <label>Availability<select aria-label={`Availability tracking for ${field.label}`} disabled={!canEdit} value={getAvailabilityMode(field)} onChange={(event) => { const availabilityMode = event.target.value as RegistrationFormField["availabilityMode"]; updateField(sectionIndex, fieldIndex, { availabilityMode, choiceLimits: availabilityMode === "NONE" ? undefined : field.choiceLimits ?? {} }); }}><option value="NONE">No counts or limits</option><option value="CAPACITY">Capacity &amp; spots</option><option value="RANKED_INTEREST">Ranked interest &amp; room assignment</option></select></label>}
                {(field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") && <><label>Choices required<input aria-label={`Minimum selections for ${field.label}`} disabled={!canEdit} type="number" min={1} max={Math.min(10, Math.max(1, field.options.length))} value={field.minSelections ?? (field.type === "RANKED_CHOICE" ? 2 : 1)} onChange={(event) => updateField(sectionIndex, fieldIndex, { minSelections: Number(event.target.value) })} /></label><label>Maximum allowed<input aria-label={`Maximum selections for ${field.label}`} disabled={!canEdit} type="number" min={1} max={Math.min(10, Math.max(1, field.options.length))} value={field.maxSelections ?? 2} onChange={(event) => updateField(sectionIndex, fieldIndex, { maxSelections: Number(event.target.value) })} /></label></>}
                {isDirectoryOptionSource(field.optionSource) ? <p className="field-full inline-notice" data-testid={`directory-source-note-${field.key}`}>Options come from the live {field.optionSource === "CHURCHES_DIRECTORY" ? "churches" : "clubs"} directory.</p> : <>
                <label className="field-full">{field.optionSource ? "Configured attendee types (read only)" : "Choices — one per line"}<textarea disabled={!canEdit || Boolean(field.optionSource)} rows={Math.min(8, Math.max(3, field.options.length))} value={field.options.map((option) => field.optionLabels?.[option] ?? option).join("\n")} onChange={(event) => { const options = event.target.value.split("\n").map((value) => value.trim()).filter(Boolean); const optionDescriptions = Object.fromEntries(options.flatMap((option, optionIndex) => { const priorOption = field.options[optionIndex]; const description = field.optionDescriptions?.[option] ?? (priorOption ? field.optionDescriptions?.[priorOption] : undefined); return description ? [[option, description]] : []; })); const choiceLimits = getAvailabilityMode(field) === "NONE" ? undefined : Object.fromEntries(Object.entries(field.choiceLimits ?? {}).filter(([choice]) => options.includes(choice))); const choicePricesCents = Object.fromEntries(Object.entries(field.choicePricesCents ?? {}).filter(([choice]) => options.includes(choice))); const lateChoicePricesCents = Object.fromEntries(Object.entries(field.latePricing?.choicePricesCents ?? {}).filter(([choice]) => options.includes(choice))); updateField(sectionIndex, fieldIndex, { options, optionLabels: undefined, optionDescriptions, choiceLimits, choicePricesCents, latePricing: field.latePricing ? { ...field.latePricing, choicePricesCents: lateChoicePricesCents } : undefined }); }} /></label>
                <div className="field-full choice-description-editor"><div><strong>Descriptions shown to registrants</strong><small>Optional. Use plain language to explain the presenter, topic, activity, room, or package.</small></div>{field.options.map((option) => <label key={option}><span>{option}</span><textarea aria-label={`Description for ${option}`} disabled={!canEdit} rows={3} maxLength={2000} placeholder="Optional description shown below this choice" value={field.optionDescriptions?.[option] ?? ""} onChange={(event) => { const optionDescriptions = { ...(field.optionDescriptions ?? {}) }; if (event.target.value) optionDescriptions[option] = event.target.value; else delete optionDescriptions[option]; updateField(sectionIndex, fieldIndex, { optionDescriptions }); }} /></label>)}</div>
                </>}
                {!field.optionSource && <div className="field-full late-pricing-controls"><label className="required-toggle"><input disabled={!canEdit} type="checkbox" checked={Boolean(field.latePricing)} onChange={(event) => updateField(sectionIndex, fieldIndex, { latePricing: event.target.checked ? { startsOn: localCalendarDate(), label: "Late registration pricing", choicePricesCents: {} } : undefined })} /> Use different prices starting on a date</label>{field.latePricing && <><label>Late pricing starts<input aria-label={`Late pricing starts for ${field.label}`} disabled={!canEdit} type="date" value={field.latePricing.startsOn} onChange={(event) => updateField(sectionIndex, fieldIndex, { latePricing: { ...field.latePricing!, startsOn: event.target.value } })} /></label><label>Pricing label<input aria-label={`Late pricing label for ${field.label}`} disabled={!canEdit} value={field.latePricing.label} maxLength={80} onChange={(event) => updateField(sectionIndex, fieldIndex, { latePricing: { ...field.latePricing!, label: event.target.value } })} /></label></>}</div>}
                {!isDirectoryOptionSource(field.optionSource) && <div className={`field-full choice-limit-editor ${getAvailabilityMode(field) !== "NONE" ? "with-capacity" : ""} ${field.latePricing ? "with-late-price" : ""}`}><div><strong>Price{getAvailabilityMode(field) === "CAPACITY" ? " & capacity" : getAvailabilityMode(field) === "RANKED_INTEREST" ? " & room assignment" : ""} by choice</strong><small>{getAvailabilityMode(field) === "CAPACITY" ? "Capacity limits close a choice when all spots are reserved. " : getAvailabilityMode(field) === "RANKED_INTEREST" ? "Room limits guide the assignment run; people can still rank a popular room so demand stays visible. " : ""}Leave a price blank for free.</small></div><div className="choice-editor-head"><span>Choice</span>{getAvailabilityMode(field) !== "NONE" && <span>{getAvailabilityMode(field) === "RANKED_INTEREST" ? "Room limit" : "Limit"}</span>}<span>Standard</span>{field.latePricing && <span>Late</span>}</div>{field.options.map((option) => <label key={option}><span>{option}</span>{getAvailabilityMode(field) !== "NONE" && <input aria-label={`${getAvailabilityMode(field) === "RANKED_INTEREST" ? "Room limit" : "Limit"} for ${option}`} disabled={!canEdit} type="number" min={1} max={10000} placeholder="Unlimited" value={field.choiceLimits?.[option] ?? ""} onChange={(event) => { const choiceLimits = { ...(field.choiceLimits ?? {}) }; if (event.target.value) choiceLimits[option] = Number(event.target.value); else delete choiceLimits[option]; updateField(sectionIndex, fieldIndex, { choiceLimits }); }} />}<span className="money-input"><b>$</b><input aria-label={`Price for ${option}`} disabled={!canEdit} type="number" min={0} max={100000} step="0.01" placeholder="0.00" value={field.choicePricesCents?.[option] === undefined ? "" : field.choicePricesCents[option] / 100} onChange={(event) => { const choicePricesCents = { ...(field.choicePricesCents ?? {}) }; if (event.target.value !== "") choicePricesCents[option] = Math.round(Number(event.target.value) * 100); else delete choicePricesCents[option]; updateField(sectionIndex, fieldIndex, { choicePricesCents }); }} /></span>{field.latePricing && <span className="money-input"><b>$</b><input aria-label={`Late price for ${option}`} disabled={!canEdit} type="number" min={0} max={100000} step="0.01" placeholder="Same" value={field.latePricing.choicePricesCents?.[option] === undefined ? "" : field.latePricing.choicePricesCents[option] / 100} onChange={(event) => { const choicePricesCents = { ...(field.latePricing?.choicePricesCents ?? {}) }; if (event.target.value !== "") choicePricesCents[option] = Math.round(Number(event.target.value) * 100); else delete choicePricesCents[option]; updateField(sectionIndex, fieldIndex, { latePricing: { ...field.latePricing!, choicePricesCents } }); }} /></span>}</label>)}</div>}
              </div></section>}
              <details className="field-advanced"><summary><Settings2 size={14} /> Advanced options</summary><div className="field-settings">
                <label>Field key<input disabled={!canEdit} value={field.key} maxLength={60} onChange={(event) => updateField(sectionIndex, fieldIndex, { key: fieldKey(event.target.value) })} /></label>
                {hasCredit(field) && <div className="field-full inline-notice" data-testid={`credit-${field.key}`}><span>{creditSummary(field)}. Set by the form template; it comes off the registration total, never below $0.</span>{canEdit && <button className="text-button" type="button" aria-label={`Remove credit from ${field.label}`} onClick={() => updateField(sectionIndex, fieldIndex, removeCreditPatch())}>Remove credit</button>}</div>}
                {!hasCredit(field) && !isChoiceFieldType(field.type) && field.type !== "ADDRESS" && <label>{field.type === "NUMBER" ? "Price per item" : field.type === "CALCULATED" ? "Standard price" : "Price when selected"}<span className="money-input"><b>$</b><input aria-label={`Price for ${field.label}`} disabled={!canEdit} type="number" min={0} max={100000} step="0.01" placeholder="0.00" value={field.priceCents === undefined ? "" : field.priceCents / 100} onChange={(event) => updateField(sectionIndex, fieldIndex, { priceCents: event.target.value === "" ? undefined : Math.round(Number(event.target.value) * 100), latePricing: event.target.value === "" ? undefined : field.latePricing })} /></span></label>}
                {field.type === "NUMBER" && <div className="field-full" data-testid={`number-bounds-${field.key}`}><label>Minimum value<input aria-label={`Minimum value for ${field.label}`} disabled={!canEdit} type="number" min={0} max={100000} step={1} value={field.ageBounds?.minimumAge ?? ""} placeholder={String(numberFieldBounds(field)?.minimumAge ?? 0)} onChange={(event) => updateNumberBounds(sectionIndex, fieldIndex, field, "minimumAge", event.target.value)} /></label><label>Maximum value<input aria-label={`Maximum value for ${field.label}`} disabled={!canEdit} type="number" min={0} max={100000} step={1} value={field.ageBounds?.maximumAge ?? ""} placeholder={String(numberFieldBounds(field)?.maximumAge ?? 100000)} onChange={(event) => updateNumberBounds(sectionIndex, fieldIndex, field, "maximumAge", event.target.value)} /></label>{field.ageBounds && field.ageBounds.minimumAge !== null && field.ageBounds.maximumAge !== null && field.ageBounds.minimumAge > field.ageBounds.maximumAge && <small role="alert" className="field-error">Minimum value cannot exceed maximum value.</small>}<small>Whole numbers only. Registrants cannot enter a value outside this range. Leave blank for no extra limit.</small></div>}
                <label className="field-wide">Help text<input disabled={!canEdit} value={field.helpText} maxLength={240} placeholder="Optional guidance shown below the field" onChange={(event) => updateField(sectionIndex, fieldIndex, { helpText: event.target.value })} /></label>
                {!Array.from(["SELECT", "RADIO", "MULTISELECT", "RANKED_CHOICE", "DATE", "CALCULATED", "ADDRESS"]).includes(field.type) && <label className="field-wide">{field.type === "CHECKBOX" ? "Agreement text" : "Placeholder"}<input disabled={!canEdit} value={field.placeholder ?? ""} maxLength={120} placeholder={field.type === "CHECKBOX" ? "Yes, I understand and agree" : "Example or short instruction"} onChange={(event) => updateField(sectionIndex, fieldIndex, { placeholder: event.target.value })} /></label>}
                {!hasCredit(field) && !isChoiceFieldType(field.type) && field.type !== "ADDRESS" && <div className="field-full late-pricing-controls"><label className="required-toggle"><input disabled={!canEdit || field.priceCents === undefined} type="checkbox" checked={Boolean(field.latePricing)} onChange={(event) => updateField(sectionIndex, fieldIndex, { latePricing: event.target.checked ? { startsOn: localCalendarDate(), label: "Late registration pricing", priceCents: field.priceCents } : undefined })} /> Use a different price starting on a date</label>{field.priceCents === undefined && <small>Set the standard price first.</small>}{field.latePricing && <><label>Late pricing starts<input aria-label={`Late pricing starts for ${field.label}`} disabled={!canEdit} type="date" value={field.latePricing.startsOn} onChange={(event) => updateField(sectionIndex, fieldIndex, { latePricing: { ...field.latePricing!, startsOn: event.target.value } })} /></label><label>Late price<span className="money-input"><b>$</b><input aria-label={`Late price for ${field.label}`} disabled={!canEdit} type="number" min={0} max={100000} step="0.01" value={(field.latePricing.priceCents ?? field.priceCents ?? 0) / 100} onChange={(event) => updateField(sectionIndex, fieldIndex, { latePricing: { ...field.latePricing!, priceCents: Math.round(Number(event.target.value) * 100) } })} /></span></label><label>Pricing label<input aria-label={`Late pricing label for ${field.label}`} disabled={!canEdit} value={field.latePricing.label} maxLength={80} onChange={(event) => updateField(sectionIndex, fieldIndex, { latePricing: { ...field.latePricing!, label: event.target.value } })} /></label></>}</div>}
                <div className="field-full conditional-editor">
                  <label className="required-toggle"><input disabled={!canEdit || allFields.length < 2} type="checkbox" checked={Boolean(field.conditional)} onChange={(event) => { const controller = allFields.find((candidate) => candidate.id !== field.id && (field.scope === "ATTENDEE" || candidate.scope === "REGISTRATION")); updateField(sectionIndex, fieldIndex, { conditional: event.target.checked && controller ? { fieldKey: controller.key, operator: "EQUALS", value: controller.options[0] ?? "" } : undefined }); }} /> Show this field only when…</label>
                  {field.conditional && (() => { const controller = allFields.find((candidate) => candidate.key === field.conditional?.fieldKey); return <div className="conditional-grid">
                    <label>Field<select disabled={!canEdit} value={field.conditional.fieldKey} onChange={(event) => { const nextController = allFields.find((candidate) => candidate.key === event.target.value); updateField(sectionIndex, fieldIndex, { conditional: { ...field.conditional!, fieldKey: event.target.value, value: nextController?.options[0] ?? "" } }); }}>{allFields.filter((candidate) => candidate.id !== field.id && (field.scope === "ATTENDEE" || candidate.scope === "REGISTRATION")).map((candidate) => <option key={candidate.id} value={candidate.key}>{candidate.label}</option>)}</select></label>
                    <label>Condition<select disabled={!canEdit} value={field.conditional.operator} onChange={(event) => updateField(sectionIndex, fieldIndex, { conditional: { ...field.conditional!, operator: event.target.value as typeof conditionOperators[number] } })}>{conditionOperators.map((operator) => <option key={operator} value={operator}>{conditionLabels[operator]}</option>)}</select></label>
                    {field.conditional.operator !== "NOT_EMPTY" && <label>Answer{controller && isChoiceFieldType(controller.type) ? <select disabled={!canEdit} value={field.conditional.value} onChange={(event) => updateField(sectionIndex, fieldIndex, { conditional: { ...field.conditional!, value: event.target.value } })}><option value="">Choose…</option>{controller.options.map((option) => <option key={option}>{option}</option>)}</select> : <input disabled={!canEdit} value={field.conditional.value} placeholder="Expected answer" onChange={(event) => updateField(sectionIndex, fieldIndex, { conditional: { ...field.conditional!, value: event.target.value } })} />}</label>}
                  </div>; })()}
                </div>
                {field.required && field.type !== "CALCULATED" && (
                  <div className="field-full conditional-editor">
                    <label className="required-toggle"><input disabled={!canEdit || allFields.length < 2} type="checkbox" checked={Boolean(field.optionalWhen)} onChange={(event) => { const controller = allFields.find((candidate) => candidate.optionSource === "ATTENDEE_TYPES" || candidate.key === "attendee_type") ?? allFields.find((candidate) => candidate.id !== field.id && (field.scope === "ATTENDEE" || candidate.scope === "REGISTRATION")); updateField(sectionIndex, fieldIndex, { optionalWhen: event.target.checked && controller && controller.id !== field.id ? { fieldKey: controller.key, operator: "EQUALS", value: controller.options.find((option) => /teen/i.test(option)) ?? controller.options[0] ?? "" } : undefined }); }} /> Not required when… <small>(still shown and answerable, marked with *)</small></label>
                    {field.optionalWhen && (() => { const controller = allFields.find((candidate) => candidate.key === field.optionalWhen?.fieldKey); return <div className="conditional-grid">
                      <label>Field<select disabled={!canEdit} value={field.optionalWhen.fieldKey} onChange={(event) => { const nextController = allFields.find((candidate) => candidate.key === event.target.value); updateField(sectionIndex, fieldIndex, { optionalWhen: { ...field.optionalWhen!, fieldKey: event.target.value, value: nextController?.options[0] ?? "" } }); }}>{allFields.filter((candidate) => candidate.id !== field.id && (field.scope === "ATTENDEE" || candidate.scope === "REGISTRATION")).map((candidate) => <option key={candidate.id} value={candidate.key}>{candidate.label}</option>)}</select></label>
                      <label>Condition<select disabled={!canEdit} value={field.optionalWhen.operator} onChange={(event) => updateField(sectionIndex, fieldIndex, { optionalWhen: { ...field.optionalWhen!, operator: event.target.value as typeof conditionOperators[number] } })}>{conditionOperators.map((operator) => <option key={operator} value={operator}>{conditionLabels[operator]}</option>)}</select></label>
                      {field.optionalWhen.operator !== "NOT_EMPTY" && <label>Answer{controller && isChoiceFieldType(controller.type) ? <select disabled={!canEdit} value={field.optionalWhen.value} onChange={(event) => updateField(sectionIndex, fieldIndex, { optionalWhen: { ...field.optionalWhen!, value: event.target.value } })}><option value="">Choose…</option>{controller.options.map((option) => <option key={option}>{option}</option>)}</select> : <input disabled={!canEdit} value={field.optionalWhen.value} placeholder="Expected answer" onChange={(event) => updateField(sectionIndex, fieldIndex, { optionalWhen: { ...field.optionalWhen!, value: event.target.value } })} />}</label>}
                    </div>; })()}
                  </div>
                )}
              </div></details>
            </div>}
          </article>)}</div>
          {canEdit && <>
            <button
              className="add-field-button"
              type="button"
              onClick={() => {
                if (openModuleSection === sectionIndex) closeModuleLibrary();
                else setOpenModuleSection(sectionIndex);
              }}
            >
              <Plus size={15} /> Add module to {section.title}
            </button>
            {openModuleSection === sectionIndex && (
              <div className="module-library">
                <div className="module-library-head">
                  <div>
                    <p className="eyebrow">Drop-in modules</p>
                    <strong>Search or filter ready-made blocks</strong>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Close module library"
                    onClick={closeModuleLibrary}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="module-library-filters">
                  <label>
                    Search modules
                    <span className="search-input">
                      <Search size={14} aria-hidden="true" />
                      <input
                        value={moduleQuery}
                        placeholder="Contact, housing, meals…"
                        onChange={(event) => setModuleQuery(event.target.value)}
                      />
                    </span>
                  </label>
                  <label>
                    Category
                    <select
                      value={moduleCategory}
                      onChange={(event) => setModuleCategory(
                        event.target.value as typeof moduleCategories[number],
                      )}
                    >
                      {moduleCategories.map((category) => (
                        <option value={category} key={category}>{category}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {visibleFieldModules.length === 0 ? (
                  <p className="module-library-empty">
                    No modules match that search.
                  </p>
                ) : (
                  <div className="module-grid">
                    {visibleFieldModules.map((module) => (
                      <button
                        type="button"
                        key={module.key}
                        onClick={() => addModule(sectionIndex, module)}
                      >
                        <span><Layers3 size={17} /></span>
                        <strong>{module.name}</strong>
                        <small>{module.description}</small>
                        <b>
                          {module.category} · {module.fields.length} field
                          {module.fields.length === 1 ? "" : "s"}
                        </b>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>}
        </section>)}

        {canEdit && <button className="add-section-button" type="button" onClick={addSection}><Plus size={17} /> Add another section</button>}
        <section className="panel payment-settings">
          <div className="section-heading"><div><p className="eyebrow">Calculations &amp; checkout</p><h2>Payment settings</h2></div><label className="switch-toggle"><input disabled={!canEdit || paymentMethodFields.length === 0} type="checkbox" checked={Boolean(definition.payment?.enabled)} onChange={(event) => { if (!event.target.checked) { replaceDefinition({ ...definition, payment: undefined }); return; } const methodField = paymentMethodFields.find((candidate) => candidate.key.includes("payment")) ?? paymentMethodFields[0]; if (!methodField) return; replaceDefinition({ ...definition, payment: { enabled: true, currency: "USD", paymentMethodFieldKey: methodField.key, cardOptionValue: methodField.options.find((option) => option.toLowerCase().includes("card")) ?? methodField.options[0], percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true } }); }} /> Enable</label></div>
          {paymentMethodFields.length === 0 && <p className="quiet-copy">Add a dropdown, radio, or multiple-choice payment-method field before enabling checkout calculations.</p>}
          {definition.payment?.enabled && <div className="payment-settings-grid">
            <label>Payment method field<select disabled={!canEdit} value={definition.payment.paymentMethodFieldKey} onChange={(event) => { const next = paymentMethodFields.find((field) => field.key === event.target.value); if (next) replaceDefinition({ ...definition, payment: { ...definition.payment!, paymentMethodFieldKey: next.key, cardOptionValue: next.options.find((option) => option.toLowerCase().includes("card")) ?? next.options[0] } }); }}>{paymentMethodFields.map((field) => <option key={field.id} value={field.key}>{field.label}</option>)}</select></label>
            <label>Card choice<select disabled={!canEdit} value={definition.payment.cardOptionValue} onChange={(event) => replaceDefinition({ ...definition, payment: { ...definition.payment!, cardOptionValue: event.target.value } })}>{paymentMethodFields.find((field) => field.key === definition.payment?.paymentMethodFieldKey)?.options.map((option) => <option key={option}>{option}</option>)}</select></label>
            <label>Card rate (%)<input disabled={!canEdit} type="number" min={0} max={20} step="0.01" value={definition.payment.percentageBasisPoints / 100} onChange={(event) => replaceDefinition({ ...definition, payment: { ...definition.payment!, percentageBasisPoints: Math.round(Number(event.target.value) * 100) } })} /></label>
            <label>Fixed fee<span className="money-input"><b>$</b><input disabled={!canEdit} type="number" min={0} max={10} step="0.01" value={definition.payment.fixedFeeCents / 100} onChange={(event) => replaceDefinition({ ...definition, payment: { ...definition.payment!, fixedFeeCents: Math.round(Number(event.target.value) * 100) } })} /></span></label>
            <label className="payment-fee-toggle"><input disabled={!canEdit} type="checkbox" checked={definition.payment.passFeeToRegistrant} onChange={(event) => replaceDefinition({ ...definition, payment: { ...definition.payment!, passFeeToRegistrant: event.target.checked } })} /><span><strong>Registrant covers the full card cost</strong><small>The fee is grossed up so Square’s percentage also applies to the fee itself.</small></span></label>
          </div>}
          {scheduledPriceFields.length > 0 && <div className="pricing-preview-control"><label>Preview calculation date<input type="date" value={pricingPreviewDate} onInput={(event) => setPricingPreviewDate(event.currentTarget.value)} /></label><span><strong>{scheduledPriceFields.length} scheduled price{scheduledPriceFields.length === 1 ? "" : "s"}</strong><small>Change this test date to verify deadline pricing. A public checkout will recompute the date server-side.</small></span></div>}
          <div className="boundary-callout"><ShieldCheck size={18} /><span><strong>Square-ready, sandbox first</strong><small>Totals work now. Card details stay outside this builder and a Square Web Payments token is required before a charge can be submitted.</small></span></div>
        </section>
        <section className="panel confirmation-editor"><label>Confirmation message<textarea disabled={!canEdit} value={definition.confirmationMessage} rows={3} maxLength={500} onChange={(event) => replaceDefinition({ ...definition, confirmationMessage: event.target.value })} /></label></section></div>

        <aside className="panel builder-preview" data-testid="live-form-preview" id="live-form-preview" ref={previewRef} tabIndex={-1}>
          <div className="section-heading"><div><p className="eyebrow">Live preview</p><h2>Preview &amp; test</h2></div><span className="live-preview-badge"><span /> Live</span></div>
          <div className="preview-device">
            <div className="preview-browser-bar"><span /><span /><span /></div>
            <div className="preview-form">
              <span className="preview-event">{eventName}</span>
              <h3>{definition.title}</h3>
              <p>{definition.description}</p>
              {previewStep && <nav className="preview-step-progress" aria-label="Public form preview steps">
                <span>Step {previewStepIndex + 1} of {previewSteps.length}</span>
                <div role="list">
                  {previewSteps.map((step, index) => (
                    <button
                      aria-current={step.id === previewStep.id ? "step" : undefined}
                      aria-label={`Preview step ${index + 1}: ${step.shortLabel}`}
                      className={step.id === previewStep.id ? "selected" : ""}
                      type="button"
                      onClick={() => setPreviewStepId(step.id)}
                      key={step.id}
                    >
                      <b>{index + 1}</b>
                      <small>{step.shortLabel}</small>
                    </button>
                  ))}
                </div>
              </nav>}
              {testIssues.length > 0 && <div className="preview-test-alert" role="alert"><AlertTriangle size={14} /><span><strong>{testIssues.length} test issue{testIssues.length === 1 ? "" : "s"}</strong><small>Fix the highlighted answer, then run the test again.</small></span></div>}
              {previewStep && <section className="preview-current-step" aria-labelledby="preview-current-step-title">
                <span>Step {previewStepIndex + 1}</span>
                <h4 id="preview-current-step-title">{previewStep.title}</h4>
                <p>{previewStep.description}</p>
              </section>}
              {renderPreviewSections(previewAllowedFieldKeys)}
              {renderPreviewRoster(previewAllowedFieldKeys)}
              {previewStep?.isReview && <section className="preview-review-card">
                <h4>Review before submitting</h4>
                <p>{roster?.enabled ? `${previewAttendees.length} ${roster.attendeeLabel.toLowerCase()}${previewAttendees.length === 1 ? "" : "s"} will be included. ` : ""}The public form shows entered answers here before the registrant submits.</p>
              </section>}
              {calculation && (calculation.lineItems.length > 0 || definition.payment?.enabled) && <section className="preview-order-summary" aria-label="Order summary"><h4>Order summary</h4>{calculation.lineItems.length === 0 ? <p>Select a priced option to see the total.</p> : <>{calculation.lineItems.map((item) => <div key={item.key}><span>{item.label}{item.pricingLabel && <small>{item.pricingLabel}</small>}</span><strong>{money(item.amountCents)}</strong></div>)}<div><span>Subtotal</span><strong>{money(calculation.subtotalCents)}</strong></div>{calculation.processingFeeCents > 0 && <div><span>Card processing</span><strong>{money(calculation.processingFeeCents)}</strong></div>}<div className="preview-total"><span>Total</span><strong>{money(calculation.totalCents)}</strong></div></>}</section>}
              {previewStep && <nav className="preview-step-actions" aria-label="Move through preview">
                <button className="secondary-button" type="button" disabled={previewStepIndex === 0} onClick={() => setPreviewStepId(previewSteps[previewStepIndex - 1]!.id)}>Back</button>
                {!previewStep.isReview && <button className="primary-button" type="button" onClick={() => setPreviewStepId(previewSteps[previewStepIndex + 1]!.id)}>Continue</button>}
              </nav>}
              {previewStep?.isReview && <>
                <button className="primary-button full-button" type="button" disabled={busy !== null || isHistorical || dirty} title={isHistorical ? "Historical versions are read-only and cannot be tested." : dirty ? "Save your changes as a draft first, then run the test." : undefined} onClick={runTest}><ClipboardCheck size={16} /> {busy === "test" ? "Testing…" : dirty ? "Save draft to test" : "Run test submission"}</button>
                <small className="preview-boundary"><ShieldCheck size={13} /> Saves a form test only — it does not create a registration, send email, or charge a card</small>
              </>}
            </div>
          </div>
          <div className="test-summary"><Settings2 size={17} /><span><strong>{selectedVersion.testSubmissionCount} test submission{selectedVersion.testSubmissionCount === 1 ? "" : "s"}</strong><small>{hasValidTest ? "Valid test passed for this version" : "A valid test against this version is required to publish"}</small></span>{hasValidTest && <CheckCircle2 className="success-icon" size={18} />}</div>
        </aside>
      </>}
    </div>}

    {confirmingUnpublish && selectedForm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmingUnpublish(false); }}><section className="modal-card confirm-import-modal" role="dialog" aria-modal="true" aria-labelledby="unpublish-form-title" tabIndex={-1}><div className="modal-head"><div><p className="eyebrow">Withdraw registration form</p><h2 id="unpublish-form-title">Stop offering {selectedForm.name}?</h2></div><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setConfirmingUnpublish(false)}><X size={18} /></button></div><div className="boundary-callout"><ShieldCheck size={19} /><span><strong>Registrations already taken are not changed</strong><small>They reference the exact version they were submitted under, including its questions and prices.</small></span></div><p className="confirm-copy">The form disappears from the public event page and stops accepting new registrations. Publishing it again later creates a new version.</p><div className="form-actions"><button className="secondary-button" type="button" onClick={() => setConfirmingUnpublish(false)}>Keep it published</button><button className="primary-button" type="button" disabled={busy !== null} onClick={unpublish}>{busy === "unpublish" ? "Withdrawing…" : "Withdraw form"}</button></div></section></div>}

    {selectedForm && <FormSlugDialog open={slugPrompt !== null} eventSlug={eventSlug} currentSlug={selectedForm.slug} offeredSlug={slugPrompt?.offeredSlug ?? ""} error={slugError} busy={busy === "slug"} onKeep={keepSlug} onUpdate={updateSlug} onCancel={() => { setSlugPrompt(null); setSlugError(""); }} />}

    {confirmingPublish && selectedForm && selectedVersion && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmingPublish(false); }}><section className="modal-card confirm-import-modal" ref={publishDialogRef} role="dialog" aria-modal="true" aria-labelledby="publish-form-title" tabIndex={-1}><div className="modal-head"><div><p className="eyebrow">Publish registration form</p><h2 id="publish-form-title">Publish version {selectedVersion.versionNumber}?</h2></div><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setConfirmingPublish(false)}><X size={18} /></button></div><div className="boundary-callout"><ShieldCheck size={19} /><span><strong>This form will be ready for the public event page</strong><small>The event must also be published in Event settings before visitors can register.</small></span></div><p className="confirm-copy">This version is saved as the public version. Later edits create a new draft, so existing registrations always retain the exact questions and prices they submitted.</p><div className="form-actions"><button className="secondary-button" type="button" onClick={() => setConfirmingPublish(false)}>Review again</button><button className="primary-button" type="button" disabled={busy !== null} onClick={publish}>{busy === "publish" ? "Publishing…" : "Publish form"}</button></div></section></div>}

    <ConfirmDialog
      busy={false}
      confirmLabel="Remove field"
      destructive
      error=""
      onCancel={() => { setRemoveFieldTarget(null); resetRemovalAnswerCounts(); }}
      onConfirm={confirmRemoveField}
      open={removeFieldTarget !== null}
      title={removeFieldTarget ? `Remove "${removeFieldTarget.field.label}"?` : "Remove field?"}
    >
      {removeFieldTarget && <p>
        This field is removed from the draft.{" "}
        {removalAnswerCountsLoading
          ? "Checking already-submitted answers…"
          : removalAnswerNote("field", [removeFieldTarget.field.key], removalAnswerCounts)}
      </p>}
    </ConfirmDialog>

    <ConfirmDialog
      busy={false}
      confirmLabel="Remove section"
      destructive
      error=""
      onCancel={() => { setRemoveSectionTarget(null); resetRemovalAnswerCounts(); }}
      onConfirm={confirmRemoveSection}
      open={removeSectionTarget !== null}
      title={removeSectionTarget ? `Remove "${removeSectionTarget.section.title}"?` : "Remove section?"}
    >
      {removeSectionTarget && <p>
        This section and its {removeSectionTarget.section.fields.length} field{removeSectionTarget.section.fields.length === 1 ? "" : "s"} are removed from the draft.{" "}
        {removalAnswerCountsLoading
          ? "Checking already-submitted answers…"
          : removalAnswerNote("section", removeSectionTarget.section.fields.map((field) => field.key), removalAnswerCounts)}
      </p>}
    </ConfirmDialog>
  </section>;
}
