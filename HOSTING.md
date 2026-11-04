# Deploy The Western Line Discord bot

## Files and secrets

This repository contains bot source, safe configuration, and the status banner. It excludes `node_modules`, the Windows DPAPI token, local logs/runtime state, and FiveM `*.cfg`/key files. Keep this GitHub repository **private**. Do not commit a real `.env` file or any bot/bridge token.

## Bot-Hosting.net

1. Create a Node.js Application deployment from this private GitHub repository and branch `main`.
2. Set the entry/start command to `node bot.mjs` (or the panel's equivalent entry file setting).
3. Set the deployment's Node.js runtime to 20 or later.
4. Add these as masked/secret environment variables in the hosting panel, not GitHub:
   - `DISCORD_BOT_TOKEN`: the bot token, entered privately in the provider's secret field.
   - `TWL_LOCAL_BRIDGE_KEY`: the same high-entropy bridge key configured in the FiveM server's secret convar file. Do not put it in the repository.
   - `TWL_FIVEM_STATUS_URL`: optional, but required for live player counts. It must be a reachable public FiveM HTTP endpoint; `127.0.0.1` refers to the bot container and will not work.
5. Make the app's HTTPS URL available. The bot bridge listens on the provider-supplied `SERVER_PORT` and `0.0.0.0`, serving `/health` and the authenticated `/fivem` endpoint.
6. Configure the local FiveM `twl_operations` resource to call the provider's HTTPS `/fivem` URL and retain the bridge key only in its local secret config. The current PC server still targets its local bridge; switching that convar is a separate cutover step after the deployment URL exists.
7. Stop the PC-hosted bot before starting the hosted bot. Do not run two gateway sessions during cutover. Keep the local bot files and encrypted token backup until the hosted bot is confirmed healthy.

The host's free plan may require renewal every four days; confirm the current plan limits before relying on uninterrupted uptime.

## Local development

```sh
npm install
DISCORD_BOT_TOKEN=... node bot.mjs
```

On Windows, use the existing local `Start-Bot.ps1` workflow instead of putting a token in a command line.
