const SECRET_FIELD =
  /(?:password|secret|token|authorization|cookie|api[_-]?key|credential|ciphertext)/i;
const SECRET_VALUE =
  /(?:bearer\s+[a-z0-9._~+/-]{12,}|sk_(?:live|test)_[a-z0-9]{8,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

export class CampaignRedactionError extends Error {
  constructor(readonly reasonCode: "CAMPAIGN_SECRET_FIELD" | "CAMPAIGN_SECRET_VALUE") {
    super(reasonCode);
  }
}

export function sanitizeCampaignValue(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): unknown {
  return visit(
    value,
    forbiddenValues.filter((item) => item.length > 0),
  );
}

export function serializeSanitizedCampaign(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): string {
  const sanitized = sanitizeCampaignValue(value, forbiddenValues);
  const output = `${JSON.stringify(sanitized, null, 2)}\n`;
  for (const forbidden of forbiddenValues) {
    if (forbidden && output.includes(forbidden)) {
      throw new CampaignRedactionError("CAMPAIGN_SECRET_VALUE");
    }
  }
  if (SECRET_VALUE.test(output)) throw new CampaignRedactionError("CAMPAIGN_SECRET_VALUE");
  return output;
}

function visit(value: unknown, forbiddenValues: readonly string[]): unknown {
  if (typeof value === "string") {
    if (
      forbiddenValues.some((forbidden) => value.includes(forbidden)) ||
      SECRET_VALUE.test(value)
    ) {
      throw new CampaignRedactionError("CAMPAIGN_SECRET_VALUE");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => visit(item, forbiddenValues));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (SECRET_FIELD.test(key)) throw new CampaignRedactionError("CAMPAIGN_SECRET_FIELD");
      return [key, visit(item, forbiddenValues)];
    }),
  );
}
