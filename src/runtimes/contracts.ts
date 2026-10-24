// Runtime layer contract. One adapter per CLI; the engine only talks to this interface.
import type { AgentConfig, ErrorFamily, RunEvent, RuntimeId, Usage } from '../core/types.js';
import type { EffectiveAccess } from '../access/contracts.js';

export type Enforcement = 'hard' | 'soft' | 'none';

/** How strongly a runtime enforces each kind of access (shown on the agent's Quyền tab). */
export interface AccessEnforcement {
  /** memory / brain / module data injected by AIOS — always hard (AIOS decides what goes into the prompt) */
  context: 'hard';
  mcp: Enforcement;
  fileRead: Enforcement;
  fileWrite: Enforcement;
  shell: Enforcement;
  /** short Vietnamese note for the UI, e.g. "Codex không chặn được đọc file ngoài thư mục" */
  note?: string;
}

export interface RuntimeCapabilities {
  /** can continue a previous session by id */
  resume: boolean;
  /** 'native' = CLI has a system-prompt flag; 'inline' = adapter prepends it to the prompt */
  systemPrompt: 'native' | 'inline';
  reportsCost: boolean;
  /** can attach local image files to a prompt */
  images: boolean;
  /** can attach local PDF documents to a prompt */
  documents: boolean;
  /** can run with no tools at all (lean turns) */
  noTools: boolean;
  enforces: AccessEnforcement;
}

export interface RunRequest {
  agent: AgentConfig;
  access: EffectiveAccess;
  /** user-side prompt (already composed by the context builder) */
  prompt: string;
  systemPrompt: string;
  /** absolute working directory (agent workspace) */
  cwd: string;
  /** resume this runtime session when capabilities.resume */
  sessionId?: string;
  /** 'none' for lean turns: no tools, single turn */
  tools: 'default' | 'none';
  /** absolute paths of images to attach (only if capabilities.images) */
  images?: string[];
  /** absolute paths of PDF documents to attach (only if capabilities.documents) */
  documents?: string[];
  signal: AbortSignal;
  timeoutMs: number;
  onEvent(event: RunEvent): void;
}

export interface RunError {
  family: ErrorFamily;
  message: string;
  /** ISO time after which a retry makes sense (quota windows) */
  retryAfter?: string;
}

export interface RunResult {
  ok: boolean;
  /** final assistant text (the last assistant message, not tool output) */
  output: string;
  sessionId?: string;
  /** the stored session is unusable; the next run must start fresh */
  clearSession?: boolean;
  model?: string;
  error?: RunError;
  /** missing fields = unknown (never fill with 0) */
  usage?: Usage;
}

export type DoctorLevel = 'info' | 'warn' | 'error';
export interface DoctorCheck {
  code: string;
  level: DoctorLevel;
  message: string;
  hint?: string;
}
export interface DoctorReport {
  runtime: RuntimeId;
  status: 'pass' | 'warn' | 'fail';
  version?: string;
  command?: string;
  checks: DoctorCheck[];
  testedAt: string;
}

export interface Runtime {
  id: RuntimeId;
  label: string;
  capabilities: RuntimeCapabilities;
  /** probe=true also sends a tiny "hello" prompt (costs a call) */
  doctor(opts?: { probe?: boolean }): Promise<DoctorReport>;
  run(req: RunRequest): Promise<RunResult>;
}

export interface RuntimeRegistry {
  get(id: RuntimeId): Runtime;
  list(): Runtime[];
  /** replace an adapter (tests) */
  register(runtime: Runtime): void;
}

export interface RuntimeRegistryOptions {
  /** override the binary used for a runtime (tests use fake CLIs) */
  commands?: Partial<Record<RuntimeId, string>>;
  /** extra env merged into every child process (after filtering) */
  env?: Record<string, string>;
}

/** Implemented in src/runtimes/index.ts */
export type CreateRuntimeRegistry = (opts?: RuntimeRegistryOptions) => RuntimeRegistry;
