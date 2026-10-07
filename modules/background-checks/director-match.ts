// Client-safe name and key helpers for matching a new club applicant to a person (#817).

/** Lower-cased words of a name, accents and punctuation dropped, so "Dana  O'Brien" and "dana obrien" compare equal. */
export function nameWords(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019.]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The key `directorBackgroundStatesByEmail` returns each director under: the email and the name typed with it. */
export function directorMatchKey(email: string, name: string) {
  return `${email.trim().toLowerCase()}\n${nameWords(name).join(" ")}`;
}

