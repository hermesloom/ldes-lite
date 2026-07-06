import { open } from "node:fs/promises";

/**
 * fsync a directory. Required after creating, renaming, or removing files
 * in that directory if you want those metadata operations to survive a crash.
 * POSIX / Linux specific; on macOS this is a no-op but harmless.
 */
export async function fsyncDir(path: string): Promise<void> {
  const dir = await open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
