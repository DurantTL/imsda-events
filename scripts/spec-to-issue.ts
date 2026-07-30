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
  milestone: string;
  risk: string;
  githubIssueUrl: string;
  sections: Record<(typeof requiredSections)[number], string>;
};

type Frontmatter = {
  bodyOffset: number;
  fields: Map<string, string>;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(markdown: string): Frontmatter {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error("Specification must begin with YAML frontmatter.");
  }

  const fields = new Map<string, string>();
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!field) {
      throw new Error(`Unsupported frontmatter line: ${rawLine}`);
    }

    const key = field[1].toLowerCase();
    if (fields.has(key)) {
      throw new Error(`Frontmatter field '${key}' may appear only once.`);
    }
    fields.set(key, unquote(field[2]));
  }

  return { bodyOffset: match[0].length, fields };
}

function requiredFrontmatterValue(fields: Map<string, string>, key: string): string {
  const value = fields.get(key)?.trim();
  if (!value) throw new Error(`Frontmatter field '${key}' is required.`);
  return value;
}

export function parseSpec(markdown: string): ApprovedSpec {
  const frontmatter = parseFrontmatter(markdown);
  const content = markdown.slice(frontmatter.bodyOffset);
  const title = content.match(/^# (.+?)\s*$/m)?.[1]?.trim();
  const status = requiredFrontmatterValue(frontmatter.fields, "status");
  const specId = requiredFrontmatterValue(frontmatter.fields, "spec_id");
  const milestone = requiredFrontmatterValue(frontmatter.fields, "milestone");
  const risk = requiredFrontmatterValue(frontmatter.fields, "risk");
  if (!frontmatter.fields.has("github_issue_url")) {
    throw new Error("Frontmatter field 'github_issue_url' is required.");
  }
  const githubIssueUrl = frontmatter.fields.get("github_issue_url")?.trim() ?? "";

  if (!title) throw new Error("Specification needs one '# Title' heading.");
  if (!specId || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(specId)) {
    throw new Error("Spec ID must be 3-80 letters, digits, periods, underscores, or hyphens.");
  }
  if (
    githubIssueUrl &&
    !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/.test(githubIssueUrl)
  ) {
    throw new Error("github_issue_url must be empty or a full GitHub issue URL.");
  }

  const headings = [...content.matchAll(/^## (.+?)\s*$/gm)];
  const discovered = new Map<string, string>();

  headings.forEach((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? content.length;
    discovered.set(heading[1].trim().toLowerCase(), content.slice(start, end).trim());
  });

  const sections = {} as ApprovedSpec["sections"];
  for (const name of requiredSections) {
    const value = discovered.get(name.toLowerCase());
    if (!value) throw new Error(`Section '## ${name}' is required and cannot be empty.`);
    sections[name] = value;
  }

  return { title, status, specId, milestone, risk, githubIssueUrl, sections };
}

export function issueBody(spec: ApprovedSpec): string {
  const content = requiredSections
    .map((name) => `## ${name}\n\n${spec.sections[name]}`)
    .join("\n\n");
  return [
    `<!-- imsda-spec-id: ${spec.specId} -->`,
    "",
    `Milestone: ${spec.milestone}`,
    `Risk: ${spec.risk}`,
    "",
    content,
    "",
  ].join("\n");
}

export function withGitHubIssueUrl(markdown: string, issueUrl: string): string {
  const frontmatter = parseFrontmatter(markdown);
  const current = frontmatter.fields.get("github_issue_url")?.trim() ?? "";
  if (current && current !== issueUrl) {
    throw new Error(
      `Specification already references a different GitHub issue: ${current}`,
    );
  }

  return markdown.replace(
    /^github_issue_url:[ \t]*.*$/m,
    `github_issue_url: ${JSON.stringify(issueUrl)}`,
  );
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
    "Default mode previews the issue. --apply requires status: approved.",
    "An existing issue with the same Spec ID is returned without modification.",
    "After apply, the issue URL is recorded in the specification frontmatter.",
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
  const markdown = readFileSync(specPath, "utf8");
  const spec = parseSpec(markdown);
  const body = issueBody(spec);

  if (!options.apply) {
    console.log(`PREVIEW: ${spec.title}`);
    console.log(`Spec ID: ${spec.specId}`);
    console.log(`Milestone: ${spec.milestone}`);
    console.log(`Risk: ${spec.risk}`);
    console.log(`Source: ${basename(specPath)}`);
    console.log("");
    console.log(body);
    console.log("No GitHub changes made. Set status: approved and rerun with --apply.");
    return;
  }

  if (spec.status.toLowerCase() !== "approved") {
    throw new Error("--apply requires the specification to contain 'status: approved'.");
  }

  const repository =
    options.repository ??
    runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const marker = `<!-- imsda-spec-id: ${spec.specId} -->`;

  if (spec.githubIssueUrl) {
    const linkedIssue = JSON.parse(
      runGh(["issue", "view", spec.githubIssueUrl, "--json", "body,url"]),
    ) as { body: string; url: string };
    if (!linkedIssue.body.includes(marker)) {
      throw new Error(
        `github_issue_url does not reference an issue for Spec ID ${spec.specId}.`,
      );
    }
    console.log(`Existing authoritative issue: ${linkedIssue.url}`);
    console.log("No GitHub changes made.");
    return;
  }

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
  const existing = issues.find((issue) => issue.body.includes(marker));

  if (existing) {
    writeFileSync(specPath, withGitHubIssueUrl(markdown, existing.url));
    console.log(`Existing authoritative issue: ${existing.url}`);
    console.log(`Recorded issue URL in ${basename(specPath)}.`);
    console.log("No new GitHub issue created.");
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
    writeFileSync(specPath, withGitHubIssueUrl(markdown, url));
    console.log(`Created issue: ${url}`);
    console.log(`Recorded issue URL in ${basename(specPath)}.`);
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
