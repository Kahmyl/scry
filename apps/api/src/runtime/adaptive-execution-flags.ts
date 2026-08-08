export type AdaptiveExecutionFlags = {
  executionKernel: true;
  authoringTurn: boolean;
};

export function adaptiveExecutionFlags(
  environment: NodeJS.ProcessEnv = process.env,
): AdaptiveExecutionFlags {
  return {
    executionKernel: true,
    authoringTurn: enabled(environment, "SCRY_AUTHORING_TURN_ENABLED", false),
  };
}

function enabled(environment: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const value = environment[name];
  if (value === undefined) return fallback;
  return value === "true";
}
