# Rivtor plugin for Claude Code

Deploy and operate apps on [Rivtor](https://rivtor.com) from Claude Code: deploy a repo or folder
(frontend, backend, Postgres, Redis, storage), read verified results, fix failures from structured
errors, and manage secrets, logs, databases, domains and rollbacks.

## What's included

- **Rivtor MCP server** (`rivtor`): the remote server at `https://api.rivtor.com/mcp`
  (Streamable HTTP). Read-only tools (status, logs, issues, database reads) are annotated
  `readOnlyHint`; tools that change or delete anything (deploy, env vars, rollback, domains,
  destroy) are annotated `destructiveHint`, so Claude Code asks before running them.
- **Rivtor skill** (`skills/rivtor`): how to deploy, read results and fix failures with Rivtor.

## Install

```
/plugin marketplace add shyamolkonwar/rivtor-cli
/plugin install rivtor@rivtor
```

Then run `/mcp`, select `plugin:rivtor:rivtor` and choose **Authenticate**. A rivtor.com window
opens: sign in (GitHub, Google, email link or password) and click **Allow**. No API token is stored
in the plugin; Claude Code keeps the OAuth tokens in your system keychain. Disconnect any time at
https://rivtor.com/dashboard/tokens.

To deploy local folders by tarball instead, the CLI also ships a local stdio server:
`claude mcp add rivtor-local -- npx -y rivtor mcp`.

Documentation: https://rivtor.com/docs/mcp and https://rivtor.com/docs/tools

## Privacy Policy

Rivtor's privacy policy: <https://rivtor.com/privacy>. It covers what data Rivtor collects
(account details, the source code and environment variables you deploy, logs and usage), how it is
used and stored (apps and databases run in India, behind Cloudflare; secrets are encrypted), which
third parties process it, how long it is kept, and how to contact us. The plugin itself collects
nothing: it only connects Claude Code to Rivtor's MCP server after you sign in.

## Support

- Email: support@rivtor.com
- Privacy and legal: legal@rivtor.com
- Issues: https://github.com/shyamolkonwar/rivtor-cli/issues

## License

MIT
