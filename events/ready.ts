import { log } from '../services/logger.ts';
import { ActivityType, type Client } from 'discord.js';
import { syncCommandsToDiscord } from '../commands/registry.ts';
import type { AurioContext } from '../services/AurioContext.ts';
import { buildBotOnlineLogCard, buildErrorFoundLogCard } from '../ui/cards/ownerLogs.ts';

export async function handleReady(client: Client, ctx: AurioContext): Promise<void> {
  log.info('ready', `Logged in as ${client.user?.tag} in ${client.guilds.cache.size} servers`);

  // 1. Strict startup emoji verification
  ctx.emojis.verifyStartup();

  // 2. Crash detection from previous run
  const startupInfo = ctx.errors.markStartup();
  if (startupInfo.crashedPreviously) {
    const crashErr = ctx.errors.record(
      new Error(`Unclean previous shutdown detected (PID ${startupInfo.previousPid ?? 'unknown'})`),
      { commandName: 'startup:crash_check' },
    );
    void ctx.ownerLogs.dispatch('errors', buildErrorFoundLogCard(ctx.ui, crashErr), 'Previous crash detected');
  }

  // 3. Sync application emojis and register slash commands (OWNER_GUILD_ID-only for owner commands)
  await syncCommandsToDiscord(ctx).catch((err) => log.error('ready', 'Command registration failed', err));
  await ctx.emojis.syncApplicationEmojis(client);

  // 4. Start Lavalink v4 nodes, wait for readiness, rejoin voice, and resume saved queues
  if (client.user) {
    ctx.lavalink.start(client.user.id);
    const presence = ctx.config.getPresence();
    const map = { Listening: ActivityType.Listening, Playing: ActivityType.Playing, Watching: ActivityType.Watching };
    client.user.setActivity(presence.text, { type: map[presence.activityType] });
  }

  const resumed = await ctx.restoreAndResumeQueues();
  log.info('ready', `Resumed ${resumed} saved queue(s)`);

  // 5. Start membership & panel cleanup schedulers and report online status
  ctx.startBackgroundSchedulers();
  await ctx.ownerLogs.dispatch(
    'status',
    buildBotOnlineLogCard(ctx.ui, client.guilds.cache.size, Math.max(0, Math.round(client.ws.ping))),
    `Aurio online (${client.guilds.cache.size} servers)`,
  );
}
