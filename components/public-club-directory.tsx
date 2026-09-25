"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { MapPin, Search, UsersRound } from "lucide-react";
import type { PublicClubListing } from "@/modules/organizations/public-club-directory";
import styles from "./public-club-directory.module.css";

const PublicClubMap = dynamic(
  () => import("@/components/public-club-map").then((mod) => mod.PublicClubMap),
  { ssr: false, loading: () => <div className={styles.mapLoading}>Loading map…</div> },
);

function matches(club: PublicClubListing, query: string) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  return [club.town, club.zip, club.clubName, club.churchName]
    .some((field) => field.toLowerCase().includes(needle));
}

/**
 * The public club listing and map (#437): search by town or ZIP, a list
 * that stays in sync with the map — filtering the list filters the pins,
 * selecting one highlights the other. Only ever shown here: church name,
 * club name, town, and meeting day/time — whatever the server sent, which
 * is already nothing more (see modules/organizations/public-club-directory).
 */
export function PublicClubDirectory({ clubs }: { clubs: PublicClubListing[] }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => clubs.filter((club) => matches(club, query)), [clubs, query]);
  const mappable = useMemo(() => filtered.filter((club) => club.latitude !== null && club.longitude !== null), [filtered]);
  const selected = useMemo(
    () => filtered.find((club) => club.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  function selectClub(id: string) {
    setSelectedId((current) => (current === id ? null : id));
  }

  return (
    <div className={styles.layout}>
      <label className={styles.search}>
        <Search aria-hidden="true" size={17} />
        <span className="sr-only">Search by town or ZIP</span>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by town or ZIP"
          type="search"
          value={query}
        />
      </label>

      {clubs.length === 0 ? (
        <p className={styles.empty}>No clubs are listed publicly yet. Check back soon.</p>
      ) : (
        <div className={styles.content}>
          {mappable.length > 0 && (
            <PublicClubMap clubs={mappable} onSelect={selectClub} selectedId={selectedId} />
          )}

          <ul className={styles.list}>
            {filtered.length === 0 ? (
              <li className={styles.empty}>No clubs match &ldquo;{query}&rdquo;.</li>
            ) : (
              filtered.map((club) => (
                <li key={club.id}>
                  <button
                    aria-expanded={selectedId === club.id}
                    className={selectedId === club.id ? `${styles.clubButton} ${styles.selected}` : styles.clubButton}
                    onClick={() => selectClub(club.id)}
                    type="button"
                  >
                    <span className={styles.clubIcon}><UsersRound aria-hidden="true" size={16} /></span>
                    <span className={styles.clubText}>
                      <strong>{club.clubName}</strong>
                      <small>{club.churchName}{club.town ? ` · ${club.town}` : ""}</small>
                    </span>
                  </button>
                  {selectedId === club.id && (
                    <dl className={styles.details}>
                      <div>
                        <dt>Church</dt>
                        <dd>{club.churchName || "Not given"}</dd>
                      </div>
                      <div>
                        <dt>Town</dt>
                        <dd>{club.town || "Not given"}</dd>
                      </div>
                      <div>
                        <dt>Meets</dt>
                        <dd>{club.meetingSchedule || "Not given"}</dd>
                      </div>
                    </dl>
                  )}
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      {selected && (
        <p className={styles.selectionNote}>
          <MapPin aria-hidden="true" size={14} /> Showing {selected.clubName}.
        </p>
      )}
    </div>
  );
}
