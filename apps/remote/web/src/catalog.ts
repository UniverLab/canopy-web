// SPDX-License-Identifier: Apache-2.0
// The host catalog as the shell sees it: clis, projects, presets and
// skills requested on connect and cached for the session. The router
// replaces it on a catalog frame, the shell clears it on a new host, and
// the open dialogs subscribe so their pickers fill in when it arrives.

import type { Catalog, CatalogCli, CatalogProject, CatalogPreset, CatalogSkill } from "./protocol.js";

export function emptyCatalog(): Catalog {
  return { clis: [], projects: [], presets: [], skills: [] };
}

export class CatalogStore {
  private catalog: Catalog = emptyCatalog();
  private loaded = false;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  replace(catalog: Catalog): void {
    this.catalog = catalog;
    this.loaded = true;
    this.notify();
  }

  clear(): void {
    this.catalog = emptyCatalog();
    this.loaded = false;
    this.notify();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get clis(): CatalogCli[] {
    return this.catalog.clis;
  }

  get projects(): CatalogProject[] {
    return this.catalog.projects;
  }

  get presets(): CatalogPreset[] {
    return this.catalog.presets;
  }

  get skills(): CatalogSkill[] {
    return this.catalog.skills;
  }

  snapshot(): Catalog {
    return this.catalog;
  }

  findCli(cli: string): CatalogCli | null {
    return this.catalog.clis.find((item) => item.cli === cli) ?? null;
  }

  findProject(name: string): CatalogProject | null {
    return this.catalog.projects.find((item) => item.name === name) ?? null;
  }

  findPreset(name: string): CatalogPreset | null {
    return this.catalog.presets.find((item) => item.name === name) ?? null;
  }
}
