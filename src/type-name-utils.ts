import type { PipelineInputBoundary } from "./types.js";

// TPF scaffold messages are keyed by unique simple names today. If fully-qualified
// message keys are introduced, update these helpers to detect simple-name collisions.
export function typeNamesMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return left === right || simpleTypeName(left) === simpleTypeName(right);
}

export function simpleTypeName(value: string): string {
  return value.replace(/.*\./, "");
}

export function legacyObjectInputBoundary(boundary: PipelineInputBoundary | undefined): PipelineInputBoundary["object"] | undefined {
  const legacy = boundary as unknown as { from?: string; emits?: NonNullable<PipelineInputBoundary["object"]>["emits"] } | undefined;
  return legacy?.from && legacy.emits ? { source: legacy.from, emits: legacy.emits } : undefined;
}
