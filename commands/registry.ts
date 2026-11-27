import { log } from '../services/logger.ts';
import { REST, Routes, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { AurioContext } from '../services/AurioContext.ts';
import { createGeneralCommands } from './general.ts';
import { createLibraryCommands } from './library.ts';
import { createMusicCommands } from './music.ts';
import { createOwnerAdminCommands } from './owner/admin.ts';
import { createOwnerBlacklistCommands } from './owner/blacklist.ts';
import { createOwnerEmojiCommands } from './owner/emojis.ts';
import { createOwnerMembershipCommands } from './owner/membership.ts';
import { createOwnerLogCommands } from './owner/ologs.ts';
import { createOwnerServerCommands } from './owner/servers.ts';
import type { AurioCommand } from './types.ts';

export function registerAllCommands(ctx: AurioContext): AurioCommand[] {
  ctx.commands.clear();
  const all: AurioCommand[] = [
    ...createMusicCommands(),
    ...createLibraryCommands(),
    ...createGeneralCommands(),
    ...createOwnerEmojiCommands(),
    ...createOwnerBlacklistCommands(),
    ...createOwnerLogCommands(),
    ...createOwnerServerCommands(),
    ...createOwnerMembershipCommands(),
    ...createOwnerAdminCommands(),
  ];

  for (const cmd of all) {
    ctx.commands.set(cmd.name, cmd);
  }
  return all;
}

export function splitCommandRegistrations(commands: AurioCommand[]): {
  publicSlash: RESTPostAPIChatInputApplicationCommandsJSONBody[];
  ownerSlash: RESTPostAPIChatInputApplicationCommandsJSONBody[];
  ownerCommandNames: Set<string>;
} {
  const publicSlash: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
  const ownerSlash: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
  const ownerCommandNames = new Set<string>();

  for (const cmd of commands) {
    const json = cmd.slash.toJSON();
    if (cmd.ownerOnly) {
      ownerSlash.push(json);
      ownerCommandNames.add(cmd.name);
    } else {
      publicSlash.push(json);
    }
  }

  return { publicSlash, ownerSlash, ownerCommandNames };
}

export async function syncCommandsToDiscord(
  ctx: AurioContext,
  options: { reset?: boolean } = {},
): Promise<number> {
  const commands = registerAllCommands(ctx);
  const { publicSlash, ownerSlash } = splitCommandRegistrations(commands);

  const token = process.env.DISCORD_TOKEN;
  const clientId = ctx.client?.user?.id ?? process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    log.warn('commands', 'Skipping registration: DISCORD_TOKEN or client ID is missing.');
    return commands.length;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const ownerGuildId = ctx.permissions.getOwnerGuildId();

  const step = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      log.info('commands', `${label}: done`);
    } catch (err) {
      log.error('commands', `${label}: failed`, err);
    }
  };

  // 1. Owner slash commands go ONLY to OWNER_GUILD_ID. Registered first so nothing can delay them.
  //    PUT overwrites the guild's whole set, so the owner guild is never wiped beforehand.
  if (ownerGuildId) {
    if (ctx.client && !ctx.client.guilds.cache.has(ownerGuildId)) {
      log.warn(
        'commands',
        `Aurio is not a member of OWNER_GUILD_ID ${ownerGuildId}. Invite it there (with the "bot" AND "applications.commands" scopes) or fix OWNER_GUILD_ID.`,
      );
    }
    await step(`Register ${ownerSlash.length} owner commands in guild ${ownerGuildId}`, async () => {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, ownerGuildId), { body: ownerSlash });
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 50001 || code === 10004 || code === 10002) {
          log.error(
            'commands',
            `Discord error ${code}: the bot cannot manage commands in guild ${ownerGuildId}. Re-invite it with the applications.commands scope, and check OWNER_GUILD_ID and DISCORD_CLIENT_ID.`,
          );
        }
        throw err;
      }
      const registered = (await rest.get(Routes.applicationGuildCommands(clientId, ownerGuildId))) as unknown[];
      log.info('commands', `Owner guild ${ownerGuildId} now has ${registered.length} commands`);
    });
  } else {
    log.warn('commands', 'OWNER_GUILD_ID is not set; owner slash commands were not registered (owner prefix/@mention commands still work).');
  }

  // 2. Public commands are global. PUT overwrites the whole set, so no separate reset is needed.
  await step(`Register ${publicSlash.length} public commands`, () =>
    rest.put(Routes.applicationCommands(clientId), { body: publicSlash }),
  );

  // 3. Clear stale guild-scoped commands left in other servers by older versions.
  if (options.reset !== false) {
    for (const guildId of ctx.client?.guilds.cache.keys() ?? []) {
      if (guildId === ownerGuildId) continue;
      try {
        const existing = (await rest.get(Routes.applicationGuildCommands(clientId, guildId))) as unknown[];
        if (existing.length > 0) {
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
          log.info('commands', `Cleared ${existing.length} stale guild commands in ${guildId}`);
        }
      } catch (err) {
        log.warn('commands', `Could not check guild commands in ${guildId}: ${(err as Error).message}`);
      }
    }
  }

  return commands.length;
}
