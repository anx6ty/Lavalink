import { PermissionsBitField, type Guild, type GuildMember } from 'discord.js';
import type { AurioRepositories, BlacklistRow } from '../db/repositories.ts';

export class PermissionService {
  constructor(private readonly repos: AurioRepositories) {}

  public getOwnerIds(): Set<string> {
    const raw = process.env.OWNER_IDS ?? '';
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  public getOwnerGuildId(): string | null {
    // Tolerate quotes/whitespace pasted into host env vars (e.g. OWNER_GUILD_ID="123...").
    const id = process.env.OWNER_GUILD_ID?.replace(/[^0-9]/g, '');
    return id && id.length > 0 ? id : null;
  }

  public isOwner(userId: string): boolean {
    return this.getOwnerIds().has(userId);
  }

  public isOwnerServer(guildId: string | null | undefined): boolean {
    const ownerGuildId = this.getOwnerGuildId();
    if (!ownerGuildId || !guildId) return false;
    return guildId === ownerGuildId;
  }

  /** Owner prefix / @mention commands and owner panels work for owners in ANY server. */
  public canUseOwnerPrefixCommand(userId: string): boolean {
    return this.isOwner(userId);
  }

  /** Owner slash commands are only registered in OWNER_GUILD_ID, so they also require that server. */
  public canUseOwnerCommand(userId: string, guildId: string | null | undefined): boolean {
    return this.isOwner(userId) && this.isOwnerServer(guildId);
  }

  public checkBlacklist(userId: string, guildOwnerId?: string | null): BlacklistRow | null {
    const userRow = this.repos.getBlacklistedUser(userId);
    if (userRow) return userRow;
    if (guildOwnerId) {
      const ownerRow = this.repos.getBlacklistedUser(guildOwnerId);
      if (ownerRow) return ownerRow;
    }
    return null;
  }

  public isServerAdmin(member: GuildMember | null | undefined): boolean {
    if (!member) return false;
    if (member.guild.ownerId === member.id) return true;
    return (
      member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      member.permissions.has(PermissionsBitField.Flags.ManageGuild)
    );
  }

  public hasDjAccess(member: GuildMember | null | undefined, guildId: string): boolean {
    if (!member) return false;
    if (this.isOwner(member.id) || this.isServerAdmin(member)) return true;

    const settings = this.repos.getGuildSettings(guildId);
    if (!settings.dj_role_id) return true;
    if (member.roles.cache.has(settings.dj_role_id)) return true;

    // Alone in voice channel grants DJ control automatically
    const botVoiceId = member.guild.members.me?.voice.channelId;
    const memberVoiceId = member.voice.channelId;
    if (botVoiceId && memberVoiceId && botVoiceId === memberVoiceId) {
      const humans = member.voice.channel?.members.filter((m) => !m.user.bot).size ?? 0;
      if (humans <= 1) return true;
    }
    return false;
  }

  public isInSameVoiceChannel(member: GuildMember | null | undefined, guild: Guild): { ok: boolean; reason?: 'no_vc' | 'wrong_vc' } {
    const memberVc = member?.voice.channelId;
    if (!memberVc) return { ok: false, reason: 'no_vc' };
    const botVc = guild.members.me?.voice.channelId;
    if (botVc && botVc !== memberVc) return { ok: false, reason: 'wrong_vc' };
    return { ok: true };
  }

  public hasActiveMembership(guildId: string): boolean {
    const row = this.repos.getMembership(guildId);
    if (!row || row.active !== 1) return false;
    if (row.lifetime === 1) return true;
    if (row.ends_at && row.ends_at <= Date.now()) {
      return false;
    }
    return true;
  }
}
