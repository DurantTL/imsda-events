-- Optional meeting attendance check-off (#653). Additive only: one new table, no existing table or row changes.
CREATE TABLE "ClubMeetingAttendance" (
    "id" TEXT NOT NULL,
    "meetingNoteId" TEXT NOT NULL,
    "rosterMemberId" TEXT NOT NULL,
    "present" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubMeetingAttendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClubMeetingAttendance_meetingNoteId_rosterMemberId_key" ON "ClubMeetingAttendance"("meetingNoteId", "rosterMemberId");

CREATE INDEX "ClubMeetingAttendance_rosterMemberId_idx" ON "ClubMeetingAttendance"("rosterMemberId");

ALTER TABLE "ClubMeetingAttendance" ADD CONSTRAINT "ClubMeetingAttendance_meetingNoteId_fkey" FOREIGN KEY ("meetingNoteId") REFERENCES "ClubMeetingNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClubMeetingAttendance" ADD CONSTRAINT "ClubMeetingAttendance_rosterMemberId_fkey" FOREIGN KEY ("rosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
