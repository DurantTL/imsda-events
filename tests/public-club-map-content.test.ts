import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildTooltipContent,
  groupClubsByLocation,
  markerLabel,
} from "@/components/public-club-map-content";
import type { PublicClubListing } from "@/modules/organizations/public-club-directory";

/**
 * The club map (#437) shows director-typed names. Leaflet writes any string
 * it is given into innerHTML, so the map builds its content as nodes whose
 * text is set with textContent. This minimal DOM records every element
 * created and refuses any markup sink, so a payload that was ever parsed
 * as HTML would either create an <img> here or throw.
 */
type FakeElement = {
  tagName: string;
  className: string;
  children: FakeElement[];
  textContent: string;
  appendChild(child: FakeElement): FakeElement;
  setAttribute(name: string, value: string): void;
};

function fakeDocument() {
  const created: FakeElement[] = [];
  const doc = {
    createElement(tag: string) {
      const element = {
        tagName: tag.toUpperCase(),
        className: "",
        children: [] as FakeElement[],
        textContent: "",
        appendChild(child: FakeElement) {
          this.children.push(child);
          return child;
        },
        setAttribute() {},
      };
      for (const sink of ["innerHTML", "outerHTML"]) {
        Object.defineProperty(element, sink, {
          set() { throw new Error(`${sink} must never be written`); },
          get() { throw new Error(`${sink} must never be read`); },
        });
      }
      Object.assign(element, {
        insertAdjacentHTML() { throw new Error("insertAdjacentHTML must never be called"); },
      });
      created.push(element);
      return element;
    },
  };
  return { doc: doc as unknown as Document, created };
}

function texts(element: FakeElement): string[] {
  return [element.textContent, ...element.children.flatMap(texts)].filter(Boolean);
}

const payload = "<img src=x onerror=alert(1)>";

function club(overrides: Partial<PublicClubListing>): PublicClubListing {
  return {
    id: "club-1",
    clubName: "Sample Pathfinders",
    churchName: "Sample Church",
    town: "Sampleton",
    state: "IA",
    zip: "50000",
    meetingSchedule: "Sundays 10am",
    latitude: 41.5,
    longitude: -93.5,
    ...overrides,
  };
}

describe("club map tooltip content (#437)", () => {
  it("renders a club name carrying an HTML payload as text and creates no element from it", () => {
    const [group] = groupClubsByLocation([club({ clubName: payload, churchName: `${payload} Church` })]);
    const { doc, created } = fakeDocument();

    const content = buildTooltipContent(doc, group) as unknown as FakeElement;

    expect(created.map((element) => element.tagName)).toEqual(["DIV", "STRONG", "UL", "LI"]);
    expect(created.some((element) => element.tagName === "IMG")).toBe(false);
    expect(texts(content)).toEqual([`${payload} Church`, payload]);
  });

  it("gives the pin a plain-text accessible name that keeps the payload literal", () => {
    const [group] = groupClubsByLocation([club({ clubName: payload })]);
    expect(markerLabel(group)).toBe(`${payload} — Sample Church, Sampleton`);
  });

  it("never hands Leaflet a string of HTML", () => {
    const source = readFileSync(new URL("../components/public-club-map.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/bind(Tooltip|Popup)\(\s*[`"']/);
    expect(source).not.toMatch(/set(Tooltip|Popup)Content\(/);
    expect(source).not.toMatch(/\battribution\s*:/);
    expect(source).not.toMatch(/innerHTML|dangerouslySetInnerHTML/);
    expect(source).toMatch(/html:\s*false/);
    expect(source).toMatch(/attributionControl:\s*false/);
  });
});

describe("clubs that share a church share one pin (#437)", () => {
  it("groups clubs at the same coordinates and lists every one in the tooltip", () => {
    const groups = groupClubsByLocation([
      club({ id: "a", clubName: "Sample Adventurers" }),
      club({ id: "b", clubName: "Sample Pathfinders" }),
      club({ id: "c", clubName: "Other Club", churchName: "Other Church", latitude: 40.1, longitude: -92.2 }),
      club({ id: "d", clubName: "Unmapped Club", latitude: null, longitude: null }),
    ]);

    expect(groups.map((group) => group.clubs.map((entry) => entry.id))).toEqual([["a", "b"], ["c"]]);

    const { doc } = fakeDocument();
    const content = buildTooltipContent(doc, groups[0]) as unknown as FakeElement;
    expect(texts(content)).toEqual(["Sample Church", "Sample Adventurers", "Sample Pathfinders"]);
    expect(markerLabel(groups[0])).toBe("2 clubs: Sample Adventurers, Sample Pathfinders — Sample Church, Sampleton");
  });
});
