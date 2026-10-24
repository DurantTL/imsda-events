/**
 * Dirty tracking for the announcement composer and the scheduled-email editor
 * (#1104). Both compare what is on screen with the loaded baseline: a blank new
 * draft, the saved draft being edited, or the prefilled correction. Keeping
 * this free of React lets one decision serve Close, Cancel, Escape and the
 * backdrop, and lets it be unit tested in the node environment.
 *
 * Wording matters here: closing or saving never publishes, approves or sends.
 * "Unsaved edits" are only in the open editor, a "saved draft" is stored but not
 * public, "published to feed" is a separate step, and so are a schedule's
 * approval and the emails it queues.
 */

export type AnnouncementDraftValues = { title: string; body: string; priority: string; /** The email's inbox preview line (#836). */ preheader?: string };

export type AnnouncementDraftBaseline = AnnouncementDraftValues & { attachmentIds: string[] };

export const blankAnnouncementValues: AnnouncementDraftValues = { title: "", body: "", priority: "NORMAL", preheader: "" };

function key(values: AnnouncementDraftValues, attachmentIds: readonly string[]) {
  return JSON.stringify([values.title, values.body, values.priority, [...attachmentIds], values.preheader ?? ""]);
}

export function announcementDraftBaseline(
  values: AnnouncementDraftValues,
  attachmentIds: readonly string[],
): AnnouncementDraftBaseline {
  return { ...values, attachmentIds: [...attachmentIds] };
}

/** Dirty when the text, priority or the attached files (by id and order) differ from the baseline. */
export function announcementDraftIsDirty(
  baseline: AnnouncementDraftBaseline | null,
  values: AnnouncementDraftValues,
  attachmentIds: readonly string[],
) {
  if (!baseline) return false;
  return key(baseline, baseline.attachmentIds) !== key(values, attachmentIds);
}

/** The one close decision for Close, Cancel, Escape and the backdrop: saving waits, clean closes now, dirty asks first. */
export function editorCloseDecision(input: { saving: boolean; reviewing: boolean; dirty: boolean }) {
  if (input.saving || input.reviewing) return "ignore" as const;
  return input.dirty ? ("confirm" as const) : ("close" as const);
}

export const announcementDiscardPrompt = {
  title: "Discard unsaved changes?",
  body: "This announcement has edits that have not been saved as a draft. Discarding closes the editor and loses them. Nothing is published or sent either way.",
  confirmLabel: "Discard changes",
  cancelLabel: "Keep editing",
  destructive: true,
};

export const scheduleDiscardPrompt = {
  title: "Discard unsaved changes?",
  body: "This schedule has edits that have not been saved. Discarding closes the editor and loses them. Nothing is approved or sent either way.",
  confirmLabel: "Discard changes",
  cancelLabel: "Keep editing",
  destructive: true,
};

/** Fields a person can change in the schedule editor; ids and revisions are not edits. */
export type ScheduleEditorFields = {
  name: string;
  templateKey: string;
  announcementTitle: string;
  announcementBody: string;
  trigger: string;
  localDate: string;
  localTime: string;
  daysBefore: string;
  roles: readonly string[];
  search: string;
};

export function scheduleEditorSnapshot(fields: ScheduleEditorFields) {
  return JSON.stringify([
    fields.name,
    fields.templateKey,
    fields.announcementTitle,
    fields.announcementBody,
    fields.trigger,
    fields.localDate,
    fields.localTime,
    fields.daysBefore,
    [...fields.roles].sort(),
    fields.search,
  ]);
}

export function scheduleEditorIsDirty(baseline: string | null, current: ScheduleEditorFields) {
  if (baseline === null) return false;
  return baseline !== scheduleEditorSnapshot(current);
}
