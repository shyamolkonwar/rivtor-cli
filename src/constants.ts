// Runtime constants. The CLI is published to npm without @rivtor/shared at runtime,
// so anything needed at runtime is duplicated here (types come from @rivtor/shared).

export const DEFAULT_API_URL = "https://api.rivtor.com";
export const SITE_URL = "https://rivtor.com";
export const DASHBOARD_URL = "https://rivtor.com/dashboard";
export const TOKENS_URL = "https://rivtor.com/dashboard/tokens";
export const REMOTE_MCP_URL = "https://api.rivtor.com/mcp";

/** Max size of the uploaded source tarball (compressed). */
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

export const EXIT = { OK: 0, FAILED: 1, NEEDS_INPUT: 2 } as const;

export const NOT_LOGGED_IN_MESSAGE =
  `Not logged in. Run \`rivtor login\` (create a token at ${TOKENS_URL}) or set RIVTOR_TOKEN.`;
