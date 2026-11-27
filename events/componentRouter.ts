import { stageRestore } from '../services/restore.ts';
import { log } from '../services/logger.ts';
import {
  ActivityType,
  AttachmentBuilder,
  ChannelType,
  PermissionsBitField,
  TextInputStyle,
  type APIContainerComponent,
  type ButtonInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from 'discord.js';
import { buildBlacklistViewItems } from '../commands/owner/blacklist.ts';
import { parseDurationDays } from '../commands/owner/membership.ts';
import { collectServerSummaries, guildToSummary } from '../commands/owner/servers.ts';
import { collectStatsSnapshot } from '../commands/owner/admin.ts';
import { LavalinkRequestError, type FilterPreset } from '../lavalink/LavalinkManager.ts';
import type { AurioContext } from '../services/AurioContext.ts';
import type { EmojiManifestEntry } from '../services/EmojiService.ts';
import type { LyricsResult } from '../services/LyricsService.ts';
import type { AurioTrack } from '../services/MusicService.ts';
import type { OwnerLogType } from '../services/OwnerLogService.ts';
import { disableApiContainerControls, type AurioMessagePayload } from '../ui/cardKit.ts';
import {
  buildBlacklistDmModal,
  buildBlacklistListCard,
  buildBlacklistReasonModal,
  buildBlacklistRemovedCard,
  buildBlacklistTheirServersCard,
  buildBlacklistUserDetailCard,
  buildMessageFromAurioCard,
  filterAndSortBlacklist,
} from '../ui/cards/blacklist.ts';
import {
  buildChangeEmojiPromptCard,
  buildEmojiCustomizationCard,
  buildEmojiEnterModal,
  buildEmojiImportCompleteCard,
  buildEmojiListCard,
  buildEmojiRenameModal,
  buildEmojiResetConfirmCard,
  buildEmojiUpdatedCard,
  filterAndSortEmojis,
} from '../ui/cards/emojis.ts';
import {
  buildCleanErrorCard,
  buildConfirmCard,
  buildDjRequiredCard,
  buildErrorCard,
  buildExpiredPanelCard,
  buildHelpCategoryCard,
  buildNothingPlayingCard,
  buildSameVoiceCard,
  buildSettingsCard,
  buildSuccessCard,
  type HelpCategory,
} from '../ui/cards/general.ts';
import {
  buildFavoriteItemDetailCard,
  buildFavoritesCard,
  buildPlaylistCreateModal,
  buildPlaylistDetailCard,
  buildPlaylistEditTracksCard,
  buildPlaylistRenameModal,
  buildPlaylistsListCard,
  buildRecentlyPlayedCard,
} from '../ui/cards/library.ts';
import {
  buildAddMembershipModal,
  buildCustomDurationModal,
  buildMembershipDetailCard,
  buildMembershipsListCard,
  buildPremiumActivatedCard,
  filterAndSortMemberships,
} from '../ui/cards/memberships.ts';
import {
  buildBackupCompleteLogCard,
  buildLogChannelsOverviewCard,
  buildOwnerActionLogCard,
} from '../ui/cards/ownerLogs.ts';
import {
  buildActivePlayersCard,
  buildAudioNodesCard,
  buildAuditLogCard,
  buildBotConfigCard,
  buildBotConfigModal,
  buildBroadcastPreviewCard,
  buildBroadcastResultCard,
  buildCommandTogglesCard,
  buildDatabaseStatusCard,
  buildMaintenanceCard,
  buildPresenceCard,
  buildPresenceModal,
  buildReloadedCard,
  buildStatsCard,
  buildUserInfoCard,
  type StatsTab,
} from '../ui/cards/ownerTools.ts';
import {
  buildFiltersCard,
  buildLyricsCard,
  buildPlaybackActionCards,
  buildPlaylistAddedCard,
  buildQueueCard,
  buildQueueItemDetailCard,
  buildVoteSkipCard,
} from '../ui/cards/playback.ts';
import {
  buildAdminsListCard,
  buildHighestRolesCard,
  buildLeaveGuildConfirmCard,
  buildOwnerInfoCard,
  buildPlayerStatusSummaryCard,
  buildServerControlCard,
  buildServerInfoCard,
  buildServerInviteCard,
  buildServersListCard,
  filterAndSortServers,
  type ServerInfoTab,
} from '../ui/cards/servers.ts';
import { discordTimestamp, formatDuration } from '../ui/theme.ts';
import {
  buildListJumpModal,
  buildListSearchModal,
  buildListSortModal,
  buildUsedInPickerCard,
  ITEMS_PER_PAGE,
  type UniversalListState,
  type UniversalSortMode,
} from '../ui/universalList.ts';

const STATELESS_NAMESPACES = new Set([
  'err', 'msmodal', 'msmodalopen', 'msmodalcancel', 'sys', 'userinfo',
  'nodelog', 'feedback', 'ms', 'mslog', 'guildlog', 'reload',
]);

const OWNER_NAMESPACES = new Set([
  'msmodalopen',
  'msmodalcancel',
  'guildlogpick',
  'srvnotice',
  'reload',
  'list',
  'listmodal',
  'emoji',
  'emojimodal',
  'emojiimport',
  'blacklist',
  'blmodal',
  'srv',
  'srvinfo',
  'srvadmins',
  'guildlog',
  'msadmin',
  'msmodal',
  'mslog',
  'stats',
  'maint',
  'maintmodal',
  'bcast',
  'bcastmodal',
  'nodes',
  'nodelog',
  'players',
  'userinfo',
  'errors',
  'err',
  'botcfg',
  'botcfgmodal',
  'presence',
  'presencemodal',
  'cmdtoggle',
  'db',
  'audit',
  'sys',
  'ologs',
  'feedback',
]);

async function updateInteractionMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  payload: AurioMessagePayload,
): Promise<void> {
  const body = { flags: payload.flags, components: payload.components, files: payload.files };
  if (!interaction.isModalSubmit()) {
    await interaction.update(body as never);
  } else if (interaction.isFromMessage() && interaction.message) {
    // update() also works on ephemeral messages; message.edit() does not.
    await interaction.update(body as never);
  } else {
    await interaction.reply(body as never);
  }
}

async function disableExpiredPanelMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  ctx: AurioContext,
): Promise<void> {
  try {
    const raw = interaction.message.components.map((c) => disableApiContainerControls(c.toJSON() as APIContainerComponent));
    await interaction.message.edit({ components: raw });
  } catch {
    // ignore if message cannot be edited
  }
  await interaction.reply(buildExpiredPanelCard(ctx.ui, interaction.guildId ?? undefined));
}

async function generateGuildInvite(
  guild: Guild,
  actorId: string,
  ctx: AurioContext,
): Promise<{ url: string | null; expiresAt: number | null }> {
  const me = guild.members.me;
  if (!me) return { url: null, expiresAt: null };

  const targetChannel = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.permissionsFor(me)?.has(PermissionsBitField.Flags.CreateInstantInvite),
  );

  if (!targetChannel || !('createInvite' in targetChannel)) {
    return { url: null, expiresAt: null };
  }

  try {
    const existing = await guild.invites.fetch().catch(() => null);
    const reusable = existing?.find((i) => !i.maxAge || i.maxAge > 0);
    if (reusable) {
      const exp = reusable.expiresTimestamp ?? null;
      ctx.repos.recordInviteAudit(guild.id, guild.name, reusable.url, actorId, exp);
      return { url: reusable.url, expiresAt: exp };
    }
    const created = await targetChannel.createInvite({ maxAge: 86_400, maxUses: 1, reason: 'Aurio owner invite lookup' });
    const exp = created.expiresTimestamp ?? Date.now() + 86_400_000;
    ctx.repos.recordInviteAudit(guild.id, guild.name, created.url, actorId, exp);
    return { url: created.url, expiresAt: exp };
  } catch {
    return { url: null, expiresAt: null };
  }
}

async function renderUniversalList(
  ctx: AurioContext,
  panelId: string,
  state: UniversalListState,
  guildId?: string,
): Promise<AurioMessagePayload> {
  if (state.listType === 'emojis') {
    return buildEmojiListCard(ctx.ui, ctx.emojis, panelId, state, guildId);
  }
  if (state.listType === 'blacklist') {
    return buildBlacklistListCard(ctx.ui, buildBlacklistViewItems(ctx), panelId, state, guildId);
  }
  if (state.listType === 'servers') {
    const servers = await collectServerSummaries(ctx);
    return buildServersListCard(ctx.ui, servers, panelId, state, guildId);
  }
  return buildMembershipsListCard(ctx.ui, ctx.repos.listMemberships(true), panelId, state, guildId);
}

async function countUniversalListItems(ctx: AurioContext, state: UniversalListState): Promise<number> {
  if (state.listType === 'emojis') return filterAndSortEmojis(ctx.emojis, state).length;
  if (state.listType === 'blacklist') return filterAndSortBlacklist(buildBlacklistViewItems(ctx), state).length;
  if (state.listType === 'servers') return filterAndSortServers(await collectServerSummaries(ctx), state).length;
  return filterAndSortMemberships(ctx.repos.listMemberships(true), state).length;
}

