import {
  DEFAULT_PAUSE_MESSAGE,
  DESK_NOTICE_MAX_LENGTH,
  PAUSE_MESSAGE_MAX_LENGTH,
  cleanDeskText,
  isDeskFeature,
  type DeskControlsView,
  type DeskFeature,
  type DeskNotice,
  type DeskPause,
} from "../src/domain/desk-controls.js";
import type { AdminSettingsRepository } from "./admin-service.js";

/** One setting per feature (`desk.pause.<feature>`), so two admins changing two switches never overwrite each other. */
const PAUSE_PREFIX = "desk.pause.";
const NOTICE_KEY = "desk.notice";

/**
 * The pauses and the desk notice, kept in `admin_settings` and read again at most every ten seconds per instance, so
 * a pause reaches every server within seconds. A read that fails keeps the last answer (or none), so a slow database
 * never stops payments on its own.
 */
export class DeskControls {
  private cached?: { at: number; view: DeskControlsView };

  constructor(private readonly settings: AdminSettingsRepository, private readonly cacheMs = 10_000, private readonly now: () => Date = () => new Date()) {}

  async view(): Promise<DeskControlsView> {
    if (this.cached && Date.now() - this.cached.at < this.cacheMs) return this.cached.view;
    try {
      const [pauses, notice] = await Promise.all([
        this.settings.list<DeskPause | null>(PAUSE_PREFIX),
        this.settings.get<DeskNotice | null>(NOTICE_KEY),
      ]);
      const paused: DeskControlsView["paused"] = {};
      for (const [key, setting] of pauses) {
        const feature = key.slice(PAUSE_PREFIX.length);
        if (isDeskFeature(feature) && setting.value && typeof setting.value.message === "string") paused[feature] = { message: setting.value.message, since: String(setting.value.since) };
      }
      const view = { paused, notice: notice?.value && typeof notice.value.text === "string" ? notice.value : null };
      this.cached = { at: Date.now(), view };
      return view;
    } catch {
      return this.cached?.view ?? { paused: {}, notice: null };
    }
  }

  /** The pause message when this feature is paused. */
  async paused(feature: DeskFeature) {
    return (await this.view()).paused[feature]?.message;
  }

  async setPause(input: { feature: DeskFeature; paused: boolean; message?: string; actor: string }) {
    const value: DeskPause | null = input.paused
      ? { message: cleanDeskText(input.message, PAUSE_MESSAGE_MAX_LENGTH) || DEFAULT_PAUSE_MESSAGE, since: this.now().toISOString() }
      : null;
    await this.settings.set(`${PAUSE_PREFIX}${input.feature}`, value, input.actor);
    this.cached = undefined;
    return this.view();
  }

  async setNotice(input: { text: string; tone: "info" | "warning"; actor: string }) {
    const text = cleanDeskText(input.text, DESK_NOTICE_MAX_LENGTH);
    await this.settings.set<DeskNotice | null>(NOTICE_KEY, text ? { text, tone: input.tone, since: this.now().toISOString() } : null, input.actor);
    this.cached = undefined;
    return this.view();
  }
}
