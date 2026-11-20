export function getAllowedClientOrigins() {
  const configured = [
    process.env.CLIENT_URL,
    process.env.BETTER_AUTH_URL,
    process.env.CLIENT_ORIGINS,
    process.env.BETTER_AUTH_TRUSTED_ORIGINS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => {
      try {
        return new URL(value.trim()).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  return [...new Set(configured)];
}
