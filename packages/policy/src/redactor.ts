export class SecretRedactor {
  private readonly secrets = new Set<string>();

  add(value: string) {
    if (value.length > 0) this.secrets.add(value);
  }

  redact(value: string): string {
    let result = value;
    for (const secret of [...this.secrets].sort((left, right) => right.length - left.length)) {
      result = result.replaceAll(secret, "[REDACTED]");
      try {
        result = result.replaceAll(encodeURIComponent(secret), "[REDACTED]");
      } catch {
        // The literal form is still redacted.
      }
    }
    return result;
  }

  redactValue<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [this.redact(key), this.redactValue(item)]),
      ) as T;
    }
    return value;
  }
}
