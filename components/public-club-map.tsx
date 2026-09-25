"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { PublicClubListing } from "@/modules/organizations/public-club-directory";
import styles from "./public-club-map.module.css";

/**
 * The club map (#437): each listed club with coordinates, placed at its
 * church's town. Loaded client-side only (the page dynamically imports this
 * with `ssr: false`) since Leaflet reaches for `window`. Tiles come from
 * OpenStreetMap's standard tile server, attributed as required; markers are
 * drawn with CSS (a divIcon), so nothing fetches an external marker image.
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
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    const markers = markersRef.current;

    void import("leaflet").then((leafletModule) => {
      if (cancelled || !containerRef.current) return;
      const L = leafletModule.default;
      map = L.map(containerRef.current, { scrollWheelZoom: false });
      mapRef.current = map;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
        maxZoom: 18,
      }).addTo(map);

      const bounds: Array<[number, number]> = [];
      for (const club of clubs) {
        if (club.latitude === null || club.longitude === null) continue;
        const icon = L.divIcon({
          className: styles.markerIcon,
          html: "<span></span>",
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        const marker = L.marker([club.latitude, club.longitude], { icon })
          .addTo(map)
          .bindTooltip(`${club.clubName} — ${club.churchName}`);
        marker.on("click", () => onSelectRef.current(club.id));
        markers.set(club.id, marker);
        bounds.push([club.latitude, club.longitude]);
      }

      if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [24, 24], maxZoom: 11 });
      } else {
        map.setView([39.5, -93.5], 6);
      }
    });

    return () => {
      cancelled = true;
      markers.clear();
      map?.remove();
      mapRef.current = null;
    };
    // Markers are rebuilt whenever the visible club list changes (search
    // filtering), so the map only ever shows what the list shows.
  }, [clubs]);

  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      marker.getElement()?.classList.toggle("selected", id === selectedId);
    }
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const marker = markersRef.current.get(selectedId);
    if (marker) {
      marker.openTooltip();
      map.panTo(marker.getLatLng());
    }
  }, [selectedId]);

  return <div aria-label="Map of listed clubs" className={styles.map} ref={containerRef} role="group" />;
}