export async function routeComponentInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  ctx: AurioContext,
): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith('aurio:')) return;

  const parts = customId.split(':');
  const ns = parts[1];

  // Re-check owner permissions on EVERY owner button, select, and modal
  if (OWNER_NAMESPACES.has(ns)) {
    if (!ctx.permissions.canUseOwnerPrefixCommand(interaction.user.id)) {
      await interaction.reply(
        buildErrorCard(ctx.ui, 'Owner access required', 'Owner controls only work for authorized owners.', interaction.guildId ?? undefined),
      );
      return;
    }
  }

  try {
    // ---- Now Playing shared controls (same VC required) ----
    if (ns === 'np') {
      const guildId = parts[2];
      const action = parts[3];
      if (!interaction.guild || interaction.guild.id !== guildId) return;
      const member = interaction.guild.members.cache.get(interaction.user.id) ?? (await interaction.guild.members.fetch(interaction.user.id));
      const vcCheck = ctx.permissions.isInSameVoiceChannel(member, interaction.guild);
      if (!vcCheck.ok) {
        await interaction.reply(
          vcCheck.reason === 'wrong_vc'
            ? buildSameVoiceCard(ctx.ui, guildId)
            : buildErrorCard(ctx.ui, 'Join a voice channel first', 'Join voice to use playback controls.', guildId),
        );
        return;
      }

      const player = ctx.music.getPlayer(guildId);
      if (!player?.current) {
        await interaction.reply(buildNothingPlayingCard(ctx.ui, guildId));
        return;
      }

      if (action === 'fav') {
        const added = ctx.repos.toggleFavorite(interaction.user.id, {
          title: player.current.title,
          author: player.current.author,
          uri: player.current.uri,
          duration_ms: player.current.durationMs,
          artwork_url: player.current.artworkUrl,
          source_name: player.current.sourceName,
        });
        await ctx.syncNowPlayingMessage(guildId);
        await interaction.reply(
          buildSuccessCard(
            ctx.ui,
            added ? `Saved **${player.current.title}** to favorites` : `Removed **${player.current.title}** from favorites`,
            guildId,
            true,
          ),
        );
        return;
      }

      if (action === 'queue') {
        const panel = ctx.panels.create(interaction.user.id, guildId, 'queue', { page: 1 });
        await interaction.reply({ ...buildQueueCard(ctx.ui, player, panel.panelId, 1), flags: buildQueueCard(ctx.ui, player, panel.panelId, 1).flags | 64 });
        return;
      }

      if (action === 'more' && interaction.isStringSelectMenu()) {
        const val = interaction.values[0];
        if (val.startsWith('filter:')) {
          const preset = val.slice(7) as FilterPreset;
          if (!ctx.permissions.hasDjAccess(member, guildId)) {
            await interaction.reply(buildDjRequiredCard(ctx.ui, '**DJ**', guildId));
            return;
          }
          await ctx.music.setFilter(guildId, preset);
          await ctx.syncNowPlayingMessage(guildId);
          await interaction.reply(buildSuccessCard(ctx.ui, `Filter set to **${preset}**`, guildId, true));
          return;
        }
        if (val === 'action:autoplay') {
          const on = ctx.music.toggleAutoplay(guildId);
          await interaction.reply(buildPlaybackActionCards(ctx.ui, guildId).autoplay(on));
          return;
        }
        if (val === 'action:lyrics') {
          await interaction.deferReply({ flags: 64 });
          const res = await ctx.lyrics.fetchLyrics(player.current.title, player.current.author);
          if (!res) {
            await interaction.editReply(buildErrorCard(ctx.ui, 'Lyrics not found', undefined, guildId));
            return;
          }
          const panel = ctx.panels.create(interaction.user.id, guildId, 'lyrics', {
            lyrics: res,
            page: 1,
            artworkUrl: player.current.artworkUrl,
          });
          const card = buildLyricsCard(ctx.ui, panel.panelId, res, 1, player.current.artworkUrl, guildId);
          await interaction.editReply({ flags: card.flags, components: card.components });
          return;
        }
      }

      if (!ctx.permissions.hasDjAccess(member, guildId) && action !== 'skip') {
        await interaction.reply(buildDjRequiredCard(ctx.ui, '**DJ**', guildId));
        return;
      }

      if (action === 'toggle') {
        if (player.paused) await ctx.music.resume(guildId);
        else await ctx.music.pause(guildId);
      } else if (action === 'skip') {
        if (ctx.permissions.hasDjAccess(member, guildId)) {
          await ctx.music.skip(guildId);
        } else {
          const listeners = member.voice.channel?.members.filter((m) => !m.user.bot).size ?? 1;
          const vote = ctx.music.registerVoteSkip(guildId, interaction.user.id, listeners);
          if (vote.passed) await ctx.music.skip(guildId);
          else {
            await interaction.reply(buildVoteSkipCard(ctx.ui, guildId, vote.votes, vote.needed));
            return;
          }
        }
      } else if (action === 'prev') {
        await ctx.music.previous(guildId);
      } else if (action === 'stop') {
        await ctx.music.stop(guildId);
      } else if (action === 'loop') {
        ctx.music.setLoop(guildId);
      } else if (action === 'shuffle') {
        ctx.music.shuffle(guildId);
      } else if (action === 'voldown') {
        await ctx.music.setVolume(guildId, player.volume - 10);
      } else if (action === 'volup') {
        await ctx.music.setVolume(guildId, player.volume + 10);
      }

      await interaction.deferUpdate();
      if (player.current) await ctx.syncNowPlayingMessage(guildId);
      return;
    }

    if (ns === 'voteskip') {
      const guildId = parts[2];
      if (!interaction.guild) return;
      const member = interaction.guild.members.cache.get(interaction.user.id) ?? (await interaction.guild.members.fetch(interaction.user.id));
      const vcCheck = ctx.permissions.isInSameVoiceChannel(member, interaction.guild);
      if (!vcCheck.ok) {
        await interaction.reply(buildSameVoiceCard(ctx.ui, guildId));
        return;
      }
      const listeners = member.voice.channel?.members.filter((m) => !m.user.bot).size ?? 1;
      const vote = ctx.music.registerVoteSkip(guildId, interaction.user.id, listeners);
      if (vote.passed) {
        const { skipped } = await ctx.music.skip(guildId);
        await updateInteractionMessage(interaction as ButtonInteraction, buildPlaybackActionCards(ctx.ui, guildId).skipped(skipped?.title ?? 'track'));
      } else {
        await updateInteractionMessage(interaction as ButtonInteraction, buildVoteSkipCard(ctx.ui, guildId, vote.votes, vote.needed));
      }
      return;
    }

    if (ns === 'autoplay') {
      const guildId = parts[2];
      const on = ctx.music.toggleAutoplay(guildId, true);
      await interaction.reply(buildPlaybackActionCards(ctx.ui, guildId).autoplay(on));
      return;
    }

    if (ns === 'welcome') {
      const action = parts[2];
      if (action === 'start') {
        await interaction.reply(
          buildSuccessCard(ctx.ui, 'Join a voice channel and run `/play <song>` to start listening.', interaction.guildId ?? undefined, true),
        );
        return;
      }
      if (action === 'settings' && interaction.guildId) {
        const settings = ctx.repos.getGuildSettings(interaction.guildId);
        const panel = ctx.panels.create(interaction.user.id, interaction.guildId, 'settings', { guildId: interaction.guildId });
        await interaction.reply(buildSettingsCard(ctx.ui, panel.panelId, settings));
        return;
      }
    }

    // ---- Stateful panels: verify panel exists, belongs to invoking user, and has not expired ----
    // Stateless namespaces carry their own IDs and are permission-checked above.
    const stateless = STATELESS_NAMESPACES.has(ns);
    const panelId = parts[2];
    const panel = stateless
      ? { userId: interaction.user.id, state: {} as Record<string, unknown> }
      : ctx.panels.get<Record<string, unknown>>(panelId)!;

    if (!stateless && (!panel || ctx.panels.isExpired(panel as never))) {
      if (!interaction.isModalSubmit()) {
        await disableExpiredPanelMessage(interaction as ButtonInteraction | StringSelectMenuInteraction, ctx);
      } else {
        await interaction.reply(buildExpiredPanelCard(ctx.ui, interaction.guildId ?? undefined));
      }
      return;
    }

    if (panel.userId !== interaction.user.id) {
      await interaction.reply(
        buildErrorCard(ctx.ui, 'Panel locked', 'Only the user who opened this panel can control it.', interaction.guildId ?? undefined),
      );
      return;
    }

    // ---- Page number: jump to page ----
    if (['playlists', 'favorites', 'history'].includes(ns) && parts[3] === 'page' && interaction.isButton()) {
      await interaction.showModal(
        ctx.ui.modal(`aurio:pagejump:${panelId}:${ns}`, 'Jump to page', [
          ctx.ui.modalTextInput({ customId: 'page', label: 'Page number', required: true, maxLength: 4 }),
        ]),
      );
      return;
    }

    if (ns === 'pagejump' && interaction.isModalSubmit()) {
      const page = Math.max(1, Math.floor(Number(interaction.fields.getTextInputValue('page'))) || 1);
      ctx.panels.update(panelId, { ...panel.state, page });
      const userId = interaction.user.id;
      const guildId = interaction.guildId ?? undefined;
      const card =
        parts[3] === 'playlists'
          ? buildPlaylistsListCard(ctx.ui, panelId, ctx.repos.listUserPlaylists(userId), page, guildId)
          : parts[3] === 'favorites'
            ? buildFavoritesCard(ctx.ui, panelId, ctx.repos.listFavorites(userId), page, guildId)
            : buildRecentlyPlayedCard(ctx.ui, panelId, ctx.repos.listUserHistory(userId, 50), page, guildId);
      await updateInteractionMessage(interaction, card);
      return;
    }

    if (ns === 'srvnotice' && interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: 64 });
      const guild = ctx.client?.guilds.cache.get(parts[3]);
      const owner = await guild?.fetchOwner().catch(() => null);
      let sent = false;
      if (owner) {
        const card = buildMessageFromAurioCard(ctx.ui, interaction.fields.getTextInputValue('message'), ctx.config.getSupportUrl());
        sent = await owner.send({ flags: card.flags, components: card.components }).then(() => true, () => false);
      }
      await interaction.editReply(
        sent
          ? buildSuccessCard(ctx.ui, `Notice sent to the owner of **${guild!.name}**`, interaction.guildId ?? undefined, true) as never
          : buildErrorCard(ctx.ui, 'Notice not sent', 'The owner could not be reached by DM.', interaction.guildId ?? undefined) as never,
      );
      return;
    }

    // ---- Universal List ----
    if (ns === 'list') {
      const state = panel.state as unknown as UniversalListState;
      const action = parts[3];

      if (action === 'close' && interaction.isButton()) {
        const disabled = interaction.message.components.map((c) => disableApiContainerControls(c.toJSON() as APIContainerComponent));
        await interaction.update({ components: disabled });
        return;
      }
      if (action === 'search' && interaction.isButton()) {
        await interaction.showModal(buildListSearchModal(ctx.ui, panelId, state.searchQuery));
        return;
      }
      if (action === 'sort' && interaction.isButton()) {
        await interaction.showModal(buildListSortModal(ctx.ui, panelId, state.listType, state.sortBy));
        return;
      }
      if (action === 'jump' && interaction.isButton()) {
        const total = Math.max(1, Math.ceil((await countUniversalListItems(ctx, state)) / ITEMS_PER_PAGE));
        await interaction.showModal(buildListJumpModal(ctx.ui, panelId, total));
        return;
      }
      if (action === 'reset') {
        state.searchQuery = '';
        state.usedInFilter = undefined;
        state.sortBy = state.listType === 'emojis' ? 'default' : 'newest';
        state.page = 1;
        ctx.panels.update(panelId, state as unknown as Record<string, unknown>);
        await updateInteractionMessage(interaction as ButtonInteraction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'prev' || action === 'next') {
        state.page = Math.max(1, state.page + (action === 'next' ? 1 : -1));
        ctx.panels.update(panelId, state as unknown as Record<string, unknown>);
        await updateInteractionMessage(interaction as ButtonInteraction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'usedin_prev' || action === 'usedin_next') {
        state.usedInPage = Math.max(1, (state.usedInPage ?? 1) + (action === 'usedin_next' ? 1 : -1));
        ctx.panels.update(panelId, state as unknown as Record<string, unknown>);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildUsedInPickerCard(ctx.ui, panelId, ctx.emojis.listCardNames(), state.usedInPage, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'usedin_pick' && interaction.isStringSelectMenu()) {
        state.usedInFilter = interaction.values[0];
        state.page = 1;
        ctx.panels.update(panelId, state as unknown as Record<string, unknown>);
        await updateInteractionMessage(interaction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'back') {
        await updateInteractionMessage(interaction as ButtonInteraction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'detail') {
        const targetId = parts[4];
        if (state.listType === 'emojis') {
          const row = ctx.emojis.getRow(targetId);
          await updateInteractionMessage(
            interaction as ButtonInteraction,
            buildEmojiCustomizationCard(ctx.ui, ctx.emojis, panelId, row, interaction.guildId ?? undefined),
          );
          return;
        }
        if (state.listType === 'blacklist') {
          const row = ctx.repos.getBlacklistedUser(targetId);
          if (row) {
            await updateInteractionMessage(
              interaction as ButtonInteraction,
              buildBlacklistUserDetailCard(ctx.ui, panelId, row, interaction.guildId ?? undefined),
            );
          }
          return;
        }
        if (state.listType === 'servers') {
          const guild = ctx.client?.guilds.cache.get(targetId);
          if (guild) {
            const summary = await guildToSummary(ctx, guild);
            await updateInteractionMessage(
              interaction as ButtonInteraction,
              buildServerControlCard(ctx.ui, panelId, summary, ctx.permissions.hasActiveMembership(targetId), interaction.guildId ?? undefined),
            );
          }
          return;
        }
        if (state.listType === 'memberships') {
          const row = ctx.repos.getMembership(targetId);
          if (row) {
            await updateInteractionMessage(
              interaction as ButtonInteraction,
              buildMembershipDetailCard(ctx.ui, panelId, row, interaction.guildId ?? undefined),
            );
          }
          return;
        }
      }
    }

    if (ns === 'listmodal' && interaction.isModalSubmit()) {
      const state = panel.state as unknown as UniversalListState;
      const action = parts[3];

      if (action === 'search') {
        state.searchQuery = interaction.fields.getTextInputValue('query').trim();
        state.page = 1;
        ctx.panels.update(panelId, state as unknown as Record<string, unknown>);
        await updateInteractionMessage(interaction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'jump') {
        const raw = Number(interaction.fields.getTextInputValue('page').trim());
        const total = Math.max(1, Math.ceil((await countUniversalListItems(ctx, state)) / ITEMS_PER_PAGE));
        if (Number.isFinite(raw) && raw >= 1) {
          state.page = Math.min(Math.floor(raw), total);
        }
        ctx.panels.update(panelId, state as unknown as Record<string, unknown>);
        await updateInteractionMessage(interaction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'sort') {
        const selected = (interaction.fields.getStringSelectValues('sort_mode')?.[0] ?? 'default') as UniversalSortMode;
        state.sortBy = selected;
        state.page = 1;
        if (selected === 'used_in' && state.listType === 'emojis') {
          state.usedInPage = 1;
          ctx.panels.update(panelId, state as unknown as Record<string, unknown>);
          await updateInteractionMessage(
            interaction,
            buildUsedInPickerCard(ctx.ui, panelId, ctx.emojis.listCardNames(), 1, interaction.guildId ?? undefined),
          );
          return;
        }
        state.usedInFilter = undefined;
        ctx.panels.update(panelId, state as unknown as Record<string, unknown>);
        await updateInteractionMessage(interaction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
    }

    // ---- Help ----
    if (ns === 'help' && interaction.isStringSelectMenu()) {
      const cat = interaction.values[0] as HelpCategory;
      await updateInteractionMessage(interaction, buildHelpCategoryCard(ctx.ui, panelId, cat, interaction.guildId ?? undefined));
      return;
    }

    // ---- Settings ----
    if (ns === 'settings') {
      const guildId = String(panel.state.guildId);
      const action = parts[3];
      if (action === '247' && interaction.isButton()) {
        const cur = ctx.repos.getGuildSettings(guildId);
        const updated = ctx.repos.updateGuildSettings(guildId, { mode_247: cur.mode_247 === 1 ? 0 : 1 });
        await updateInteractionMessage(interaction, buildSettingsCard(ctx.ui, panelId, updated));
        return;
      }
      if (action === 'prefix' && interaction.isButton()) {
        const cur = ctx.repos.getGuildSettings(guildId);
        await interaction.showModal(
          ctx.ui.modal(`aurio:settingsmodal:${panelId}:prefix`, 'Edit prefix', [
            ctx.ui.modalTextInput({
              customId: 'prefix',
              label: 'Server prefix',
              value: cur.prefix,
              style: TextInputStyle.Short,
              required: true,
              maxLength: 5,
            }),
          ]),
        );
        return;
      }
      if (action === 'dj' && interaction.isButton()) {
        const roles = interaction.guild?.roles.cache.filter((r) => r.name !== '@everyone').first(24) ?? [];
        const card = ctx.ui.container(guildId);
        card.addTextDisplayComponents(ctx.ui.text('### Select DJ role\n-# Choose a role or clear DJ restriction'));
        card.addActionRowComponents(
          ctx.ui.selectRow({
            customId: `aurio:settings:${panelId}:djpick`,
            placeholder: 'Choose DJ role',
            options: [
              { label: 'Everyone (no DJ restriction)', value: 'none' },
              ...roles.map((r) => ({ label: r.name, value: r.id })),
            ],
          }),
        );
        await updateInteractionMessage(interaction, ctx.ui.payload(card, { ephemeral: true }));
        return;
      }
      if (action === 'djpick' && interaction.isStringSelectMenu()) {
        const val = interaction.values[0];
        const updated = ctx.repos.updateGuildSettings(guildId, { dj_role_id: val === 'none' ? null : val });
        await updateInteractionMessage(interaction, buildSettingsCard(ctx.ui, panelId, updated));
        return;
      }
    }

    if (ns === 'settingsmodal' && interaction.isModalSubmit()) {
      const guildId = String(panel.state.guildId);
      const nextPrefix = interaction.fields.getTextInputValue('prefix').trim() || '!';
      const updated = ctx.repos.updateGuildSettings(guildId, { prefix: nextPrefix });
      await updateInteractionMessage(interaction, buildSettingsCard(ctx.ui, panelId, updated));
      return;
    }

    // ---- Search / Queue / Filters / Lyrics ----
    if (ns === 'search') {
      const action = parts[3];
      if (action === 'cancel' && interaction.isButton()) {
        await updateInteractionMessage(interaction, buildSuccessCard(ctx.ui, 'Search cancelled', interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'pick' && interaction.isStringSelectMenu() && interaction.guild) {
        const idx = Number(interaction.values[0]);
        const results = panel.state.results as AurioTrack[];
        const picked = results?.[idx];
        if (!picked) return;
        ctx.music.enqueue(interaction.guild.id, interaction.guild.name, [picked], {
          voiceChannelId: String(panel.state.vcId),
          textChannelId: String(panel.state.channelId),
        });
        await updateInteractionMessage(
          interaction,
          buildSuccessCard(ctx.ui, `Queued **${picked.title}**`, interaction.guild.id, true),
        );
        return;
      }
    }

    if (ns === 'queue' && interaction.guild) {
      const player = ctx.music.getPlayer(interaction.guild.id);
      if (!player) {
        await interaction.reply(buildNothingPlayingCard(ctx.ui, interaction.guild.id));
        return;
      }
      const action = parts[3];
      let page = Number(panel.state.page ?? 1);
      if (action === 'prev') page = Math.max(1, page - 1);
      else if (action === 'next') page += 1;
      else if (action === 'shuffle') ctx.music.shuffle(interaction.guild.id);
      else if (action === 'clear') {
        const count = player.queue.length;
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildConfirmCard(
            ctx.ui,
            `Clear ${count} tracks?`,
            `aurio:queue:${panelId}:clearconfirm`,
            `aurio:queue:${panelId}:back`,
            { guildId: interaction.guild.id, danger: true },
          ),
        );
        return;
      } else if (action === 'clearconfirm') {
        ctx.music.clearQueue(interaction.guild.id);
      } else if (action === 'item') {
        const pos = Number(parts[4]);
        const track = player.queue[pos - 1];
        if (track) {
          await updateInteractionMessage(
            interaction as ButtonInteraction,
            buildQueueItemDetailCard(ctx.ui, panelId, track, pos, interaction.guild.id),
          );
          return;
        }
      } else if (action === 'top') {
        const pos = Number(parts[4]);
        ctx.music.moveTrack(interaction.guild.id, pos, 1);
      } else if (action === 'remove') {
        const pos = Number(parts[4]);
        ctx.music.removeTrack(interaction.guild.id, pos);
      }

      ctx.panels.update(panelId, { ...panel.state, page });
      await updateInteractionMessage(interaction as ButtonInteraction, buildQueueCard(ctx.ui, player, panelId, page));
      return;
    }

    if (ns === 'filters' && interaction.guild) {
      const action = parts[3];
      let preset: FilterPreset = 'off';
      if (action === 'pick' && interaction.isStringSelectMenu()) {
        preset = interaction.values[0] as FilterPreset;
      }
      await ctx.music.setFilter(interaction.guild.id, preset);
      await updateInteractionMessage(interaction as ButtonInteraction | StringSelectMenuInteraction, buildFiltersCard(ctx.ui, interaction.guild.id, panelId, preset));
      return;
    }

    if (ns === 'lyrics') {
      const lyrics = panel.state.lyrics as LyricsResult;
      const artworkUrl = (panel.state.artworkUrl as string | null) ?? null;
      let page = Number(panel.state.page ?? 1);
      if (parts[3] === 'prev') page = Math.max(1, page - 1);
      if (parts[3] === 'next') page = Math.min(lyrics.pages.length, page + 1);
      ctx.panels.update(panelId, { ...panel.state, page });
      await updateInteractionMessage(
        interaction as ButtonInteraction,
        buildLyricsCard(ctx.ui, panelId, lyrics, page, artworkUrl, interaction.guildId ?? undefined),
      );
      return;
    }

    // ---- Playlists, Favorites, History ----
    if (ns === 'playlists') {
      const action = parts[3];
      const plId = Number(parts[4]);
      if (action === 'create' && interaction.isButton()) {
        await interaction.showModal(buildPlaylistCreateModal(ctx.ui, panelId));
        return;
      }
      if (action === 'prev' || action === 'next') {
        const page = Math.max(1, Number(panel.state.page ?? 1) + (action === 'next' ? 1 : -1));
        ctx.panels.update(panelId, { ...panel.state, page });
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildPlaylistsListCard(ctx.ui, panelId, ctx.repos.listUserPlaylists(interaction.user.id), page, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'back') {
        const page = Number(panel.state.page ?? 1);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildPlaylistsListCard(ctx.ui, panelId, ctx.repos.listUserPlaylists(interaction.user.id), page, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'open') {
        const pl = ctx.repos.getPlaylist(plId);
        if (pl && pl.user_id === interaction.user.id) {
          await updateInteractionMessage(
            interaction as ButtonInteraction,
            buildPlaylistDetailCard(ctx.ui, panelId, pl, ctx.repos.listPlaylistTracks(pl.id), interaction.guildId ?? undefined),
          );
        }
        return;
      }
      if (action === 'play' && interaction.guild) {
        const member = interaction.guild.members.cache.get(interaction.user.id);
        const vcId = member?.voice.channelId;
        if (!vcId) {
          await interaction.reply(buildErrorCard(ctx.ui, 'Join a voice channel first', undefined, interaction.guild.id));
          return;
        }
        const pl = ctx.repos.getPlaylist(plId);
        if (!pl) return;
        const rows = ctx.repos.listPlaylistTracks(pl.id);
        const tracks: AurioTrack[] = rows.map((r) => ({
          encoded: r.uri,
          title: r.title,
          author: r.author,
          uri: r.uri,
          durationMs: r.duration_ms,
          artworkUrl: r.artwork_url,
          sourceName: r.source_name ?? 'audio',
          requesterId: interaction.user.id,
          requesterTag: interaction.user.username,
        }));
        if (!interaction.guild.members.me?.voice.channelId) {
          await ctx.joinVoiceChannel(interaction.guild.id, vcId);
        }
        ctx.music.enqueue(interaction.guild.id, interaction.guild.name, tracks, {
          allowDuplicates: true,
          voiceChannelId: vcId,
          textChannelId: interaction.channelId ?? undefined,
        });
        const totalMs = tracks.reduce((a, t) => a + t.durationMs, 0);
        await interaction.reply(buildPlaylistAddedCard(ctx.ui, pl.name, tracks[0]?.uri || 'https://aurio.bot', tracks.length, totalMs, interaction.guild.id));
        return;
      }
      if (action === 'addcurrent' && interaction.guild) {
        const pl = ctx.repos.getPlaylist(plId);
        const cur = ctx.music.getPlayer(interaction.guild.id)?.current;
        if (!pl || !cur) {
          await interaction.reply(buildNothingPlayingCard(ctx.ui, interaction.guild.id));
          return;
        }
        ctx.repos.addTrackToPlaylist(pl.id, {
          title: cur.title,
          author: cur.author,
          uri: cur.uri,
          duration_ms: cur.durationMs,
          artwork_url: cur.artworkUrl,
          source_name: cur.sourceName,
        });
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildPlaylistDetailCard(ctx.ui, panelId, pl, ctx.repos.listPlaylistTracks(pl.id), interaction.guild.id),
        );
        return;
      }
      if (action === 'edittracks') {
        const pl = ctx.repos.getPlaylist(plId);
        if (pl) {
          await updateInteractionMessage(
            interaction as ButtonInteraction,
            buildPlaylistEditTracksCard(ctx.ui, panelId, pl, ctx.repos.listPlaylistTracks(pl.id), interaction.guildId ?? undefined),
          );
        }
        return;
      }
      if (action === 'removetrack' && interaction.isStringSelectMenu()) {
        const trackId = Number(interaction.values[0]);
        ctx.repos.removePlaylistTrack(plId, trackId);
        const pl = ctx.repos.getPlaylist(plId);
        if (pl) {
          await updateInteractionMessage(
            interaction,
            buildPlaylistDetailCard(ctx.ui, panelId, pl, ctx.repos.listPlaylistTracks(pl.id), interaction.guildId ?? undefined),
          );
        }
        return;
      }
      if (action === 'rename' && interaction.isButton()) {
        const pl = ctx.repos.getPlaylist(plId);
        if (pl) await interaction.showModal(buildPlaylistRenameModal(ctx.ui, panelId, plId, pl.name));
        return;
      }
      if (action === 'privacy') {
        const pl = ctx.repos.getPlaylist(plId);
        if (pl) {
          ctx.repos.setPlaylistPrivacy(pl.id, pl.is_public === 0);
          const refreshed = ctx.repos.getPlaylist(pl.id)!;
          await updateInteractionMessage(
            interaction as ButtonInteraction,
            buildPlaylistDetailCard(ctx.ui, panelId, refreshed, ctx.repos.listPlaylistTracks(pl.id), interaction.guildId ?? undefined),
          );
        }
        return;
      }
      if (action === 'delete') {
        const pl = ctx.repos.getPlaylist(plId);
        if (pl) {
          await updateInteractionMessage(
            interaction as ButtonInteraction,
            buildConfirmCard(
              ctx.ui,
              `Delete playlist "${pl.name}"?`,
              `aurio:playlists:${panelId}:deleteconfirm:${pl.id}`,
              `aurio:playlists:${panelId}:open:${pl.id}`,
              { guildId: interaction.guildId ?? undefined, danger: true },
            ),
          );
        }
        return;
      }
      if (action === 'deleteconfirm') {
        ctx.repos.deletePlaylist(plId);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildPlaylistsListCard(ctx.ui, panelId, ctx.repos.listUserPlaylists(interaction.user.id), 1, interaction.guildId ?? undefined),
        );
        return;
      }
    }

    if (ns === 'playlistsmodal' && interaction.isModalSubmit()) {
      const action = parts[3];
      if (action === 'create') {
        const name = interaction.fields.getTextInputValue('name').trim().slice(0, 50);
        const isPublic = interaction.fields.getStringSelectValues('privacy')?.[0] === 'public';
        const pl = ctx.repos.createPlaylist(interaction.user.id, name, isPublic);
        await updateInteractionMessage(
          interaction,
          buildPlaylistDetailCard(ctx.ui, panelId, pl, [], interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'rename') {
        const plId = Number(parts[4]);
        const name = interaction.fields.getTextInputValue('name').trim().slice(0, 50);
        ctx.repos.renamePlaylist(plId, name);
        const pl = ctx.repos.getPlaylist(plId)!;
        await updateInteractionMessage(
          interaction,
          buildPlaylistDetailCard(ctx.ui, panelId, pl, ctx.repos.listPlaylistTracks(pl.id), interaction.guildId ?? undefined),
        );
        return;
      }
    }

    if (ns === 'favorites') {
      const action = parts[3];
      const list = ctx.repos.listFavorites(interaction.user.id);
      let page = Number(panel.state.page ?? 1);
      if (action === 'prev') page = Math.max(1, page - 1);
      else if (action === 'next') page += 1;
      else if (action === 'item') {
        const fav = list.find((f) => f.id === Number(parts[4]));
        if (fav) {
          await updateInteractionMessage(interaction as ButtonInteraction, buildFavoriteItemDetailCard(ctx.ui, panelId, fav, interaction.guildId ?? undefined));
          return;
        }
      } else if (action === 'remove') {
        ctx.repos.removeFavorite(interaction.user.id, Number(parts[4]));
      } else if ((action === 'playone' || action === 'playall') && interaction.guild) {
        const vcId = interaction.guild.members.cache.get(interaction.user.id)?.voice.channelId;
        if (!vcId) {
          await interaction.reply(buildErrorCard(ctx.ui, 'Join a voice channel first', undefined, interaction.guild.id));
          return;
        }
        const selected = action === 'playone' ? list.filter((f) => f.id === Number(parts[4])) : list;
        const tracks: AurioTrack[] = selected.map((f) => ({
          encoded: f.uri,
          title: f.title,
          author: f.author,
          uri: f.uri,
          durationMs: f.duration_ms,
          artworkUrl: f.artwork_url,
          sourceName: 'audio',
          requesterId: interaction.user.id,
          requesterTag: interaction.user.username,
        }));
        if (!interaction.guild.members.me?.voice.channelId) {
          await ctx.joinVoiceChannel(interaction.guild.id, vcId);
        }
        ctx.music.enqueue(interaction.guild.id, interaction.guild.name, tracks, {
          allowDuplicates: true,
          voiceChannelId: vcId,
          textChannelId: interaction.channelId ?? undefined,
        });
        await interaction.reply(buildSuccessCard(ctx.ui, `Queued **${tracks.length} favorite track(s)**`, interaction.guild.id, true));
        return;
      }
      ctx.panels.update(panelId, { ...panel.state, page });
      await updateInteractionMessage(
        interaction as ButtonInteraction,
        buildFavoritesCard(ctx.ui, panelId, ctx.repos.listFavorites(interaction.user.id), page, interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'history') {
      const action = parts[3];
      const list = ctx.repos.listUserHistory(interaction.user.id, 50);
      let page = Number(panel.state.page ?? 1);
      if (action === 'prev') page = Math.max(1, page - 1);
      else if (action === 'next') page += 1;
      else if (action === 'play' && interaction.guild) {
        const entry = list.find((h) => h.id === Number(parts[4]));
        const vcId = interaction.guild.members.cache.get(interaction.user.id)?.voice.channelId;
        if (!entry || !vcId) {
          await interaction.reply(buildErrorCard(ctx.ui, 'Join a voice channel first', undefined, interaction.guild.id));
          return;
        }
        if (!interaction.guild.members.me?.voice.channelId) {
          await ctx.joinVoiceChannel(interaction.guild.id, vcId);
        }
        ctx.music.enqueue(
          interaction.guild.id,
          interaction.guild.name,
          [
            {
              encoded: entry.uri,
              title: entry.title,
              author: entry.author,
              uri: entry.uri,
              durationMs: entry.duration_ms,
              artworkUrl: null,
              sourceName: 'audio',
              requesterId: interaction.user.id,
              requesterTag: interaction.user.username,
            },
          ],
          { voiceChannelId: vcId, textChannelId: interaction.channelId ?? undefined },
        );
        await interaction.reply(buildSuccessCard(ctx.ui, `Queued **${entry.title}**`, interaction.guild.id, true));
        return;
      }
      ctx.panels.update(panelId, { ...panel.state, page });
      await updateInteractionMessage(
        interaction as ButtonInteraction,
        buildRecentlyPlayedCard(ctx.ui, panelId, list, page, interaction.guildId ?? undefined),
      );
      return;
    }

    // ---- Emoji Customization & Import ----
    if (ns === 'emoji') {
      const action = parts[3];
      const key = parts[4];
      if (action === 'back') {
        const state = panel.state as unknown as UniversalListState;
        await updateInteractionMessage(interaction as ButtonInteraction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      const row = ctx.emojis.getRow(key);
      if (action === 'detail') {
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildEmojiCustomizationCard(ctx.ui, ctx.emojis, panelId, row, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'change') {
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildChangeEmojiPromptCard(ctx.ui, panelId, row, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'enter' && interaction.isButton()) {
        await interaction.showModal(buildEmojiEnterModal(ctx.ui, panelId, row));
        return;
      }
      if (action === 'rename' && interaction.isButton()) {
        await interaction.showModal(buildEmojiRenameModal(ctx.ui, panelId, row));
        return;
      }
      if (action === 'reset') {
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildEmojiResetConfirmCard(ctx.ui, panelId, key, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'resetconfirm' || action === 'remove') {
        const updated = ctx.emojis.resetEmoji(key);
        ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'emoji_reset', key, updated.default_value);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildEmojiCustomizationCard(ctx.ui, ctx.emojis, panelId, updated, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'preview') {
        await interaction.reply(
          buildSuccessCard(ctx.ui, `${ctx.emojis.get(key)} Preview of **${key}** (\`${row.current_value}\`)`, interaction.guildId ?? undefined, true),
        );
        return;
      }
      if (action === 'copyid') {
        await interaction.reply(
          buildSuccessCard(ctx.ui, `Emoji value: \`${row.current_value}\` • App ID: \`${row.app_emoji_id ?? 'default'}\``, interaction.guildId ?? undefined, true),
        );
        return;
      }
      if (action === 'sendfile') {
        const exported = ctx.emojis.exportZipBuffer();
        const att = new AttachmentBuilder(exported.buffer, { name: `${key}-bundle.zip` });
        await interaction.reply({
          ...buildSuccessCard(ctx.ui, `Exported asset bundle for **${key}**`, interaction.guildId ?? undefined, true),
          files: [att],
        });
        return;
      }
    }

    if (ns === 'emojimodal' && interaction.isModalSubmit()) {
      const action = parts[3];
      const key = parts[4];
      if (action === 'set') {
        const val = interaction.fields.getTextInputValue('value').trim();
        const { oldValue, newValue } = ctx.emojis.setEmoji(key, val);
        ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'emoji_set', key, `${oldValue} -> ${newValue}`);
        await interaction.reply(buildEmojiUpdatedCard(ctx.ui, key, oldValue, newValue, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'rename') {
        const name = interaction.fields.getTextInputValue('name').trim();
        const updated = ctx.emojis.renameEmoji(key, name);
        await updateInteractionMessage(
          interaction,
          buildEmojiCustomizationCard(ctx.ui, ctx.emojis, panelId, updated, interaction.guildId ?? undefined),
        );
        return;
      }
    }

    if (ns === 'emojiimport') {
      const action = parts[3];
      if (action === 'cancel') {
        await updateInteractionMessage(interaction as ButtonInteraction, buildSuccessCard(ctx.ui, 'Emoji import cancelled', interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'details') {
        const added = (panel.state.added as EmojiManifestEntry[]).map((e) => `+ ${e.key}`);
        const changed = (panel.state.changed as EmojiManifestEntry[]).map((e) => `~ ${e.key}`);
        const skipped = (panel.state.skipped as Array<{ key: string; reason: string }>).map((e) => `- ${e.key}: ${e.reason}`);
        const summary = [...added, ...changed, ...skipped].slice(0, 20).join('\n') || 'No entries';
        await interaction.reply(buildSuccessCard(ctx.ui, `Import breakdown:\n${summary}`, interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'confirm') {
        const entriesArr = panel.state.entries as Array<{ key: string; entry: EmojiManifestEntry; b64: string }>;
        const entriesByKey = new Map(entriesArr.map((e) => [e.key, { entry: e.entry, buffer: Buffer.from(e.b64, 'base64') }]));
        const res = ctx.emojis.applyImport({
          added: panel.state.added as EmojiManifestEntry[],
          changed: panel.state.changed as EmojiManifestEntry[],
          skipped: panel.state.skipped as Array<{ key: string; reason: string }>,
          entriesByKey,
        });
        ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'emoji_import', String(res.importedCount), res.backupFile);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildEmojiImportCompleteCard(ctx.ui, res.importedCount, interaction.guildId ?? undefined),
        );
        return;
      }
    }

    // ---- Blacklist Detail ----
    if (ns === 'blacklist') {
      const action = parts[3];
      const targetId = parts[4];
      if (action === 'back') {
        const state = panel.state as unknown as UniversalListState;
        await updateInteractionMessage(interaction as ButtonInteraction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'detail') {
        const row = ctx.repos.getBlacklistedUser(targetId);
        if (row) {
          await updateInteractionMessage(interaction as ButtonInteraction, buildBlacklistUserDetailCard(ctx.ui, panelId, row, interaction.guildId ?? undefined));
        }
        return;
      }
      if (action === 'remove') {
        const row = ctx.repos.getBlacklistedUser(targetId);
        ctx.repos.removeBlacklist(targetId, interaction.user.id);
        ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'blacklist_remove', targetId, row?.username ?? null);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildBlacklistRemovedCard(ctx.ui, row?.username ?? targetId, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'editreason' && interaction.isButton()) {
        const row = ctx.repos.getBlacklistedUser(targetId);
        if (row) await interaction.showModal(buildBlacklistReasonModal(ctx.ui, panelId, targetId, row.reason));
        return;
      }
      if (action === 'dm' && interaction.isButton()) {
        await interaction.showModal(buildBlacklistDmModal(ctx.ui, panelId, targetId));
        return;
      }
      if (action === 'servers' || action === 'invites') {
        const servers = Array.from(ctx.client?.guilds.cache.values() ?? [])
          .filter((g) => g.ownerId === targetId)
          .map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount }));
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildBlacklistTheirServersCard(ctx.ui, panelId, targetId, servers, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'invite') {
        const g = ctx.client?.guilds.cache.get(targetId);
        if (g) {
          const inv = await generateGuildInvite(g, interaction.user.id, ctx);
          await interaction.reply(buildServerInviteCard(ctx.ui, g.name, inv.url, inv.expiresAt, interaction.guildId ?? undefined));
        }
        return;
      }
      if (action === 'history') {
        const hist = ctx.repos.getBlacklistHistory(targetId);
        const lines = hist.map((h) => `${h.action} • ${h.reason ?? 'no reason'} • ${discordTimestamp(h.created_at, 'R')}`).join('\n');
        await interaction.reply(buildSuccessCard(ctx.ui, `Blacklist history:\n${lines || 'None'}`, interaction.guildId ?? undefined, true));
        return;
      }
    }

    if (ns === 'blmodal' && interaction.isModalSubmit()) {
      const action = parts[3];
      const targetId = parts[4];
      if (action === 'reason') {
        const reason = interaction.fields.getTextInputValue('reason').trim();
        const updated = ctx.repos.updateBlacklistReason(targetId, reason, interaction.user.id);
        if (updated) {
          await updateInteractionMessage(interaction, buildBlacklistUserDetailCard(ctx.ui, panelId, updated, interaction.guildId ?? undefined));
        }
        return;
      }
      if (action === 'dm') {
        const msg = interaction.fields.getTextInputValue('message').trim();
        const user = await ctx.client?.users.fetch(targetId).catch(() => null);
        if (!user) {
          await interaction.reply(buildErrorCard(ctx.ui, 'User not reachable', undefined, interaction.guildId ?? undefined));
          return;
        }
        const dmCard = buildMessageFromAurioCard(ctx.ui, msg, ctx.config.getSupportUrl());
        await user.send({ flags: dmCard.flags, components: dmCard.components });
        await interaction.reply(buildSuccessCard(ctx.ui, `Sent DM to **${user.username}**`, interaction.guildId ?? undefined, true));
        return;
      }
    }

    // ---- Servers Control & Info ----
    if (ns === 'srv') {
      const action = parts[3];
      const targetGuildId = parts[4];
      if (action === 'back') {
        const state = panel.state as unknown as UniversalListState;
        await updateInteractionMessage(interaction as ButtonInteraction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      const guild = ctx.client?.guilds.cache.get(targetGuildId);
      if (!guild) {
        await interaction.reply(buildErrorCard(ctx.ui, 'Server not in cache', undefined, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'open') {
        const summary = await guildToSummary(ctx, guild);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildServerControlCard(ctx.ui, panelId, summary, ctx.permissions.hasActiveMembership(guild.id), interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'info') {
        const detailed = await buildDetailedServerInfo(ctx, guild);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildServerInfoCard(ctx.ui, panelId, detailed, 'overview', interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'invite') {
        const inv = await generateGuildInvite(guild, interaction.user.id, ctx);
        await interaction.reply(buildServerInviteCard(ctx.ui, guild.name, inv.url, inv.expiresAt, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'owner') {
        const owner = await guild.fetchOwner().catch(() => null);
        const shared = Array.from(ctx.client?.guilds.cache.values() ?? []).filter((g) => g.ownerId === guild.ownerId).length;
        const blacklisted = Boolean(ctx.repos.getBlacklistedUser(guild.ownerId));
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildOwnerInfoCard(
            ctx.ui,
            panelId,
            {
              id: guild.ownerId,
              tag: owner?.user.username ?? guild.ownerId,
              avatarUrl: owner?.user.displayAvatarURL({ size: 128 }) ?? null,
              createdAtMs: owner?.user.createdTimestamp ?? Date.now(),
              sharedServers: shared,
              blacklisted,
            },
            guild.id,
            interaction.guildId ?? undefined,
          ),
        );
        return;
      }
      if (action === 'leave') {
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildLeaveGuildConfirmCard(ctx.ui, panelId, guild.id, guild.name, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'leaveconfirm') {
        await guild.leave();
        ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'guild_leave', guild.id, guild.name);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildSuccessCard(ctx.ui, `Left **${guild.name}**`, interaction.guildId ?? undefined, true),
        );
        return;
      }
      if (action === 'bl') {
        const owner = await guild.fetchOwner().catch(() => null);
        ctx.repos.addBlacklist(guild.ownerId, owner?.user.username ?? guild.ownerId, 'Blacklisted via server panel', interaction.user.id);
        await interaction.reply(buildSuccessCard(ctx.ui, `Blacklisted owner of **${guild.name}**`, interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'ms') {
        if (ctx.permissions.hasActiveMembership(guild.id)) {
          ctx.repos.deactivateMembership(guild.id);
          await interaction.reply(buildSuccessCard(ctx.ui, `Removed membership from **${guild.name}**`, interaction.guildId ?? undefined, true));
        } else if (interaction.isButton()) {
          await interaction.showModal(buildAddMembershipModal(ctx.ui, guild.id));
        }
        return;
      }
      if (action === 'player') {
        const p = ctx.music.getPlayer(guild.id);
        await interaction.reply(
          buildPlayerStatusSummaryCard(
            ctx.ui,
            guild.name,
            p?.current?.title ?? null,
            p?.queue.length ?? 0,
            p ? ctx.music.getEstimatedPosition(p) : 0,
            p?.current?.durationMs ?? 0,
            interaction.guildId ?? undefined,
          ),
        );
        return;
      }
      if (action === 'reset') {
        ctx.repos.resetGuildSettings(guild.id);
        await interaction.reply(buildSuccessCard(ctx.ui, `Reset settings for **${guild.name}**`, interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'notice' && interaction.isButton()) {
        await interaction.showModal(
          ctx.ui.modal(`aurio:srvnotice:${panelId}:${guild.id}`, 'Send notice to owner', [
            ctx.ui.modalTextInput({
              customId: 'message',
              label: 'Message',
              style: TextInputStyle.Paragraph,
              required: true,
              maxLength: 1000,
            }),
          ]),
        );
        return;
      }
    }

    if (ns === 'srvinfo' && interaction.isStringSelectMenu()) {
      const targetGuildId = parts[4];
      const guild = ctx.client?.guilds.cache.get(targetGuildId);
      if (guild) {
        const tab = interaction.values[0] as ServerInfoTab;
        const detailed = await buildDetailedServerInfo(ctx, guild);
        await updateInteractionMessage(
          interaction,
          buildServerInfoCard(ctx.ui, panelId, detailed, tab, interaction.guildId ?? undefined),
        );
      }
      return;
    }

    if (ns === 'srvadmins') {
      const targetGuildId = parts[4];
      const guild = ctx.client?.guilds.cache.get(targetGuildId);
      if (!guild) return;
      const admins = guild.members.cache
        .filter((m) => m.permissions.has(PermissionsBitField.Flags.Administrator))
        .map((m) => ({ tag: m.user.username, roleLabel: 'Administrator' }));
      const page = Math.max(1, Number(panel.state.adminsPage ?? 1) + (parts[3] === 'next' ? 1 : -1));
      ctx.panels.update(panelId, { ...panel.state, adminsPage: page });
      await updateInteractionMessage(
        interaction as ButtonInteraction,
        buildAdminsListCard(ctx.ui, panelId, targetGuildId, admins, page, interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'guildlog') {
      const targetGuildId = parts[3];
      const guild = ctx.client?.guilds.cache.get(targetGuildId);
      if (!guild) {
        await interaction.reply(buildErrorCard(ctx.ui, 'Server unavailable', 'Aurio is no longer in that server.', interaction.guildId ?? undefined));
        return;
      }
      const managePanel = ctx.panels.create(interaction.user.id, interaction.guildId ?? null, 'guild_manage', {
        targetGuildId,
        listType: 'servers',
        page: 1,
        searchQuery: '',
        sortBy: 'newest',
      });
      const card = ctx.ui.container(interaction.guildId ?? undefined);
      card.addTextDisplayComponents(ctx.ui.text(`### Manage ${guild.name}`));
      card.addActionRowComponents(
        ctx.ui.selectRow({
          customId: `aurio:guildlogpick:${managePanel.panelId}:${guild.id}`,
          placeholder: 'Choose an action',
          options: [
            { label: 'Server info', value: 'info' },
            { label: 'Generate invite', value: 'invite' },
            { label: 'Owner info', value: 'owner' },
            { label: 'Admin list', value: 'admins' },
            { label: 'Highest roles', value: 'roles' },
            { label: 'Channels', value: 'channels' },
            { label: 'Permissions', value: 'permissions' },
            { label: 'Bot usage', value: 'music_stats' },
            { label: 'Blacklist owner', value: 'blacklist' },
            { label: 'Membership', value: 'membership' },
            { label: 'Leave', value: 'leave' },
          ],
        }),
      );
      await interaction.reply(ctx.ui.payload(card, { ephemeral: true }));
      return;
    }

    // ---- Memberships Admin & Modals ----
    if (ns === 'msadmin') {
      const action = parts[3];
      const targetGuildId = parts[4];
      if (action === 'back') {
        const state = panel.state as unknown as UniversalListState;
        await updateInteractionMessage(interaction as ButtonInteraction, await renderUniversalList(ctx, panelId, state, interaction.guildId ?? undefined));
        return;
      }
      const row = ctx.repos.getMembership(targetGuildId);
      if (!row) return;
      if (action === 'extend') {
        const base = row.ends_at && row.ends_at > Date.now() ? row.ends_at : Date.now();
        const updated = ctx.repos.upsertMembership({
          ...row,
          ends_at: row.lifetime === 1 ? null : base + 30 * 86_400_000,
          reminded_7d: 0,
          reminded_1d: 0,
          active: 1,
        });
        ctx.repos.addMembershipHistory(targetGuildId, 'extended', row.plan, '+30d', interaction.user.id);
        await updateInteractionMessage(interaction as ButtonInteraction, buildMembershipDetailCard(ctx.ui, panelId, updated, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'plan') {
        const nextPlan = row.plan === 'Premium' ? 'Supporter' : row.plan === 'Supporter' ? 'Partner' : 'Premium';
        const updated = ctx.repos.upsertMembership({ ...row, plan: nextPlan });
        ctx.repos.addMembershipHistory(targetGuildId, 'plan_changed', nextPlan, null, interaction.user.id);
        await updateInteractionMessage(interaction as ButtonInteraction, buildMembershipDetailCard(ctx.ui, panelId, updated, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'remove') {
        ctx.repos.deactivateMembership(targetGuildId);
        ctx.repos.addMembershipHistory(targetGuildId, 'removed', row.plan, null, interaction.user.id);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildSuccessCard(ctx.ui, `Removed membership for **${row.guild_name}**`, interaction.guildId ?? undefined, true),
        );
        return;
      }
      if (action === 'history') {
        const hist = ctx.repos.getMembershipHistory(targetGuildId);
        const lines = hist.map((h) => `${h.action} (${h.plan}) • ${h.details ?? ''} • ${discordTimestamp(h.created_at, 'R')}`).join('\n');
        await interaction.reply(buildSuccessCard(ctx.ui, `Membership history:\n${lines || 'None'}`, interaction.guildId ?? undefined, true));
        return;
      }
    }

    // ---- Owner Tools (Stats, Maintenance, Broadcast, Nodes, Players, Errors, Config, Presence, Toggles, DB, Audit, System) ----
    if (ns === 'stats') {
      const action = parts[3];
      if (action === 'close' && interaction.isButton()) {
        const disabled = interaction.message.components.map((c) => disableApiContainerControls(c.toJSON() as APIContainerComponent));
        await interaction.update({ components: disabled });
        return;
      }
      const tab: StatsTab =
        action === 'tab' && interaction.isStringSelectMenu()
          ? (interaction.values[0] as StatsTab)
          : ((panel.state.tab as StatsTab) || 'overview');
      ctx.panels.update(panelId, { tab });
      await updateInteractionMessage(
        interaction as ButtonInteraction | StringSelectMenuInteraction,
        buildStatsCard(ctx.ui, panelId, collectStatsSnapshot(ctx), tab, interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'maint') {
      const action = parts[3];
      if (action === 'toggle') {
        const next = !ctx.config.isMaintenanceEnabled();
        ctx.config.setMaintenance(next);
        ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'maintenance_toggle', String(next), null);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildMaintenanceCard(ctx.ui, panelId, next, ctx.config.getMaintenanceMessage(), interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'message' && interaction.isButton()) {
        await interaction.showModal(
          ctx.ui.modal(`aurio:maintmodal:${panelId}:save`, 'Maintenance message', [
            ctx.ui.modalTextInput({
              customId: 'message',
              label: 'Message',
              value: ctx.config.getMaintenanceMessage(),
              style: TextInputStyle.Paragraph,
              required: true,
              maxLength: 300,
            }),
          ]),
        );
        return;
      }
    }

    if (ns === 'maintmodal' && interaction.isModalSubmit()) {
      const msg = interaction.fields.getTextInputValue('message').trim();
      ctx.config.setMaintenance(ctx.config.isMaintenanceEnabled(), msg);
      await updateInteractionMessage(
        interaction,
        buildMaintenanceCard(ctx.ui, panelId, ctx.config.isMaintenanceEnabled(), msg, interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'bcast') {
      const action = parts[3];
      if (action === 'cancel') {
        await updateInteractionMessage(interaction as ButtonInteraction, buildSuccessCard(ctx.ui, 'Broadcast cancelled', interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'edit' && interaction.isButton()) {
        await interaction.showModal(
          ctx.ui.modal(`aurio:bcastmodal:${panelId}:edit`, 'Edit broadcast message', [
            ctx.ui.modalTextInput({
              customId: 'message',
              label: 'Message',
              value: String(panel.state.message ?? ''),
              style: TextInputStyle.Paragraph,
              required: true,
              maxLength: 1500,
            }),
          ]),
        );
        return;
      }
      if (action === 'send') {
        const message = String(panel.state.message ?? '');
        let sent = 0;
        let failed = 0;
        const card = buildMessageFromAurioCard(ctx.ui, message, ctx.config.getSupportUrl());
        for (const guild of ctx.client?.guilds.cache.values() ?? []) {
          const ch = guild.systemChannel ?? guild.channels.cache.find((c) => c.type === ChannelType.GuildText);
          if (!ch || !ch.isTextBased()) {
            failed += 1;
            continue;
          }
          try {
            await (ch as TextBasedChannel & { send: (d: unknown) => Promise<unknown> }).send({
              flags: card.flags,
              components: card.components,
            });
            sent += 1;
          } catch {
            failed += 1;
          }
        }
        ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'broadcast', `${sent} sent`, `${failed} failed`);
        await updateInteractionMessage(interaction as ButtonInteraction, buildBroadcastResultCard(ctx.ui, sent, failed, interaction.guildId ?? undefined));
        return;
      }
    }

    if (ns === 'bcastmodal' && interaction.isModalSubmit()) {
      const msg = interaction.fields.getTextInputValue('message').trim();
      ctx.panels.update(panelId, { message: msg });
      await updateInteractionMessage(
        interaction,
        buildBroadcastPreviewCard(ctx.ui, panelId, msg, ctx.client?.guilds.cache.size ?? 0, interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'nodes') {
      const nodeName = parts[4];
      ctx.lavalink.reconnectNode(nodeName);
      await updateInteractionMessage(
        interaction as ButtonInteraction,
        buildAudioNodesCard(ctx.ui, panelId, ctx.lavalink.listNodes(), interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'players') {
      const targetGuildId = parts[4];
      await ctx.music.stop(targetGuildId);
      const active = ctx.music.listActivePlayers().map((player) => ({ player, listeners: 0 }));
      await updateInteractionMessage(
        interaction as ButtonInteraction,
        buildActivePlayersCard(ctx.ui, panelId, active, interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'botcfg' && interaction.isButton()) {
      await interaction.showModal(buildBotConfigModal(ctx.ui, panelId, ctx.config.getAccentColorHex(), ctx.config.getSupportUrl()));
      return;
    }

    if (ns === 'botcfgmodal' && interaction.isModalSubmit()) {
      const accent = interaction.fields.getTextInputValue('accent').trim();
      const supportUrl = interaction.fields.getTextInputValue('support_url').trim();
      ctx.config.setGlobalAccentColor(accent);
      ctx.config.setSupportUrl(supportUrl);
      await updateInteractionMessage(
        interaction,
        buildBotConfigCard(ctx.ui, panelId, ctx.config.getAccentColorHex(), ctx.config.getSupportUrl(), interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'presence' && interaction.isButton()) {
      const p = ctx.config.getPresence();
      await interaction.showModal(buildPresenceModal(ctx.ui, panelId, p.activityType, p.text));
      return;
    }

    if (ns === 'presencemodal' && interaction.isModalSubmit()) {
      const type = (interaction.fields.getStringSelectValues('type')?.[0] ?? 'Listening') as 'Listening' | 'Playing' | 'Watching';
      const text = interaction.fields.getTextInputValue('text').trim();
      ctx.config.setPresence(type, text);
      const map = { Listening: ActivityType.Listening, Playing: ActivityType.Playing, Watching: ActivityType.Watching };
      ctx.client?.user?.setActivity(text, { type: map[type] });
      await updateInteractionMessage(interaction, buildPresenceCard(ctx.ui, panelId, type, text, interaction.guildId ?? undefined));
      return;
    }

    if (ns === 'cmdtoggle') {
      const cmdName = parts[4];
      const next = !ctx.config.isCommandEnabled(cmdName);
      ctx.config.setCommandEnabled(cmdName, next);
      const publicCmds = Array.from(ctx.commands.values())
        .filter((c) => !c.ownerOnly)
        .map((c) => ({ name: c.name, enabled: ctx.config.isCommandEnabled(c.name) }));
      await updateInteractionMessage(
        interaction as ButtonInteraction,
        buildCommandTogglesCard(ctx.ui, panelId, publicCmds, interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'db') {
      const action = parts[3];
      if (action === 'backup') {
        const entry = await ctx.backup.createBackup();
        void ctx.ownerLogs.dispatch('backups', buildBackupCompleteLogCard(ctx.ui, entry.sizeBytes, entry.createdAt));
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildDatabaseStatusCard(ctx.ui, panelId, ctx.database.integrityCheck(), ctx.database.getSizeBytes(), entry, interaction.guildId ?? undefined),
        );
        return;
      }
      if (action === 'restore') {
        const latest = ctx.backup.getLatestBackup();
        if (!latest) {
          await interaction.reply(buildErrorCard(ctx.ui, 'No backups available', undefined, interaction.guildId ?? undefined));
          return;
        }
        ctx.panels.update(panelId, { ...panel.state, restoreFile: latest.fileName });
        await interaction.reply(
          buildConfirmCard(
            ctx.ui,
            `Restore ${latest.fileName}? Changes made after this backup will be replaced and Aurio will restart.`,
            `aurio:db:${panelId}:restoreconfirm`,
            `aurio:db:${panelId}:restorecancel`,
            { guildId: interaction.guildId ?? undefined, danger: true },
          ),
        );
        return;
      }
      if (action === 'restorecancel') {
        await updateInteractionMessage(interaction as ButtonInteraction, buildSuccessCard(ctx.ui, 'Cancelled', interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'restoreconfirm') {
        const fileName = String(panel.state.restoreFile ?? '');
        stageRestore(ctx.backup.getBackupPath(fileName), ctx.database.dbPath);
        ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'db_restore', fileName, null);
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildSuccessCard(ctx.ui, 'Backup verified. Restarting to restore it...', interaction.guildId ?? undefined, true),
        );
        process.exitCode = 1;
        setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 500);
        return;
      }
    }

    if (ns === 'audit') {
      const page = Math.max(1, Number(panel.state.page ?? 1) + (parts[3] === 'next' ? 1 : -1));
      ctx.panels.update(panelId, { page });
      await updateInteractionMessage(
        interaction as ButtonInteraction,
        buildAuditLogCard(ctx.ui, panelId, ctx.repos.listAuditLogs(200), page, interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'ologs' && parts[3] === 'test' && interaction.isStringSelectMenu()) {
      const logType = interaction.values[0] as OwnerLogType;
      const ok = await ctx.ownerLogs.dispatch(
        logType,
        buildOwnerActionLogCard(ctx.ui, interaction.user.username, `sent a test event to ${logType}`, 'OWNER LOG TEST'),
        `Test dispatch for ${logType}`,
      );
      await interaction.reply(
        ok
          ? buildSuccessCard(ctx.ui, `Test sent to **${logType}**.`, interaction.guildId ?? undefined, true)
          : buildErrorCard(ctx.ui, 'Log test failed', `Configure and enable this category with \`/ologsetup\`, then check the bot's channel permissions.`, interaction.guildId ?? undefined),
      );
      return;
    }

    // ---- Direct ID-based owner actions (not tied to panelId) ----
    if (ns === 'err') {
      const errId = parts[2];
      const action = parts[3];
      const err = ctx.errors.get(errId);
      if (!err) {
        await interaction.reply(buildErrorCard(ctx.ui, 'Error not found', undefined, interaction.guildId ?? undefined));
        return;
      }
      if (action === 'stack') {
        await interaction.reply(buildSuccessCard(ctx.ui, `\`\`\`\n${err.stack.slice(0, 1800)}\n\`\`\``, interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'resolve') {
        ctx.errors.resolve(errId);
        await interaction.reply(buildSuccessCard(ctx.ui, `Resolved **${errId}**`, interaction.guildId ?? undefined, true));
        return;
      }
      if (action === 'ignore') {
        ctx.errors.ignore(errId);
        await interaction.reply(buildSuccessCard(ctx.ui, `Ignored similar errors for **${errId}**`, interaction.guildId ?? undefined, true));
        return;
      }
    }

    if (ns === 'msmodal' && interaction.isModalSubmit()) {
      const mode = parts[2];
      const targetGuildId = parts[3];
      if (mode === 'add') {
        const duration = interaction.fields.getStringSelectValues('duration')?.[0] ?? '30d';
        const plan = interaction.fields.getStringSelectValues('plan')?.[0] ?? 'Premium';
        const note = interaction.fields.getTextInputValue('note')?.trim() || '';
        const notify = interaction.fields.getStringSelectValues('notify_owner')?.[0] ?? 'yes';
        if (duration === 'custom') {
          await interaction.reply(
            buildConfirmCard(
              ctx.ui,
              'Enter custom duration days',
              `aurio:msmodalopen:${targetGuildId}:${plan}:${notify}`,
              'aurio:msmodalcancel',
              { guildId: interaction.guildId ?? undefined, confirmLabel: 'Enter days' },
            ),
          );
          return;
        }
        await applyMembershipGrant(ctx, targetGuildId, duration, plan, note, notify === 'yes', interaction);
        return;
      }
      if (mode === 'custom') {
        const plan = parts[4];
        const notify = parts[5] === 'yes';
        const days = interaction.fields.getTextInputValue('days').trim();
        if (!/^[1-9]\d{0,3}$/.test(days)) {
          await interaction.reply(buildErrorCard(ctx.ui, 'Invalid number of days', 'Enter a whole number from 1 to 3650.', interaction.guildId ?? undefined));
          return;
        }
        const note = interaction.fields.getTextInputValue('note')?.trim() || '';
        await applyMembershipGrant(ctx, targetGuildId, `${days}d`, plan, note, notify, interaction);
        return;
      }
    }

    if (ns === 'msmodalcancel') {
      await updateInteractionMessage(interaction, buildSuccessCard(ctx.ui, 'Cancelled', interaction.guildId ?? undefined, true));
      return;
    }

    if (ns === 'msmodalopen' && interaction.isButton()) {
      await interaction.showModal(buildCustomDurationModal(ctx.ui, parts[2], parts[3], '', parts[4]));
      return;
    }

    if (ns === 'sys' && (parts[2] === 'restart' || parts[2] === 'shutdown')) {
      if (parts[3] === 'cancel') {
        await updateInteractionMessage(interaction as ButtonInteraction, buildSuccessCard(ctx.ui, 'Cancelled', interaction.guildId ?? undefined, true));
        return;
      }
      if (parts[3] === 'confirm') {
        const restart = parts[2] === 'restart';
        await updateInteractionMessage(
          interaction as ButtonInteraction,
          buildSuccessCard(ctx.ui, restart ? 'Restarting Aurio cleanly...' : 'Shutting down Aurio cleanly...', interaction.guildId ?? undefined, true),
        );
        // A non-zero exit code makes Railway's "On Failure" policy start the bot again.
        process.exitCode = restart ? 1 : 0;
        setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 500);
        return;
      }
    }

    if (ns === 'userinfo' && parts[2] === 'bl') {
      const targetId = parts[3];
      const existing = ctx.repos.getBlacklistedUser(targetId);
      if (existing) {
        ctx.repos.removeBlacklist(targetId, interaction.user.id);
        await interaction.reply(buildSuccessCard(ctx.ui, `Removed \`${targetId}\` from blacklist`, interaction.guildId ?? undefined, true));
      } else {
        ctx.repos.addBlacklist(targetId, targetId, 'Blacklisted from userinfo', interaction.user.id);
        await interaction.reply(buildSuccessCard(ctx.ui, `Blacklisted \`${targetId}\``, interaction.guildId ?? undefined, true));
      }
      return;
    }

    if (ns === 'nodelog' && parts[2] === 'reconnect') {
      ctx.lavalink.reconnectNode(parts[3]);
      await interaction.reply(buildSuccessCard(ctx.ui, `Reconnecting node **${parts[3]}**`, interaction.guildId ?? undefined, true));
      return;
    }

    if (ns === 'guildlogpick' && interaction.isStringSelectMenu()) {
      const targetGuildId = parts[3];
      const guild = ctx.client?.guilds.cache.get(targetGuildId);
      if (!guild) return;
      const choice = interaction.values[0];
      if (choice === 'invite') {
        const inv = await generateGuildInvite(guild, interaction.user.id, ctx);
        await interaction.reply(buildServerInviteCard(ctx.ui, guild.name, inv.url, inv.expiresAt, interaction.guildId ?? undefined));
        return;
      }
      if (choice === 'owner') {
        const owner = await guild.fetchOwner().catch(() => null);
        const shared = Array.from(ctx.client?.guilds.cache.values() ?? []).filter((g) => g.ownerId === guild.ownerId).length;
        await updateInteractionMessage(
          interaction,
          buildOwnerInfoCard(
            ctx.ui,
            panelId,
            {
              id: guild.ownerId,
              tag: owner?.user.username ?? guild.ownerId,
              avatarUrl: owner?.user.displayAvatarURL({ size: 128 }) ?? null,
              createdAtMs: owner?.user.createdTimestamp ?? Date.now(),
              sharedServers: shared,
              blacklisted: Boolean(ctx.repos.getBlacklistedUser(guild.ownerId)),
            },
            guild.id,
            interaction.guildId ?? undefined,
          ),
        );
        return;
      }
      if (choice === 'admins') {
        const admins = guild.members.cache
          .filter((m) => m.permissions.has(PermissionsBitField.Flags.Administrator))
          .map((m) => ({ tag: m.user.username, roleLabel: 'Administrator' }));
        await updateInteractionMessage(
          interaction,
          buildAdminsListCard(ctx.ui, panelId, guild.id, admins, 1, interaction.guildId ?? undefined),
        );
        return;
      }
      if (choice === 'blacklist') {
        const owner = await guild.fetchOwner().catch(() => null);
        ctx.repos.addBlacklist(guild.ownerId, owner?.user.username ?? guild.ownerId, 'Blacklisted via join log', interaction.user.id);
        await interaction.reply(buildSuccessCard(ctx.ui, `Blacklisted owner of **${guild.name}**`, interaction.guildId ?? undefined, true));
        return;
      }
      if (choice === 'leave') {
        await updateInteractionMessage(
          interaction,
          buildLeaveGuildConfirmCard(ctx.ui, panelId, guild.id, guild.name, interaction.guildId ?? undefined),
        );
        return;
      }
      if (choice === 'roles') {
        const roles = Array.from(guild.roles.cache.values())
          .sort((a, b) => b.position - a.position)
          .slice(0, 10)
          .map((r) => ({ name: r.name, memberCount: r.members.size }));
        await updateInteractionMessage(interaction, buildHighestRolesCard(ctx.ui, panelId, guild.id, roles, interaction.guildId ?? undefined));
        return;
      }
      const tabMap: Record<string, ServerInfoTab> = {
        info: 'overview',
        channels: 'channels',
        permissions: 'permissions',
        music_stats: 'music_stats',
        membership: 'membership',
      };
      const detailed = await buildDetailedServerInfo(ctx, guild);
      await updateInteractionMessage(
        interaction,
        buildServerInfoCard(ctx.ui, panelId, detailed, tabMap[choice] ?? 'overview', interaction.guildId ?? undefined),
      );
      return;
    }

    if (ns === 'errors' && parts[3] === 'view') {
      const err = ctx.errors.get(parts[4]);
      if (err) {
        await interaction.reply(buildSuccessCard(ctx.ui, `\`${err.id}\` **${err.name}**\n${err.message}\nOccurrences: ${err.occurrences}`, interaction.guildId ?? undefined, true));
      }
      return;
    }

    if (ns === 'feedback') {
      if (parts[3] === 'dismiss' && interaction.isButton()) {
        await interaction.deferUpdate();
        await interaction.message.delete();
        return;
      }
      await interaction.reply(buildSuccessCard(ctx.ui, `Feedback ${parts[3] === 'dismiss' ? 'dismissed' : 'acknowledged'}`, interaction.guildId ?? undefined, true));
      return;
    }

    if (ns === 'ms' && parts[2] === 'perks') {
      await interaction.reply(
        buildSuccessCard(
          ctx.ui,
          'Member perks include custom server avatar, banner, bio, nickname, card accent theme, compact NP style, 24/7, autoplay, and default volume.',
          interaction.guildId ?? undefined,
          true,
        ),
      );
      return;
    }

    if (ns === 'mslog' && parts[2] === 'renew' && interaction.isButton()) {
      await interaction.showModal(buildAddMembershipModal(ctx.ui, parts[3]));
      return;
    }

    // Fallback for reload button if triggered
    if (ns === 'reload') {
      const { syncCommandsToDiscord } = await import('../commands/registry.ts');
      const count = await syncCommandsToDiscord(ctx, { reset: false });
      await interaction.reply(buildReloadedCard(ctx.ui, count, interaction.guildId ?? undefined));
    }
  } catch (err) {
    log.error('component', `${customId} failed`, err);
    const recorded = ctx.errors.record(err, {
      commandName: `component:${ns}`,
      guildId: interaction.guildId,
      guildName: interaction.guild?.name ?? null,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      username: interaction.user.username,
    });
    const replyCard =
      err instanceof LavalinkRequestError
        ? buildErrorCard(ctx.ui, 'Audio server error', `${err.message} (${recorded.id})`, interaction.guildId ?? undefined)
        : buildCleanErrorCard(ctx.ui, recorded.id, ctx.config.getSupportUrl(), interaction.guildId ?? undefined);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyCard).catch(() => undefined);
    } else {
      await interaction.reply(replyCard).catch(() => undefined);
    }
  }
}

async function applyMembershipGrant(
  ctx: AurioContext,
  targetGuildId: string,
  durationStr: string,
  plan: string,
  note: string,
  notifyOwner: boolean,
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const guild = ctx.client?.guilds.cache.get(targetGuildId);
  const guildName = guild?.name ?? targetGuildId;
  const dur = parseDurationDays(durationStr);
  const now = Date.now();
  const endsAt = dur.lifetime ? null : now + (dur.ms ?? 30 * 86_400_000);

  ctx.repos.upsertMembership({
    guild_id: targetGuildId,
    guild_name: guildName,
    plan,
    note: note || null,
    added_by: interaction.user.id,
    starts_at: now,
    ends_at: endsAt,
    lifetime: dur.lifetime ? 1 : 0,
    reminded_7d: 0,
    reminded_1d: 0,
    active: 1,
  });
  ctx.repos.addMembershipHistory(targetGuildId, 'added', plan, durationStr, interaction.user.id);
  ctx.repos.addAuditLog(interaction.user.id, interaction.user.username, 'membership_add', targetGuildId, `${plan} (${durationStr})`);

  await interaction.reply(
    buildSuccessCard(ctx.ui, `Added **${plan}** membership for **${guildName}**`, interaction.guildId ?? undefined, true),
  );
  if (notifyOwner && guild) {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      const card = buildPremiumActivatedCard(ctx.ui, endsAt, dur.lifetime, guild.id);
      await owner.send({ flags: card.flags, components: card.components }).catch(() => undefined);
    }
  }

}

async function buildDetailedServerInfo(ctx: AurioContext, guild: Guild) {
  const summary = await guildToSummary(ctx, guild);
  const channels = guild.channels.cache;
  const textChannels = channels.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).size;
  const voiceChannels = channels.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).size;
  const categoriesCount = channels.filter((c) => c.type === ChannelType.GuildCategory).size;
  const botsCount = guild.members.cache.filter((m) => m.user.bot).size;
  const humansCount = Math.max(0, guild.memberCount - botsCount);
  const stats = ctx.repos.getGuildStats(guild.id);
  const ms = ctx.repos.getMembership(guild.id);

  return {
    ...summary,
    humansCount,
    botsCount,
    textChannels,
    voiceChannels,
    categoriesCount,
    rolesCount: guild.roles.cache.size,
    boostTier: guild.premiumTier,
    boostCount: guild.premiumSubscriptionCount ?? 0,
    emojiCount: guild.emojis.cache.size,
    stickerCount: guild.stickers.cache.size,
    verificationLevel: String(guild.verificationLevel),
    mfaRequired: guild.mfaLevel > 0,
    botPermissions: guild.members.me?.permissions.toArray() ?? [],
    tracksPlayed: stats?.tracks_played ?? 0,
    listeningMs: stats?.listening_ms ?? 0,
    commandsUsed: stats?.commands_used ?? 0,
    membershipPlan: ms && ms.active === 1 ? ms.plan : null,
    membershipEndsAt: ms?.ends_at ?? null,
    membershipLifetime: ms?.lifetime === 1,
  };
}

// Keep unused import guard clean
void (buildUserInfoCard as unknown);
