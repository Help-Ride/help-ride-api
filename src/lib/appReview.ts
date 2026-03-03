function parseBooleanEnv(value: string | undefined) {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  )
}

function getReviewEmailAllowlist() {
  const raw =
    process.env.APP_REVIEW_EMAILS ?? process.env.APP_REVIEW_EMAIL ?? ""
  const emails = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)

  return new Set(emails)
}

export function isAppReviewEmailBypassEnabled() {
  return parseBooleanEnv(process.env.APP_REVIEW_BYPASS_EMAIL_VERIFICATION)
}

export function isAppReviewEmail(email: string | null | undefined) {
  if (!email || !isAppReviewEmailBypassEnabled()) {
    return false
  }

  const allowlist = getReviewEmailAllowlist()
  if (allowlist.size === 0) {
    return false
  }

  return allowlist.has(email.trim().toLowerCase())
}
