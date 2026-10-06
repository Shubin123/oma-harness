import {
  migrateProject,
  serialize,
  deserialize,
  type Project,
} from "@oma/shared";
export class BrowserProjects {
  private database: Promise<IDBDatabase>;
  readonly changed =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("oma-projects");
  constructor(name = "oma-harness") {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("projects", { keyPath: "id" });
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () =>
        reject(
          new Error("Browser storage unavailable: " + request.error?.message),
        );
      request.onblocked = () =>
        reject(
          new Error("Close other harness tabs to upgrade browser storage"),
        );
    });
  }
  async get(id: string): Promise<Project> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readonly");
      const req = tx.objectStore("projects").get(id);
      req.onsuccess = () => {
        try {
          if (!req.result)
            throw new Error("Project not found in browser cache");
          resolve(migrateProject(deserialize(req.result.snapshot)));
        } catch (e) {
          reject(e);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }
  async list(): Promise<
    Array<{ id: string; name: string; updated_at: number }>
  > {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readonly");
      const req = tx.objectStore("projects").getAll();
      req.onsuccess = () =>
        resolve(
          req.result
            .map((p) => ({ id: p.id, name: p.name, updated_at: p.updated_at }))
            .sort((a, b) => b.updated_at - a.updated_at),
        );
      req.onerror = () => reject(req.error);
    });
  }
  async save(value: Project, insertOnly = false): Promise<Project> {
    const p = migrateProject(value);
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      const store = tx.objectStore("projects");
      const get = store.get(p.id);
      let saved: Project;
      get.onsuccess = () => {
        try {
          const previous = get.result;
          if (previous && insertOnly) {
            saved = migrateProject(deserialize(previous.snapshot));
            return;
          }
          if (previous && previous.revision !== p.revision)
            throw new Error(
              "Project changed in another tab. Reload before saving.",
            );
          p.revision++;
          p.updated_at = Date.now() / 1000;
          saved = p;
          store.put({
            id: p.id,
            name: p.name,
            updated_at: p.updated_at,
            revision: p.revision,
            snapshot: serialize(p),
          });
        } catch (e) {
          reject(e);
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        this.changed?.postMessage({ id: p.id, revision: saved.revision });
        resolve(saved);
      };
      tx.onerror = () =>
        reject(new Error("Browser save failed: " + tx.error?.message));
      tx.onabort = () =>
        reject(
          new Error(
            "Browser save aborted: " +
              (tx.error?.message || "conflicting change"),
          ),
        );
    });
  }
  async recover(id: string): Promise<Project> {
    const p = await this.get(id);
    let changed = false;
    for (const m of p.messages)
      if (["sending", "streaming", "queued"].includes(m.status || "")) {
        m.status = "interrupted";
        m.error =
          "Delivery interrupted. Review the partial reply and retry if needed.";
        changed = true;
      }
    for (const r of p.runs)
      if (r.status === "running") {
        r.status = "interrupted";
        for (const n of Object.values(r.node_results || {}) as any[])
          if (["queued", "running"].includes(n.status))
            n.status = n.status === "running" ? "failed" : "blocked";
        changed = true;
      }
    return changed ? this.save(p) : p;
  }
  async export(): Promise<string> {
    const projects = await Promise.all(
      (await this.list()).map((p) => this.get(p.id)),
    );
    return serialize({ kind: "oma-projects", schema_version: 1, projects });
  }
  async import(text: string): Promise<number> {
    let payload: any;
    try {
      payload = deserialize(text);
    } catch {
      payload = JSON.parse(text);
    }
    const values =
      payload.kind === "oma-projects" && payload.schema_version === 1
        ? payload.projects
        : [payload];
    if (!Array.isArray(values)) throw new Error("Invalid project export");
    const projects = values.map(migrateProject);
    for (const p of projects) await this.save(p, true);
    return projects.length;
  }
  async close(): Promise<void> {
    (await this.database).close();
    this.changed?.close();
  }
}
