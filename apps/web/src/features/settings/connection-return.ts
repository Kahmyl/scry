const key = "scry-connection-return";
export function rememberConnectionReturn(path: string) {
  if (!/^\/connect\/authorize\/[A-Za-z0-9_-]{10,128}$/u.test(path)) return;
  try {
    sessionStorage.setItem(key, JSON.stringify({ path, createdAt: Date.now() }));
  } catch {
    /* The current page still supports email sign-in without storage. */
  }
}
export function takeConnectionReturn() {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    sessionStorage.removeItem(key);
    if (
      typeof value?.path === "string" &&
      /^\/connect\/authorize\/[A-Za-z0-9_-]{10,128}$/u.test(value.path) &&
      typeof value.createdAt === "number" &&
      Date.now() >= value.createdAt &&
      Date.now() - value.createdAt < 600000
    )
      return value.path;
  } catch {
    /* Never turn an invalid or unavailable return value into a redirect. */
  }
  return "/dashboard";
}
