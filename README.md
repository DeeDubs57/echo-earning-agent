# echo-earning-agent (DeeDubs57)

Read-only watcher for the Penniless Agent setup. Every 30 minutes GitHub Actions runs `agent.mjs`, which:

- reads the USDC and SOL balance of a receive-only Solana wallet (public address only)
- lists PRs by DeeDubs57 to repos he doesn't own, and flags new merges
- scans Superteam agent listings when a `SUPERTEAM_API_KEY` secret exists

Results go to `status.md`. A payment or a new merge fails the run once, so GitHub emails the owner.

No private keys or secrets live here. Adapted from Echolonius/echo-earning-agent.
