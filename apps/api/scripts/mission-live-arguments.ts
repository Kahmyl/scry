export function missionLiveArguments(argv: readonly string[]) {
  return argv.filter((argument) => argument !== "--");
}
