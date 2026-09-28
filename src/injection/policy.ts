import { createHash } from 'node:crypto';

export type PreviewProbe = {
  /** Content hash of the last screenshot handed to the agent. */
  frameHash: string | null;
  /** Errors seen since the previous probe. */
  newErrors: number;
  /** True when the agent asked to see the preview itself. */
  requested: boolean;
  /** The user explicitly asked, via the UI or an @screenshot mention. */
  forced: boolean;
  /** The turn changed files that plausibly affect what is rendered. */
  touchedUi: boolean;
  /** The turn ended in a tool or build failure. */
  failed: boolean;
  /** Screenshots handed to the agent in the last N turns. */
  recentCount: number;
};

export type Verdict = {
  inject: boolean;
  reason: string;
};

/**
 * Screenshots are expensive in tokens and, in large numbers, actively degrade
 * output quality. So we inject only when seeing the screen would change what the
 * agent does next. Anything else is a guess that usually costs more than it pays.
 */
export function shouldInjectScreenshot(probe: PreviewProbe): Verdict {
  if (probe.forced) return { inject: true, reason: 'user asked to see the preview' };
  if (probe.requested) return { inject: true, reason: 'agent asked to see the preview' };
  if (probe.failed) return { inject: true, reason: 'the turn failed' };
  if (probe.newErrors > 0) return { inject: true, reason: 'the preview reported new errors' };

  if (probe.touchedUi) {
    if (probe.frameHash === null) return { inject: true, reason: 'first look at the preview' };
    if (probe.recentCount >= 3) {
      return { inject: false, reason: 'already seeing the preview every turn' };
    }
    return { inject: true, reason: 'files changed that affect what is rendered' };
  }

  if (probe.recentCount === 0 && probe.frameHash === null) {
    return { inject: true, reason: 'first look at the preview' };
  }

  return { inject: false, reason: 'nothing about the screen changed' };
}

export function hashFrame(bytes: Buffer | string): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 16);
}

const UI_HINT = /\.(tsx?|jsx?|svelte|vue|astro|css|scss|less|html?|erb|ejs|hbs|twig|j2|jinja|blade\.php|pug|haml|templ|tmpl)$/i;

/** Cheap heuristic for "this change could alter what the user sees". */
export function touchesUi(files: string[]): boolean {
  return files.some((file) => UI_HINT.test(file));
}

export type InjectionState = {
  frameHash: string | null;
  recent: number;
};

/** Tracks the rolling window so we stop injecting once the agent is seeing everything. */
export class InjectionPolicy {
  #state: InjectionState = { frameHash: null, recent: 0 };
  #window: number;

  constructor(window = 3) {
    this.#window = window;
  }

  decide(input: {
    requested: boolean;
    forced: boolean;
    files: string[];
    newErrors: number;
    failed: boolean;
  }): Verdict {
    const verdict = shouldInjectScreenshot({
      frameHash: this.#state.frameHash,
      newErrors: input.newErrors,
      requested: input.requested,
      forced: input.forced,
      touchedUi: touchesUi(input.files),
      failed: input.failed,
      recentCount: this.#state.recent,
    });

    if (verdict.inject) this.#state.recent += 1;
    return verdict;
  }

  record(frame: Buffer | string): { inject: boolean; reason: string } {
    const hash = hashFrame(frame);
    if (hash === this.#state.frameHash) return { inject: false, reason: 'screen is unchanged' };
    this.#state.frameHash = hash;
    return { inject: true, reason: 'screen changed' };
  }

  reset(): void {
    this.#state = { frameHash: null, recent: 0 };
  }
}
