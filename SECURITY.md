# Security Policy

Agent HQ starts Claude Code sessions that can run commands on the machines hosting them, so security reports are taken
seriously. Thank you for helping keep users safe.

## Supported versions

Agent HQ is in early development and has no long-term support branches. Security fixes land on `main` and in the next
release.

| Version | Supported |
|---|---|
| `main` / latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

**Please don't report security vulnerabilities in public issues, discussions or pull requests.**

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. If
that option isn't available, contact the maintainer, [@geovane-gc](https://github.com/geovane-gc), privately and ask
for a secure channel. Don't include exploit details until you have one.

Please include:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The Agent HQ version or commit, your OS, and how you run it (desktop app, browser, or `npm run join` runner)
- Whether the server was exposed beyond `127.0.0.1`, and how (LAN, tunnel, reverse proxy)

We aim to acknowledge reports within a few days, keep you updated while we work on a fix, and credit you when it ships
unless you'd rather stay anonymous.

## Scope

Examples of what we want to hear about:

- Bypassing the token-based access control (owner token, invite tokens, or the short-lived tokens for agents' MCP tools)
- A member or watcher being able to type into, approve actions for, or control an agent they don't own
- A way for a remote party to make an agent or the boss terminal run commands without the owner's consent
- Agent HQ trusting folders other than the worktrees and scratch folders it creates from repositories you added
- Leaking Claude credentials, tokens, or the contents of the data directory

Out of scope, because they are documented behavior:

- Agents running commands on their owner's machine. That is what they are for, within the permission mode you choose.
- Risks of exposing the server to untrusted networks without TLS. The server listens on `127.0.0.1` by default and has
  no TLS of its own; use a tunnel or a reverse proxy with HTTPS. See [Security notes](README.md#security-notes).
- Vulnerabilities in Claude Code itself. Report those to Anthropic.
