export const SDK_AUTH_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

const SECRET_NAME = /(key|token|secret|password|passwd|credential|cookie|authorization)/i;

/** Env for child processes: everything except secret-looking variables, plus the explicitly allowed auth secrets. */
export function getScrubbedSdkEnv(authSecrets?: Partial<Record<(typeof SDK_AUTH_VARS)[number], string>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_NAME.test(k)) out[k] = v;
  for (const name of SDK_AUTH_VARS) if (authSecrets?.[name]) out[name] = authSecrets[name];
  return out;
}
