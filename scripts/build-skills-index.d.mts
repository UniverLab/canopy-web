// SPDX-License-Identifier: Apache-2.0
/**
 * Types for the skills-index builder, so the staleness test can import
 * the pure pieces (front matter, digests, collection) directly.
 */
import type { Buffer } from "node:buffer";

export interface CollectedSkill {
  name: string;
  description: string;
  digest: string;
  files: Record<string, string>;
}

export function readFrontMatter(source: string): Record<string, string>;
export function digestOf(bytes: Buffer): string;
export function collectSkills(dir: string): CollectedSkill[];
export function renderModule(source: string, skills: CollectedSkill[], builtAt: string): string;
export function previousBuild(out: string): { builtAt: string; payload: string } | null;
export function buildSkillsIndex(options?: {
  check?: boolean;
  now?: () => string;
}): Promise<{ changed: boolean }>;
