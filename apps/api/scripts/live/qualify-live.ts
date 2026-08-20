const capability = process.argv[2] ?? "protected-interaction";

switch (capability) {
  case "protected-interaction":
  case "protected-output-acquisition":
    await import("./protected-output-acquisition-lab.js");
    break;
  case "protected-credential-generation":
    await import("./protected-credential-generation.js");
    break;
  default:
    throw new Error(`UNKNOWN_LIVE_QUALIFICATION_CAPABILITY:${capability}`);
}
