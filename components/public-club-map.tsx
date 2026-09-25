"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { PublicClubListing } from "@/modules/organizations/public-club-directory";
import {
  buildTooltipContent,
  groupClubsByLocation,
  groupSignature,
  markerLabel,
  type ClubMapGroup,
} from "@/components/public-club-map-content";
import styles from "./public-club-map.module.css";

type Leaflet = typeof import("leaflet");
type PinEntry = { marker: Marker; group: ClubMapGroup; signature: string };

const defaultCenter: [number, number] = [39.5, -93.5];
const defaultZoom = 6;

/**
 * The club map (#437): one pin per church with coordinates, listing every
 * club that meets there. Loaded client-side only (the page dynamically
 * imports this with `ssr: false`) since Leaflet reaches for `window`.
 *
 * The map is created once. Searching only adds and removes pins in a layer
 * group, so zoom, pan, and the selection survive every keystroke; the view
 * is refitted only when the set of visible pins actually changes.
 *
 * Nothing the map shows is handed to Leaflet as an HTML string — tooltips
 * are DOM nodes built with textContent (see public-club-map-content), pins
 * are empty divIcons styled in CSS, and the OpenStreetMap attribution is
 * rendered by React beside the map rather than through Leaflet's
 * innerHTML-based attribution control.
 */
export function PublicClubMap({
  clubs,
  selectedId,
  onSelect,
}: {
  clubs: PublicClubListing[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<Leaflet | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const pinsRef = useRef<Map<string, PinEntry>>(new Map());
  const fittedRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  const selectedIdRef = useRef(selectedId);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const groups = useMemo(() => groupClubsByLocation(clubs), [clubs]);

  // Create the map exactly once.
  useEffect(() => {
    let cancelled = false;
    const pins = pinsRef.current;

    void import("leaflet").then((leafletModule) => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      const L = leafletModule.default;
      leafletRef.current = L;
      const map = L.map(containerRef.current, {
        scrollWheelZoom: false,
        attributionControl: false,
      }).setView(defaultCenter, defaultZoom);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(map);
      mapRef.current = map;
      layerRef.current = L.layerGroup().addTo(map);
      setReady(true);
    });

    return () => {
      cancelled = true;
      pins.clear();
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
      leafletRef.current = null;
      fittedRef.current = null;
    };
  }, []);

  // Keep the pins in step with the visible clubs, touching only what changed.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer) return;
    const pins = pinsRef.current;
    const wanted = new Map(groups.map((group) => [group.key, group]));

    for (const [key, entry] of pins) {
      const next = wanted.get(key);
      if (!next || groupSignature(next) !== entry.signature) {
        layer.removeLayer(entry.marker);
        pins.delete(key);
      }
    }

    for (const group of groups) {
      if (pins.has(group.key)) continue;
      const icon = L.divIcon({
        className: styles.markerIcon,
        html: false,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const marker = L.marker([group.latitude, group.longitude], { icon, keyboard: true, riseOnHover: true });
      marker.bindTooltip(buildTooltipContent(document, group), { direction: "top", offset: [0, -10] });
      const firstClubId = group.clubs[0].id;
      const select = () => {
        const current = selectedIdRef.current;
        // A pin stands for its church: re-tapping it keeps whichever of its
        // clubs is already selected instead of jumping back to the first.
        const keep = current && group.clubs.some((club) => club.id === current);
        onSelectRef.current(keep ? current : firstClubId);
      };
      marker.on("click", select);
      marker.addTo(layer);
      const element = marker.getElement();
      if (element) {
        element.setAttribute("aria-label", markerLabel(group));
        element.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select();
          }
        });
      }
      pins.set(group.key, { marker, group, signature: groupSignature(group) });
    }

    // Refit only when the set of visible pins changes, not on every keystroke.
    const fitKey = groups.map((group) => group.key).join("|");
    if (fitKey !== fittedRef.current && groups.length > 0) {
      fittedRef.current = fitKey;
      map.fitBounds(
        groups.map((group) => [group.latitude, group.longitude] as [number, number]),
        { padding: [32, 32], maxZoom: 11 },
      );
    }

    applySelection(pins, selectedIdRef.current);
  }, [ready, groups]);

  // Mirror the list's selection onto the map.
  useEffect(() => {
    selectedIdRef.current = selectedId;
    const pins = pinsRef.current;
    const entry = applySelection(pins, selectedId);
    const map = mapRef.current;
    if (!map || !entry) return;
    entry.marker.openTooltip();
    if (!map.getBounds().pad(-0.1).contains(entry.marker.getLatLng())) {
      map.panTo(entry.marker.getLatLng());
    }
  }, [selectedId, ready]);

  return (
    <div className={styles.frame}>
      <div aria-label="Map of listed clubs" className={styles.map} ref={containerRef} role="group" />
      {ready && groups.length === 0 && (
        <p className={styles.overlayNote}>No mapped clubs match this search.</p>
      )}
      <p className={styles.attribution}>
        &copy; <a href="https://www.openstreetmap.org/copyright" rel="noreferrer" target="_blank">OpenStreetMap</a> contributors
      </p>
    </div>
  );
}

function applySelection(pins: Map<string, PinEntry>, selectedId: string | null) {
  let selected: PinEntry | null = null;
  for (const entry of pins.values()) {
    const isSelected = selectedId !== null && entry.group.clubs.some((club) => club.id === selectedId);
    const element = entry.marker.getElement();
    element?.classList.toggle(styles.selected, isSelected);
    if (isSelected) {
      element?.setAttribute("aria-pressed", "true");
      entry.marker.setZIndexOffset(1000);
      selected = entry;
    } else {
      element?.setAttribute("aria-pressed", "false");
      entry.marker.setZIndexOffset(0);
    }
  }
  return selected;
}
