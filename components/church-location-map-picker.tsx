"use client";

import { useEffect, useRef, useState } from "react";
import type { LeafletMouseEvent, Map as LeafletMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";
import styles from "./church-location-map-picker.module.css";

type Leaflet = typeof import("leaflet");

// Centered on the continental US, matching the public club map's initial
// view (#437) when a church has no coordinates yet to center on.
const defaultCenter: [number, number] = [39.5, -93.5];
const defaultZoom = 4;
const pinnedZoom = 13;

/**
 * "Pick on map" helper for the church location form (#480): click the map,
 * or drag the pin once it exists, to set the church's coordinates. Reuses
 * the map library, tile provider, and CSP scoping already added for the
 * public club map (#437) — no new third-party service.
 *
 * The map is created once; the marker is created on the first click or the
 * first render with existing coordinates, then only moved afterward so a
 * drag doesn't fight the map for focus.
 */
export function ChurchLocationMapPicker({
  latitude,
  longitude,
  onChange,
}: {
  latitude: number | null;
  longitude: number | null;
  onChange: (latitude: number, longitude: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<Leaflet | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const [ready, setReady] = useState(false);
  const [hasPin, setHasPin] = useState(latitude !== null && longitude !== null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  function placeMarker(L: Leaflet, map: LeafletMap, position: [number, number]) {
    let marker = markerRef.current;
    if (!marker) {
      const icon = L.divIcon({
        className: styles.markerIcon,
        html: false,
        iconSize: [22, 22],
        iconAnchor: [11, 20],
      });
      marker = L.marker(position, { icon, draggable: true, keyboard: true, riseOnHover: true });
      marker.on("dragend", () => {
        const { lat, lng } = marker!.getLatLng();
        onChangeRef.current(lat, lng);
      });
      marker.addTo(map);
      const element = marker.getElement();
      element?.setAttribute("aria-label", "Church location pin. Drag to adjust, or switch to manual entry to type coordinates.");
      markerRef.current = marker;
      setHasPin(true);
    } else {
      marker.setLatLng(position);
    }
  }

  // Create the map exactly once.
  useEffect(() => {
    let cancelled = false;

    void import("leaflet").then((leafletModule) => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      const L = leafletModule.default;
      leafletRef.current = L;
      const initialCenter: [number, number] = latitude !== null && longitude !== null
        ? [latitude, longitude]
        : defaultCenter;
      const map = L.map(containerRef.current, {
        scrollWheelZoom: false,
        attributionControl: false,
      }).setView(initialCenter, latitude !== null && longitude !== null ? pinnedZoom : defaultZoom);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(map);
      if (latitude !== null && longitude !== null) {
        placeMarker(L, map, [latitude, longitude]);
      }
      map.on("click", (event: LeafletMouseEvent) => {
        const { lat, lng } = event.latlng;
        placeMarker(L, map, [lat, lng]);
        onChangeRef.current(lat, lng);
      });
      mapRef.current = map;
      setReady(true);
    });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      leafletRef.current = null;
    };
    // Only the map's creation depends on the initial position; later prop
    // changes move the existing marker instead (see the effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker in step with coordinates set elsewhere (manual entry).
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    if (latitude === null || longitude === null) return;
    placeMarker(L, map, [latitude, longitude]);
  }, [ready, latitude, longitude]);

  return (
    <div className={styles.frame}>
      <div
        aria-label="Click the map to place the church's pin, or drag the pin to adjust it"
        className={styles.map}
        ref={containerRef}
        role="group"
      />
      {ready && !hasPin && (
        <p className={styles.hint}>Click the map to place the pin.</p>
      )}
      <p className={styles.attribution}>
        &copy; <a href="https://www.openstreetmap.org/copyright" rel="noreferrer" target="_blank">OpenStreetMap</a> contributors
      </p>
    </div>
  );
}
