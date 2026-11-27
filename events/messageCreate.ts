import { log } from '../services/logger.ts';
import type { Message } from 'discord.js';
import type { AurioCommand, CommandInvocation } from '../commands/types.ts';
import { LavalinkRequestError } from '../lavalink/LavalinkManager.ts';
import type { AurioContext } from '../services/AurioContext.ts';
import type { AurioMessagePayload } from '../ui/cardKit.ts';
import { buildServerBlockedCard } from '../ui/cards/blacklist.ts';
import {
  buildCleanErrorCard,
  buildCooldownCard,
  buildDjRequiredCard,
  buildErrorCard,
  buildMaintenanceNoticeCard,
  buildMentionGreetingCard,
} from '../ui/cards/general.ts';
import {
  buildBlacklistHitLogCard,
  buildCommandUsedLogCard,
  buildErrorFoundLogCard,
} from '../ui/cards/ownerLogs.ts';

function findCommandByNameOrAlias(ctx: AurioContext, token: string): AurioCommand | undefined {
  const lower = token.toLowerCase();
  const direct = ctx.commands.get(lower);
  if (direct) return direct;
  for (const cmd of ctx.commands.values()) {
    if (cmd.aliases?.includes(lower)) return cmd;
  }
  return undefined;
}

export async function handleMessageCreate(message: Message, ctx: AurioContext): Promise<void> {
  if (message.author.bot || !message.guild) return;

  const settings = ctx.repos.getGuildSettings(message.guild.id, ctx.config.getDefaultPrefix());
  const prefix = settings.prefix;
  const botId = ctx.client?.user?.id;
  const mentionRegex = botId ? new RegExp(`^<@!?${botId}>\\s*`) : null;

  let rawBody: string | null = null;
  let isMentionOnly = false;

  if (mentionRegex && mentionRegex.test(message.content)) {
    const stripped = message.content.replace(mentionRegex, '').trim();
    if (!stripped) {
      isMentionOnly = true;
    } else {
      rawBody = stripped;
    }
  } else if (message.content.startsWith(prefix)) {
    rawBody = message.content.slice(prefix.length).trim();
  } else {
    return;
  }

  // Blacklist gate
  if (!ctx.permissions.isOwner(message.author.id)) {
    const bl = ctx.permissions.checkBlacklist(message.author.id, message.guild.ownerId);
    if (bl) {
      void ctx.ownerLogs.dispatch(
        'blacklist',
        buildBlacklistHitLogCard(ctx.ui, message.author.username, isMentionOnly ? '@mention' : rawBody || 'prefix', message.guild.name),
      );
      const card = buildServerBlockedCard(ctx.ui, ctx.config.getSupportUrl(), message.guild.id);
      await message.reply({ flags: card.flags, components: card.components }).catch(() => undefined);
      return;
    }
  }

  if (isMentionOnly) {
    const card = buildMentionGreetingCard(ctx.ui, prefix, message.guild.id);
    await message.reply({ flags: card.flags, components: card.components }).catch(() => undefined);
    return;
  }

  if (!rawBody) return;
  const tokens = rawBody.split(/\s+/);
  const cmdName = tokens[0];
  const args = tokens.slice(1);

  const cmd = findCommandByNameOrAlias(ctx, cmdName);
  if (!cmd) return;

  // Owner commands: owners only, via prefix or @mention, in any server. Silently ignored for everyone else.
  if (cmd.ownerOnly) {
    if (!ctx.permissions.canUseOwnerPrefixCommand(message.author.id)) {
      return;
    }
  }

  if (!ctx.permissions.isOwner(message.author.id)) {
    if (ctx.config.isMaintenanceEnabled()) {
      const card = buildMaintenanceNoticeCard(ctx.ui, ctx.config.getMaintenanceMessage(), message.guild.id);
      await message.reply({ flags: card.flags, components: card.components }).catch(() => undefined);
      return;
    }
    if (!ctx.config.isCommandEnabled(cmd.name)) {
      const card = buildErrorCard(ctx.ui, 'Command disabled', `\`/${cmd.name}\` is temporarily disabled.`, message.guild.id);
      await message.reply({ flags: card.flags, components: card.components }).catch(() => undefined);
      return;
    }
    const retryAt = ctx.checkCooldown(message.author.id, cmd.name, cmd.cooldownMs ?? 2000);
    if (retryAt) {
      const card = buildCooldownCard(ctx.ui, retryAt, message.guild.id);
      await message.reply({ flags: card.flags, components: card.components }).catch(() => undefined);
      return;
    }
  }

  if (cmd.djOnly && !ctx.permissions.hasDjAccess(message.member, message.guild.id)) {
    const card = buildDjRequiredCard(ctx.ui, '**DJ**', message.guild.id);
    await message.reply({ flags: card.flags, components: card.components }).catch(() => undefined);
    return;
  }

  let sentReply: Message | null = null;
  const sendBody = (payload: AurioMessagePayload) => ({
    flags: payload.flags,
    components: payload.components,
    files: payload.files,
  });

  const inv: CommandInvocation = {
    ctx,
    userId: message.author.id,
    username: message.author.username,
    guild: message.guild,
    member: message.member,
    channelId: message.channelId,
    isSlash: false,
    message,
    args,
    reply: async (payload) => {
      sentReply = await message.reply(sendBody(payload) as never);
    },
    editReply: async (payload) => {
      if (sentReply) {
        await sentReply.edit({ flags: payload.flags, components: payload.components } as never);
      } else {
        sentReply = await message.reply(sendBody(payload) as never);
      }
    },
    defer: async () => {
      // No-op for message commands; editReply sends if not yet sent
    },
    showModal: async () => {
      await inv.reply(buildErrorCard(ctx.ui, 'Use slash command', `Run \`/${cmd.name}\` to open this interactive dialog.`, message.guild?.id));
    },
    getString: () => null,
    getInteger: () => null,
    getChannelId: () => null,
    getRoleId: () => null,
    getAttachmentUrl: () => message.attachments.first()?.url ?? null,
    getSubcommand: () => null,
  };

  const start = Date.now();
  try {
    await cmd.execute(inv);
    log.info('command', `${cmd.name} (message) by ${message.author.id} in ${message.guild.id}, ${Date.now() - start}ms`);
    ctx.repos.recordGuildCommand(message.guild.id, message.guild.name);
    void ctx.ownerLogs.dispatch(
      'commands',
      buildCommandUsedLogCard(ctx.ui, `${prefix}${cmd.name}`, message.author.username, message.guild.name, Date.now() - start),
    );
  } catch (err) {
    log.error('command', `${cmd.name} (message) failed`, err);
    const recorded = ctx.errors.record(err, {
      commandName: `${prefix}${cmd.name}`,
      guildId: message.guild.id,
      guildName: message.guild.name,
      channelId: message.channelId,
      messageLink: message.url,
      userId: message.author.id,
      username: message.author.username,
    });
    void ctx.ownerLogs.dispatch('errors', buildErrorFoundLogCard(ctx.ui, recorded));
    const replyCard =
      err instanceof LavalinkRequestError
        ? buildErrorCard(ctx.ui, 'Audio server error', `${err.message} (${recorded.id})`, message.guild.id)
        : buildCleanErrorCard(ctx.ui, recorded.id, ctx.config.getSupportUrl(), message.guild.id);
    await inv.reply(replyCard).catch(() => undefined);
  }
}
