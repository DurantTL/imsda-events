"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useState } from "react";
import { MapPin, Search, UsersRound } from "lucide-react";
import type { PublicClubListing } from "@/modules/organizations/public-club-directory";
import { locationKey } from "@/components/public-club-map-content";
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
  const [selection, setSelection] = useState<{ id: string; fromMap: boolean } | null>(null);
  const selectedId = selection?.id ?? null;
  const rowIdPrefix = useId();

  const filtered = useMemo(() => clubs.filter((club) => matches(club, query)), [clubs, query]);
  const mappable = useMemo(() => filtered.filter((club) => club.latitude !== null && club.longitude !== null), [filtered]);
  // Whether to show a map at all depends on every listed club, not the
  // search: the map stays mounted while typing, even when no pin matches.
  const anyMappable = useMemo(() => clubs.some((club) => club.latitude !== null && club.longitude !== null), [clubs]);
  const selected = useMemo(
    () => filtered.find((club) => club.id === selectedId) ?? null,
    [filtered, selectedId],
  );
  const selectedPoint = selected && selected.latitude !== null && selected.longitude !== null
    ? locationKey(selected.latitude, selected.longitude)
    : null;
  const rowId = (id: string) => `${rowIdPrefix}-club-${id}`;

  function selectFromList(id: string) {
    setSelection((current) => (current?.id === id ? null : { id, fromMap: false }));
  }

  function selectFromMap(id: string) {
    setSelection({ id, fromMap: true });
  }

  // A tapped pin brings its club's row into view (on phones the list sits
  // below the map).
  useEffect(() => {
    if (!selection?.fromMap) return;
    document.getElementById(`${rowIdPrefix}-club-${selection.id}`)?.scrollIntoView({ block: "nearest" });
  }, [selection, rowIdPrefix]);

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
          {anyMappable && (
            <PublicClubMap clubs={mappable} onSelect={selectFromMap} selectedId={selectedId} />
          )}

          <ul className={styles.list}>
            {filtered.length === 0 ? (
              <li className={styles.empty}>No clubs match &ldquo;{query}&rdquo;.</li>
            ) : (
              filtered.map((club) => {
                const isSelected = selectedId === club.id;
                const sharesPin = !isSelected && selectedPoint !== null
                  && club.latitude !== null && club.longitude !== null
                  && locationKey(club.latitude, club.longitude) === selectedPoint;
                const className = [
                  styles.clubButton,
                  isSelected ? styles.selected : "",
                  sharesPin ? styles.samePin : "",
                ].filter(Boolean).join(" ");
                return (
                  <li id={rowId(club.id)} key={club.id}>
                    <button
                      aria-expanded={isSelected}
                      className={className}
                      onClick={() => selectFromList(club.id)}
                      type="button"
                    >
                      <span className={styles.clubIcon}><UsersRound aria-hidden="true" size={16} /></span>
                      <span className={styles.clubText}>
                        <strong>{club.clubName}</strong>
                        <small>{club.churchName}{club.town ? ` · ${club.town}` : ""}</small>
                        {sharesPin && <small className={styles.samePinNote}>Same church, same pin</small>}
                      </span>
                    </button>
                    {isSelected && (
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
                );
              })
            )}
          </ul>
        </div>
      )}

      <p aria-live="polite" className={styles.selectionNote}>
        {selected && (
          <>
            <MapPin aria-hidden="true" size={14} /> Showing {selected.clubName}.
          </>
        )}
      </p>
    </div>
  );
}
