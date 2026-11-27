// Runtime layer contract: GenBot (and the mock); the engine only talks to this interface.
import type { AgentConfig, AgentRuntime, ErrorFamily, RunEvent, RuntimeId, Usage } from '../core/types.js';
import type { EffectiveAccess } from '../access/contracts.js';
import type { GenbotRuntimeOptions } from './genbot.js';

export type Enforcement = 'hard' | 'soft' | 'none';

/** How strongly a runtime enforces each kind of access (shown on the agent's Quyền tab). */
export interface AccessEnforcement {
  /** memory / brain / module data injected by AIOS — always hard (AIOS decides what goes into the prompt) */
  context: 'hard';
  mcp: Enforcement;
  fileRead: Enforcement;
  fileWrite: Enforcement;
  shell: Enforcement;
  /** short Vietnamese note for the UI */
  note?: string;
}

export interface RuntimeCapabilities {
  /** can continue a previous session by id */
  resume: boolean;
  /** 'native' = the engine takes a system prompt; 'inline' = adapter prepends it to the prompt */
  systemPrompt: 'native' | 'inline';
  reportsCost: boolean;
  /** can attach local image files to a prompt */
  images: boolean;
  /** can attach local PDF documents to a prompt */
  documents: boolean;
  /** can run with no tools at all (lean turns). Says nothing about whether tools or MCP are available otherwise. */
  noTools: boolean;
  /** can be given MCP servers on a standard turn (the access policy grants `aios-integrations` only when true) */
  mcp: boolean;
  /** can open local files by path (skill files, attachments named in the prompt); false = text in, text out */
  readsFiles: boolean;
  /** hard cap on systemPrompt + prompt in characters; the context builder fits everything inside it */
  maxPromptChars?: number;
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
  /** throws for an id with no adapter (an old engine named by a legacy agent.yaml) */
  get(id: AgentRuntime): Runtime;
  /** undefined for an id with no adapter */
  find(id: AgentRuntime): Runtime | undefined;
  list(): Runtime[];
  /** replace an adapter (tests) */
  register(runtime: Runtime): void;
}

export interface RuntimeRegistryOptions {
  /** GenBot adapter options (tests inject env, poll interval, limiter) */
  genbot?: GenbotRuntimeOptions;
}

/** Implemented in src/runtimes/index.ts */
export type CreateRuntimeRegistry = (opts?: RuntimeRegistryOptions) => RuntimeRegistry;
