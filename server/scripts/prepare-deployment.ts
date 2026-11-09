import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateDeployment(
  tag: string,
  commit: string,
  version: string,
  release: { tagName: string; isDraft: boolean; isPrerelease: boolean },
  manifest: { commit: string; repository: string },
  metadata: { "containerimage.digest": string },
  repository: string,
) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(tag, `v${version}`, "Tag and source version differ");
  assert.equal(release.tagName, tag);
  assert.equal(release.isDraft, false, "Publish the release before deploying");
  assert.equal(
    release.isPrerelease,
    false,
    "Production requires a stable release",
  );
  assert.equal(manifest.commit, commit, "Release assets and tag differ");
  assert.equal(manifest.repository, `https://github.com/${repository}`);
  assert.match(metadata["containerimage.digest"], /^sha256:[a-f0-9]{64}$/);
  return `ghcr.io/${repository.split("/")[0].toLowerCase()}/orka-api@${metadata["containerimage.digest"]}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.env.RELEASE_TAG ?? "";
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  assert.match(repository, /^[\w-]+\/[\w.-]+$/);
  const output = resolve(process.argv[2]);
  mkdirSync(output, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const commit = git("rev-parse", `refs/tags/${tag}^{commit}`);
  git("merge-base", "--is-ancestor", commit, "origin/main");
  const release = JSON.parse(
    execFileSync(
      "gh",
      [
        "release",
        "view",
        tag,
        "--repo",
        repository,
        "--json",
        "tagName,isDraft,isPrerelease",
      ],
      { encoding: "utf8" },
    ),
  );
  execFileSync("gh", [
    "release",
    "download",
    tag,
    "--repo",
    repository,
    "--pattern",
    "manifest.json",
    "--pattern",
    "orka-api-image.json",
    "--dir",
    output,
  ]);
  const image = validateDeployment(
    tag,
    commit,
    JSON.parse(git("show", `${commit}:package.json`)).version,
    release,
    JSON.parse(readFileSync(resolve(output, "manifest.json"), "utf8")),
    JSON.parse(readFileSync(resolve(output, "orka-api-image.json"), "utf8")),
    repository,
  );
  execFileSync("git", [
    "archive",
    "--format=tar",
    "--output",
    resolve(output, "deploy.tar"),
    commit,
    "deploy/ec2",
    "deploy/cloud",
  ]);
  writeFileSync(resolve(output, "image"), image);
  writeFileSync(resolve(output, "commit"), commit);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Deploying ${tag} (${commit})\n\nImage: \`${image}\`\n`,
      { flag: "a" },
    );
}
