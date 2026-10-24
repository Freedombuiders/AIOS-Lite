// Every integration the app knows about. Adding one: write its definition under src/integrations/<id>/ and list it here.
import { botcakeIntegration } from './botcake/index.js';
import { composioIntegration } from './composio/index.js';
import { googleIntegrations } from './composio/google.js';
import { elevenlabsIntegration } from './elevenlabs/index.js';
import { fptaiIntegration } from './fptai/index.js';
import { freesoundIntegration } from './freesound/index.js';
import { pancakeIntegration } from './pancake/index.js';
import { pexelsIntegration } from './pexels/index.js';
import type { IntegrationDefinition } from './types.js';

export const INTEGRATIONS: IntegrationDefinition[] = [
  composioIntegration,
  ...googleIntegrations,
  botcakeIntegration,
  pancakeIntegration,
  pexelsIntegration,
  freesoundIntegration,
  elevenlabsIntegration,
  fptaiIntegration,
];

export function getIntegration(id: string): IntegrationDefinition | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}

export function listIntegrationIds(): string[] {
  return INTEGRATIONS.map((i) => i.id);
}
