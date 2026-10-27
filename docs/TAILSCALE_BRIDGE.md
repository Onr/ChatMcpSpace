# Private Tailscale communication bridge

This project can be reached privately through a machine connected to your
Tailscale tailnet. The bridge uses Tailscale Serve to terminate HTTPS and proxy
requests to the local ChatMCP server. It does not use Tailscale Funnel and does
not publish the app to the public internet.

## Start it

1. Start ChatMCP locally and confirm it responds on its configured `PORT`
   (3000 by default).
2. Confirm Tailscale is connected on the same machine:

   ```bash
   tailscale status
   ```

3. Configure the private proxy:

   ```bash
   ./scripts/tailscale_bridge.sh up
   ```

   If the app uses a different port, set `TAILSCALE_APP_PORT` for that
   invocation. The script checks the local app before changing Serve config.

4. Copy the HTTPS hostname printed by `tailscale serve status` into `.env`:

   ```dotenv
   BASE_URL=https://your-machine.your-tailnet.ts.net
   ```

   Restart ChatMCP after changing `BASE_URL`. This keeps generated links,
   browser origins, and connector URLs on the same private HTTPS address.

5. On an external agent machine that is also allowed in the tailnet, point the
   existing connector at the same address:

   ```bash
   export CHATSPACE_URL=https://your-machine.your-tailnet.ts.net
   node scripts/external-agent-bridge.js run
   ```

Use the paired state file and runtime credentials described in
[`EXTERNAL_AGENT_BRIDGE.md`](EXTERNAL_AGENT_BRIDGE.md). Keep those secrets
local; Tailscale connectivity does not replace ChatMCP authentication or agent
pairing.

## Check or stop it

```bash
./scripts/tailscale_bridge.sh status
```

To stop sharing, run `tailscale serve off` only if this machine has no other
Serve routes that you need. Tailscale Serve configuration is persistent across
restarts when started with `--bg`; it resumes when Tailscale reconnects.

Access still depends on your tailnet ACLs/grants and the ChatMCP login. Treat
the Tailscale hostname as private network access, not as a replacement for
application authentication.
