export type ReleaseTarget = {
  version: string;
  distTag: "latest" | "next";
};

const TAG_RE = /^v(\d{2})\.([1-9]|1[0-2])\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

export function resolveRelease(
  tag: string,
  prerelease: boolean,
): ReleaseTarget {
  if (!TAG_RE.test(tag)) {
    throw new Error(`tag ${tag} is not CalVer vYY.M.patch`);
  }
  const version = tag.slice(1);
  const distTag = prerelease || version.includes("-") ? "next" : "latest";
  return { version, distTag };
}

if (import.meta.main) {
  try {
    const tag = process.env.RELEASE_TAG;
    if (!tag) throw new Error("RELEASE_TAG is required");
    const { version, distTag } = resolveRelease(
      tag,
      process.env.PRERELEASE === "true",
    );
    process.stdout.write(`VERSION=${version}\nDIST_TAG=${distTag}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
