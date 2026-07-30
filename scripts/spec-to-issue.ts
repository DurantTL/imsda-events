import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const requiredSections = [
  "Goal",
  "User workflow",
  "Business rules",
  "Security/privacy impact",
  "Acceptance criteria",
  "Verification required",
  "Out of scope",
] as const;

export type ApprovedSpec = {
  title: string;
  status: string;
  specId: string;
  sections: Record<(typeof requiredSections)[number], string>;
};

function metadataValue(markdown: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, "im"))?.[1];
}

export function parseSpec(markdown: string): ApprovedSpec {
  const title = markdown.match(/^# (.+?)\s*$/m)?.[1]?.trim();
  const status = metadataValue(markdown, "Status")?.trim();
  const specId = metadataValue(markdown, "Spec ID")?.trim();

  if (!title) throw new Error("Specification needs one '# Title' heading.");
  if (!status) throw new Error("Specification needs a 'Status:' value.");
  if (!specId || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(specId)) {
    throw new Error("Spec ID must be 3-80 letters, digits, periods, underscores, or hyphens.");
  }

  const headings = [...markdown.matchAll(/^## (.+?)\s*$/gm)];
  const discovered = new Map<string, string>();

  headings.forEach((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    discovered.set(heading[1].trim().toLowerCase(), markdown.slice(start, end).trim());
  });

  const sections = {} as ApprovedSpec["sections"];
  for (const name of requiredSections) {
    const value = discovered.get(name.toLowerCase());
    if (!value) throw new Error(`Section '## ${name}' is required and cannot be empty.`);
    sections[name] = value;
  }

  return { title, status, specId, sections };
}

export function issueBody(spec: ApprovedSpec): string {
  const content = requiredSections
    .map((name) => `## ${name}\n\n${spec.sections[name]}`)
    .join("\n\n");
  return `<!-- imsda-spec-id: ${spec.specId} -->\n\n${content}\n`;
}

function runGh(args: string[]): string {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error) throw new Error(`Unable to run gh: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args[0]} failed.`);
  }
  return result.stdout.trim();
}

function usage(): string {
  return [
    "Usage: npm run issue:from-spec -- <spec.md> [--repo owner/name] [--apply]",
    "",
    "Default mode previews the issue. --apply requires Status: Approved.",
    "An existing issue with the same Spec ID is returned without modification.",
  ].join("\n");
}

function parseArguments(args: string[]) {
  let apply = false;
  let repository: string | undefined;
  let file: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true, apply, repository, file };
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--repo") {
      repository = args[index + 1];
      index += 1;
      if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
        throw new Error("--repo requires an owner/name value.");
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (file) {
      throw new Error("Provide exactly one specification file.");
    } else {
      file = arg;
    }
  }

  return { help: false, apply, repository, file };
}

export function main(args = process.argv.slice(2)): void {
  const options = parseArguments(args);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.file) throw new Error(usage());

  const specPath = resolve(options.file);
  const spec = parseSpec(readFileSync(specPath, "utf8"));
  const body = issueBody(spec);

  if (!options.apply) {
    console.log(`PREVIEW: ${spec.title}`);
    console.log(`Spec ID: ${spec.specId}`);
    console.log(`Source: ${basename(specPath)}`);
    console.log("");
    console.log(body);
    console.log("No GitHub changes made. Set Status: Approved and rerun with --apply.");
    return;
  }

  if (spec.status.toLowerCase() !== "approved") {
    throw new Error("--apply requires the specification to contain 'Status: Approved'.");
  }

  const repository =
    options.repository ??
    runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const issues = JSON.parse(
    runGh([
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,body,url",
    ]),
  ) as Array<{ number: number; body: string; url: string }>;
  const marker = `<!-- imsda-spec-id: ${spec.specId} -->`;
  const existing = issues.find((issue) => issue.body.includes(marker));

  if (existing) {
    console.log(`Existing authoritative issue: ${existing.url}`);
    console.log("No GitHub changes made.");
    return;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "imsda-spec-"));
  const bodyFile = join(temporaryDirectory, "issue.md");
  try {
    writeFileSync(bodyFile, body);
    const url = runGh([
      "issue",
      "create",
      "--repo",
      repository,
      "--title",
      spec.title,
      "--body-file",
      bodyFile,
    ]);
    console.log(`Created issue: ${url}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
