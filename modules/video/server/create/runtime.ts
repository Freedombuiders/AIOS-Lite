import path from 'node:path';
import { z } from 'zod';
import type { CreationService } from './service.js';
import { chatBriefSchema, createPlanSchema } from './schema.js';
const services = new Map<string, CreationService>();
export function bindCreationService(root: string, service: CreationService) { services.set(path.resolve(root), service); }
const empty = z.object({}).strict();
const scene = z.object({ sceneId: z.string().regex(/^scene-\d+$/) }).strict();
const definitions = [
  ['create_context', 'Read the bound project brief, profile, scenes, stable IDs and real output state.', empty],
  ['create_brief', 'Interpret the latest owner chat and confirm exact duration, aspect, scene count, model/type/audio and intent. plan/questions never authorize generation; generate requires an exact explicit instruction quote from the current owner message. Call before planning new work.', chatBriefSchema],
  ['flow_capabilities', 'Discover current Google Flow image/video models, aspect ratios and durations. Required before planning; never invent model names.', empty],
  ['create_plan', 'Save script and ordered image/video scenes. Follow the brief model/type/aspect/duration. Host assigns stable request IDs. Plan is immutable after generation begins.', createPlanSchema],
  ['create_generate', 'Generate ONE planned scene using its host-owned stable request ID. Uses user Flow credits. Never recreate unknown jobs or change IDs.', scene],
  ['create_poll', 'Wait briefly then read a submitted scene. Safe to repeat while queued/running; stop on unknown/failed/paused. No generation.', z.object({ sceneId: z.string().regex(/^scene-\d+$/), waitSeconds: z.number().int().min(0).max(20).default(15) }).strict()],
  ['create_import', 'Import the verified downloaded output of this scene into the shared library and project. No path or URL input accepted.', scene],
  ['create_render', 'Queue local MP4 assembly from all imported scenes with captions. Returns a job, not a finished video. No raw video or transcript required.', empty],
  ['create_status', 'Read real project and render job state. Claim a final video only when outputs.final and final URL exist.', empty],
  ['create_cancel', 'Cancel only the bound scene when the owner asks. Submitted work may continue; never replay uncertain cancellation.', scene],
] as const;
export const creationTools = definitions.map(([name, description, schema]) => ({ name, description, inputSchema: z.toJSONSchema(schema) }));

export function creationServiceFor(root: string): CreationService | undefined { return services.get(path.resolve(root)); }

/** Validates one tool call from an agent action against the same schemas the MCP gateway used. */
export function parseCreationArgs(name: string, args: unknown): unknown {
  const definition = definitions.find((d) => d[0] === name);
  if (!definition) throw new Error('Công cụ không tồn tại.');
  return definition[2].parse(args ?? {});
}
