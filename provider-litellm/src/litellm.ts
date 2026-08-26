export function getSessionIdFromFile(sessionFile?: string): string | undefined {
  if (!sessionFile) return undefined;
  const filename = sessionFile
    .split("/")
    .pop()
    ?.replace(/\.jsonl$/i, "");
  if (!filename) return undefined;
  const uuidMatch = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return uuidMatch?.[1] ?? filename;
}
