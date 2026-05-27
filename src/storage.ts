import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { ArtifactReference, SessionState } from "./types.js";

export interface SessionStore {
  get(sessionId: string): Promise<SessionState | undefined>;
  put(session: SessionState): Promise<void>;
}

export interface ArtifactBlob {
  bytes: Uint8Array;
  contentType: string;
}

export interface ArtifactStore {
  put(sessionId: string, bytes: Uint8Array, options?: { ttlSeconds?: number; baseUrl?: string }): Promise<ArtifactReference>;
  get(sessionId: string, artifactId: string): Promise<ArtifactBlob | undefined>;
}

export interface QuotaStore {
  consume(key: string, limit: number, ttlSeconds: number): Promise<{ allowed: boolean; used: number; remaining: number }>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  async get(sessionId: string): Promise<SessionState | undefined> {
    return this.sessions.get(sessionId);
  }

  async put(session: SessionState): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactBlob & { artifactId: string; expiresAt: string }>();

  async put(sessionId: string, bytes: Uint8Array, options: { ttlSeconds?: number; baseUrl?: string } = {}): Promise<ArtifactReference> {
    const artifactId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + (options.ttlSeconds ?? 3600) * 1000).toISOString();
    const key = `${sessionId}:${artifactId}`;
    this.artifacts.set(key, { bytes, contentType: "application/zip", artifactId, expiresAt });
    return {
      artifactId,
      contentType: "application/zip",
      expiresAt,
      ...(options.baseUrl ? { downloadUrl: `${options.baseUrl}/artifacts/${sessionId}/${artifactId}?token=${artifactId}` } : {})
    };
  }

  async get(sessionId: string, artifactId: string): Promise<ArtifactBlob | undefined> {
    const artifact = this.artifacts.get(`${sessionId}:${artifactId}`);
    if (!artifact) {
      return undefined;
    }
    return { bytes: artifact.bytes, contentType: artifact.contentType };
  }
}

export class LocalFileArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string = path.join(os.tmpdir(), "tpf-mcp-artifacts")) {}

  async put(sessionId: string, bytes: Uint8Array, options: { ttlSeconds?: number; baseUrl?: string } = {}): Promise<ArtifactReference> {
    const artifactId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + (options.ttlSeconds ?? 3600) * 1000).toISOString();
    const sessionDir = path.join(this.rootDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const localPath = path.join(sessionDir, `${artifactId}.zip`);
    await fs.writeFile(localPath, bytes);
    return {
      artifactId,
      localPath,
      contentType: "application/zip",
      expiresAt
    };
  }

  async get(sessionId: string, artifactId: string): Promise<ArtifactBlob | undefined> {
    const localPath = path.join(this.rootDir, sessionId, `${artifactId}.zip`);
    try {
      const bytes = await fs.readFile(localPath);
      return { bytes: new Uint8Array(bytes), contentType: "application/zip" };
    } catch {
      return undefined;
    }
  }
}

export class NoopQuotaStore implements QuotaStore {
  async consume(_key: string, limit: number): Promise<{ allowed: boolean; used: number; remaining: number }> {
    return { allowed: true, used: 1, remaining: Math.max(0, limit - 1) };
  }
}

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export class KvQuotaStore implements QuotaStore {
  constructor(private readonly kv: KvLike) {}

  async consume(key: string, limit: number, ttlSeconds: number): Promise<{ allowed: boolean; used: number; remaining: number }> {
    const current = Number.parseInt((await this.kv.get(key)) || "0", 10);
    const next = current + 1;
    await this.kv.put(key, String(next), { expirationTtl: ttlSeconds });
    return {
      allowed: next <= limit,
      used: next,
      remaining: Math.max(0, limit - next)
    };
  }
}

export function dailyQuotaKey(prefix: string, identifier: string, date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return `${prefix}:${hashValue(identifier)}:${day}`;
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
